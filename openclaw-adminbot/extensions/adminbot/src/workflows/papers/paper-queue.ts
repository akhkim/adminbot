// What each paper needs from the PI next, read off OpenReview, for every venue at once.
//
// The OpenReview sync already records what the venue said (`openreview_sync`) and the PaperFlow
// ladder already knows which venue stage is still open. Neither put anything in front of her: an
// acceptance only emailed the first author, so a NeurIPS camera-ready could sit with nobody at
// the top of the lab knowing how many days were left. This turns those two facts into rows on her
// queue, one category per paper, ranked so the thing with a hard clock is read first:
//
//   camera_ready     accepted, and the camera-ready is not confirmed       -- a hard deadline
//   proofreading     headed to a venue whose submission deadline is near  -- a hard deadline
//   safety_impact    a safety-related impact statement waiting on her read
//   arxiv_release    the arXiv package waiting on her yes
//   under_review     submitted: reviews pending, rebuttal open, or decision pending
//   after_rejection  rejected: what changes before the next venue
//
// Nothing here is venue-specific. The status is OpenReview's, the stage is PaperFlow's, and the
// camera-ready date is the deadline dataset's row for the venue's family and year, so a venue the
// dataset has never heard of still gets a row -- just without a date.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import { isStaleDeadline } from "../../contracts/paper-feedback.js";
import {
  isAdminBotPaperAtPiGate,
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import type {
  AdminBotPaperflowEvidenceRecord,
  AdminBotPaperflowStage,
} from "../../contracts/paperflow-stages.js";
import { isPaperClosed } from "./paper-slots.js";
import { openPaperflowStage } from "./paperflow-stages.js";
import type { PiReviewRow } from "./pi-review.js";

export const paperQueueCategories = [
  "camera_ready",
  "proofreading",
  "safety_impact",
  "arxiv_release",
  "under_review",
  "after_rejection",
] as const;

export type PaperQueueCategory = (typeof paperQueueCategories)[number];

export const paperQueueCategoryLabels: Record<PaperQueueCategory, string> = {
  camera_ready: "Camera-ready",
  proofreading: "Proofreading",
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
  name?: unknown;
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
export function venueKey(label: string): { family: string; year: number } | undefined {
  const year = Number(/\b(20\d{2})\b/u.exec(label)?.[1]);
  const family = /[a-z]+/iu.exec(label.replace(/\b20\d{2}\b/gu, ""))?.[0]?.toLowerCase();
  return family && Number.isInteger(year) ? { family, year } : undefined;
}

/**
 * The dataset's AoE wall-clock time as an instant: "2026-10-01 23:59:59" AoE is 11:59:59Z the next
 * day. A value that carries its own offset (or Z) is already an instant and is read as one: the
 * stages a published deadline proposal adds are stored that way, and reading their wall clock as
 * AoE put the NeurIPS 2026 camera-ready (Nov 6 AoE, 2026-11-07T11:59Z) twelve hours late.
 */
export function aoeToIso(date: string, now?: Date, venueYear?: number): string | undefined {
  const trimmed = date.trim();
  if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(trimmed)) {
    const instant = Date.parse(trimmed);
    return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/u.exec(trimmed);
  if (!match) {
    return now ? yearlessAoeToIso(trimmed, now, venueYear) : undefined;
  }
  return wallClockAoe(match[1], match[2]);
}

function wallClockAoe(day: string, clock: string | undefined): string | undefined {
  const time = clock ? (clock.length === 5 ? `${clock}:00` : clock) : "23:59:59";
  const instant = Date.parse(`${day}T${time}-12:00`);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

/**
 * A month and day with no year ("11-06", "Nov 6", "6 November 23:59") as the next time that wall
 * clock comes round in AoE: this year if it is still ahead, otherwise next year (or the next leap
 * year, for February 29).
 *
 * Never a past year on its own. `Date.parse("Nov 6")` is 2001 in V8, which turned a date somebody
 * typed without a year into a deadline twenty-five years overdue. With the venue's year known, the
 * coming occurrence is taken only up to that year; past it, the venue's own occurrence is returned
 * even though it is gone, so a missed deadline reads as overdue instead of as next year's.
 */
export function yearlessAoeToIso(date: string, now: Date, venueYear?: number): string | undefined {
  const text = date.trim().toLowerCase().replace(/,/gu, " ");
  const clock = /(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*aoe)?$/u.exec(text)?.[1];
  const day = clock ? text.slice(0, text.lastIndexOf(clock)).trim() : text.replace(/\s*aoe$/u, "");
  let month: number | undefined;
  let dayOfMonth: number | undefined;
  const numeric = /^(\d{1,2})[-/](\d{1,2})$/u.exec(day);
  const named =
    /^([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/u.exec(day) ??
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\.?$/u.exec(day);
  if (numeric) {
    month = Number(numeric[1]);
    dayOfMonth = Number(numeric[2]);
  } else if (named) {
    const [word, digits] = /^\d/u.test(named[1]) ? [named[2], named[1]] : [named[1], named[2]];
    const index = MONTHS.findIndex((name) => word.startsWith(name));
    month = index >= 0 ? index + 1 : undefined;
    dayOfMonth = Number(digits);
  }
  if (!month || !dayOfMonth || month > 12 || dayOfMonth > 31) {
    return undefined;
  }
  const paddedClock = clock && /^\d:/u.test(clock) ? `0${clock}` : clock;
  const inYear = (year: number): string | undefined => {
    const isoDay = `${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
    const iso = wallClockAoe(isoDay, paddedClock);
    // Reject a rollover ("02-30" parsing as March 2): the date has to exist that year.
    return iso && new Date(Date.parse(iso) - 12 * 3_600_000).getUTCDate() === dayOfMonth
      ? iso
      : undefined;
  };
  // A venue's deadlines fall no later than the year it is named for, so its year caps the
  // search: NeurIPS 2026's "Oct 30" read in November 2026 is twelve days overdue, not a date in
  // 2027. Four years ahead at most otherwise, which is as far as February 29 can be.
  const last = Math.min(now.getUTCFullYear() + 4, venueYear ?? Number.POSITIVE_INFINITY);
  for (let year = now.getUTCFullYear(); year <= last; year += 1) {
    const iso = inYear(year);
    if (iso && Date.parse(iso) >= now.getTime()) {
      return iso;
    }
  }
  // Every occurrence up to the venue year is past: the venue year's own, read as overdue.
  return venueYear === undefined ? undefined : inYear(venueYear);
}

/**
 * Whether a venue's year is behind the current one. A conference is held in the year it is named
 * for, so "NeurIPS 2023" read in 2026 is a past cycle whatever its stage on the card says.
 */
export function isPastVenueYear(year: number | undefined, now: Date): boolean {
  return year !== undefined && year < now.getUTCFullYear();
}

/**
 * Why a row is history rather than something on her desk. A row with a reason is never dropped:
 * it moves to the queue's history list, which the desk keeps behind a toggle.
 *
 *   conference_held  the venue's conference has been held, so its camera-ready is over either way
 *   past_cycle       the venue's year is behind the current one
 *   stale_deadline   the hard deadline is more than STALE_DEADLINE_DAYS behind
 *   reviewed         a feedback request she has already answered, or a row she marked reviewed
 */
export type PaperQueueHistoryReason =
  | "conference_held"
  | "past_cycle"
  | "stale_deadline"
  | "reviewed";

/**
 * When the venue's main conference ends, as an ISO instant: the end of its last day in AoE, the
 * latest of the dataset's `conference` periods for the venue's family and year.
 *
 * Main-conference records only, workshop labels included: workshops are held alongside the main
 * conference and the dataset publishes no period of their own.
 */
export function conferenceEnd(venue: string, dataset: readonly unknown[]): string | undefined {
  const key = venueKey(venue);
  if (!key) {
    return undefined;
  }
  const ends: string[] = [];
  for (const raw of dataset) {
    const record = (raw ?? {}) as DatasetRecord;
    if (record.venue_type === "workshop" || record.entry_type === "workshop") {
      continue;
    }
    const recordKey = datasetRecordKey(record);
    if (recordKey?.family !== key.family || recordKey.year !== key.year) {
      continue;
    }
    for (const entry of Array.isArray(record.schedule) ? record.schedule : []) {
      const row = (entry ?? {}) as Record<string, unknown>;
      const day = /^\d{4}-\d{2}-\d{2}/u.exec(textOf(row.ends) || textOf(row.date))?.[0];
      const iso = row.milestone === "conference" && day ? wallClockAoe(day, undefined) : undefined;
      if (iso) {
        ends.push(iso);
      }
    }
  }
  return ends.toSorted().at(-1);
}

/**
 * Whether the venue's conference is over. Its camera-ready is then history whatever the card
 * says: the proceedings went out with the paper in them or without it, and an "N days overdue"
 * row for it is noise above the camera-readies she can still act on.
 */
export function isConferenceHeld(
  venue: string | undefined,
  dataset: readonly unknown[],
  now: Date,
): boolean {
  const end = venue ? conferenceEnd(venue, dataset) : undefined;
  return end !== undefined && Date.parse(end) < now.getTime();
}

/**
 * The venue a paper's conference questions are about: what OpenReview says, else the accepted
 * venue, else the target, with the accepted year added when the label carries none.
 */
export function paperVenueLabel(paper: AdminBotPaperRecord): string | undefined {
  const label = paper.openreview_sync?.venue ?? paper.accepted_venue ?? paper.venue;
  if (!label) {
    return undefined;
  }
  return venueKey(label) || paper.accepted_year === undefined
    ? label
    : `${label} ${paper.accepted_year}`;
}

/**
 * Whether the conference an accepted paper was presented at is over: held per the dataset, or a
 * past year's cycle. Its camera-ready and its talk deliverables are then done or moot, not late.
 */
export function isPaperConferenceOver(
  paper: AdminBotPaperRecord,
  dataset: readonly unknown[],
  now: Date,
): boolean {
  const accepted =
    paper.venue_decision === "accept" || paper.openreview_sync?.status === "accepted";
  if (!accepted) {
    return false;
  }
  const venue = paperVenueLabel(paper);
  const year = (venue ? venueKey(venue)?.year : undefined) ?? paper.accepted_year;
  return isPastVenueYear(year, now) || isConferenceHeld(venue, dataset, now);
}

/**
 * Slots that only make sense before the conference: the talk, the poster and the printed copy.
 * Once it has been held they are obsolete rather than missing. The arXiv and social-post slots
 * are not here on purpose: a paper is posted and announced after its conference as often as before.
 */
export const conferenceBoundSlots: ReadonlySet<AdminBotPaperSlot> = new Set<AdminBotPaperSlot>([
  "slides",
  "poster",
  "poster_physical",
  "talk_video",
]);

/** Whether a slot has stopped being wanted because the paper's conference is over. */
export function isSlotObsoleteAfterConference(
  slot: AdminBotPaperSlot,
  conferenceOver: boolean,
): boolean {
  return conferenceOver && conferenceBoundSlots.has(slot);
}

/** The arXiv steps in the order they happen. The PI's yes sits between the password and the post. */
const ARXIV_STEPS = ["arxiv_paper_password", "pi_approval", "arxiv"] as const;

/** The first arXiv step not yet provided or waived, or undefined once the abstract page is in. */
export function nextArxivStep(
  paper: AdminBotPaperRecord,
  slots: readonly AdminBotPaperSlotRecord[],
): (typeof ARXIV_STEPS)[number] | undefined {
  if (paper.artifacts?.arxiv_url?.trim()) {
    return undefined;
  }
  return ARXIV_STEPS.find(
    (name) =>
      !isAdminBotPaperSlotSettled(slots.find((row) => row.slot === name)?.status ?? "missing"),
  );
}

const arxivStepNotes: Record<(typeof ARXIV_STEPS)[number], string> = {
  arxiv_paper_password:
    "the first author adds the arXiv paper password, then it comes to you to approve",
  pi_approval: "your approval to post on arXiv",
  arxiv: "the first author posts it and adds the arXiv abstract page",
};

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
    const recordKey = datasetRecordKey(record);
    if (recordKey?.family !== key.family || recordKey.year !== key.year) {
      continue;
    }
    for (const entry of Array.isArray(record.schedule) ? record.schedule : []) {
      const row = (entry ?? {}) as Record<string, unknown>;
      const iso =
        row.milestone === "camera_ready" ? aoeToIso(textOf(row.date), now, key.year) : undefined;
      if (iso) {
        dates.push(iso);
      }
    }
  }
  const sorted = dates.toSorted();
  return sorted.find((iso) => Date.parse(iso) >= now.getTime()) ?? sorted.at(-1);
}

/**
 * A dataset record's venue family and year. The name is read too: a record published through a
 * deadline proposal can carry its year only there ("CLeaR 2027" grouped as "CLeaR"), and without
 * it no venue could ever match the record.
 */
function datasetRecordKey(record: DatasetRecord): { family: string; year: number } | undefined {
  const group = textOf(record.venue_group);
  return venueKey(`${textOf(record.venue_family) || group} ${group} ${textOf(record.name)}`);
}

/** How far ahead a submission deadline puts a paper on her queue for proofreading. */
export const PROOFREADING_WINDOW_DAYS = 45;
const SUBMISSION_MILESTONES = new Set([
  "direct_submission",
  "full_paper",
  "submission",
  "paper",
  "paper_submission",
]);

/**
 * The next submission deadline the dataset publishes for this venue, as an ISO instant, with the
 * record's name. Main-conference rows unless the label says workshop, as for the camera-ready.
 */
export function submissionDeadline(
  venue: string,
  dataset: readonly unknown[],
  now: Date,
): { deadline: string; name: string } | undefined {
  const key = venueKey(venue);
  if (!key) {
    return undefined;
  }
  const workshop = /workshop/iu.test(venue);
  let best: { deadline: string; name: string } | undefined;
  for (const raw of dataset) {
    const record = (raw ?? {}) as DatasetRecord & Record<string, unknown>;
    const group = textOf(record.venue_group);
    const isWorkshop =
      record.venue_type === "workshop" ||
      record.entry_type === "workshop" ||
      /workshop/iu.test(group);
    if (isWorkshop !== workshop || record.stale === true) {
      continue;
    }
    if (!SUBMISSION_MILESTONES.has(textOf(record.milestone))) {
      continue;
    }
    const recordKey = datasetRecordKey(record);
    if (recordKey?.family !== key.family || recordKey.year !== key.year) {
      continue;
    }
    const at = textOf(record.deadline_at);
    const deadline = aoeToIso(at || textOf(record.deadline_aoe), now, key.year);
    if (!deadline || Date.parse(deadline) < now.getTime()) {
      continue;
    }
    if (!best || deadline < best.deadline) {
      best = { deadline, name: textOf(record.name) || group || venue };
    }
  }
  return best;
}

/**
 * Papers headed to a venue whose submission deadline is within PROOFREADING_WINDOW_DAYS, so her
 * proofreading happens before the deadline rather than after it.
 *
 * Read off the card's target venue, because these papers are not on OpenReview yet: a submission
 * the sync has already seen at that venue leaves this list and is the OpenReview rows' business,
 * and so does a paper that already has a decision. A venue the dataset has no upcoming submission
 * deadline for gives no row -- there is no clock to put on it.
 */
export function proofreadingPaperQueue(
  candidates: readonly { paper: AdminBotPaperRecord }[],
  dataset: readonly unknown[],
  now: Date,
): PiReviewRow[] {
  return candidates.flatMap(({ paper }) => {
    const target = textOf(paper.venue);
    const key = target ? venueKey(target) : undefined;
    if (
      !key ||
      isPastVenueYear(key.year, now) ||
      paper.venue_decision === "accept" ||
      paper.venue_decision === "reject"
    ) {
      return [];
    }
    const synced = paper.openreview_sync ? venueKey(paper.openreview_sync.venue) : undefined;
    if (synced && synced.family === key.family && synced.year === key.year) {
      return [];
    }
    const due = submissionDeadline(target, dataset, now);
    if (!due) {
      return [];
    }
    const left = daysLeft(due.deadline, now);
    if (left > PROOFREADING_WINDOW_DAYS) {
      return [];
    }
    return [
      {
        paper_id: paper.id,
        title: paper.title,
        authors: paper.authors,
        venue: target,
        waiting_since: paper.updated_at,
        package_complete: true,
        category: "proofreading" as const,
        hard_deadline: due.deadline,
        days_left: left,
        proofreading: {
          venue: due.name,
          note: `Submission to ${due.name} is due ${due.deadline.slice(0, 10)}. Proofread before it goes in.`,
        },
      },
    ];
  });
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
 * paper is resubmitted or after AFTER_REJECTION_DAYS. A camera-ready that has gone out of date
 * (see openReviewPaperHistory) is left off here and listed there instead.
 */
export function openReviewPaperQueue(
  candidates: readonly PaperQueueCandidate[],
  dataset: readonly unknown[],
  now: Date,
): PiReviewRow[] {
  return openReviewRows(candidates, dataset, now).filter((row) => !row.history_reason);
}

/**
 * The camera-ready rows that have gone out of date, each with the reason it did: the venue's
 * conference was held, its cycle is a past year's, or its deadline is long gone. They leave the
 * queue but not the record, so the desk can show them under history.
 */
export function openReviewPaperHistory(
  candidates: readonly PaperQueueCandidate[],
  dataset: readonly unknown[],
  now: Date,
): PiReviewRow[] {
  return openReviewRows(candidates, dataset, now).filter((row) => row.history_reason);
}

function openReviewRows(
  candidates: readonly PaperQueueCandidate[],
  dataset: readonly unknown[],
  now: Date,
): PiReviewRow[] {
  return candidates.flatMap(({ paper, slots, evidence }): PiReviewRow[] => {
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
      // The venue's year, or the accepted year when OpenReview's label carries none ("NeurIPS
      // poster"). A past cycle's acceptance whose camera-ready nobody ticked on the card is not an
      // overdue item: the paper was published, and listing it buried the live camera-readies.
      // The same goes for a camera-ready whose conference has been held: EMNLP's was due in
      // August and the conference met in October, so in November it is over, not overdue.
      const year = venueKey(sync.venue)?.year ?? paper.accepted_year;
      const venue =
        venueKey(sync.venue) || year === undefined ? sync.venue : `${sync.venue} ${year}`;
      const deadline = cameraReadyDeadline(venue, dataset, now);
      const historyReason: PaperQueueHistoryReason | undefined = isPastVenueYear(year, now)
        ? "past_cycle"
        : isConferenceHeld(venue, dataset, now)
          ? "conference_held"
          : isStaleDeadline(deadline, now)
            ? "stale_deadline"
            : undefined;
      const cameraReady: PiReviewRow = {
        ...base,
        category: "camera_ready" as const,
        ...(deadline ? { hard_deadline: deadline, days_left: daysLeft(deadline, now) } : {}),
        ...(historyReason ? { history_reason: historyReason } : {}),
        openreview: {
          status: sync.status,
          stage: stage.stage,
          note: deadline
            ? `Accepted at ${sync.venue}. Camera-ready is due; make the post-acceptance changes.`
            : `Accepted at ${sync.venue}. No camera-ready date is published for this venue yet; check its site.`,
        },
      };
      // A held conference means the camera-ready is done, not late. When that row was the only
      // thing putting the paper in front of her, the next open step takes its place: arXiv. Not
      // when the paper is already at her gate (piReviewQueue lists that one), and with no hard
      // deadline, so nothing of the camera-ready's "N days overdue" carries over. A past cycle
      // with no published conference period (NeurIPS 2023) is not resurfaced: that is old work,
      // not a step she is waiting to take.
      const arxivStep =
        historyReason === "conference_held" ? nextArxivStep(paper, slots) : undefined;
      const arxivRow: PiReviewRow[] =
        arxivStep && !isPaperClosed(paper) && !isAdminBotPaperAtPiGate(slots)
          ? [
              {
                ...base,
                category: "arxiv_release" as const,
                package_complete: isAdminBotPaperSlotSettled(
                  slots.find((row) => row.slot === "arxiv_paper_password")?.status ?? "missing",
                ),
                openreview: {
                  status: sync.status,
                  note: `Camera-ready done; ${venue} has been held. Next is arXiv: ${arxivStepNotes[arxivStep]}.`,
                },
              },
            ]
          : [];
      return [cameraReady, ...arxivRow];
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
 * The whole queue in reading order: anything already past its hard deadline first, then category,
 * then the nearest hard deadline, then the longest wait. A row with no deadline sorts after every
 * dated row in its category.
 *
 * Overdue leads whatever its category. A camera-ready feedback request past its cutoff, or an
 * under-review revision whose submission cutoff has gone, is the most urgent thing on her desk,
 * and ranking it by category left it below every safety and arXiv row.
 */
export function rankPaperQueue(rows: readonly PiReviewRow[], now: Date): PiReviewRow[] {
  const deadlineOf = (row: PiReviewRow) => row.hard_deadline ?? row.feedback?.hard_deadline;
  const overdue = (row: PiReviewRow) => {
    const deadline = deadlineOf(row);
    return deadline !== undefined && Date.parse(deadline) < now.getTime() ? 0 : 1;
  };
  return rows.toSorted(
    (left, right) =>
      overdue(left) - overdue(right) ||
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
