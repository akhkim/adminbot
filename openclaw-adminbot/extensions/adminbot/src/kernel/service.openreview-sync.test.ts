// Papers following the PI's OpenReview: what the sync writes, what it leaves to people, and what
// it stops chasing once OpenReview shows the paper submitted.
import { describe, expect, it } from "vitest";
import { ADMINBOT_LAB_OVERLEAF_HOST } from "../contracts/overleaf.js";
import type { OpenReviewEvidence } from "../workflows/papers/openreview-paper-sync.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const NOW = "2026-10-24T08:55:00.000Z";

function lab() {
  const service = new AdminBotService();
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      privilege_level: "member",
    } as never),
  );
  unwrap(
    service.upsertLabMember({
      id: "zhijing",
      name: "Zhijing Jin",
      privilege_level: "admin",
    } as never),
  );
  unwrap(service.updateSettings({ head_professor_member_id: "zhijing" } as never));
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: "Causal Garden Planning",
      authors: ["Ada Lovelace"],
      current_step: "submission",
      first_author_member_id: "ada",
      venue: "ARR October 2026",
    }),
  );
  return service;
}

const submitted: OpenReviewEvidence = {
  source: "author_results",
  status: "under_review",
  title: "Causal Garden Planning",
  submission_id: "Abc123xyz",
  forums: ["Abc123xyz"],
  venue_id: "aclweb.org/ACL/ARR/2026/October",
  observed_at: "2026-10-10T12:00:00+00:00",
  reference: "n1",
};

const accepted: OpenReviewEvidence = {
  ...submitted,
  source: "author_results",
  status: "accepted",
  venue_id: "EMNLP/2026/Conference",
  track: "findings",
  presentation: "poster",
  observed_at: "2026-10-24T07:35:00+00:00",
  reference: "Abc123xyz",
};

/** The writing steps done, so the walk has reached the submission. */
function writeUp(service: AdminBotService) {
  const links: Record<string, string | undefined> = {
    project_folder: "https://docs.google.com/document/d/brainstorm",
    overleaf_share: `https://${ADMINBOT_LAB_OVERLEAF_HOST}/1234567890abcdefghijkl`,
    papermentor_review: undefined,
    fixes_merged: undefined,
    pdf_ready: undefined,
  };
  for (const [slot, url] of Object.entries(links)) {
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: slot as never,
        input: url ? { url } : { done: true },
        memberId: "ada",
        privileged: true,
      }),
    );
  }
}

const paperOf = (service: AdminBotService) =>
  unwrap(service.listPapers()).papers.find((paper) => paper.id === "p1");
const slotOf = (service: AdminBotService, slot: string) =>
  unwrap(service.listPaperSlots("p1", { isAdmin: true })).slots.find((row) => row.slot === slot);
const missingSlots = (service: AdminBotService) =>
  unwrap(service.listPaperSlotOverview(NOW)).papers.find((row) => row.paper_id === "p1")
    ?.missing_slots ?? [];
const syncAudits = (service: AdminBotService) =>
  service.listAuditEvents().filter((event) => event.type === "paper.openreview_synced");

