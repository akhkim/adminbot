// Turning OpenReview's reports into one plan per paper, the way the paper sheet reads them.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import {
  cycleKey,
  evidenceFromAuthorResults,
  evidenceFromCitationChecks,
  isLaterPlan,
  matchPaperEvidence,
  openReviewStageProofs,
  planOpenReviewSync,
  venueFromId,
  type OpenReviewEvidence,
} from "./openreview-paper-sync.js";

const NOW = "2026-10-24T08:55:00.000Z";

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal Garden Planning",
    authors: ["Ada Lovelace"],
    current_step: "submission",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as AdminBotPaperRecord;
}

function evidence(overrides: Partial<OpenReviewEvidence> = {}): OpenReviewEvidence {
  return {
    source: "author_results",
    status: "under_review",
    title: "Causal Garden Planning",
    submission_id: "Abc123xyz",
    forums: ["Abc123xyz"],
    venue_id: "aclweb.org/ACL/ARR/2026/October",
    observed_at: "2026-10-10T12:00:00+00:00",
    ...overrides,
  };
}

function slot(overrides: Partial<AdminBotPaperSlotRecord>): AdminBotPaperSlotRecord {
  return { paper_id: "p1", status: "provided", ...overrides } as AdminBotPaperSlotRecord;
}

describe("venue ids", () => {
  it("reads them the way the sheet does", () => {
    expect(venueFromId("aclweb.org/ACL/ARR/2026/October/Submission")).toBe("ARR October 2026");
    expect(venueFromId("ICLR.cc/2027/Conference")).toBe("ICLR 2027");
    expect(venueFromId("ICML.cc/2026/Workshop/Causal_Learning")).toBe(
      "ICML 2026 Workshop Causal Learning",
    );
    expect(venueFromId("aclweb.org/ACL/2026/Conference")).toBe("ACL 2026");
    expect(venueFromId("eacl.org/EACL/2027")).toBe("EACL 2027");
    expect(cycleKey({ venue_id: "aclweb.org/ACL/ARR/2026/October" })).toBe(202610);
    expect(cycleKey({ venue_id: "ICLR.cc/2027/Conference" })).toBe(202700);
  });
});

