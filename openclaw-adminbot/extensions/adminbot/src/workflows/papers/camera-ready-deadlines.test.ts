// A lab paper accepted at a venue the deadline dataset does not track still gets a camera-ready
// date, a deadline row and a lab-calendar proposal. All papers and venues here are synthetic.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperOpenReviewSync, AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  cameraReadyCalendarEntries,
  cameraReadyCalendarProposal,
  paperCameraReadyDeadlineRows,
  withPaperCameraReadyDeadlines,
} from "./camera-ready-deadlines.js";
import {
  cameraReadyDueOf,
  planOpenReviewSync,
  refreshedCameraReadyDue,
  type OpenReviewEvidence,
} from "./openreview-paper-sync.js";
import { cameraReadyDeadline } from "./paper-queue.js";

const now = new Date("2026-11-10T12:00:00.000Z");

function paper(
  id: string,
  sync: Partial<AdminBotPaperOpenReviewSync> &
    Pick<AdminBotPaperOpenReviewSync, "status" | "venue">,
): AdminBotPaperRecord {
  return {
    id,
    title: `Synthetic paper ${id}`,
    authors: ["Test Author"],
    current_step: "submission",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    openreview_sync: {
      fingerprint: `f-${id}`,
      source: "author_results",
      applied_at: "2026-11-01T00:00:00.000Z",
      ...sync,
    },
  };
}

/** A curated dataset that, like the real one, has no CLeaR row at all. */
const dataset = [
  {
    id: "emnlp2026_main",
    venue_group: "EMNLP 2026",
    venue_family: "EMNLP",
    entry_type: "main_conference",
    schedule: [{ milestone: "camera_ready", date: "2026-12-01 23:59:59" }],
  },
  {
    id: "neurips2026_rebuttal",
    venue_group: "NeurIPS 2026",
    venue_family: "NeurIPS",
    entry_type: "rebuttal",
    schedule: [{ milestone: "notification", date: "2026-09-25" }],
  },
];

const evidence: OpenReviewEvidence = {
  source: "author_results",
  status: "accepted",
  title: "Synthetic paper p1",
  submission_id: "Syn111",
  forums: ["Syn111"],
  venue_id: "CLeaR.cc/2027/Conference",
  observed_at: "2026-11-09T08:00:00+00:00",
  author_tasks: [
    {
      kind: "camera_ready",
      name: "Camera Ready Revision",
      due: "2027-02-15T11:59:00+00:00",
      open: true,
      forms: 1,
      done: 0,
    },
    {
      kind: "camera_ready",
      name: "Camera Ready Supplementary",
      due: "2027-02-20T11:59:00+00:00",
      open: true,
      forms: 1,
      done: 0,
    },
    { kind: "form", name: "Copyright", due: "2027-01-01T00:00:00Z", open: true, forms: 1, done: 0 },
  ],
};

describe("recording the camera-ready date OpenReview shows", () => {
  it("takes the earliest camera-ready author task", () => {
    expect(cameraReadyDueOf(evidence)).toBe("2027-02-15T11:59:00.000Z");
    expect(cameraReadyDueOf({ ...evidence, author_tasks: undefined })).toBeUndefined();
  });

  it("puts it on the sync without changing the fingerprint", () => {
    const blank = paper("p1", { status: "under_review", venue: "CLeaR 2027" });
    delete blank.openreview_sync;
    const plan = planOpenReviewSync(blank, [], evidence, "2026-11-10T00:00:00.000Z");
    expect(plan.sync.venue).toBe("CLeaR 2027");
    expect(plan.sync.camera_ready_due).toBe("2027-02-15T11:59:00.000Z");
    const without = planOpenReviewSync(
      blank,
      [],
      { ...evidence, author_tasks: undefined },
      "2026-11-10T00:00:00.000Z",
    );
    expect(without.sync.fingerprint).toBe(plan.sync.fingerprint);
  });

  it("refreshes an already-applied acceptance when the date appears or moves", () => {
    const blank = paper("p1", { status: "accepted", venue: "CLeaR 2027" });
    delete blank.openreview_sync;
    const first = planOpenReviewSync(
      blank,
      [],
      { ...evidence, author_tasks: undefined },
      "2026-11-01T00:00:00.000Z",
    );
    const applied = { ...blank, openreview_sync: first.sync };
    const next = planOpenReviewSync(applied, [], evidence, "2026-11-10T00:00:00.000Z");
    expect(next.unchanged).toBe(true);
    expect(refreshedCameraReadyDue(applied, next)).toEqual({
      ...first.sync,
      camera_ready_due: "2027-02-15T11:59:00.000Z",
    });
    const recorded = { ...applied, openreview_sync: refreshedCameraReadyDue(applied, next) };
    expect(
      refreshedCameraReadyDue(
        recorded,
        planOpenReviewSync(recorded, [], evidence, "2026-11-11T00:00:00.000Z"),
      ),
    ).toBeUndefined();
  });
});

