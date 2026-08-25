// AoE date arithmetic and urgency banding for the bundled deadline snapshot.
//
// Extracted from views/deadlines.ts so the full board and the two-row summary on the profile page
// agree on what "3 days left" means. Both read DEADLINE_VENUES; only the presentation differs, and
// a countdown that disagreed between the two surfaces would read as a bug in the data.

import { DEADLINE_VENUES, type DeadlineVenue } from "./deadlines.ts";

export const MS_DAY = 86_400_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// AoE (UTC-12): a wall-clock deadline maps to its UTC instant + 12h.
export function aoeInstantMs(aoe: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(aoe);
  if (!m) {
    return Number.NaN;
  }
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) + 12 * 3600 * 1000;
}

// Display the AoE calendar date (not the +12h-shifted UTC date).
export function aoeDateLabel(aoe: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/u.exec(aoe);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : "";
}

// Keep the wall-clock part attached to its zone. A date by itself is ambiguous on the day it
// passes, because an AoE deadline remains open twelve hours after the same UTC calendar date.
export function aoeDateTimeLabel(aoe: string): string {
  const date = aoeDateLabel(aoe);
  const time = /[ T](\d{2}):(\d{2})/u.exec(aoe);
  return date && time ? `${date} · ${time[1]}:${time[2]} AoE` : date;
}

// Four bands rather than a gradient: a countdown is read as "can I still start this", and that
// question has a small number of distinct answers. Named for the token each one resolves to, so
// urgency is a design-system color and not a hex chosen per component.
export type Urgency = "critical" | "soon" | "planned" | "distant";

export function urgencyOf(instant: number, now: number): Urgency {
  const days = Math.floor((instant - now) / MS_DAY);
  if (days <= 3) {
    return "critical";
  }
  if (days <= 7) {
    return "soon";
  }
  if (days <= 30) {
    return "planned";
  }
  return "distant";
}

const pad = (n: number): string => String(n).padStart(2, "0");

// Remaining time as "Nd HH:MM:SS", including 0d on the final day so every board keeps one stable
// shape as the deadline approaches.
export function countdownLabel(ms: number): string {
  const left = Math.max(ms, 0);
  const d = Math.floor(left / MS_DAY);
  const h = Math.floor(left / 3_600_000) % 24;
  const m = Math.floor(left / 60_000) % 60;
  const s = Math.floor(left / 1000) % 60;
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${d}d ${clock}`;
}

export type DeadlineEntry = { venue: DeadlineVenue; instant: number };

// "Major" is a conference/track submission deadline, read from the generated entry type. Workshops
// dominate the snapshot and often share a handful of instants, so including them would make a
// two-row summary repeat one workshop group. Rebuttals
// are excluded for the same reason they are not submissions -- they are work on a paper already in,
// not a deadline to aim a new one at. The full board still lists every one of them.
function isMajorConference(venue: DeadlineVenue): boolean {
  return (
    venue.entry_type !== "workshop" &&
    venue.entry_type !== "rebuttal" &&
    venue.entry_type !== "other"
  );
}

/**
 * The soonest upcoming major conference deadlines, one row per conference.
 *
 * Deduplicated by `venue_group` because a single conference can carry several dated entries (an
 * abstract deadline and a full-paper deadline, a main track and an ARR commitment). Two rows of
 * the same venue would answer "what is coming up" with one answer twice, so the earliest entry
 * represents its conference and the next distinct conference takes the second slot.
 */
export function upcomingMajorDeadlines(
  now: number,
  limit: number,
  options: { archivalOnly?: boolean } = {},
): DeadlineEntry[] {
  const upcoming = allUpcomingConferences(now, options);
  const seen = new Set<string>();
  const picked: DeadlineEntry[] = [];
  for (const entry of upcoming) {
    const key = conferenceGroupKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    picked.push(entry);
    if (picked.length >= limit) {
      break;
    }
  }
  return picked;
}

/** The key that makes two dated rows the same conference. One conference, one slot on a summary. */
export function conferenceGroupKey(entry: DeadlineEntry): string {
  return (entry.venue.venue_group ?? "").trim() || entry.venue.name;
}

/**
 * Every upcoming conference deadline, soonest first and undeduplicated.
 *
 * `upcomingMajorDeadlines` is the "what is next" answer and stops at a limit. This is the whole
 * list, which is what a picker offering "add another conference" needs: the point of that control
 * is to reach the ones the summary did not have room for, so a helper that had already cut them
 * would be no use to it.
 *
 * `archivalOnly` narrows to venues that consume the paper. That is the split a member planning a
 * submission is actually making -- an archival deadline is a commitment, a workshop is an
 * opportunity -- and it is read off the flag the collector stamps rather than re-derived here.
 */
export function allUpcomingConferences(
  now: number,
  options: { archivalOnly?: boolean } = {},
): DeadlineEntry[] {
  return DEADLINE_VENUES.filter(isMajorConference)
    .filter((venue) => !options.archivalOnly || venue.archival_status === "archival")
    .map((venue) => ({ venue, instant: aoeInstantMs(venue.deadline_aoe) }))
    .filter((entry) => Number.isFinite(entry.instant) && entry.instant > now)
    .toSorted((a, b) => a.instant - b.instant);
}

/**
 * Every upcoming venue in the snapshot, conferences and workshops alike, soonest first.
 *
 * Not deduplicated by conference group, unlike the summary helpers: this backs a picker where the
 * reader is choosing one specific venue to put on their own timeline, and collapsing ninety-nine
 * NeurIPS workshops into one row would hide the ninety-eight they did not want and misname the one
 * they got.
 */
export function allUpcomingVenues(now: number): DeadlineEntry[] {
  return DEADLINE_VENUES.map((venue) => ({ venue, instant: aoeInstantMs(venue.deadline_aoe) }))
    .filter((entry) => Number.isFinite(entry.instant) && entry.instant > now)
    .toSorted((a, b) => a.instant - b.instant);
}
