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
  reportTo?: string[];
  citationReportTo?: string[];
  sheetGrid?: string[][];
  reportChannel?: { saved: string[]; initial?: string };
}) {
  const store = new AdminBotMemoryStore();
  const sent: AdminBotStoredProposal[] = [];
  const reports: AdminBotStoredProposal[] = [];
  const sheetWrites: AdminBotStoredProposal[] = [];
  const service = new AdminBotService(store, {
    executor: {
      execute: async (proposal) => {
        if (proposal.type === "paper_integrity.sheet_scores") {
          sheetWrites.push(proposal);
          return { handled: true };
        }
        if (proposal.type === "paper_integrity.report") {
          if (options.slackFails) {
            throw new Error("Slack DM open failed 500: internal_error");
          }
          reports.push(proposal);
          const payload = proposal.proposed_payload as { channel_id?: string; update_ts?: string };
          return payload.channel_id
            ? {
                handled: true,
                artifacts: { slack_ts: payload.update_ts ?? "1758841200.000100" },
              }
            : { handled: true };
        }
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
  const watch = new IclrIntegrityWatch({
    store,
    service,
    reader,
    score,
    extractText,
    ...(options.reportTo ? { reportTo: options.reportTo } : {}),
    ...(options.citationReportTo ? { citationReportTo: options.citationReportTo } : {}),
    ...(options.reportChannel
      ? {
          reportChannel: {
            channelId: "C0ACTIVE1",
            message: {
              load: () => options.reportChannel!.saved.at(-1) ?? options.reportChannel!.initial,
              save: (ts: string) => {
                options.reportChannel!.saved.push(ts);
              },
            },
          },
        }
      : {}),
    ...(options.sheetGrid
      ? {
          sheet: {
            spreadsheetId: "sheet-1",
            tab: "Papers-iclr-feedback",
            read: async () => options.sheetGrid as string[][],
          },
        }
      : {}),
  });
  const sweep = async () => {
    const started = await watch.start();
    await watch.idle();
    return started;
  };
  return { store, service, reader, score, extractText, watch, sweep, sent, reports, sheetWrites };
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
    // Scored from the whole PDF, and the message says so rather than "before the references".
    expect(payload.message).toContain("72% of the paper as AI-written");
    expect(payload.message).toContain("the whole paper");
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

  // The website scored a paper 82% with Pangram 4 on the whole document; the watch now sends that
  // same text (never the PDF) and records which model scored it.
  it("sends the whole document's text and records the model that scored it", async () => {
    const { store, score, sweep } = setup({
      submissions: [submission()],
      score: async () => ({
        fraction_ai: 0.82,
        fraction_ai_assisted: 0,
        fraction_human: 0.18,
        model_version: "4.0",
      }),
    });

    await sweep();

    expect(score.mock.calls[0]?.[0]).toBe(LONG_TEXT);
    expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "completed",
      scored_from: "full_text",
      model_version: "4.0",
      words_scored: 400,
    });
  });

  // A response without a version must not leave the score looking outdated, or the paper would be
  // re-scored, and billed, every hour.
  it("does not re-score a Pangram 4 result that came back without a version", async () => {
    const { score, sweep } = setup({
      submissions: [submission()],
      score: async () => ({ fraction_ai: 0.1, fraction_ai_assisted: 0, fraction_human: 0.9 }),
    });
    await sweep();
    await sweep();
    expect(score).toHaveBeenCalledTimes(1);
  });

  it("still skips a placeholder without paying to score it", async () => {
    const { store, score, sweep } = setup({
      submissions: [submission()],
      extractText: async () => {
        throw new ReferenceCheckError(NO_TEXT_LAYER);
      },
    });
    await sweep();
    expect(score).not.toHaveBeenCalled();
    expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")?.status).toBe("unreadable");
  });

  describe("the hourly digest", () => {
    it("DMs the configured operators after every sweep, with each paper's scores", async () => {
      const { sweep, reports, watch } = setup({
        submissions: [
          submission(),
          submission({ id: "paperBBBB", title: "Second synthetic paper", modified_at: 2 }),
        ],
        score: async () => ({
          fraction_ai: 0.105,
          fraction_ai_assisted: 0.013,
          fraction_human: 0.882,
          model_version: "4.0",
        }),
        reportTo: ["UOPERATOR1"],
      });

      await sweep();
      // A second hour with nothing new still reports: that is when "still fine" is the news.
      await sweep();

      expect(reports).toHaveLength(2);
      const [first] = reports;
      expect(first.status).toBe("executed");
      expect(first.proposed_payload).toMatchObject({ user_ids: ["UOPERATOR1"] });
      const message = (first.proposed_payload as { message: string }).message;
      expect(message).toContain("Second synthetic paper");
      expect(message).toContain("Synthetic paper");
      expect(message).toContain("11% AI, 1% AI-assisted (400 words, whole paper, Pangram 4.0)");
      expect(message).toContain("Citations: not checked yet");
      expect(watch.status().last_sweep?.report_error).toBeUndefined();
    });

    // One message in the lab channel, edited every hour, rather than a new post per sweep.
    it("posts to the channel once and edits that message on every later sweep", async () => {
      const saved: string[] = [];
      const { sweep, reports } = setup({
        submissions: [submission()],
        score: async () => ({ fraction_ai: 0.1, fraction_ai_assisted: 0, fraction_human: 0.9 }),
        reportChannel: { saved },
      });

      await sweep();
      await sweep();

      expect(reports).toHaveLength(2);
      expect(reports[0].proposed_payload).toMatchObject({ channel_id: "C0ACTIVE1" });
      expect(reports[0].proposed_payload).not.toHaveProperty("update_ts");
      expect(reports[1].proposed_payload).toMatchObject({
        channel_id: "C0ACTIVE1",
        update_ts: "1758841200.000100",
      });
      expect(saved).toEqual(["1758841200.000100", "1758841200.000100"]);
    });

    it("edits the message a previous process posted", async () => {
      const { sweep, reports } = setup({
        submissions: [submission()],
        reportChannel: { saved: [], initial: "1758800000.000001" },
      });
      await sweep();
      expect(reports[0].proposed_payload).toMatchObject({ update_ts: "1758800000.000001" });
    });

    it("sends nothing when no operator is configured", async () => {
      const { sweep, reports } = setup({ submissions: [submission()] });
      await sweep();
      expect(reports).toHaveLength(0);
    });

    // A digest that cannot be sent is noted on the sweep, and the scoring it reports on stands.
    it("records a failed send without failing the sweep", async () => {
      const { store, sweep, watch } = setup({
        submissions: [submission()],
        score: async () => ({ fraction_ai: 0.1, fraction_ai_assisted: 0, fraction_human: 0.9 }),
        reportTo: ["UOPERATOR1"],
        slackFails: true,
      });
      await sweep();
      expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")?.status).toBe("completed");
      expect(watch.status().last_sweep?.report_error).toMatch(/Slack DM open failed/u);
    });
  });

  describe("a version scored by an earlier pipeline", () => {
    const textEra = {
      submission_id: "paperAAAA",
      pdf_path: "/pdf/v1.pdf",
      pdf_sha256: "0".repeat(64),
      title: "Synthetic paper",
      venue_id: ICLR,
      status: "completed" as const,
      checked_at: "2026-09-25T04:38:00.000Z",
      attempts: 1,
      fraction_ai: 0.72,
      fraction_ai_assisted: 0.1,
      fraction_human: 0.18,
      words_scored: 6_324,
      alerted_for: ["ai_text" as const],
      alert_proposal_ids: ["proposal-1"],
    };

    it("is scored again from the whole text, once", async () => {
      const { store, score, sweep } = setup({
        submissions: [submission()],
        score: async () => ({ fraction_ai: 0.1, fraction_ai_assisted: 0, fraction_human: 0.9 }),
      });
      store.savePaperAiTextCheck(textEra);

      await sweep();
      await sweep();

      expect(score).toHaveBeenCalledTimes(1);
      expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
        scored_from: "full_text",
        fraction_ai: 0.1,
      });
    });

    // The file endpoint's scores: whole PDF, but Pangram 3.3.2, which read 0% where the website
    // read 82%. Re-scored like the main-text ones.
    it("re-scores a Pangram 3.3.2 file score too", async () => {
      const { store, score, sweep } = setup({ submissions: [submission()] });
      store.savePaperAiTextCheck({ ...textEra, scored_from: "pdf", alerted_for: [] });

      await sweep();

      expect(score).toHaveBeenCalledTimes(1);
      expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")?.scored_from).toBe("full_text");
    });

    // Same version, same PDF: the Slack alert it already raised is not raised a second time.
    it("keeps the alerts it already raised", async () => {
      const { store, sweep, sent } = setup({ submissions: [submission()] });
      store.savePaperAiTextCheck(textEra);

      await sweep();

      expect(sent).toHaveLength(0);
      expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
        scored_from: "full_text",
        alerted_for: ["ai_text"],
        alert_proposal_ids: ["proposal-1"],
      });
    });

    it("keeps its old score when the re-score fails", async () => {
      const { store, sweep } = setup({
        submissions: [submission()],
        score: async () => {
          throw new PangramError("The Pangram account is out of credits.");
        },
      });
      store.savePaperAiTextCheck(textEra);

      await sweep();

      expect(store.getPaperAiTextCheck("paperAAAA", "/pdf/v1.pdf")).toMatchObject({
        status: "completed",
        fraction_ai: 0.72,
      });
    });

    it("is not reused for identical bytes under a new path", async () => {
      const bytes = Buffer.from("%PDF-identical");
      const { createHash } = await import("node:crypto");
      const { store, score, sweep } = setup({
        submissions: [submission({ pdf_path: "/pdf/v2.pdf", modified_at: 2 })],
        pdf: () => bytes,
      });
      store.savePaperAiTextCheck({
        ...textEra,
        pdf_sha256: createHash("sha256").update(bytes).digest("hex"),
      });

      await sweep();

      expect(score).toHaveBeenCalledTimes(1);
    });
  });

  describe("confirmed hallucinated citations", () => {
    const citationCheck = (overrides: Record<string, unknown> = {}) => ({
      submission_id: "paperAAAA",
      pdf_path: "/pdf/v1.pdf",
      title: "Synthetic paper",
      venue_id: ICLR,
      status: "completed" as const,
      checked_at: "2026-09-25T00:00:00.000Z",
      attempts: 1,
      findings: [
        {
          citation: "Nobody. A paper that does not exist. 2031.",
          status: "not_found" as const,
          explanation: "",
        },
        { citation: "Real. A real paper. 2020.", status: "matched" as const, explanation: "" },
      ],
      ...overrides,
    });

    it("DMs the exact reference to the configured operator, once per version", async () => {
      const { store, sweep, reports } = setup({
        submissions: [submission()],
        score: async () => ({ fraction_ai: 0.05, fraction_ai_assisted: 0, fraction_human: 0.95 }),
        citationReportTo: ["UCITATIONS1"],
      });
      store.saveOpenReviewCitationCheck(citationCheck());

      await sweep();
      await sweep();

      expect(reports).toHaveLength(1);
      expect(reports[0].proposed_payload).toMatchObject({ user_ids: ["UCITATIONS1"] });
      const message = (reports[0].proposed_payload as { message: string }).message;
      expect(message).toContain("Confirmed hallucinated citation");
      expect(message).toContain("• Nobody. A paper that does not exist. 2031.");
      expect(message).not.toContain("A real paper");
    });

    // The whole point of "confirmed": a check that could not reach the databases, or a reference
    // they could not be asked about, is not evidence that anything is fabricated.
    it("sends nothing when the check failed or only could not reach a database", async () => {
      for (const check of [
        citationCheck({
          status: "failed",
          error: "About 18 of 47 references could not be checked.",
        }),
        citationCheck({
          findings: [
            { citation: "Unasked. 2024.", status: "unavailable", explanation: "" },
            { citation: "Close call. 2023.", status: "review", explanation: "" },
          ],
        }),
      ]) {
        const { store, sweep, reports } = setup({
          submissions: [submission()],
          score: async () => ({ fraction_ai: 0.05, fraction_ai_assisted: 0, fraction_human: 0.95 }),
          citationReportTo: ["UCITATIONS1"],
        });
        store.saveOpenReviewCitationCheck(check);
        await sweep();
        expect(reports).toHaveLength(0);
      }
    });
  });

  describe("the lab sheet", () => {
    const grid = [
      ["Title", "Venue", "Authors", "D", "E", "F", "G", "Pangram Score"],
      ["Synthetic paper", "", "Ada Lovelace, Grace Hopper"],
      ["An unrelated paper", "", "Someone Else"],
    ];

    it("writes the score to H and a confirmed reference to I, in the matched row", async () => {
      const { store, sweep, sheetWrites, watch } = setup({
        submissions: [submission()],
        score: async () => ({
          fraction_ai: 0.82,
          fraction_ai_assisted: 0,
          fraction_human: 0.18,
          model_version: "4.0",
        }),
        sheetGrid: grid,
      });
      store.saveOpenReviewCitationCheck({
        submission_id: "paperAAAA",
        pdf_path: "/pdf/v1.pdf",
        title: "Synthetic paper",
        venue_id: ICLR,
        status: "completed",
        checked_at: "2026-09-25T00:00:00.000Z",
        attempts: 1,
        findings: [{ citation: "Nobody. 2031.", status: "not_found", explanation: "" }],
      });

      await sweep();

      expect(sheetWrites).toHaveLength(1);
      expect(sheetWrites[0].status).toBe("executed");
      expect(sheetWrites[0].proposed_payload).toMatchObject({
        spreadsheet_id: "sheet-1",
        columns: ["H", "I"],
        updates: [
          {
            range: "'Papers-iclr-feedback'!H2",
            values: [["82% AI, 0% AI-assisted (Pangram 4.0)"]],
          },
          { range: "'Papers-iclr-feedback'!I2", values: [["Nobody. 2031."]] },
        ],
      });
      expect(watch.status().last_sweep).toMatchObject({ sheet_updated: 2, sheet_unmatched: [] });
    });

    it("writes nothing when the cells already say it", async () => {
      const { sweep, sheetWrites } = setup({
        submissions: [submission()],
        score: async () => ({
          fraction_ai: 0.82,
          fraction_ai_assisted: 0,
          fraction_human: 0.18,
          model_version: "4.0",
        }),
        sheetGrid: [
          grid[0],
          [...grid[1], "", "", "", "", "82% AI, 0% AI-assisted (Pangram 4.0)"],
          grid[2],
        ],
      });
      await sweep();
      expect(sheetWrites).toHaveLength(0);
    });

    it("names a submission no row matches instead of guessing", async () => {
      const { sweep, sheetWrites, watch } = setup({
        submissions: [
          submission({
            title: "A title the sheet never had",
            author_ids: ["~Nobody_Listed1", "~Also_Absent1"],
          }),
        ],
        sheetGrid: grid,
      });
      await sweep();
      expect(sheetWrites).toHaveLength(0);
      expect(watch.status().last_sweep?.sheet_unmatched).toEqual(["A title the sheet never had"]);
    });
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
