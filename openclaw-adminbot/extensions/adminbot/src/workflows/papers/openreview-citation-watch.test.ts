import { describe, expect, it, vi } from "vitest";
import {
  NO_TEXT_LAYER,
  ReferenceCheckError,
  type PdfReferenceChecker,
  type ReferenceFinding,
} from "../../connectors/reference-check.js";
import {
  OpenReviewLoginError,
  type OpenReviewSubmission,
  type OpenReviewSubmissionReader,
} from "../../contracts/openreview-citation-checks.js";
import { AdminBotService } from "../../kernel/service.js";
import { AdminBotMemoryStore } from "../../persistence/memory.js";
import {
  CITATION_EXTRACTOR_VERSION,
  MAX_CITATION_CHECK_ATTEMPTS,
  MAX_PARTIAL_CHECK_ATTEMPTS,
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
  checkTimeoutMs?: number;
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
    ...(options.checkTimeoutMs ? { checkTimeoutMs: options.checkTimeoutMs } : {}),
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

  it("raises no proposal when nothing is outright not found", async () => {
    const review = { ...notFound, status: "review" as const, explanation: "Weak match." };
    const { store, sweep } = setup({
      submissions: [submission()],
      check: async () => ({ findings: [matched, review] }),
    });
    await sweep();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")?.findings).toContainEqual(
      review,
    );
    expect(store.listProposalsByType("email.send")).toHaveLength(0);
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

  it("reads an unreadable version again once the extractor improves", async () => {
    const { store, check, sweep } = setup({ submissions: [submission()] });
    // Written by the first release, which predates extractor versions.
    store.saveOpenReviewCitationCheck({
      submission_id: "paperAAAA",
      pdf_path: "/pdf/v1.pdf",
      title: "Synthetic paper",
      venue_id: "Synthetic.cc/2027/Conference/Submission",
      status: "unreadable",
      checked_at: "2026-09-23T17:00:00.000Z",
      attempts: 1,
      error: "The bibliography could not be split reliably into individual references.",
    });
    await sweep();
    expect(check).toHaveBeenCalledTimes(1);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "completed",
      attempts: 1,
      extractor_version: CITATION_EXTRACTOR_VERSION,
    });
    await sweep();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("labels a text-less upload as a placeholder, to be checked when the paper arrives", async () => {
    const { store, sweep } = setup({
      submissions: [submission()],
      check: async () => {
        throw new ReferenceCheckError(NO_TEXT_LAYER);
      },
    });
    await sweep();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "unreadable",
      error: "Placeholder PDF with no text; the full paper is checked when it is uploaded.",
    });
  });

  it("waits while the required databases back off, without spending retries", async () => {
    let pausedUntil: number | undefined = Date.now() + 60_000;
    const store = new AdminBotMemoryStore();
    const check = vi.fn<PdfReferenceChecker>(async () => {
      // A back-off that starts mid-check leaves most of the paper unchecked.
      pausedUntil = Date.now() + 60_000;
      return { findings: [matched, { ...notFound, status: "unavailable" as const }] };
    });
    const watch = new OpenReviewCitationWatch({
      store,
      service: new AdminBotService(store),
      reader: {
        profileId: async () => "~Synthetic_Author1",
        listSubmissions: async () => [
          submission(),
          submission({ id: "paperBBBB", modified_at: 0 }),
        ],
        readPdf: async (id) => Buffer.from(`%PDF-${id}`),
      },
      check,
      pausedUntil: () => pausedUntil,
    });
    const paused = await watch.start();
    expect(paused).toMatchObject({ started: false, paused_until: expect.any(String) });
    expect(check).not.toHaveBeenCalled();

    pausedUntil = undefined;
    await watch.start();
    await watch.idle();
    // Checked the newest paper, saw the back-off begin, and stopped before the next one.
    expect(check).toHaveBeenCalledTimes(1);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "failed",
      attempts: 0,
    });
    expect(store.getOpenReviewCitationCheck("paperBBBB", "/pdf/v1.pdf")).toBeUndefined();
  });

  it("gives a version that failed under an older extractor fresh retries", async () => {
    const { store, check, sweep } = setup({ submissions: [submission()] });
    store.saveOpenReviewCitationCheck({
      submission_id: "paperAAAA",
      pdf_path: "/pdf/v1.pdf",
      title: "Synthetic paper",
      venue_id: "Synthetic.cc/2027/Conference/Submission",
      status: "failed",
      checked_at: "2026-09-23T18:34:00.000Z",
      attempts: MAX_CITATION_CHECK_ATTEMPTS,
      extractor_version: CITATION_EXTRACTOR_VERSION - 1,
    });
    await sweep();
    expect(check).toHaveBeenCalledTimes(1);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "completed",
      attempts: 1,
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
      error: "No reference could be checked.",
    });
    expect(store.listProposalsByType("email.send")).toHaveLength(0);
  });

  it("retries a version when too many references could not be checked", async () => {
    const unavailable = { ...notFound, status: "unavailable" as const };
    const { store, check, sweep } = setup({
      submissions: [submission()],
      check: async () => ({ findings: [matched, matched, matched, unavailable, unavailable] }),
    });
    await sweep();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "failed",
      error: "About 2 of 5 references could not be checked.",
    });
    // Kept, so the lab sheet can name the references that could not be confirmed.
    expect(
      store
        .getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")
        ?.findings?.filter((finding) => finding.status === "unavailable"),
    ).toHaveLength(2);
    await sweep();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("records a mostly unsplittable bibliography as unreadable, keeping what was checked", async () => {
    const chunk = {
      citation: "Run-together entries…",
      status: "unavailable" as const,
      explanation: "This part of the bibliography could not be split.",
      // Ten typical entries' worth: 10 hidden of 10 + 8 is over the 20% limit.
      oversized_chars: matched.citation.length * 10,
    };
    const { store, check, sweep } = setup({
      submissions: [submission()],
      check: async () => ({ findings: [...Array.from({ length: 8 }, () => matched), chunk] }),
    });
    await sweep();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "unreadable",
      error: "About 10 of 18 references could not be split out of the bibliography.",
      findings: expect.arrayContaining([matched, chunk]),
    });
    // Deterministic for these bytes: not retried, and no email about a mostly unchecked paper.
    await sweep();
    expect(check).toHaveBeenCalledTimes(1);
    expect(store.listProposalsByType("email.send")).toHaveLength(0);
  });

  it("completes a version with a few unchecked references, without flagging them", async () => {
    const unavailable = { ...notFound, status: "unavailable" as const };
    const { store, sweep } = setup({
      submissions: [submission()],
      check: async () => ({ findings: [matched, matched, matched, matched, matched, unavailable] }),
    });
    await sweep();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")?.status).toBe("completed");
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

  // What happened before the ICLR deadline: the paper edited last kept being retried first, hit
  // a database back-off, and ended the sweep, so the papers behind it waited for days.
  it("retries the paper tried least recently first, so a back-off cannot starve the rest", async () => {
    const store = new AdminBotMemoryStore();
    const failedAt = (id: string, at: string) =>
      store.saveOpenReviewCitationCheck({
        submission_id: id,
        pdf_path: "/pdf/v1.pdf",
        title: id,
        venue_id: "Synthetic.cc/2027/Conference/Submission",
        status: "failed",
        error: "About 9 of 37 references could not be checked.",
        checked_at: at,
        attempts: 1,
        extractor_version: CITATION_EXTRACTOR_VERSION,
      });
    failedAt("editedLast", "2026-09-25T18:55:00.000Z");
    failedAt("waitingSinceMonday", "2026-09-23T18:32:00.000Z");
    let pausedUntil: number | undefined;
    const order: string[] = [];
    const watch = new OpenReviewCitationWatch({
      store,
      service: new AdminBotService(store),
      reader: {
        profileId: async () => "~Synthetic_Author1",
        listSubmissions: async () => [
          submission({ id: "editedLast", modified_at: 9 }),
          submission({ id: "waitingSinceMonday", modified_at: 1 }),
        ],
        readPdf: async (id) => {
          order.push(id);
          return Buffer.from(`%PDF-${id}`);
        },
      },
      check: async () => {
        // Every check trips the back-off, so each sweep gets exactly one paper.
        pausedUntil = Date.now() + 60_000;
        return { findings: [matched, { ...notFound, status: "unavailable" as const }] };
      },
      pausedUntil: () => pausedUntil,
    });
    for (let i = 0; i < 2; i++) {
      pausedUntil = undefined;
      await watch.start();
      await watch.idle();
    }
    expect(order).toEqual(["waitingSinceMonday", "editedLast"]);
  });

  it("still checks a new upload before any retry", async () => {
    const order: string[] = [];
    const { store, sweep } = setup({
      submissions: [
        submission({ id: "retry", modified_at: 9 }),
        submission({ id: "fresh", modified_at: 1 }),
      ],
      pdf: (id) => {
        order.push(id);
        return Buffer.from(`%PDF-${id}`);
      },
    });
    store.saveOpenReviewCitationCheck({
      submission_id: "retry",
      pdf_path: "/pdf/v1.pdf",
      title: "retry",
      venue_id: "Synthetic.cc/2027/Conference/Submission",
      status: "failed",
      error: "About 9 of 37 references could not be checked.",
      checked_at: "2026-09-20T00:00:00.000Z",
      attempts: 1,
      extractor_version: CITATION_EXTRACTOR_VERSION,
    });
    await sweep();
    expect(order).toEqual(["fresh", "retry"]);
  });

  // What the first version of the fix got wrong on the live account: 327 submissions, most of a
  // PI's history never checked. "Never tried first" put a retry on a paper due tomorrow behind
  // every one of them.
  it("retries a paper under active revision before the never-checked backlog", async () => {
    const now = Date.parse("2026-09-25T21:00:00.000Z");
    const order: string[] = [];
    const { store, sweep } = setup({
      submissions: [
        submission({ id: "dueTomorrow", modified_at: now - 60 * 60_000 }),
        submission({ id: "from2021", modified_at: Date.parse("2021-05-01T00:00:00.000Z") }),
        submission({ id: "from2023", modified_at: Date.parse("2023-05-01T00:00:00.000Z") }),
        submission({ id: "uploadedToday", modified_at: now - 30 * 60_000 }),
      ],
      pdf: (id) => {
        order.push(id);
        return Buffer.from(`%PDF-${id}`);
      },
    });
    store.saveOpenReviewCitationCheck({
      submission_id: "dueTomorrow",
      pdf_path: "/pdf/v1.pdf",
      title: "dueTomorrow",
      venue_id: "ICLR.cc/2027/Conference/Submission",
      status: "failed",
      error: "About 9 of 37 references could not be checked.",
      checked_at: "2026-09-25T20:00:00.000Z",
      attempts: 2,
      extractor_version: CITATION_EXTRACTOR_VERSION,
    });
    vi.useFakeTimers({ now, toFake: ["Date"] });
    try {
      await sweep();
    } finally {
      vi.useRealTimers();
    }
    expect(order).toEqual(["uploadedToday", "dueTomorrow", "from2023", "from2021"]);
  });

  // Unanswered lookups are the databases' fault; a broken download or checker error is not.
  it("gives a partial check more retries than a hard failure", async () => {
    const unavailable = { ...notFound, status: "unavailable" as const };
    const { store, check, sweep } = setup({
      submissions: [submission()],
      pdf: () => Buffer.from("%PDF-same-bytes"),
      check: async () => ({ findings: [matched, unavailable, unavailable] }),
    });
    for (let i = 0; i < MAX_PARTIAL_CHECK_ATTEMPTS + 3; i++) {
      await sweep();
    }
    expect(MAX_PARTIAL_CHECK_ATTEMPTS).toBeGreaterThan(MAX_CITATION_CHECK_ATTEMPTS);
    // The first try settled a reference, which is progress and costs no retry; every try after
    // it settled nothing new.
    expect(check).toHaveBeenCalledTimes(MAX_PARTIAL_CHECK_ATTEMPTS + 1);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "failed",
      attempts: MAX_PARTIAL_CHECK_ATTEMPTS,
    });
  });

  // DBLP walling off API clients left every paper with the same references unanswered, and each
  // retry started the bibliography over. A retry now asks only about what is still open.
  it("resumes a partial check, looking up only the references still open", async () => {
    const citations = ["Ref one.", "Ref two.", "Ref three.", "Ref four."];
    // Each try, the databases answer for two more references than before.
    let answerable = 2;
    const looked: string[][] = [];
    const { store, check, sweep } = setup({
      submissions: [submission()],
      pdf: () => Buffer.from("%PDF-same-bytes"),
      check: async (_pdf, _signal, onProgress, options) => {
        const asked: string[] = [];
        const findings = citations.map((citation, index): ReferenceFinding => {
          const known = options?.known?.get(citation);
          if (known) {
            return known;
          }
          asked.push(citation);
          return index < answerable
            ? { citation, status: "matched", explanation: "A matching record was found." }
            : { citation, status: "unavailable", explanation: "Not fully checked." };
        });
        looked.push(asked);
        findings.forEach((finding, index) =>
          onProgress?.({ completed: index + 1, total: findings.length, finding }),
        );
        answerable += 2;
        return { findings };
      },
    });

    await sweep();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "failed",
      error: "About 2 of 4 references could not be checked.",
      // Progress was made, so no retry was spent.
      attempts: 0,
    });
    await sweep();
    expect(check).toHaveBeenCalledTimes(2);
    expect(looked).toEqual([citations, ["Ref three.", "Ref four."]]);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "completed",
    });
  });

  it("keeps what a check cut short by the time limit had settled", async () => {
    let tries = 0;
    const seen: Array<string[]> = [];
    const { store, sweep } = setup({
      submissions: [submission()],
      pdf: () => Buffer.from("%PDF-same-bytes"),
      checkTimeoutMs: 20,
      check: async (_pdf, signal, onProgress, options) => {
        seen.push([...(options?.known?.keys() ?? [])]);
        if (tries++ === 0) {
          onProgress?.({ completed: 1, total: 2, finding: matched });
          onProgress?.({
            completed: 2,
            total: 2,
            finding: { ...notFound, status: "unavailable" },
          });
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          );
        }
        return { findings: [matched, notFound] };
      },
    });
    await sweep();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "failed",
      error: "The check did not finish in time.",
      // Only what was settled is kept; the next try starts from it without spending a retry.
      findings: [matched],
      attempts: 0,
    });
    await sweep();
    expect(seen[1]).toEqual([matched.citation]);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")?.status).toBe("completed");
  });

  it("reuses another paper's matched reference, never its not-found", async () => {
    let current = [submission()];
    const knownSeen: Array<string[]> = [];
    const { sweep } = setup({
      submissions: () => current,
      check: async (_pdf, _signal, _progress, options) => {
        knownSeen.push([...(options?.known?.keys() ?? [])]);
        return { findings: [matched, notFound] };
      },
    });
    await sweep();
    current = [submission({ id: "paperBBBB", pdf_path: "/pdf/other.pdf", modified_at: 2 })];
    await sweep();
    expect(knownSeen).toEqual([[], [matched.citation]]);
  });

  // Evaluation Awareness had spent all three tries on unanswered lookups; it is owed more.
  it("picks a partial check back up that had used up the old limit", async () => {
    const { store, check, sweep } = setup({ submissions: [submission()] });
    store.saveOpenReviewCitationCheck({
      submission_id: "paperAAAA",
      pdf_path: "/pdf/v1.pdf",
      title: "Synthetic paper",
      venue_id: "Synthetic.cc/2027/Conference/Submission",
      status: "failed",
      error: "About 16 of 58 references could not be checked.",
      checked_at: "2026-09-25T18:25:00.000Z",
      attempts: MAX_CITATION_CHECK_ATTEMPTS,
      extractor_version: CITATION_EXTRACTOR_VERSION,
    });
    await sweep();
    expect(check).toHaveBeenCalledTimes(1);
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "completed",
    });
  });

  // A 429's minute used to end the sweep, and the next paper waited for the next scheduled run.
  it("waits out a short back-off between papers instead of ending the sweep", async () => {
    const store = new AdminBotMemoryStore();
    let pausedUntil: number | undefined;
    const order: string[] = [];
    const watch = new OpenReviewCitationWatch({
      store,
      service: new AdminBotService(store),
      reader: {
        profileId: async () => "~Synthetic_Author1",
        listSubmissions: async () => [
          submission({ id: "first", modified_at: 2 }),
          submission({ id: "second", modified_at: 1 }),
        ],
        readPdf: async (id) => {
          order.push(id);
          return Buffer.from(`%PDF-${id}`);
        },
      },
      check: async () => {
        pausedUntil = Date.now() + 100;
        return { findings: [matched] };
      },
      pausedUntil: () => (pausedUntil && pausedUntil > Date.now() ? pausedUntil : undefined),
      maxPauseWaitMs: 5_000,
    });
    await watch.start();
    await watch.idle();
    expect(order).toEqual(["first", "second"]);
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

// A login problem is the account's, not any paper's. It used to be saved against each paper as
// "the PDF could not be downloaded", spending one of three retries, so an outage that lasted three
// sweeps retired every paper from checking for good -- with nothing telling anyone.
describe("OpenReview citation watch when the login fails", () => {
  const papers = ["paperAAAA", "paperBBBB", "paperCCCC"].map((id, index) =>
    submission({ id, pdf_path: `/pdf/${id}.pdf`, modified_at: index + 1 }),
  );
  const loginIssue = (service: AdminBotService) => {
    const health = service.automationHealth();
    return health.ok
      ? health.payload.issues.find((issue) => issue.key === "openreview-login")
      : undefined;
  };

  it("stops the sweep without spending any paper's retries, and resumes once OpenReview answers", async () => {
    let down = true;
    const { store, reader, watch, sweep, service } = setup({
      submissions: papers,
      pdf: (id) => {
        if (down) {
          throw new OpenReviewLoginError("OpenReview login did not succeed after 3 tries", false);
        }
        return Buffer.from(`%PDF-${id}`);
      },
    });
    for (let run = 0; run <= MAX_CITATION_CHECK_ATTEMPTS; run++) {
      await sweep();
      expect(watch.status().last_sweep).toMatchObject({
        failed: 0,
        login_error: "OpenReview login did not succeed after 3 tries",
      });
    }
    // One try per sweep, then the sweep stopped instead of failing the other papers too.
    expect(reader.readPdf).toHaveBeenCalledTimes(MAX_CITATION_CHECK_ATTEMPTS + 1);
    expect(store.listOpenReviewCitationChecks()).toEqual([]);
    // An outage is not reported as bad credentials.
    expect(loginIssue(service)).toBeUndefined();

    down = false;
    expect(await sweep()).toMatchObject({ pending: 3 });
    expect(store.listOpenReviewCitationChecks().map((check) => check.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("tells admins when OpenReview refuses the password, and clears that once it works", async () => {
    const { reader, watch, sweep, service } = setup({ submissions: papers });
    reader.listSubmissions.mockRejectedValueOnce(
      new OpenReviewLoginError("OpenReview rejected the login (403)", true, 403),
    );
    await expect(watch.start()).rejects.toThrow("OpenReview rejected the login");
    expect(loginIssue(service)).toMatchObject({
      kind: "credentials",
      label: "OpenReview is refusing the lab's login",
    });
    expect(loginIssue(service)?.detail).toContain("OPENREVIEW_USERNAME / OPENREVIEW_PASSWORD");

    // Fixed: the next run lists, checks every paper, and the alert goes away on its own.
    await sweep();
    expect(loginIssue(service)).toBeUndefined();
    expect(watch.status().last_sweep).toMatchObject({ checked: 3 });
  });

  it("flags a refusal that arrives mid-sweep, when the token is renewed", async () => {
    const { store, sweep, service, watch } = setup({
      submissions: papers,
      pdf: () => {
        throw new OpenReviewLoginError("OpenReview rejected the login (401)", true, 401);
      },
    });
    await sweep();
    expect(watch.status().last_sweep?.login_error).toContain("rejected the login");
    expect(store.listOpenReviewCitationChecks()).toEqual([]);
    expect(loginIssue(service)).toMatchObject({ kind: "credentials" });
  });

  it("records a refusal once, not once per run", async () => {
    const { reader, watch, store } = setup({ submissions: papers });
    const refused = new OpenReviewLoginError("OpenReview rejected the login (403)", true, 403);
    reader.listSubmissions.mockRejectedValue(refused);
    for (let run = 0; run < 3; run++) {
      await expect(watch.start()).rejects.toBe(refused);
    }
    expect(
      store.listAuditEvents().filter((event) => event.type.startsWith("openreview.login")),
    ).toHaveLength(1);
  });

  it("keeps checking the other papers when one paper's PDF is refused", async () => {
    const { store, sweep, service, watch } = setup({
      submissions: papers,
      pdf: (id) => {
        if (id === "paperBBBB") {
          // What the reader returns when a fresh login still cannot read this one PDF.
          throw new Error("OpenReview returned 403 for the PDF");
        }
        return Buffer.from(`%PDF-${id}`);
      },
    });
    await sweep();
    expect(watch.status().last_sweep).toMatchObject({ checked: 2, failed: 1 });
    expect(watch.status().last_sweep?.login_error).toBeUndefined();
    expect(store.getOpenReviewCitationCheck("paperAAAA", "/pdf/paperAAAA.pdf")?.status).toBe(
      "completed",
    );
    expect(store.getOpenReviewCitationCheck("paperBBBB", "/pdf/paperBBBB.pdf")).toMatchObject({
      status: "failed",
      attempts: 1,
    });
    expect(store.getOpenReviewCitationCheck("paperCCCC", "/pdf/paperCCCC.pdf")?.status).toBe(
      "completed",
    );
    expect(loginIssue(service)).toBeUndefined();
  });
});
