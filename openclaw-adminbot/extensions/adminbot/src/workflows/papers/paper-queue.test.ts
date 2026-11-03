// The PI queue's OpenReview reading: which category each paper lands in, the camera-ready clock it
// carries, and the order she reads them in.
import { describe, expect, it } from "vitest";
import type {
  AdminBotPaperOpenReviewSync,
  AdminBotPaperRecord,
} from "../../contracts/actions.js";
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import type { AdminBotPaperflowEvidenceRecord } from "../../contracts/paperflow-stages.js";
import {
  buildCameraReadyNotice,
  cameraReadyDeadline,
  daysLeft,
  openReviewPaperQueue,
  rankPaperQueue,
} from "./paper-queue.js";
import type { PiReviewRow } from "./pi-review.js";

const now = new Date("2026-11-03T12:00:00.000Z");

function paper(
  sync: Partial<AdminBotPaperOpenReviewSync> & Pick<AdminBotPaperOpenReviewSync, "status" | "venue">,
  overrides: Partial<AdminBotPaperRecord> = {},
): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal Data Agent",
    authors: ["Ada Lovelace", "Zhijing Jin"],
    current_step: "submission",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    openreview_sync: {
      fingerprint: "f1",
      source: "author_results",
      applied_at: "2026-10-20T00:00:00.000Z",
      submission_id: "abc123",
      ...sync,
    },
    ...overrides,
  };
}

const submitted: AdminBotPaperSlotRecord[] = [
  { paper_id: "p1", slot: "submission", status: "provided", url: "https://openreview.net/x" },
];

function seen(...stages: AdminBotPaperflowEvidenceRecord["stage"][]) {
  return stages.map((stage) => ({
    paper_id: "p1",
    stage,
    recorded_at: "2026-10-01T00:00:00.000Z",
    recorded_by: "openreview" as const,
  }));
}

const dataset = [
  {
    venue_group: "EACL 2027",
    venue_family: "EACL",
    entry_type: "arr_commitment",
    schedule: [
      { milestone: "camera_ready", date: "2027-01-06 23:59:59" },
      { milestone: "camera_ready", date: "2026-11-26 23:59:59" },
    ],
  },
  {
    venue_group: "EACL 2027",
    venue_family: "EACL",
    entry_type: "demo_track",
    schedule: [{ milestone: "camera_ready", date: "2026-11-10 23:59:59" }],
  },
  {
    venue_group: "EMNLP 2026",
    venue_family: "EMNLP",
    schedule: [{ milestone: "camera_ready", date: "2026-08-30 23:59:59" }],
  },
  {
    venue_group: "EACL 2027 Workshops",
    venue_type: "workshop",
    schedule: [{ milestone: "camera_ready", date: "2026-11-05 23:59:59" }],
  },
];

describe("cameraReadyDeadline", () => {
  it("takes the earliest main-conference date still ahead, read as Anywhere on Earth", () => {
    expect(cameraReadyDeadline("EACL 2027", dataset, now)).toBe("2026-11-27T11:59:59.000Z");
  });

  it("reads a workshop acceptance against the workshop rows", () => {
    expect(cameraReadyDeadline("EACL 2027 Workshop on Safety", dataset, now)).toBe(
      "2026-11-06T11:59:59.000Z",
    );
  });

  it("keeps a passed date so an overdue camera-ready reads as overdue", () => {
    const deadline = cameraReadyDeadline("EMNLP 2026", dataset, now);
    expect(deadline).toBe("2026-08-31T11:59:59.000Z");
    expect(daysLeft(deadline as string, now)).toBeLessThan(0);
  });

  it("has no date for a venue the dataset does not carry one for", () => {
    expect(cameraReadyDeadline("NeurIPS 2026", dataset, now)).toBeUndefined();
  });
});

