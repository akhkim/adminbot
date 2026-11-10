// Camera-ready deadlines for venues the lab actually has an accepted paper at.
//
// The deadline dataset is curated: a venue appears only once someone adds it to the collector, and
// a venue's camera-ready appears only once its official page is scraped. A NeurIPS acceptance whose
// camera-ready nobody had entered therefore had no date anywhere, and the PI queue said "No
// camera-ready date is published for this venue yet" while OpenReview showed the form with its due
// date on the paper's own forum.
//
// This module closes that gap without inventing anything. The OpenReview sync records the
// camera-ready due date the forum shows (`openreview_sync.camera_ready_due`); every accepted paper
// whose venue the dataset gives no camera-ready for becomes one deadline row for that venue. The
// row carries the venue and the date only -- never the paper's title or authors -- because the
// deadline read model is served on the public, login-free /deadlines.
//
// A curated or administrator-published camera-ready always wins: the row is only derived when the
// dataset has nothing for that venue and year.
import type { AdminBotActionProposal, AdminBotPaperRecord } from "../../contracts/actions.js";
import { cameraReadyDeadline, venueKey } from "./paper-queue.js";

const AOE_OFFSET_MS = 12 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The idempotency prefix every camera-ready calendar proposal carries. */
export const CAMERA_READY_CALENDAR_KEY_PREFIX = "camera-ready-calendar:";

type VenueGroup = {
  /** "neurips2026", or "neurips2026_workshop": one row and one calendar entry per group. */
  slug: string;
  /** The family as the venue spells it ("NeurIPS"), for display. */
  family: string;
  year: number;
  workshop: boolean;
};

function venueGroupOf(venue: string): VenueGroup | undefined {
  const key = venueKey(venue);
  if (!key) {
    return undefined;
  }
  const workshop = /workshop/iu.test(venue);
  const family =
    /[a-z]+/iu.exec(venue.replace(/\b20\d{2}\b/gu, ""))?.[0] ?? key.family.toUpperCase();
  return {
    slug: `${key.family}${key.year}${workshop ? "_workshop" : ""}`,
    family,
    year: key.year,
    workshop,
  };
}

function groupLabel(group: VenueGroup): string {
  return `${group.family} ${group.year}${group.workshop ? " Workshops" : ""}`;
}

/** "2026-11-06 23:59:59" for 2026-11-07T11:59:59Z: the AoE wall clock the dataset stores. */
function aoeWallClock(iso: string): string {
  return new Date(Date.parse(iso) - AOE_OFFSET_MS).toISOString().replace("T", " ").slice(0, 19);
}

function acceptedWithVenue(papers: readonly AdminBotPaperRecord[]) {
  return papers.flatMap((paper) => {
    const sync = paper.openreview_sync;
    const group = sync?.status === "accepted" ? venueGroupOf(sync.venue) : undefined;
    return sync && group ? [{ paper, sync, group }] : [];
  });
}

/**
 * One deadline row per venue where a lab paper was accepted, OpenReview shows its camera-ready
 * due date, and the dataset publishes no camera-ready for that venue and year. The earliest due
 * date wins when several papers report different ones, as the clock that runs out first.
 */
