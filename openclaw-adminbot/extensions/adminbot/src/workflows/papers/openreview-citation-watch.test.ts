import { describe, expect, it, vi } from "vitest";
import {
  ReferenceCheckError,
  type PdfReferenceChecker,
  type ReferenceFinding,
} from "../../connectors/reference-check.js";
import type {
  OpenReviewSubmission,
  OpenReviewSubmissionReader,
} from "../../contracts/openreview-citation-checks.js";
import { AdminBotService } from "../../kernel/service.js";
import { AdminBotMemoryStore } from "../../persistence/memory.js";
import {
  MAX_CITATION_CHECK_ATTEMPTS,
  OpenReviewCitationWatch,
} from "./openreview-citation-watch.js";

const matched: ReferenceFinding = {
  citation: "Synthetic A. A real paper. 2024.",
  status: "matched",
  explanation: "A matching record was found.",
};
const notFound: ReferenceFinding = {
  citation: "Synthetic B. A paper nobody wrote. 2031.",
  status: "not_found",
  explanation: "No matching reference found in the available databases.",
};

function submission(overrides: Partial<OpenReviewSubmission> = {}): OpenReviewSubmission {
  return {
    id: "paperAAAA",
    title: "Synthetic paper",
    venue_id: "Synthetic.cc/2027/Conference/Submission",
    pdf_path: "/pdf/v1.pdf",
    modified_at: 1,
    ...overrides,
  };
}

function setup(options: {
  submissions: OpenReviewSubmission[] | (() => OpenReviewSubmission[]);
  pdf?: (id: string) => Uint8Array | Promise<Uint8Array>;
  check?: PdfReferenceChecker;
  notifyEmail?: string | null;
}) {
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(store);
  const list = () =>
    typeof options.submissions === "function" ? options.submissions() : options.submissions;
  const reader = {
    profileId: vi.fn(async () => "~Synthetic_Author1"),
    listSubmissions: vi.fn(async () => list()),
    readPdf: vi.fn(
      async (id: string) => options.pdf?.(id) ?? Buffer.from(`%PDF-${id}-${Math.random()}`),
    ),
  } satisfies OpenReviewSubmissionReader;
  const check = vi.fn<PdfReferenceChecker>(
    options.check ?? (async () => ({ findings: [matched] })),
  );
  const watch = new OpenReviewCitationWatch({
    store,
    service,
    reader,
    check,
    ...(options.notifyEmail === null
      ? {}
      : { notifyEmail: options.notifyEmail ?? "lab-admin@example.test" }),
  });
  const sweep = async () => {
    const started = await watch.start();
    await watch.idle();
    return started;
  };
  return { store, service, reader, check, watch, sweep };
}

