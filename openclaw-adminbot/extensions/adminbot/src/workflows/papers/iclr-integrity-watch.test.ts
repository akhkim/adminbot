import { describe, expect, it, vi } from "vitest";
import { PangramError } from "../../connectors/pangram.js";
import { NO_TEXT_LAYER, ReferenceCheckError } from "../../connectors/reference-check.js";
import type { AdminBotStoredProposal } from "../../contracts/actions.js";
import type {
  OpenReviewSubmission,
  OpenReviewSubmissionReader,
} from "../../contracts/openreview-citation-checks.js";
import type { AiTextScorer } from "../../contracts/paper-integrity-checks.js";
import { AdminBotService } from "../../kernel/service.js";
import { AdminBotMemoryStore } from "../../persistence/memory.js";
import {
  IclrIntegrityWatch,
  MAX_AI_CHECK_ATTEMPTS,
  normalizeAuthorId,
} from "./iclr-integrity-watch.js";

const ICLR = "ICLR.cc/2027/Conference/Submission";
const LONG_TEXT = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function submission(overrides: Partial<OpenReviewSubmission> = {}): OpenReviewSubmission {
  return {
    id: "paperAAAA",
    title: "Synthetic paper",
    venue_id: ICLR,
    pdf_path: "/pdf/v1.pdf",
    modified_at: 1,
    author_ids: ["~External_Person1", "~Ada_Lovelace1", "~Alan_Turing1", "~Grace_Hopper1"],
    ...overrides,
  };
}

function setup(options: {
  submissions: OpenReviewSubmission[] | (() => OpenReviewSubmission[]);
  score?: AiTextScorer;
  extractText?: (pdf: Uint8Array) => Promise<string>;
  pdf?: (id: string) => Uint8Array | Promise<Uint8Array>;
  slackFails?: boolean;
}) {
  const store = new AdminBotMemoryStore();
  const sent: AdminBotStoredProposal[] = [];
  const service = new AdminBotService(store, {
    executor: {
      execute: async (proposal) => {
        if (proposal.type !== "paper_integrity.alert") {
          return { handled: false };
        }
        if (options.slackFails) {
          throw new Error("Slack DM open failed 500: internal_error");
        }
        sent.push(proposal);
        return { handled: true };
      },
    },
  });
  const member = (input: Record<string, unknown>) =>
    unwrap(service.upsertLabMember({ privilege_level: "member", ...input } as never));
  member({
    id: "zhijing",
    name: "Zhijing Jin",
    privilege_level: "admin",
    slack_user_id: "UZHIJING",
    openreview_id: "~Zhijing_Jin1",
  });
  member({
    id: "ada",
    name: "Ada Lovelace",
    member_type: "full",
    slack_user_id: "UADA",
    openreview_id: "~Ada_Lovelace1",
  });
  // A lab member who is neither full nor coauthor-major: skipped, not counted as one of the two.
  member({
    id: "alan",
    name: "Alan Turing",
    member_type: "external-prof",
    slack_user_id: "UALAN",
    openreview_id: "~Alan_Turing1",
  });
  member({
    id: "grace",
    name: "Grace Hopper",
    member_type: "full, coauthor-major",
    slack_user_id: "UGRACE",
    openreview_id: "~Grace_Hopper1",
  });
  unwrap(service.updateSettings({ head_professor_member_id: "zhijing" } as never));
  const list = () =>
    typeof options.submissions === "function" ? options.submissions() : options.submissions;
  const reader = {
    profileId: vi.fn(async () => "~Zhijing_Jin1"),
    listSubmissions: vi.fn(async () => list()),
    readPdf: vi.fn(
      async (id: string) => options.pdf?.(id) ?? Buffer.from(`%PDF-${id}-${Math.random()}`),
    ),
  } satisfies OpenReviewSubmissionReader;
  const score = vi.fn<AiTextScorer>(
    options.score ??
      (async () => ({ fraction_ai: 0.72, fraction_ai_assisted: 0.1, fraction_human: 0.18 })),
  );
  const extractText = vi.fn(options.extractText ?? (async () => LONG_TEXT));
  const watch = new IclrIntegrityWatch({ store, service, reader, score, extractText });
  const sweep = async () => {
    const started = await watch.start();
    await watch.idle();
    return started;
  };
  return { store, service, reader, score, extractText, watch, sweep, sent };
}

