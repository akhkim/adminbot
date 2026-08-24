// Conference pre-registration: which venues a paper is aimed at, and how likely each is.
//
// The lab has always tracked this in a spreadsheet -- "100% ICLR", "90% ARR Aug", one row per
// paper. This is that column, in AdminBot, with two differences that matter: a paper can aim at
// more than one venue, and the odds are per venue rather than one number for the row. A paper
// genuinely can be 80% ICLR and 50% ARR October; those are independent bets on the same work,
// not a distribution that has to sum to anything.
//
// Stored as JSON in `artifacts.venue_targets`, the same free-form map that already carries the
// nudge log, blockers and confidence. The service merges artifacts on write, so writing this key
// never disturbs the rest, and it needs no schema change -- see nudge-alerts.ts, which made the
// same call for the same reason. When `paper_venue_targets` exists server-side this becomes a
// backfill, not a rewrite: the shape below is already the row shape.

import type { AdminBotPaperRecord } from "./controllers/admin.ts";
import { aoeInstantMs } from "./data/deadline-time.ts";

/** One bet: a venue, and how likely the authors think they will actually submit to it. */
export type VenueTarget = {
  /** Matches a `DEADLINE_VENUES` id where one exists, so the deadline board can line up. */
  venue_id: string;
  /** What to show. Held alongside the id so an old target still reads if the board moves on. */
  label: string;
  /** 30 | 50 | 80 | 99. Stored as a number so sorting does not have to parse it. */
  confidence: number;
};

/**
 * What members are offered, and deliberately not the whole deadline board.
 *
 * Offering the full board would bury the few deadlines the lab is actually working toward. This
 * is the curated set; "Other" is the escape hatch, and the board remains the place to browse all.
 */
export const PRE_REGISTRATION_VENUES: Array<{
  venue_id: string;
  label: string;
  /** AoE date, for the countdown. Absent for "Other", which has no one deadline. */
  deadline?: string;
}> = [
  { venue_id: "iclr2027_paper", label: "ICLR 2027", deadline: "2026-09-25" },
  { venue_id: "arr_2026_october", label: "ARR October", deadline: "2026-10-12" },
  { venue_id: "other", label: "Other" },
];

export const CONFIDENCE_CHOICES = [30, 50, 80, 99] as const;

const ARTIFACT_KEY = "venue_targets";

/**
 * Read the targets off a paper.
 *
 * Tolerant on purpose: this is free-form JSON in a shared map, so a hand-edited or half-written
 * value must degrade to "no targets" rather than break the page that renders it.
 */
export function readVenueTargets(paper: AdminBotPaperRecord): VenueTarget[] {
  const raw = (paper.artifacts as Record<string, unknown> | undefined)?.[ARTIFACT_KEY];
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is VenueTarget => {
        const row = entry as Partial<VenueTarget> | null;
        return (
          !!row &&
          typeof row.venue_id === "string" &&
          typeof row.label === "string" &&
          typeof row.confidence === "number"
        );
      })
      .sort((left, right) => right.confidence - left.confidence);
  } catch {
    return [];
  }
}

/** The value to write back into `artifacts.venue_targets`. Empty clears the key. */
export function serializeVenueTargets(targets: VenueTarget[]): string {
  return targets.length === 0 ? "" : JSON.stringify(targets);
}

/** "80% ICLR 2027 · 50% ARR October" — highest bet first, the way the spreadsheet reads. */
export function formatVenueTargets(targets: VenueTarget[]): string {
  return targets.map((target) => `${target.confidence}% ${target.label}`).join(" · ");
}

/** Whole days until a deadline, or undefined when the venue has none. Negative once past. */
export function daysUntil(deadline: string | undefined, now = new Date()): number | undefined {
  if (!deadline) {
    return undefined;
  }
  const due = aoeInstantMs(`${deadline} 23:59:59`);
  if (!Number.isFinite(due)) {
    return undefined;
  }
  const remaining = due - now.getTime();
  return remaining >= 0
    ? Math.ceil(remaining / 86_400_000)
    : -Math.ceil(-remaining / 86_400_000);
}

/**
 * The venue the banner should shout about: the soonest deadline still ahead.
 *
 * One at a time. A banner naming three deadlines is a list, and a list is something people learn
 * to scroll past -- the whole point of this surface is that it is impossible to miss.
 */
export function nextDeadlineVenue(now = new Date()) {
  return PRE_REGISTRATION_VENUES.filter((venue) => venue.deadline)
    .map((venue) => ({ venue, days: daysUntil(venue.deadline, now) as number }))
    .filter((entry) => entry.days >= 0)
    .sort((left, right) => left.days - right.days)[0];
}

/**
 * Papers this member could still pre-register for that venue.
 *
 * Already-registered papers are excluded rather than shown ticked: the banner is a prompt to do
 * something, and a prompt that keeps asking about work already done is how people learn to
 * ignore it.
 */
export function papersNeedingRegistration(
  papers: AdminBotPaperRecord[],
  venueId: string,
): AdminBotPaperRecord[] {
  return papers.filter(
    (paper) => !readVenueTargets(paper).some((target) => target.venue_id === venueId),
  );
}

// ── the venue picker on a paper card ─────────────────────────────────────────────────────
//
// Two sections, because two different questions are being answered. The top is "what is due
// next", which needs dates and is short by construction. The rest is "where might this go",
// which needs names and nothing else -- a paper aimed at COLM in March does not benefit from
// seeing a date twelve months out, and dating everything is what buried ICLR under fifty
// workshop commitment deadlines in the first place.
//
// ARR is here despite being marked non-archival in the deadline dataset: it is the front door
// for every *ACL venue and the most common thing this lab submits to, so filtering on `archival`
// -- which is what the old picker did -- dropped the single most useful row.

/** The imminent ones, with their real deadlines. Kept to two: it is a prompt, not a calendar. */
export const DATED_VENUE_CHOICES = [
  { value: "ICLR 2027", label: "ICLR 2027", note: "abstract 18 Sep · paper 25 Sep 2026" },
  { value: "ARR October 2026", label: "ARR October 2026", note: "submission 12 Oct 2026" },
];

/** Everything else, by name. Grouped the way people talk about them. */
export const VENUE_FAMILIES: Array<{ group: string; venues: string[] }> = [
  {
    group: "Machine learning",
    venues: ["NeurIPS", "ICML", "ICLR", "COLM", "AAAI", "IJCAI"],
  },
  {
    group: "NLP",
    venues: ["ARR", "ACL", "EMNLP", "NAACL", "EACL"],
  },
  {
    group: "Journals",
    venues: ["TACL", "TMLR", "Nature"],
  },
];
