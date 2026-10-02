// The ingest end to end: which paper a review lands on, what it ticks, and what it refuses.
import { describe, expect, it } from "vitest";
import { ADMINBOT_LAB_OVERLEAF_HOST } from "../contracts/overleaf.js";
import type { AdminBotPaperMentorRunInput } from "../contracts/papermentor.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const PROJECT = "65f2a1c9d4e3b7a801f6";
const PROJECT_URL = `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/${PROJECT}`;

const RUN: AdminBotPaperMentorRunInput = {
  project_id: PROJECT,
  reviewed_at: "2026-09-12T11:04:09.221Z",
  model: "gpt-5.2-chat-latest",
  paper_type: "method_improvement",
  comments_total: 3,
  by_severity: { critical: 1, warning: 1, suggestion: 1 },
  by_category: { abstract: 1, results: 1, related_work: 1 },
  by_document: [{ path: "main.tex", comments: 2 }],
  failed_agents: ["figures"],
};

function lab(options: { link?: "slot" | "artifact" | "none" } = {}) {
  const service = new AdminBotService();
  unwrap(service.upsertLabMember({ id: "ada", name: "Ada Lovelace", privilege_level: "member" }));
  unwrap(service.upsertLabMember({ id: "zhijing", name: "Zhijing Jin", privilege_level: "admin" }));
  const link = options.link ?? "slot";
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: "Causal Garden Planning",
      authors: ["Ada Lovelace"],
      current_step: "overleaf_writing",
      ...(link === "artifact" ? { artifacts: { overleaf_edit_url: PROJECT_URL } } : {}),
    }),
  );
  if (link === "slot") {
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "overleaf_edit",
        input: { url: PROJECT_URL },
        memberId: "zhijing",
        privileged: true,
      }),
    );
  }
  return service;
}

const slotStatus = (service: AdminBotService, slot: string) =>
  unwrap(service.listPaperSlots("p1")).slots.find((row) => row.slot === slot)?.status;

describe("recordPaperMentorRun", () => {
  it("lands the review on the paper carrying that Overleaf project, and ticks the review slot", () => {
    const service = lab();

    const result = unwrap(service.recordPaperMentorRun("cron", RUN));

    expect(result).toMatchObject({ paper_id: "p1", recorded: true, review_slot: "provided" });
    expect(slotStatus(service, "papermentor_review")).toBe("provided");
    const [stored] = unwrap(service.listPaperMentorRuns("p1")).runs;
    expect(stored).toMatchObject({
      paper_id: "p1",
      project_id: PROJECT,
      comments_total: 3,
      by_severity: { critical: 1 },
      failed_agents: ["figures"],
    });
  });

  it("dates the slot from the review, not from the moment the collector spoke", () => {
    const service = lab();
    unwrap(service.recordPaperMentorRun("cron", RUN, { nowIso: "2026-09-13T06:00:00.000Z" }));

    const slot = unwrap(service.listPaperSlots("p1")).slots.find(
      (row) => row.slot === "papermentor_review",
    );
    expect(slot?.provided_at).toBe(RUN.reviewed_at);
    // Nobody ticked this box, so nobody is credited with having ticked it.
    expect(slot?.provided_by_member_id).toBeUndefined();
  });

  it("also finds the paper by the older artifact link", () => {
    const service = lab({ link: "artifact" });
    expect(unwrap(service.recordPaperMentorRun("cron", RUN)).paper_id).toBe("p1");
  });

  it("records one run once, however often the collector re-reads the same file", () => {
    const service = lab();
    unwrap(service.recordPaperMentorRun("cron", RUN));

    const again = unwrap(service.recordPaperMentorRun("cron", RUN));

    expect(again.recorded).toBe(false);
    expect(unwrap(service.listPaperMentorRuns("p1")).runs).toHaveLength(1);
  });

  it("keeps each review of the same paper, newest first", () => {
    const service = lab();
    unwrap(service.recordPaperMentorRun("cron", RUN));
    unwrap(
      service.recordPaperMentorRun("cron", {
        ...RUN,
        reviewed_at: "2026-09-20T09:00:00.000Z",
        comments_total: 1,
      }),
    );

    const { runs } = unwrap(service.listPaperMentorRuns("p1"));
    expect(runs.map((run) => run.reviewed_at)).toEqual([
      "2026-09-20T09:00:00.000Z",
      "2026-09-12T11:04:09.221Z",
    ]);
  });

  it("refuses a review of a project no paper claims, rather than filing an orphan", () => {
    const service = lab({ link: "none" });

    const result = service.recordPaperMentorRun("cron", RUN);

    expect(result.ok).toBe(false);
    expect(unwrap(service.listPaperMentorRuns()).runs).toEqual([]);
  });

  it("does not match a project id that merely looks similar", () => {
    const service = lab();

    expect(service.recordPaperMentorRun("cron", { ...RUN, project_id: `${PROJECT}f` }).ok).toBe(
      false,
    );
  });

  // A waiver is an admin's decision that this paper does not need the review. A review arriving
  // afterwards is still recorded -- it is evidence -- but it does not quietly reopen the override.
  it("leaves a waived slot waived, and still records the run", () => {
    const service = lab();
    unwrap(
      service.waivePaperSlot({
        paperId: "p1",
        slot: "papermentor_review",
        reason: "Workshop paper, reviewed by the organisers",
        memberId: "zhijing",
      }),
    );

    const result = unwrap(service.recordPaperMentorRun("cron", RUN));

    expect(result.review_slot).toBe("waived");
    expect(slotStatus(service, "papermentor_review")).toBe("waived");
    expect(unwrap(service.listPaperMentorRuns("p1")).runs).toHaveLength(1);
  });
});