describe("OpenReview citation watch", () => {
  it("checks each uploaded version exactly once", async () => {
    let current = [submission()];
    const { store, check, sweep } = setup({ submissions: () => current });

    expect(await sweep()).toMatchObject({ started: true, submissions: 1, pending: 1 });
    expect(check).toHaveBeenCalledTimes(1);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "completed",
      attempts: 1,
      findings: [matched],
    });

    // Unchanged paper: nothing is downloaded or checked again.
    expect(await sweep()).toMatchObject({ started: true, pending: 0 });
    expect(check).toHaveBeenCalledTimes(1);

    // A new upload is a new content-addressed path.
    current = [submission({ pdf_path: "/pdf/v2.pdf", modified_at: 2 })];
    await sweep();
    expect(check).toHaveBeenCalledTimes(2);
    expect(
      store
        .listOpenReviewCitationChecks("paperAAAA")
        .map((c) => c.pdf_path)
        .toSorted(),
    ).toEqual(["/pdf/v1.pdf", "/pdf/v2.pdf"]);
  });

  it("reuses the result when identical bytes are stored under a new path", async () => {
    let current = [submission()];
    const { store, check, sweep } = setup({
      submissions: () => current,
      pdf: () => Buffer.from("%PDF-same-bytes"),
      check: async () => ({ findings: [notFound] }),
    });
    await sweep();
    current = [submission({ pdf_path: "/pdf/v1-restored.pdf", modified_at: 2 })];
    await sweep();
    expect(check).toHaveBeenCalledTimes(1);
    const [first, second] = [
      store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")!,
      store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1-restored.pdf")!,
    ];
    expect(second.findings).toEqual(first.findings);
    expect(second.notification_proposal_id).toBe(first.notification_proposal_id);
    // No second email about the same findings.
    expect(store.listProposalsByType("email.send")).toHaveLength(1);
  });

  it("proposes, never sends, an email for flagged citations", async () => {
    const { store, sweep } = setup({
      submissions: [submission()],
      check: async () => ({ findings: [matched, notFound] }),
    });
    await sweep();
    const proposals = store.listProposalsByType("email.send");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: "pending",
      proposed_payload: {
        to: "lab-admin@example.test",
        openreview_citation_check: { submission_id: "paperAAAA", pdf_path: "/pdf/v1.pdf" },
      },
    });
    const body = (proposals[0].proposed_payload as { body: string }).body;
    expect(body).toContain(notFound.citation);
    expect(body).not.toContain(matched.citation);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      notification_proposal_id: proposals[0].id,
    });
  });

  it("raises no proposal for a clean paper or without a recipient", async () => {
    const clean = setup({ submissions: [submission()] });
    await clean.sweep();
    expect(clean.store.listProposalsByType("email.send")).toHaveLength(0);

    const unaddressed = setup({
      submissions: [submission()],
      check: async () => ({ findings: [notFound] }),
      notifyEmail: null,
    });
    await unaddressed.sweep();
    expect(unaddressed.store.listProposalsByType("email.send")).toHaveLength(0);
    expect(unaddressed.store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")?.status).toBe(
      "completed",
    );
  });

  it("records an unreadable PDF once and does not retry it", async () => {
    const { store, check, sweep } = setup({
      submissions: [submission()],
      check: async () => {
        throw new ReferenceCheckError("No References or Bibliography heading was found.");
      },
    });
    await sweep();
    await sweep();
    expect(check).toHaveBeenCalledTimes(1);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "unreadable",
      error: "No References or Bibliography heading was found.",
    });
  });

  it("retries transient failures on later sweeps, a bounded number of times", async () => {
    const { store, check, sweep } = setup({
      submissions: [submission()],
      check: async () => {
        throw new Error("synthetic secret-bearing provider error");
      },
    });
    for (let i = 0; i < MAX_CITATION_CHECK_ATTEMPTS + 2; i++) {
      await sweep();
    }
    expect(check).toHaveBeenCalledTimes(MAX_CITATION_CHECK_ATTEMPTS);
    const stored = store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")!;
    expect(stored).toMatchObject({ status: "failed", attempts: MAX_CITATION_CHECK_ATTEMPTS });
    // Provider text never reaches the stored record.
    expect(stored.error).toBe("The reference check could not be completed.");
  });

  it("never records a paper as checked when no database answered", async () => {
    const { store, sweep } = setup({
      submissions: [submission()],
      check: async () => ({
        findings: [{ ...notFound, status: "unavailable" }],
      }),
    });
    await sweep();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "failed",
      error: "No reference database could be reached.",
    });
    expect(store.listProposalsByType("email.send")).toHaveLength(0);
  });

  it("records a failed download without checking anything", async () => {
    const { store, check, sweep } = setup({
      submissions: [submission()],
      pdf: () => {
        throw new Error("OpenReview returned 500 for the PDF");
      },
    });
    await sweep();
    expect(check).not.toHaveBeenCalled();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "failed",
      error: "The PDF could not be downloaded from OpenReview.",
    });
  });

  it("checks the most recently changed paper first and picks up uploads mid-sweep", async () => {
    const order: string[] = [];
    let current = [
      submission({ id: "oldPaper", modified_at: 1 }),
      submission({ id: "newPaper", modified_at: 5 }),
    ];
    const { sweep } = setup({
      submissions: () => current,
      pdf: (id) => {
        order.push(id);
        if (id === "newPaper") {
          // Uploaded while the sweep is running; checked before the older backlog.
          current = [...current, submission({ id: "lateUpload", modified_at: 9 })];
        }
        return Buffer.from(`%PDF-${id}`);
      },
    });
    await sweep();
    expect(order).toEqual(["newPaper", "lateUpload", "oldPaper"]);
  });

  it("runs one sweep at a time and surfaces listing failures to the caller", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { watch, reader } = setup({
      submissions: [submission()],
      check: async () => {
        await gate;
        return { findings: [matched] };
      },
    });
    expect((await watch.start()).started).toBe(true);
    expect((await watch.start()).started).toBe(false);
    expect(watch.status().running).toBe(true);
    release();
    await watch.idle();
    expect(watch.status()).toMatchObject({ running: false, last_sweep: { checked: 1 } });

    reader.listSubmissions.mockRejectedValueOnce(new Error("OpenReview rejected the login (403)"));
    await expect(watch.start()).rejects.toThrow("OpenReview rejected the login");
    expect(watch.status().running).toBe(false);
  });
});