describe("reading the sources", () => {
  it("keeps the snapshot's track and presentation only on an acceptance", () => {
    const items = evidenceFromAuthorResults({
      fetched_at: "2026-10-24T07:35:00+00:00",
      submissions: [
        {
          id: "Acc111",
          forum: "Acc111",
          title: "Accepted One",
          status: "accepted",
          venue_id: "EMNLP/2026/Conference",
          track: "Findings",
          presentation: "poster",
        },
        { id: "Rev222", title: "Under Review", status: "under_review", track: "main" },
        { id: "Odd333", title: "Unclassified", status: "maybe" },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: "author_results",
      track: "findings",
      presentation: "poster",
      observed_at: "2026-10-24T07:35:00+00:00",
    });
    expect(items[1].track).toBeUndefined();
  });

  it("reads outcomes off the citation-watch venue ids, and skips the ones it cannot place", () => {
    const items = evidenceFromCitationChecks([
      { submission_id: "s1", title: "A", venue_id: "ICLR.cc/2027/Conference/Submission" },
      { submission_id: "s2", title: "B", venue_id: "ICLR.cc/2027/Conference/Withdrawn_Submission" },
      {
        submission_id: "s3",
        title: "C",
        venue_id: "ICLR.cc/2027/Conference/Desk_Rejected_Submission",
      },
      { submission_id: "s4", title: "D", venue_id: "ICLR.cc/2027/Conference" },
    ]);
    expect(items.map((item) => item.status)).toEqual([
      "under_review",
      "withdrawn",
      "desk_rejected",
    ]);
  });

  it("reads the stages a visible reply proves and nothing it does not", () => {
    const [item, bare] = evidenceFromAuthorResults({
      submissions: [
        {
          id: "Arr222",
          title: "Reviewed",
          status: "under_review",
          stages: { reviews_out: "2026-10-20T09:00:00+00:00", rebuttal: "", camera_ready: "x" },
        },
        { id: "Arr333", title: "Quiet", status: "under_review", stages: {} },
      ],
    });
    expect(item.stages).toEqual({ reviews_out: "2026-10-20T09:00:00+00:00", rebuttal: "" });
    expect(bare.stages).toBeUndefined();
    expect(openReviewStageProofs(item)).toEqual([
      {
        stage: "reviews_out",
        at: "2026-10-20T09:00:00+00:00",
        subject: "OpenReview: reviews visible (forum Arr222)",
      },
      {
        stage: "rebuttal",
        at: "",
        subject: "OpenReview: author response or meta-review posted (forum Arr222)",
      },
    ]);
    expect(openReviewStageProofs(bare)).toEqual([]);
  });

  it("reads every title, the submission time and the ARR cycle a commitment came from", () => {
    const [item] = evidenceFromAuthorResults({
      fetched_at: "2026-10-24T07:35:00+00:00",
      submissions: [
        {
          id: "Emn111",
          forum: "Emn111",
          review_forum: "Arr111",
          title: "Camera Ready Name",
          titles: ["Camera Ready Name", "Submitted Name", ""],
          submitted_at: "2026-06-20T10:00:00+00:00",
          arr_venue_id: "aclweb.org/ACL/ARR/2026/May/Submission",
          status: "accepted",
          venue_id: "EMNLP/2026/Conference",
        },
      ],
    });
    expect(item).toMatchObject({
      titles: ["Camera Ready Name", "Submitted Name"],
      forums: ["Emn111", "Arr111"],
      submitted_at: "2026-06-20T10:00:00+00:00",
      arr_venue_id: "aclweb.org/ACL/ARR/2026/May/Submission",
    });
  });
});

describe("matching a paper", () => {
  it("prefers a forum id the paper already holds over a title match", () => {
    const byTitle = evidence({
      submission_id: "Other999",
      forums: ["Other999"],
      status: "rejected",
    });
    const byForum = evidence({ title: "Renamed Since", venue_id: "ICLR.cc/2025/Conference" });
    const slots = [slot({ slot: "submission", url: "https://openreview.net/forum?id=Abc123xyz" })];
    expect(matchPaperEvidence(paper(), slots, [byTitle, byForum])).toBe(byForum);
  });

  it("matches on a normalized title when the paper holds no forum", () => {
    const item = evidence({ title: "causal garden-planning!" });
    expect(matchPaperEvidence(paper(), [], [item])).toBe(item);
    expect(matchPaperEvidence(paper({ title: "Something Else" }), [], [item])).toBeUndefined();
  });

  it("matches a retitled paper by any title the submission has carried", () => {
    const item = evidence({
      title: "Gardens, Causally",
      titles: ["Gardens, Causally", "Causal Garden Planning"],
    });
    expect(matchPaperEvidence(paper(), [], [item])).toBe(item);
    expect(matchPaperEvidence(paper({ title: "Gardens causally" }), [], [item])).toBe(item);
  });

  it("lets the latest cycle win, then the newest report inside a cycle", () => {
    const iclr = evidence({ status: "rejected", venue_id: "ICLR.cc/2026/Conference" });
    const arr = evidence({ status: "under_review" });
    expect(matchPaperEvidence(paper(), [], [arr, iclr])).toBe(arr);

    const snapshot = evidence({ observed_at: "2026-10-20T07:35:00Z" });
    const decision = evidence({ status: "accepted", observed_at: "2026-10-22T09:00:00Z" });
    expect(matchPaperEvidence(paper(), [], [decision, snapshot])).toBe(decision);
    const laterSnapshot = { ...snapshot, observed_at: "2026-10-23T07:35:00Z" };
    expect(matchPaperEvidence(paper(), [], [decision, laterSnapshot])).toBe(laterSnapshot);
  });

  it("lets the later submission win inside one cycle", () => {
    // Committed to ACL, rejected, then committed to EMNLP the same year: both years read 2026.
    const acl = evidence({
      status: "rejected",
      venue_id: "aclweb.org/ACL/2026/Conference",
      submitted_at: "2026-02-20T00:00:00Z",
    });
    const emnlp = evidence({
      status: "accepted",
      venue_id: "EMNLP/2026/Conference",
      submitted_at: "2026-06-20T00:00:00Z",
    });
    expect(matchPaperEvidence(paper(), [], [emnlp, acl])).toBe(emnlp);
    expect(matchPaperEvidence(paper(), [], [acl, emnlp])).toBe(emnlp);
  });

  it("hears the citation-watch table only when nothing else speaks, as the sheet does", () => {
    const stale = evidence({
      source: "citation_checks",
      venue_id: "aclweb.org/ACL/ARR/2027/February/Submission",
      observed_at: "2026-10-24T00:00:00Z",
    });
    const snapshot = evidence({ status: "accepted", venue_id: "EMNLP/2026/Conference" });
    expect(matchPaperEvidence(paper(), [], [stale, snapshot])).toBe(snapshot);
    expect(matchPaperEvidence(paper(), [], [stale])).toBe(stale);
  });
});

describe("planning the change", () => {
  it("records an acceptance with its venue, year, track and presentation", () => {
    const plan = planOpenReviewSync(
      paper({ venue: "ICLR 2027" }),
      [],
      evidence({
        status: "accepted",
        venue_id: "EMNLP/2026/Conference",
        track: "findings",
        presentation: "poster",
      }),
      NOW,
    );
    expect(plan.patch).toEqual({
      venue_decision: "accept",
      accepted_venue: "EMNLP",
      accepted_year: 2026,
      artifacts: { publication_track: "findings" },
      presentation_type: "poster",
    });
    expect(plan.slotWrites.map((write) => write.slot)).toEqual(["submission", "submission_id"]);
    expect(plan.sync).toMatchObject({ status: "accepted", venue: "EMNLP 2026", applied_at: NOW });
  });

  it("marks a submission under review and closes the feedback request it answered", () => {
    const request = JSON.stringify({ reason: "Before ARR", url: "https://example.com/draft" });
    const plan = planOpenReviewSync(
      paper({ venue_decision: "reject", venue: "ICLR 2026" }),
      [
        slot({ slot: "feedback_arr", value_text: request, provided_at: "2026-10-01T00:00:00Z" }),
        slot({ slot: "submission_id", value_text: "typed-by-hand" }),
      ],
      evidence(),
      NOW,
    );
    expect(plan.patch).toEqual({ venue: "ARR October 2026", venue_decision: "pending" });
    // The id somebody typed is theirs; only the missing page is filled in.
    expect(plan.slotWrites).toEqual([
      expect.objectContaining({
        slot: "submission",
        url: "https://openreview.net/forum?id=Abc123xyz",
      }),
    ]);
    expect(plan.feedbackClosures).toHaveLength(1);
    expect(JSON.parse(plan.feedbackClosures[0].value_text)).toMatchObject({
      reason: "Before ARR",
      reviewed: true,
      review_note: "Submitted to ARR October 2026 (per OpenReview).",
    });
  });

  it("judges a commitment's feedback requests by the ARR cycle it came from", () => {
    const request = (provided_at: string) =>
      slot({
        slot: "feedback_arr",
        value_text: JSON.stringify({ reason: "Before ARR", url: "https://example.com/draft" }),
        provided_at,
      });
    const commitment = evidence({
      venue_id: "EMNLP/2026/Conference/Submission",
      arr_venue_id: "aclweb.org/ACL/ARR/2026/May/Submission",
    });
    expect(
      planOpenReviewSync(paper(), [request("2026-05-10T00:00:00Z")], commitment, NOW)
        .feedbackClosures,
    ).toHaveLength(1);
    expect(
      planOpenReviewSync(paper(), [request("2026-09-01T00:00:00Z")], commitment, NOW)
        .feedbackClosures,
    ).toEqual([]);
  });

  it("leaves a feedback request filed after the cycle open: it is about a revision", () => {
    const request = JSON.stringify({ reason: "Revision", url: "https://example.com/draft" });
    const plan = planOpenReviewSync(
      paper(),
      [slot({ slot: "feedback_arr", value_text: request, provided_at: "2026-11-20T00:00:00Z" })],
      evidence(),
      NOW,
    );
    expect(plan.feedbackClosures).toEqual([]);
  });

  it("withdraws an acceptance a rejection contradicts", () => {
    const plan = planOpenReviewSync(
      paper({
        venue: "ICLR 2027",
        venue_decision: "accept",
        accepted_venue: "ICLR",
        accepted_year: 2027,
      }),
      [],
      evidence({ status: "rejected", venue_id: "ICLR.cc/2027/Conference" }),
      NOW,
    );
    expect(plan.patch).toEqual({
      accepted_venue: "",
      accepted_year: "",
      venue_decision: "reject",
    });
  });

  it("leaves an acceptance at another venue alone, whatever OpenReview says here", () => {
    const workshop = paper({
      venue: "ARR May 2026",
      venue_decision: "pending",
      accepted_venue: "REALM workshop @EMNLP",
      accepted_year: 2026,
    });
    const elsewhere = planOpenReviewSync(
      workshop,
      [],
      evidence({ status: "rejected", venue_id: "ICLR.cc/2026/Conference" }),
      NOW,
    );
    expect(elsewhere.patch).toEqual({});
    expect(elsewhere.kept).toContain("REALM");
    // Under review at the next venue names the venue but keeps the acceptance.
    const next = planOpenReviewSync(
      workshop,
      [],
      evidence({ venue_id: "aclweb.org/ACL/ARR/2026/October" }),
      NOW,
    );
    expect(next.patch).toEqual({ venue: "ARR October 2026" });
  });

  it("does not close a paper on a withdrawal", () => {
    const plan = planOpenReviewSync(
      paper({ venue: "ICLR 2027" }),
      [],
      evidence({ status: "withdrawn", venue_id: "ICLR.cc/2027/Conference" }),
      NOW,
    );
    expect(plan.patch).toEqual({});
  });

  it("keeps a later plan when an older submission is rejected", () => {
    const plan = planOpenReviewSync(
      paper({ venue: "ARR February 2027" }),
      [],
      evidence({ status: "rejected" }),
      NOW,
    );
    expect(plan.patch).toEqual({});
    expect(plan.kept).toContain("ARR February 2027");
    expect(isLaterPlan("ICML 2026", evidence({ venue_id: "ICLR.cc/2026/Conference" }))).toBe(true);
    expect(isLaterPlan("ARR August 2026", evidence())).toBe(false);
    expect(isLaterPlan("", evidence())).toBe(false);
  });

  it("keeps an acceptance from a later year than the submission", () => {
    const plan = planOpenReviewSync(
      paper({ venue_decision: "accept", accepted_venue: "ACL", accepted_year: 2027 }),
      [],
      evidence({ status: "rejected" }),
      NOW,
    );
    expect(plan.patch).toEqual({});
    expect(plan.kept).toContain("2027");
  });

  it("does nothing for an observation it already applied", () => {
    const first = planOpenReviewSync(paper(), [], evidence(), NOW);
    const again = planOpenReviewSync(
      paper({ venue: "ICLR 2027", openreview_sync: first.sync }),
      [],
      evidence({ observed_at: "2026-10-11T00:00:00Z" }),
      NOW,
    );
    expect(again.unchanged).toBe(true);
    expect(again.patch).toEqual({});
  });
});
