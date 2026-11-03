// What each paper needs from the PI next, read off OpenReview, for every venue at once.
//
// The OpenReview sync already records what the venue said (`openreview_sync`) and the PaperFlow
// ladder already knows which venue stage is still open. Neither put anything in front of her: an
// acceptance only emailed the first author, so a NeurIPS camera-ready could sit with nobody at
// the top of the lab knowing how many days were left. This turns those two facts into rows on her
// queue, one category per paper, ranked so the thing with a hard clock is read first:
//
//   camera_ready     accepted, and the camera-ready is not confirmed       -- a hard deadline
//   safety_impact    a safety-related impact statement waiting on her read
//   arxiv_release    the arXiv package waiting on her yes
//   under_review     submitted: reviews pending, rebuttal open, or decision pending
//   after_rejection  rejected: what changes before the next venue
//
// Nothing here is venue-specific. The status is OpenReview's, the stage is PaperFlow's, and the
// camera-ready date is the deadline dataset's row for the venue's family and year, so a venue the
// dataset has never heard of still gets a row -- just without a date.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import type {
  AdminBotPaperflowEvidenceRecord,
  AdminBotPaperflowStage,
} from "../../contracts/paperflow-stages.js";
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import { openPaperflowStage } from "./paperflow-stages.js";
import type { PiReviewRow } from "./pi-review.js";

export const paperQueueCategories = [
  "camera_ready",
  "safety_impact",
  "arxiv_release",
  "under_review",
  "after_rejection",
] as const;

export type PaperQueueCategory = (typeof paperQueueCategories)[number];

export const paperQueueCategoryLabels: Record<PaperQueueCategory, string> = {
  camera_ready: "Camera-ready",
  safety_impact: "Safety impact",
  arxiv_release: "arXiv release",
  under_review: "Under review",
  after_rejection: "After rejection",
};

/** How long a rejection stays on her queue. After that the next venue is the authors' plan. */
const AFTER_REJECTION_DAYS = 45;
const DAY_MS = 86_400_000;

export type PaperQueueCandidate = {
  paper: AdminBotPaperRecord;
  slots: readonly AdminBotPaperSlotRecord[];
  evidence: readonly AdminBotPaperflowEvidenceRecord[];
};

type DatasetRecord = {
  venue_type?: unknown;
  entry_type?: unknown;
  venue_group?: unknown;
  venue_family?: unknown;
  schedule?: unknown;
};

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** "NeurIPS 2026", "ICLR 2027 Conference" -> { family: "neurips", year: 2026 }. */
function venueKey(label: string): { family: string; year: number } | undefined {
  const year = Number(/\b(20\d{2})\b/u.exec(label)?.[1]);
  const family = /[a-z]+/iu.exec(label.replace(/\b20\d{2}\b/gu, ""))?.[0]?.toLowerCase();
  return family && Number.isInteger(year) ? { family, year } : undefined;
}