describe("ICLR integrity watch", () => {
  it("scores only ICLR papers still under review", async () => {
    const { score, sweep } = setup({
      submissions: [
        submission(),
        submission({ id: "acceptedB", venue_id: "ICLR.cc/2026/Conference" }),
        submission({ id: "rejectedC", venue_id: "ICLR.cc/2026/Conference/Rejected_Submission" }),
        submission({ id: "neuripsD", venue_id: "NeurIPS.cc/2026/Conference/Submission" }),
      ],
      score: async () => ({ fraction_ai: 0.1, fraction_ai_assisted: 0, fraction_human: 0.9 }),
    });

    expect(await sweep()).toMatchObject({ started: true, submissions: 1, pending: 1 });
    expect(score).toHaveBeenCalledTimes(1);
  });

  it("group-DMs the professor and the first two full / coauthor-major authors over 50%", async () => {
    const { store, sweep, sent } = setup({ submissions: [submission()] });

    await sweep();

    expect(sent).toHaveLength(1);
    const payload = sent[0].proposed_payload as { user_ids: string[]; message: string };
    // Ada and Grace, in author order; Alan (external-prof) and the external author are skipped.
    expect(payload.user_ids).toEqual(["UZHIJING", "UADA", "UGRACE"]);
    expect(payload.message).toContain("For Zhijing Jin, Ada Lovelace, Grace Hopper.");
    expect(payload.message).toContain("72% of the main text as AI-written");
    expect(payload.message).toContain("over the 50% alert threshold");
    expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "completed",
      fraction_ai: 0.72,
      words_scored: 400,
      alerted_for: ["ai_text"],
    });
  });

  it("stays quiet at or under the threshold", async () => {
    const { sweep, sent } = setup({
      submissions: [submission()],
      score: async () => ({ fraction_ai: 0.5, fraction_ai_assisted: 0.4, fraction_human: 0.1 }),
    });

    await sweep();

    expect(sent).toHaveLength(0);
  });

  it("scores a version once and alerts once, however many sweeps run", async () => {
    const { score, sweep, sent } = setup({ submissions: [submission()] });

    await sweep();
    await sweep();
    await sweep();

    expect(score).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("scores a new upload again and alerts about it", async () => {
    let current = [submission()];
    const { score, sweep, sent } = setup({ submissions: () => current });

    await sweep();
    current = [submission({ pdf_path: "/pdf/v2.pdf", modified_at: 2 })];
    await sweep();

    expect(score).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
  });

  it("reuses the score and the alert for identical bytes under a new path", async () => {
    let current = [submission()];
    const { score, sweep, sent } = setup({
      submissions: () => current,
      pdf: () => Buffer.from("%PDF-identical"),
    });

    await sweep();
    current = [submission({ pdf_path: "/pdf/v2.pdf", modified_at: 2 })];
    await sweep();

    expect(score).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("alerts on hallucinated citations once the citation watch has stored them", async () => {
    const { store, sweep, sent } = setup({
      submissions: [submission()],
      score: async () => ({ fraction_ai: 0.05, fraction_ai_assisted: 0, fraction_human: 0.95 }),
    });

    await sweep();
    expect(sent).toHaveLength(0);

    store.saveOpenReviewCitationCheck({
      submission_id: "paperAAAA",
      pdf_path: "/pdf/v1.pdf",
      title: "Synthetic paper",
      venue_id: ICLR,
      status: "completed",
      checked_at: "2026-09-24T00:00:00.000Z",
      attempts: 1,
      findings: [
        {
          citation: "Nobody. A paper that does not exist. 2031.",
          status: "not_found",
          explanation: "",
        },
        { citation: "Real. A real paper. 2020.", status: "matched", explanation: "" },
      ],
    });
    await sweep();
    await sweep();

    expect(sent).toHaveLength(1);
    const message = (sent[0].proposed_payload as { message: string }).message;
    expect(message).toContain("1 reference(s) matched nothing");
    expect(message).toContain("A paper that does not exist");
    expect(message).toContain("under the 50% alert threshold");
    expect(sent[0].proposed_payload).toMatchObject({
      paper_integrity: { reasons: ["citations"] },
    });
  });

  it("records a placeholder upload as unreadable and never scores it", async () => {
    const { store, score, sweep } = setup({
      submissions: [submission()],
      extractText: async () => {
        throw new ReferenceCheckError(NO_TEXT_LAYER);
      },
    });

    await sweep();

    expect(score).not.toHaveBeenCalled();
    expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "unreadable",
      error: expect.stringContaining("Placeholder PDF"),
    });
  });

  it("does not pay to score an abstract-only upload", async () => {
    const { store, score, sweep } = setup({
      submissions: [submission()],
      extractText: async () => "An abstract of a few words.",
    });

    await sweep();

    expect(score).not.toHaveBeenCalled();
    expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")?.status).toBe("unreadable");
  });

  it("retries a failed score a bounded number of times", async () => {
    const { store, score, sweep } = setup({
      submissions: [submission()],
      score: async () => {
        throw new PangramError("The Pangram account is out of credits.");
      },
    });

    for (let run = 0; run < MAX_AI_CHECK_ATTEMPTS + 2; run++) {
      await sweep();
    }

    expect(score).toHaveBeenCalledTimes(MAX_AI_CHECK_ATTEMPTS);
    expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "failed",
      attempts: MAX_AI_CHECK_ATTEMPTS,
      error: "The Pangram account is out of credits.",
    });
  });

  it("keeps an alert pending while nobody on the paper has Slack", async () => {
    const { store, service, sweep, sent } = setup({
      submissions: [submission({ author_ids: ["~External_Person1"] })],
    });
    unwrap(service.updateSettings({ head_professor_member_id: "" } as never));

    await sweep();
    expect(sent).toHaveLength(0);
    expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      alert_error: expect.stringContaining("linked Slack"),
    });

    unwrap(service.updateSettings({ head_professor_member_id: "zhijing" } as never));
    await sweep();

    expect(sent).toHaveLength(1);
    expect((sent[0].proposed_payload as { user_ids: string[] }).user_ids).toEqual(["UZHIJING"]);
    expect((sent[0].proposed_payload as { message: string }).message).toContain(
      "No full or coauthor-major lab member",
    );
  });

  it("does not resend when Slack refused the first attempt", async () => {
    const { store, sweep } = setup({ submissions: [submission()], slackFails: true });

    await sweep();
    await sweep();

    const check = store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf");
    expect(check?.alert_proposal_ids).toHaveLength(1);
    expect(check?.alert_error).toBeTruthy();
  });

  it("scores and alerts nothing once the deadline has passed", async () => {
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store);
    const reader = {
      profileId: vi.fn(async () => "~Zhijing_Jin1"),
      listSubmissions: vi.fn(async () => [submission()]),
      readPdf: vi.fn(async () => Buffer.from("%PDF-x")),
    } satisfies OpenReviewSubmissionReader;
    const score = vi.fn<AiTextScorer>();
    const watch = new IclrIntegrityWatch({
      store,
      service,
      reader,
      score,
      extractText: async () => LONG_TEXT,
      until: new Date("2026-09-26T12:00:00Z"),
      now: () => new Date("2026-09-26T12:00:00Z"),
    });

    expect(await watch.start()).toMatchObject({
      started: false,
      ended_at: "2026-09-26T12:00:00.000Z",
    });
    expect(reader.listSubmissions).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
  });

  it("stops a sweep that crosses the deadline before the next paper", async () => {
    let clock = new Date("2026-09-26T11:59:00Z");
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store);
    const reader = {
      profileId: vi.fn(async () => "~Zhijing_Jin1"),
      listSubmissions: vi.fn(async () => [
        submission({ id: "newerBBBB", modified_at: 2 }),
        submission({ id: "olderAAAA", modified_at: 1 }),
      ]),
      readPdf: vi.fn(async (id: string) => Buffer.from(`%PDF-${id}`)),
    } satisfies OpenReviewSubmissionReader;
    const score = vi.fn<AiTextScorer>(async () => {
      clock = new Date("2026-09-26T12:00:01Z");
      return { fraction_ai: 0.1, fraction_ai_assisted: 0, fraction_human: 0.9 };
    });
    const watch = new IclrIntegrityWatch({
      store,
      service,
      reader,
      score,
      extractText: async () => LONG_TEXT,
      until: new Date("2026-09-26T12:00:00Z"),
      now: () => clock,
    });

    await watch.start();
    await watch.idle();

    expect(score).toHaveBeenCalledTimes(1);
    expect(store.getPaperAiTextCheck("olderAAAA", "/pdf/v1.pdf")).toBeUndefined();
  });

  it("normalizes tilde ids, profile URLs and emails alike", () => {
    expect(normalizeAuthorId("https://openreview.net/profile?id=~Ada_Lovelace1")).toBe(
      "~ada_lovelace1",
    );
    expect(normalizeAuthorId(" ~Ada_Lovelace1 ")).toBe("~ada_lovelace1");
    expect(normalizeAuthorId("Ada@CS.Toronto.edu")).toBe("ada@cs.toronto.edu");
    expect(normalizeAuthorId("  ")).toBeUndefined();
  });
});