describe("openReviewPaperQueue", () => {
  it("puts an accepted paper under camera-ready with its deadline and days left", () => {
    const [row] = openReviewPaperQueue(
      [
        {
          paper: paper({ status: "accepted", venue: "EACL 2027" }, { venue_decision: "accept" }),
          slots: submitted,
          evidence: [],
        },
      ],
      dataset,
      now,
    );
    expect(row).toMatchObject({
      category: "camera_ready",
      venue: "EACL 2027",
      hard_deadline: "2026-11-27T11:59:59.000Z",
      days_left: 23,
      drive_pdf_url: "https://openreview.net/forum?id=abc123",
      openreview: { status: "accepted", stage: "camera_ready" },
    });
  });

  it("still lists an acceptance at a venue with no published camera-ready date", () => {
    const [row] = openReviewPaperQueue(
      [
        {
          paper: paper({ status: "accepted", venue: "NeurIPS 2026" }, { venue_decision: "accept" }),
          slots: submitted,
          evidence: [],
        },
      ],
      dataset,
      now,
    );
    expect(row?.category).toBe("camera_ready");
    expect(row?.hard_deadline).toBeUndefined();
    expect(row?.openreview?.note).toMatch(/No camera-ready date/);
  });

  it("drops the paper once the camera-ready is confirmed", () => {
    expect(
      openReviewPaperQueue(
        [
          {
            paper: paper({ status: "accepted", venue: "EACL 2027" }, { venue_decision: "accept" }),
            slots: submitted,
            evidence: seen("camera_ready"),
          },
        ],
        dataset,
        now,
      ),
    ).toEqual([]);
  });

  it("says where an under-review paper is in its cycle", () => {
    const rows = openReviewPaperQueue(
      [
        {
          paper: paper({ status: "under_review", venue: "ICLR 2027" }),
          slots: submitted,
          evidence: seen("reviews_out"),
        },
      ],
      dataset,
      now,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        category: "under_review",
        openreview: expect.objectContaining({
          stage: "rebuttal",
          note: "ICLR 2027: Reviews are out; the rebuttal has not been accounted for.",
        }),
      }),
    ]);
  });

  it("lists a recent rejection, and lets it go after a while or once resubmitted", () => {
    const rejected = paper(
      { status: "rejected", venue: "ICML 2026" },
      { venue_decision: "reject" },
    );
    const queue = (record: AdminBotPaperRecord, at = now) =>
      openReviewPaperQueue([{ paper: record, slots: submitted, evidence: [] }], dataset, at);
    expect(queue(rejected)[0]?.category).toBe("after_rejection");
    expect(queue(rejected, new Date("2027-01-01T00:00:00.000Z"))).toEqual([]);
    expect(queue({ ...rejected, venue_decision: "pending" })).toEqual([]);
  });

  it("ignores papers OpenReview has said nothing about, and withdrawals", () => {
    const { openreview_sync: _, ...unsynced } = paper({ status: "accepted", venue: "EACL 2027" });
    expect(
      openReviewPaperQueue(
        [
          { paper: unsynced, slots: submitted, evidence: [] },
          {
            paper: paper({ status: "withdrawn", venue: "EACL 2027" }),
            slots: submitted,
            evidence: [],
          },
        ],
        dataset,
        now,
      ),
    ).toEqual([]);
  });
});

describe("rankPaperQueue", () => {
  const row = (paper_id: string, overrides: Partial<PiReviewRow>): PiReviewRow => ({
    category: "arxiv_release",
    paper_id,
    title: paper_id,
    authors: [],
    package_complete: true,
    ...overrides,
  });

  it("reads camera-ready first, then by category, then by nearest hard deadline", () => {
    const ranked = rankPaperQueue([
      row("rejected", { category: "after_rejection" }),
      row("arxiv", { category: "arxiv_release", waiting_since: "2026-01-01T00:00:00.000Z" }),
      row("impact", { category: "safety_impact", priority: "high" }),
      row("cr-late", { category: "camera_ready", hard_deadline: "2026-12-01T00:00:00.000Z" }),
      row("cr-undated", { category: "camera_ready" }),
      row("cr-feedback", {
        category: "camera_ready",
        feedback: {
          reason: "r",
          url: "https://x.test",
          hard_deadline: "2026-11-10T00:00:00.000Z",
          label: "Camera-ready feedback",
          slot: "feedback_camera_ready",
        },
      }),
      row("review", { category: "under_review" }),
    ]);
    expect(ranked.map((entry) => entry.paper_id)).toEqual([
      "cr-feedback",
      "cr-late",
      "cr-undated",
      "impact",
      "arxiv",
      "review",
      "rejected",
    ]);
  });
});

describe("buildCameraReadyNotice", () => {
  it("names the venue, the date and the days left", () => {
    const notice = buildCameraReadyNotice({
      category: "camera_ready",
      paper_id: "p1",
      title: "Causal Data Agent",
      authors: ["Ada Lovelace"],
      venue: "EACL 2027",
      hard_deadline: "2026-11-27T11:59:59.000Z",
      days_left: 23,
      package_complete: true,
    });
    expect(notice.title).toBe("Accepted at EACL 2027: camera-ready");
    expect(notice.body).toContain("Camera-ready is due 2026-11-27 (23 days left).");
  });
});