/** The dataset's AoE wall-clock time as an instant: "2026-10-01 23:59:59" AoE is 11:59:59Z the next day. */
function aoeToIso(date: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/u.exec(date);
  if (!match) {
    return undefined;
  }
  const time = match[2] ? (match[2].length === 5 ? `${match[2]}:00` : match[2]) : "23:59:59";
  const instant = Date.parse(`${match[1]}T${time}-12:00`);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

/**
 * The camera-ready deadline the dataset publishes for this venue, as an ISO instant.
 *
 * A venue has several (main, Findings, demos, workshops); the main conference's is the one an
 * OpenReview acceptance means unless the label says workshop. Of those, the earliest still ahead,
 * because that is the clock that runs out first -- or, when all are past, the latest, so an
 * overdue camera-ready reads as overdue rather than as undated.
 */
export function cameraReadyDeadline(
  venue: string,
  dataset: readonly unknown[],
  now: Date,
): string | undefined {
  const key = venueKey(venue);
  if (!key) {
    return undefined;
  }
  const workshop = /workshop/iu.test(venue);
  const dates: string[] = [];
  for (const raw of dataset) {
    const record = (raw ?? {}) as DatasetRecord;
    const group = textOf(record.venue_group);
    const isWorkshop =
      record.venue_type === "workshop" ||
      record.entry_type === "workshop" ||
      /workshop/iu.test(group);
    if (isWorkshop !== workshop || /demo/iu.test(textOf(record.entry_type))) {
      continue;
    }
    const recordKey = venueKey(`${textOf(record.venue_family) || group} ${group}`);
    if (recordKey?.family !== key.family || recordKey.year !== key.year) {
      continue;
    }
    for (const entry of Array.isArray(record.schedule) ? record.schedule : []) {
      const row = (entry ?? {}) as Record<string, unknown>;
      const iso = row.milestone === "camera_ready" ? aoeToIso(textOf(row.date)) : undefined;
      if (iso) {
        dates.push(iso);
      }
    }
  }
  const sorted = dates.toSorted();
  return sorted.find((iso) => Date.parse(iso) >= now.getTime()) ?? sorted.at(-1);
}

/** Whole days until the deadline, rounded down; negative once it has passed. */
export function daysLeft(deadline: string, now: Date): number {
  return Math.floor((Date.parse(deadline) - now.getTime()) / DAY_MS);
}

function forumUrl(paper: AdminBotPaperRecord): string | undefined {
  const id = paper.openreview_sync?.submission_id ?? paper.openreview_sync?.reference;
  return id ? `https://openreview.net/forum?id=${encodeURIComponent(id)}` : undefined;
}

const reviewStageNotes: Partial<Record<AdminBotPaperflowStage, string>> = {
  reviews_out: "Submitted; reviews are not out yet.",
  rebuttal: "Reviews are out; the rebuttal has not been accounted for.",
  decision: "Rebuttal done; waiting on the decision.",
};

/**
 * One row per paper OpenReview has something to say about, in the category it belongs to.
 *
 * Only papers the sync has touched: this is the OpenReview reading, and a paper nobody has
 * submitted anywhere has nothing for the venue to decide. Accepted papers leave once the
 * camera-ready is confirmed; under-review papers leave on a decision; rejections leave when the
 * paper is resubmitted or after AFTER_REJECTION_DAYS.
 */
export function openReviewPaperQueue(
  candidates: readonly PaperQueueCandidate[],
  dataset: readonly unknown[],
  now: Date,
): PiReviewRow[] {
  return candidates.flatMap(({ paper, slots, evidence }) => {
    const sync = paper.openreview_sync;
    if (!sync) {
      return [];
    }
    const url = forumUrl(paper);
    const base = {
      paper_id: paper.id,
      title: paper.title,
      authors: paper.authors,
      venue: sync.venue,
      waiting_since: sync.applied_at,
      package_complete: true,
      ...(url ? { drive_pdf_url: url } : {}),
    };

    if (sync.status === "rejected" || sync.status === "desk_rejected") {
      const since = Date.parse(sync.applied_at);
      if (
        paper.venue_decision !== "reject" ||
        !Number.isFinite(since) ||
        now.getTime() - since > AFTER_REJECTION_DAYS * DAY_MS
      ) {
        return [];
      }
      const what = sync.status === "desk_rejected" ? "Desk rejected" : "Rejected";
      return [
        {
          ...base,
          category: "after_rejection" as const,
          openreview: {
            status: sync.status,
            note: `${what} at ${sync.venue}. Decide what changes before the next venue; the reviews are on OpenReview.`,
          },
        },
      ];
    }

    const stage = openPaperflowStage({ paper, slots, evidence, now });
    if (sync.status === "accepted") {
      if (stage?.stage !== "camera_ready") {
        return [];
      }
      const deadline = cameraReadyDeadline(sync.venue, dataset, now);
      return [
        {
          ...base,
          category: "camera_ready" as const,
          ...(deadline ? { hard_deadline: deadline, days_left: daysLeft(deadline, now) } : {}),
          openreview: {
            status: sync.status,
            stage: stage.stage,
            note: deadline
              ? `Accepted at ${sync.venue}. Camera-ready is due; make the post-acceptance changes.`
              : `Accepted at ${sync.venue}. No camera-ready date is published for this venue yet; check its site.`,
          },
        },
      ];
    }

    const note = stage ? reviewStageNotes[stage.stage] : undefined;
    if (sync.status !== "under_review" || !stage || !note) {
      return [];
    }
    return [
      {
        ...base,
        category: "under_review" as const,
        openreview: { status: sync.status, stage: stage.stage, note: `${sync.venue}: ${note}` },
      },
    ];
  });
}

const categoryRank = new Map(paperQueueCategories.map((category, index) => [category, index]));

/**
 * The whole queue in reading order: category first, then the nearest hard deadline, then the
 * longest wait. A row with no deadline sorts after every dated row in its category.
 */
export function rankPaperQueue(rows: readonly PiReviewRow[]): PiReviewRow[] {
  const deadlineOf = (row: PiReviewRow) => row.hard_deadline ?? row.feedback?.hard_deadline;
  return rows.toSorted(
    (left, right) =>
      (categoryRank.get(left.category) ?? 99) - (categoryRank.get(right.category) ?? 99) ||
      (deadlineOf(left) ?? "9999").localeCompare(deadlineOf(right) ?? "9999") ||
      (left.waiting_since ?? "9999").localeCompare(right.waiting_since ?? "9999") ||
      left.paper_id.localeCompare(right.paper_id),
  );
}

/** What she is told, once, when OpenReview reports an acceptance. */
export function buildCameraReadyNotice(row: PiReviewRow): { title: string; body: string } {
  const due =
    row.hard_deadline === undefined
      ? "No camera-ready date is published for this venue yet."
      : `Camera-ready is due ${row.hard_deadline.slice(0, 10)} (${
          (row.days_left ?? 0) < 0
            ? `${-(row.days_left ?? 0)} days overdue`
            : `${row.days_left} days left`
        }).`;
  return {
    title: `Accepted at ${row.venue ?? "a venue"}: camera-ready`,
    body: [
      `"${row.title}" (${row.authors.join(", ")}) was accepted, per OpenReview.`,
      due,
      "It is at the top of My Desk, under camera-ready.",
    ].join("\n\n"),
  };
}