describe("syncing papers from OpenReview", () => {
  it("reports in a dry run and writes nothing", () => {
    const service = lab();
    const report = unwrap(
      service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: true, nowIso: NOW }),
    );
    expect(report).toMatchObject({ dry_run: true, matched: 1, unchanged: 0 });
    expect(report.applied[0]).toMatchObject({
      paper_id: "p1",
      status: "accepted",
      slots: ["submission", "submission_id"],
    });
    expect(paperOf(service)?.venue_decision).not.toBe("accept");
    expect(slotOf(service, "submission")?.status).not.toBe("provided");
    expect(syncAudits(service)).toEqual([]);
  });

  it("fills the submission, stops asking for it and closes the ARR feedback request", () => {
    const service = lab();
    writeUp(service);
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "feedback_arr",
        input: {
          value_text: JSON.stringify({ reason: "Before ARR", url: "https://example.com/draft" }),
        },
        memberId: "ada",
        privileged: false,
      }),
    );
    expect(unwrap(service.listPiReviewQueue()).papers.some((row) => row.feedback)).toBe(true);
    expect(missingSlots(service)).toContain("submission");

    unwrap(service.syncPapersFromOpenReview({ evidence: [submitted], dryRun: false, nowIso: NOW }));

    expect(slotOf(service, "submission")).toMatchObject({
      status: "provided",
      url: "https://openreview.net/forum?id=Abc123xyz",
      verified_by: "openreview",
    });
    expect(slotOf(service, "submission_id")?.value_text).toBe("Abc123xyz");
    expect(missingSlots(service)).not.toContain("submission");
    expect(missingSlots(service)).not.toContain("submission_id");
    expect(unwrap(service.listPiReviewQueue()).papers.some((row) => row.feedback)).toBe(false);
    expect(syncAudits(service)[0]).toMatchObject({
      actor: "openreview",
      details: { paper_id: "p1", status: "under_review", venue: "ARR October 2026" },
    });
  });

  it("records an acceptance once and is a no-op on the next pass", () => {
    const service = lab();
    unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    expect(paperOf(service)).toMatchObject({
      venue_decision: "accept",
      accepted_venue: "EMNLP",
      accepted_year: 2026,
      presentation_type: "poster",
      artifacts: expect.objectContaining({ publication_track: "findings" }),
    });

    const again = unwrap(
      service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }),
    );
    expect(again).toMatchObject({ applied: [], unchanged: 1 });
    expect(syncAudits(service)).toHaveLength(1);
  });

  it("leaves a human correction alone until OpenReview says something new", () => {
    const service = lab();
    unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    const current = paperOf(service);
    // The author knows it is an oral; OpenReview's snapshot still says poster.
    unwrap(service.upsertPaper({ ...current!, presentation_type: "oral" } as never));

    unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    expect(paperOf(service)?.presentation_type).toBe("oral");

    // A record echoed back by a client cannot reset what the sync last applied.
    unwrap(service.upsertPaper({ ...paperOf(service)!, openreview_sync: undefined } as never));
    unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    expect(paperOf(service)?.presentation_type).toBe("oral");

    // New evidence from OpenReview is applied.
    unwrap(
      service.syncPapersFromOpenReview({
        evidence: [{ ...accepted, presentation: "spotlight", observed_at: "2026-10-25T07:35:00Z" }],
        dryRun: false,
        nowIso: NOW,
      }),
    );
    expect(paperOf(service)?.presentation_type).toBe("spotlight");
  });

  it("closes only the stages a visible reply proves, so the reminder moves on", () => {
    const service = lab();
    writeUp(service);
    const reviewed: OpenReviewEvidence = {
      ...submitted,
      stages: { reviews_out: "2026-10-20T09:00:00+00:00" },
    };
    const evidenced = () =>
      service.listAuditEvents().filter((event) => event.type === "paperflow_stage.evidenced");
    const openStage = () =>
      unwrap(service.collectPaperflowStageNudges(NOW)).items.find((item) => item.paper_id === "p1")
        ?.stage;

    const preview = unwrap(
      service.syncPapersFromOpenReview({ evidence: [reviewed], dryRun: true, nowIso: NOW }),
    );
    expect(preview.stages_closed).toEqual([{ paper_id: "p1", stage: "reviews_out" }]);
    expect(evidenced()).toEqual([]);

    // Reviews alone say nothing about the rebuttal: that rung stays open until a reply proves it.
    unwrap(service.syncPapersFromOpenReview({ evidence: [reviewed], dryRun: false, nowIso: NOW }));
    expect(openStage()).toBe("rebuttal");
    expect(evidenced().map((event) => event.details)).toEqual([
      { paper_id: "p1", stage: "reviews_out", recorded_by: "openreview" },
    ]);

    const responded: OpenReviewEvidence = {
      ...reviewed,
      stages: { ...reviewed.stages, rebuttal: "2026-10-22T09:00:00+00:00" },
    };
    const next = unwrap(
      service.syncPapersFromOpenReview({ evidence: [responded], dryRun: false, nowIso: NOW }),
    );
    expect(next.stages_closed).toEqual([{ paper_id: "p1", stage: "rebuttal" }]);
    expect(openStage()).toBe("decision");
  });

  it("counts reports that match no paper on file once per submission", () => {
    const service = lab();
    const stranger = {
      ...submitted,
      title: "Not Ours",
      submission_id: "Zzz999",
      forums: ["Zzz999"],
    };
    const report = unwrap(
      service.syncPapersFromOpenReview({
        evidence: [stranger, { ...stranger, status: "rejected" }],
        dryRun: true,
        nowIso: NOW,
      }),
    );
    expect(report).toMatchObject({ matched: 0, unmatched_submissions: 1 });
  });
});
