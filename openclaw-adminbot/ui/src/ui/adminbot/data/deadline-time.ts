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

// Remaining time as "Nd HH:MM:SS" (AoE deadlines can be same-day, so we always show
// hours:minutes:seconds instead of collapsing a due-today item to "0d"). Inside the last day the
// leading "0d" is dropped: it reads as a zero quantity when what it actually means is "today".
export function countdownLabel(ms: number): string {
  const left = Math.max(ms, 0);
  const d = Math.floor(left / MS_DAY);
  const h = Math.floor(left / 3_600_000) % 24;
  const m = Math.floor(left / 60_000) % 60;
  const s = Math.floor(left / 1000) % 60;
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

export type DeadlineEntry = { venue: DeadlineVenue; instant: number };

// "Major" is the conference's own submission deadline: `venue_type === "conference"`. The snapshot
// is 107 entries and 101 of them are workshops sharing a handful of instants, so including those
// would make a two-row summary permanently read "NeurIPS workshops, NeurIPS workshops". Rebuttals
// are excluded for the same reason they are not submissions -- they are work on a paper already in,
// not a deadline to aim a new one at. The full board still lists every one of them.
function isMajorConference(venue: DeadlineVenue): boolean {
  return venue.venue_type === "conference";
}

/**
 * The soonest upcoming major conference deadlines, one row per conference.
 *
 * Deduplicated by `venue_group` because a single conference can carry several dated entries (an
 * abstract deadline and a full-paper deadline, a main track and an ARR commitment). Two rows of
 * the same venue would answer "what is coming up" with one answer twice, so the earliest entry
 * represents its conference and the next distinct conference takes the second slot.
 */
export function upcomingMajorDeadlines(now: number, limit: number): DeadlineEntry[] {
  const upcoming = DEADLINE_VENUES.filter(isMajorConference)
    .map((venue) => ({ venue, instant: aoeInstantMs(venue.deadline_aoe) }))
    .filter((entry) => Number.isFinite(entry.instant) && entry.instant > now)
    .toSorted((a, b) => a.instant - b.instant);

  const seen = new Set<string>();
  const picked: DeadlineEntry[] = [];
  for (const entry of upcoming) {
    const key = (entry.venue.venue_group ?? "").trim() || entry.venue.name;
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