describe("what the nudge says about PaperMentor", () => {
  /** The message the first author would receive, from the same walk the send uses. */
  function preview(service: AdminBotService, nowIso?: string): string {
    const { batches } = unwrap(service.collectPaperNudgeBatches(nowIso));
    return batches.find((batch) => batch.member_id === "ada")?.message ?? "";
  }

  function chaseable(options: { link?: "lab" | "com" } = {}) {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        id: "ada",
        name: "Ada Lovelace",
        privilege_level: "member",
        slack_user_id: "U-ADA",
      } as never),
    );
    unwrap(
      service.upsertPaper({
        id: "p1",
        title: "Causal Garden Planning",
        authors: ["Ada Lovelace"],
        current_step: "overleaf_writing",
        first_author_member_id: "ada",
        venue: "ICLR 2027",
        deadline: "2099-01-01",
      }),
    );
    // Everything upstream of the review is done, so the review is the step in front of them.
    for (const [slot, url] of [
      ["project_folder", "https://docs.google.com/document/d/xyz"],
      [
        "overleaf_edit",
        options.link === "com"
          ? "https://www.overleaf.com/project/65f2a1c9d4e3b7a801f6"
          : PROJECT_URL,
      ],
    ] as const) {
      unwrap(
        service.setPaperSlot({
          paperId: "p1",
          slot,
          input: { url },
          memberId: "ada",
          privileged: true,
        }),
      );
    }
    return service;
  }

  it("tells an author whose draft is on overleaf.com that it has to move first", () => {
    const message = preview(chaseable({ link: "com" }));

    expect(message).toContain("PaperMentor review done");
    expect(message).toContain("www.overleaf.com");
    expect(message).toContain(`move the project to ${ADMINBOT_LAB_OVERLEAF_HOST}`);
  });

  it("points an author with no review at the panel that runs one", () => {
    expect(preview(chaseable())).toContain("AI Tutor panel");
  });

  it("stops asking for the review once one has been ingested", () => {
    const service = chaseable();
    unwrap(service.recordPaperMentorRun("cron", RUN, { nowIso: "2026-09-13T09:00:00.000Z" }));

    const message = preview(service, "2026-09-13T09:00:00.000Z");
    expect(message).not.toContain("PaperMentor review done");
  });

  it("asks for the fixes with the counts the reviewer actually produced", () => {
    const service = chaseable();
    unwrap(service.recordPaperMentorRun("cron", RUN, { nowIso: "2026-09-13T09:00:00.000Z" }));

    const message = preview(service, "2026-09-13T09:00:00.000Z");
    expect(message).toContain("Review fixes merged");
    expect(message).toContain("PaperMentor left 3 comments");
    expect(message).toContain("1 critical");
    // The comments themselves are in the author's project, not in the lab's Slack.
    expect(message).not.toContain("main.tex");
  });

  it("asks for the review again once it is older than the freshness window", () => {
    const service = chaseable();
    unwrap(service.recordPaperMentorRun("cron", RUN));

    // Six weeks on, with the draft still unsubmitted: the review is about a paper that has moved.
    const message = preview(service, "2026-10-24T09:00:00.000Z");
    expect(message).toContain("PaperMentor review done");
    expect(message).toContain("the last review was 42 days ago");
  });

  it("does not ask a submitted paper to be reviewed again", () => {
    const service = chaseable();
    unwrap(service.recordPaperMentorRun("cron", RUN));
    for (const slot of ["fixes_merged", "pdf_ready"] as const) {
      unwrap(
        service.setPaperSlot({
          paperId: "p1",
          slot,
          input: { done: true },
          memberId: "ada",
          privileged: true,
        }),
      );
    }
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "submission",
        input: { url: "https://openreview.net/forum?id=abc" },
        memberId: "ada",
        privileged: true,
      }),
    );

    const message = preview(service, "2026-10-24T09:00:00.000Z");
    expect(message).not.toContain("PaperMentor review done");
  });
});
