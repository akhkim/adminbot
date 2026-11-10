// The PI queue's OpenReview reading: which category each paper lands in, the camera-ready clock it
// carries, and the order she reads them in.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperOpenReviewSync, AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import type { AdminBotPaperflowEvidenceRecord } from "../../contracts/paperflow-stages.js";
import {
  aoeToIso,
  buildCameraReadyNotice,
  cameraReadyDeadline,
  daysLeft,
  openReviewPaperQueue,
  proofreadingPaperQueue,
  rankPaperQueue,
  submissionDeadline,
  yearlessAoeToIso,
} from "./paper-queue.js";
import type { PiReviewRow } from "./pi-review.js";

const now = new Date("2026-11-03T12:00:00.000Z");

function paper(
  sync: Partial<AdminBotPaperOpenReviewSync> &
    Pick<AdminBotPaperOpenReviewSync, "status" | "venue">,
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

// A published deadline proposal stores its stage as an instant. Read as an AoE wall clock it put
// the NeurIPS 2026 camera-ready (Nov 6 AoE) twelve hours late on her queue.
describe("aoeToIso", () => {
  it("reads a bare wall clock as Anywhere on Earth", () => {
    expect(aoeToIso("2026-11-06 23:59")).toBe("2026-11-07T11:59:00.000Z");
    expect(aoeToIso("2026-11-06")).toBe("2026-11-07T11:59:59.000Z");
  });

  it("keeps a timestamp that carries its own offset", () => {
    expect(aoeToIso("2026-11-07T11:59:00.000Z")).toBe("2026-11-07T11:59:00.000Z");
    expect(aoeToIso("2026-11-06T23:59:00-12:00")).toBe("2026-11-07T11:59:00.000Z");
  });

  it("gives the NeurIPS camera-ready stage a proposal added its real instant", () => {
    const neurips = [
      {
        venue_group: "NeurIPS 2026",
        venue_family: "NeurIPS",
        entry_type: "rebuttal",
        schedule: [
          { milestone: "camera_ready", label: "Camera-ready", date: "2026-11-07T11:59:00.000Z" },
        ],
      },
    ];
    for (const venue of [
      "NeurIPS 2026",
      "NeurIPS 2026 Position Paper Track",
      "NeurIPS 2026 Evaluations and Datasets Track",
    ]) {
      expect(cameraReadyDeadline(venue, neurips, now)).toBe("2026-11-07T11:59:00.000Z");
    }
  });
});

describe("proofreadingPaperQueue", () => {
  // CLeaR 2027 as the deadline proposal published it: the year only in the name.
  const clear = [
    {
      name: "CLeaR 2027",
      venue_group: "CLeaR",
      venue_family: "CLeaR",
      venue_type: "conference",
      entry_type: "main_conference",
      milestone: "direct_submission",
      deadline_aoe: "2026-11-16 23:59:00",
      deadline_at: "2026-11-17T11:59:00.000Z",
    },
  ];
  const draft = (overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord => ({
    id: "p2",
    title: "Causal Proofreading",
    authors: ["Ada Lovelace"],
    current_step: "overleaf_writing",
    venue: "CLeaR 2027",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-10-30T00:00:00.000Z",
    ...overrides,
  });

  it("finds the submission deadline of a record that carries its year only in its name", () => {
    expect(submissionDeadline("CLeaR 2027", clear, now)).toEqual({
      deadline: "2026-11-17T11:59:00.000Z",
      name: "CLeaR 2027",
    });
  });

  it("puts a paper headed to a near deadline under proofreading, with the clock", () => {
    const [row] = proofreadingPaperQueue([{ paper: draft() }], clear, now);
    expect(row).toMatchObject({
      paper_id: "p2",
      category: "proofreading",
      hard_deadline: "2026-11-17T11:59:00.000Z",
      days_left: 13,
      venue: "CLeaR 2027",
      proofreading: { venue: "CLeaR 2027" },
    });
    expect(row?.proofreading?.note).toContain("due 2026-11-17");
  });

  it("leaves out papers already submitted there, decided, too far off, or past", () => {
    const submittedThere = draft({
      openreview_sync: {
        fingerprint: "f",
        source: "author_results",
        applied_at: "2026-11-01T00:00:00.000Z",
        status: "under_review",
        venue: "CLeaR 2027",
      },
    });
    expect(proofreadingPaperQueue([{ paper: submittedThere }], clear, now)).toEqual([]);
    expect(
      proofreadingPaperQueue([{ paper: draft({ venue_decision: "accept" }) }], clear, now),
    ).toEqual([]);
    expect(
      proofreadingPaperQueue([{ paper: draft() }], clear, new Date("2026-08-01T00:00:00.000Z")),
    ).toEqual([]);
    expect(
      proofreadingPaperQueue([{ paper: draft() }], clear, new Date("2026-11-18T00:00:00.000Z")),
    ).toEqual([]);
    expect(
      proofreadingPaperQueue([{ paper: draft({ venue: "Unknown Venue 2027" }) }], clear, now),
    ).toEqual([]);
  });

  it("still lists a paper whose OpenReview record is from an earlier venue", () => {
    const resubmitting = draft({
      openreview_sync: {
        fingerprint: "f",
        source: "author_results",
        applied_at: "2026-09-25T00:00:00.000Z",
        status: "rejected",
        venue: "NeurIPS 2026",
      },
    });
    expect(proofreadingPaperQueue([{ paper: resubmitting }], clear, now)).toHaveLength(1);
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
    const ranked = rankPaperQueue(
      [
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
      ],
      now,
    );
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

describe("rankPaperQueue overdue", () => {
  const row = (paper_id: string, overrides: Partial<PiReviewRow>): PiReviewRow => ({
    category: "arxiv_release",
    paper_id,
    title: paper_id,
    authors: [],
    package_complete: true,
    ...overrides,
  });

  // Overdue rows in a later category sat below every camera-ready, safety and arXiv row.
  it("puts every row past its hard deadline at the top, whatever its category", () => {
    const ranked = rankPaperQueue(
      [
        row("impact", { category: "safety_impact", priority: "high" }),
        row("cr-upcoming", { category: "camera_ready", hard_deadline: "2026-11-20T00:00:00.000Z" }),
        row("arr-overdue", {
          category: "under_review",
          feedback: {
            reason: "r",
            url: "https://x.test",
            hard_deadline: "2026-10-20T00:00:00.000Z",
            label: "ARR / Overleaf feedback",
            slot: "feedback_arr",
          },
        }),
        row("arxiv", { category: "arxiv_release" }),
        row("cr-overdue", {
          category: "camera_ready",
          hard_deadline: "2026-10-30T00:00:00.000Z",
          days_left: -5,
        }),
      ],
      now,
    );
    expect(ranked.map((entry) => entry.paper_id)).toEqual([
      "cr-overdue",
      "arr-overdue",
      "cr-upcoming",
      "impact",
      "arxiv",
    ]);
  });
});

describe("past cycles and year-less dates", () => {
  const neurips = [
    {
      venue_group: "NeurIPS 2023",
      venue_family: "NeurIPS",
      schedule: [{ milestone: "camera_ready", date: "2023-10-27 23:59:59" }],
    },
    {
      venue_group: "NeurIPS 2026",
      venue_family: "NeurIPS",
      schedule: [{ milestone: "camera_ready", date: "2026-11-06 23:59:59" }],
    },
  ];
  const accepted = (venue: string, overrides: Partial<AdminBotPaperRecord> = {}) =>
    openReviewPaperQueue(
      [
        {
          paper: paper({ status: "accepted", venue }, { venue_decision: "accept", ...overrides }),
          slots: submitted,
          evidence: [],
        },
      ],
      neurips,
      now,
    );

  // A three-year-old NeurIPS acceptance whose camera-ready slot nobody ticked read as three years
  // overdue at the top of her desk.
  it("drops an acceptance from a past year's NeurIPS instead of calling it overdue", () => {
    expect(accepted("NeurIPS 2023")).toEqual([]);
    expect(accepted("NeurIPS", { accepted_year: 2023 })).toEqual([]);
  });

  it("keeps this year's NeurIPS camera-ready, overdue by days, with its clock", () => {
    expect(accepted("NeurIPS 2026")).toEqual([
      expect.objectContaining({
        category: "camera_ready",
        hard_deadline: "2026-11-07T11:59:59.000Z",
        days_left: 3,
      }),
    ]);
    expect(accepted("NeurIPS", { accepted_year: 2026 })[0]?.hard_deadline).toBe(
      "2026-11-07T11:59:59.000Z",
    );
  });

  it("drops a camera-ready that went by more than a season ago", () => {
    const icml = [
      {
        venue_group: "ICML 2026",
        venue_family: "ICML",
        schedule: [{ milestone: "camera_ready", date: "2026-06-05 23:59:59" }],
      },
    ];
    expect(
      openReviewPaperQueue(
        [
          {
            paper: paper({ status: "accepted", venue: "ICML 2026" }, { venue_decision: "accept" }),
            slots: submitted,
            evidence: [],
          },
        ],
        icml,
        now,
      ),
    ).toEqual([]);
  });

  it("puts no past-year venue under proofreading", () => {
    const old = [
      {
        name: "NeurIPS 2025",
        venue_group: "NeurIPS 2025",
        venue_family: "NeurIPS",
        milestone: "full_paper",
        deadline_aoe: "11-20 23:59",
      },
    ];
    const draft = { ...paper({ status: "under_review", venue: "x" }), venue: "NeurIPS 2025" };
    const { openreview_sync: _, ...unsynced } = draft;
    expect(proofreadingPaperQueue([{ paper: unsynced }], old, now)).toEqual([]);
  });

  // `Date.parse("Nov 6")` is 2001 in V8: a deadline typed without its year read as decades late.
  it("reads a month and day with no year as the next time it comes round", () => {
    expect(yearlessAoeToIso("Nov 20", now)).toBe("2026-11-21T11:59:59.000Z");
    expect(yearlessAoeToIso("11-20 23:59", now)).toBe("2026-11-21T11:59:00.000Z");
    expect(yearlessAoeToIso("20 November", now)).toBe("2026-11-21T11:59:59.000Z");
    // Already gone this year: next year, never a past one.
    expect(yearlessAoeToIso("Oct 1", now)).toBe("2027-10-02T11:59:59.000Z");
    expect(yearlessAoeToIso("02-29", now)).toBe("2028-03-01T11:59:59.000Z");
    expect(yearlessAoeToIso("Feb 30", now)).toBeUndefined();
    expect(yearlessAoeToIso("soon", now)).toBeUndefined();
    expect(aoeToIso("Nov 20")).toBeUndefined();
    expect(aoeToIso("Nov 20", now)).toBe("2026-11-21T11:59:59.000Z");
  });

  it("gives a year-less camera-ready date in the dataset its coming occurrence", () => {
    const yearless = [
      {
        venue_group: "EACL 2027",
        venue_family: "EACL",
        schedule: [{ milestone: "camera_ready", date: "Nov 26" }],
      },
    ];
    expect(cameraReadyDeadline("EACL 2027", yearless, now)).toBe("2026-11-27T11:59:59.000Z");
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