describe("deadline rows for venues only the lab's papers know about", () => {
  const accepted = paper("p1", {
    status: "accepted",
    venue: "CLeaR 2027",
    camera_ready_due: "2027-02-15T11:59:00.000Z",
  });

  it("adds a camera-ready row for an accepted paper at an untracked venue", () => {
    expect(cameraReadyDeadline("CLeaR 2027", dataset, now)).toBeUndefined();
    const [row, ...rest] = paperCameraReadyDeadlineRows([accepted], dataset, now);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      id: "clear2027_camera_ready_openreview",
      name: "CLeaR 2027",
      venue_group: "CLeaR 2027",
      venue_family: "CLeaR",
      entry_type: "main_conference",
      milestone: "camera_ready",
      deadline_label: "camera-ready",
      deadline_aoe: "2027-02-14 23:59:00",
      deadline_at: "2027-02-15T11:59:00.000Z",
      deadline_source_kind: "openreview",
    });
    // Served on the public /deadlines: the venue and the date, nothing about the paper.
    expect(JSON.stringify(row)).not.toContain("Synthetic paper");
    expect(JSON.stringify(row)).not.toContain("Test Author");
  });

  it("makes the camera-ready date readable wherever the dataset is", () => {
    const merged = withPaperCameraReadyDeadlines(dataset, [accepted], now);
    expect(merged).toHaveLength(dataset.length + 1);
    expect(cameraReadyDeadline("CLeaR 2027", merged, now)).toBe("2027-02-15T11:59:00.000Z");
  });

  it("covers a tracked venue whose camera-ready the dataset lacks (NeurIPS 2026)", () => {
    const neurips = paper("p2", {
      status: "accepted",
      venue: "NeurIPS 2026",
      camera_ready_due: "2026-11-07T11:59:00.000Z",
    });
    const merged = withPaperCameraReadyDeadlines(dataset, [neurips], now);
    expect(cameraReadyDeadline("NeurIPS 2026", merged, now)).toBe("2026-11-07T11:59:00.000Z");
  });

  it("keeps the curated date when the dataset has one", () => {
    const emnlp = paper("p3", {
      status: "accepted",
      venue: "EMNLP 2026",
      camera_ready_due: "2026-11-20T00:00:00.000Z",
    });
    expect(paperCameraReadyDeadlineRows([emnlp], dataset, now)).toEqual([]);
  });

  it("derives nothing for a paper that is not accepted or has no date", () => {
    expect(
      paperCameraReadyDeadlineRows(
        [
          paper("p4", {
            status: "under_review",
            venue: "CLeaR 2027",
            camera_ready_due: "2027-02-15T11:59:00.000Z",
          }),
          paper("p5", { status: "accepted", venue: "CLeaR 2027" }),
        ],
        dataset,
        now,
      ),
    ).toEqual([]);
  });

  it("keeps one row per venue, at the earliest date two papers report", () => {
    const rows = paperCameraReadyDeadlineRows(
      [
        accepted,
        paper("p6", {
          status: "accepted",
          venue: "CLeaR 2027",
          camera_ready_due: "2027-02-10T11:59:00.000Z",
        }),
        paper("p7", {
          status: "accepted",
          venue: "SynthConf 2027 Workshop on Testing",
          camera_ready_due: "2027-03-01T11:59:00.000Z",
        }),
      ],
      dataset,
      now,
    );
    expect(rows.map((row) => [row.id, row.deadline_at, row.entry_type])).toEqual([
      ["clear2027_camera_ready_openreview", "2027-02-10T11:59:00.000Z", "main_conference"],
      ["synthconf2027_workshop_camera_ready_openreview", "2027-03-01T11:59:00.000Z", "workshop"],
    ]);
  });
});

describe("camera-ready deadlines on the lab calendar", () => {
  const accepted = paper("p1", {
    status: "accepted",
    venue: "CLeaR 2027",
    camera_ready_due: "2027-02-15T11:59:00.000Z",
  });

  it("lists one entry per venue with an accepted paper and a date still ahead", () => {
    const readModel = withPaperCameraReadyDeadlines(dataset, [accepted], now);
    const passed = paper("p2", {
      status: "accepted",
      venue: "NeurIPS 2026",
      camera_ready_due: "2026-11-07T11:59:00.000Z",
    });
    const curated = paper("p3", { status: "accepted", venue: "EMNLP 2026" });
    expect(
      cameraReadyCalendarEntries(
        [accepted, passed, curated],
        withPaperCameraReadyDeadlines(readModel, [passed], now),
        now,
      ),
    ).toEqual([
      { venue_key: "emnlp2026", venue: "EMNLP 2026", due: "2026-12-02T11:59:59.000Z" },
      { venue_key: "clear2027", venue: "CLeaR 2027", due: "2027-02-15T11:59:00.000Z" },
    ]);
  });

  it("proposes an attendee-less all-day hold on the AoE date", () => {
    const proposal = cameraReadyCalendarProposal(
      { venue_key: "clear2027", venue: "CLeaR 2027", due: "2027-02-15T11:59:00.000Z" },
      "lab-calendar@example.test",
    );
    expect(proposal).toMatchObject({
      type: "calendar.create_tentative_hold",
      target: { camera_ready_venue: "clear2027", camera_ready_due: "2027-02-15T11:59:00.000Z" },
      proposed_payload: {
        calendar_id: "lab-calendar@example.test",
        summary: "CLeaR 2027 camera-ready due (AoE)",
        from: "2027-02-14",
        to: "2027-02-15",
        all_day: true,
      },
      idempotency_key: "camera-ready-calendar:clear2027:2027-02-15T11:59:00.000Z",
    });
    expect(proposal.proposed_payload).not.toHaveProperty("attendees");
  });
});