export function paperCameraReadyDeadlineRows(
  papers: readonly AdminBotPaperRecord[],
  dataset: readonly unknown[],
  now: Date,
): Record<string, unknown>[] {
  const earliest = new Map<string, { group: VenueGroup; due: string; observed: string }>();
  for (const { sync, group } of acceptedWithVenue(papers)) {
    const due = sync.camera_ready_due;
    if (!due || !Number.isFinite(Date.parse(due))) {
      continue;
    }
    if (cameraReadyDeadline(sync.venue, dataset, now)) {
      continue;
    }
    const observed = sync.observed_at ?? sync.applied_at;
    const current = earliest.get(group.slug);
    if (!current || Date.parse(due) < Date.parse(current.due)) {
      earliest.set(group.slug, { group, due: new Date(Date.parse(due)).toISOString(), observed });
    }
  }
  return [...earliest.values()]
    .toSorted((left, right) => left.group.slug.localeCompare(right.group.slug))
    .map(({ group, due, observed }) => {
      const id = `${group.slug}_camera_ready_openreview`;
      const label = groupLabel(group);
      const aoe = aoeWallClock(due);
      return {
        id,
        deadline_id: id,
        venue_id: id,
        venue_aliases: [id],
        name: label,
        venue_type: group.workshop ? "workshop" : "conference",
        venue_group: label,
        venue_family: group.family,
        entry_type: group.workshop ? "workshop" : "main_conference",
        archival_status: "unknown",
        venue_priority: "standard",
        archival: false,
        stale: false,
        milestone: "camera_ready",
        schedule: [
          { milestone: "camera_ready", label: "Camera-ready due", date: due, kind: "deadline" },
        ],
        deadline_label: "camera-ready",
        deadline_aoe: aoe,
        deadline_at: due,
        deadline_date: aoe.slice(0, 10),
        deadline_time_precision: "exact",
        deadline_source_kind: "openreview",
        deadline_source_status: "observed",
        deadline_extended: false,
        source_checked_at: observed,
        revisions: [],
      };
    });
}

/** The dataset with the venues only the lab's own accepted papers know about added to it. */
export function withPaperCameraReadyDeadlines(
  dataset: readonly unknown[],
  papers: readonly AdminBotPaperRecord[],
  now: Date,
): unknown[] {
  const rows = paperCameraReadyDeadlineRows(papers, dataset, now);
  if (!rows.length) {
    return [...dataset];
  }
  const taken = new Set(dataset.map((row) => (row as { id?: unknown })?.id));
  return [...dataset, ...rows.filter((row) => !taken.has(row.id))];
}

export type CameraReadyCalendarEntry = {
  /** Venue group slug, e.g. "neurips2026". */
  venue_key: string;
  venue: string;
  /** ISO instant. */
  due: string;
};

/**
 * The camera-ready deadlines that belong on the lab calendar: one per venue with an accepted lab
 * paper, from whichever source the read model has (curated, published or OpenReview), still ahead.
 */
export function cameraReadyCalendarEntries(
  papers: readonly AdminBotPaperRecord[],
  readModel: readonly unknown[],
  now: Date,
): CameraReadyCalendarEntry[] {
  const byVenue = new Map<string, CameraReadyCalendarEntry>();
  for (const { sync, group } of acceptedWithVenue(papers)) {
    const due = cameraReadyDeadline(sync.venue, readModel, now);
    if (!due || Date.parse(due) < now.getTime()) {
      continue;
    }
    const current = byVenue.get(group.slug);
    if (!current || Date.parse(due) < Date.parse(current.due)) {
      byVenue.set(group.slug, { venue_key: group.slug, venue: groupLabel(group), due });
    }
  }
  return [...byVenue.values()].toSorted((left, right) => left.due.localeCompare(right.due));
}

/**
 * The approval-gated proposal that puts one camera-ready deadline on the lab calendar: an all-day
 * event on the AoE date, with no attendees, so approving it notifies nobody. The same
 * `calendar.create_tentative_hold` the Calendar tab files for an attendee-less event.
 */
export function cameraReadyCalendarProposal(
  entry: CameraReadyCalendarEntry,
  calendarId: string,
): AdminBotActionProposal {
  const date = aoeWallClock(entry.due).slice(0, 10);
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  return {
    type: "calendar.create_tentative_hold",
    summary: `Add the ${entry.venue} camera-ready deadline to the lab calendar`,
    target: { camera_ready_venue: entry.venue_key, camera_ready_due: entry.due },
    proposed_payload: {
      calendar_id: calendarId,
      summary: `${entry.venue} camera-ready due (AoE)`,
      from: date,
      to: next,
      all_day: true,
      description: `Camera-ready deadline for the lab's accepted paper(s) at ${entry.venue}: ${aoeWallClock(entry.due)} AoE (${entry.due}).`,
    },
    rationale: `A lab paper was accepted at ${entry.venue}; its camera-ready is due ${date} AoE.`,
    undo_plan: "Delete the all-day event from the lab calendar.",
    idempotency_key: `${CAMERA_READY_CALENDAR_KEY_PREFIX}${entry.venue_key}:${entry.due}`,
  };
}
