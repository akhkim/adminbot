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
import { DEADLINE_VENUES } from "./data/deadlines.ts";
import { findVenue, formatVenue, parseVenue } from "./data/venue-catalog.ts";

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

/** Digit lookarounds, not \\b: board ids run the year onto the name (`iclr2027_paper`). */
const NAMES_A_YEAR = /(?<!\d)20\d{2}(?!\d)/u;

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

/**
 * Where a paper is going, counting the venue it has simply declared.
 *
 * Two fields say this and only one of them was ever read here. `venue_targets` is written by the
 * pre-registration dialog and, since recently, by the card's target picker. `artifacts.conference`
 * is the older field the venue selects have always written, and it is what most of the roster
 * carries: 127 papers name a conference and 23 carry a venue target. Reading only the second meant
 * a paper whose card plainly said "ICLR 2027" was absent from the pre-registration board, from the
 * banner's count, and from its own Pre-registered line.
 *
 * A declaration counts as a registration. There is no third thing an author does to turn one into
 * the other -- saying where the paper is going *is* the act -- so the declared venue is folded in
 * here rather than asked for again.
 *
 * Derived only when no explicit target already covers that venue, so an author who set 80% in the
 * dialog is not overruled by a 50% default inferred from the same conference.
 *
 * Read-only. Writers keep using readVenueTargets, because materialising an inference into stored
 * data on an unrelated save would turn a guess into a fact nobody made.
 */
export function effectiveVenueTargets(paper: AdminBotPaperRecord): VenueTarget[] {
  const explicit = readVenueTargets(paper);
  const declared = declaredVenueTarget(paper);
  if (!declared) {
    return explicit;
  }
  if (explicit.some((target) => venueTargetMatches(target, declared.venue_id))) {
    return explicit;
  }
  return [...explicit, declared].sort((left, right) => right.confidence - left.confidence);
}

/**
 * The venue named by `artifacts.conference`, as a target, or null when none is usable.
 *
 * Only when the declaration names a year. Without one there is no way to tell which cycle is
 * meant, and venueTargetMatches treats an unknown year as matching any -- so a bare "ARR", or the
 * twenty papers reading "ARR Acceptance, Committed to EMNLP Findings", would land on the board for
 * *this* October's ARR deadline. Those are finished commitments from a past cycle, and an upcoming
 * pre-registration board that lists them is worse than one that misses them.
 *
 * With the year required this derives exactly what it should on the current roster: the four
 * papers declaring "ICLR 2027", and nothing whose cycle is unstated or already over.
 */
function declaredVenueTarget(paper: AdminBotPaperRecord): VenueTarget | null {
  const raw = (paper.artifacts as Record<string, unknown> | undefined)?.conference;
  const conference = typeof raw === "string" ? raw.trim() : "";
  if (!conference || !NAMES_A_YEAR.test(conference)) {
    return null;
  }
  const odds = Number((paper.artifacts as Record<string, unknown> | undefined)?.confidence);
  return {
    // The catalog id where the string is one the catalog knows, so this target compares equal to
    // one the picker would have written; the raw text otherwise, which still matches by family.
    venue_id: parseVenue(conference).id ?? conference,
    label: conference,
    // Same default the Add a project form uses. A declared venue with no odds is still a plan,
    // and zero would render as "certainly not going".
    confidence: Number.isFinite(odds) && odds > 0 ? odds : 50,
  };
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
  return remaining >= 0 ? Math.ceil(remaining / 86_400_000) : -Math.ceil(-remaining / 86_400_000);
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
    (paper) => !effectiveVenueTargets(paper).some((target) => venueTargetMatches(target, venueId)),
  );
}

/**
 * Does this target already cover the venue the banner is asking about?
 *
 * Two id spaces write this field and they do not spell anything the same way. The pre-registration
 * dialog writes deadline-board ids -- `iclr2027_paper`, `arr_2026_october`. The Add a project form
 * writes venue-catalog ids -- `ICLR-main` -- and puts the year in the label instead. Comparing them
 * as strings meant only the dialog's own writes ever counted, so a member who picked a target venue
 * while adding a project was asked to pre-register a paper they had already aimed.
 *
 * So: exact id first, then the conference and the year, which is the pair both spaces do carry.
 * The year matters -- `iclr2027_paper` must not be answered by a paper aimed at ICLR 2026, which is
 * a different deadline that has already passed. A side that names no year is taken as matching,
 * because the alternative is going back to ignoring it.
 */
export function venueTargetMatches(target: VenueTarget, venueId: string): boolean {
  const wantedYear = venueYear(venueId);
  // The catalog id carries no year, so the label is where the target's year actually lives.
  const targetYear = venueYear(target.venue_id) ?? venueYear(target.label);
  // Years first, and they are decisive. `canonicalVenueId` resolves both `ICLR` and
  // `iclr2027_paper` to the same venue, so an id comparison alone returned true for a paper aimed
  // at ICLR 2026 when the board was asking about ICLR 2027 -- the year check below never ran. A
  // side that names no year still matches anything, which is what lets a bare venue name work.
  if (wantedYear !== undefined && targetYear !== undefined && wantedYear !== targetYear) {
    return false;
  }
  const wanted = canonicalVenueId(venueId);
  if (canonicalVenueId(target.venue_id) === wanted) {
    return true;
  }
  const wantedFamily = venueFamily(wanted);
  return Boolean(wantedFamily && venueFamily(canonicalVenueId(target.venue_id)) === wantedFamily);
}

/** The conference behind an id, without its track or year: the one part both spaces agree on. */
function venueFamily(value: string): string {
  return /^[a-z]+/u.exec(value.trim().toLowerCase())?.[0] ?? "";
}

/**
 * The four-digit year inside an id or label, if it names one.
 *
 * Digit lookarounds rather than `\b`: the deadline-board ids run the year straight onto the
 * conference (`iclr2027_paper`), where there is no word boundary to find, so a `\b` anchor read
 * every one of them as carrying no year at all -- and "no year" matches anything.
 */
function venueYear(value: string): number | undefined {
  const found = /(?<!\d)(20\d{2})(?!\d)/u.exec(value);
  return found ? Number(found[1]) : undefined;
}

export function canonicalVenueId(value: string): string {
  const candidate = value.trim().toLowerCase();
  for (const deadline of DEADLINE_VENUES) {
    if (deadline.venue_aliases.some((alias) => alias.toLowerCase() === candidate)) {
      return deadline.venue_id.toLowerCase();
    }
  }
  return candidate;
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

// ── the venue list on a paper card ───────────────────────────────────────────────────────
//
// The card used to ask "where is this going" with a single select, so the question could only
// ever be answered once: picking a second venue overwrote the first. Everything underneath was
// already a list -- `artifacts.venue_targets` is written as one by the pre-registration dialog
// and by Add a project, and a paper genuinely is 80% ICLR *and* 50% ARR October. Only the card
// was narrower than the data it edited.
//
// These helpers are that list in the shape the card's controls need: one row per venue, keyed so
// a checkbox in the dropdown can tick it, with the year and the odds pulled out of the stored
// target because those are the two things people come back to change.

/** The odds a venue takes when it is first ticked. Same default Add a project uses. */
export const DEFAULT_VENUE_CONFIDENCE = 50;

/** One venue on a card: a checkbox in the dropdown, and a row of selects under it. */
export type CardVenueTarget = {
  /**
   * What the checkbox is keyed by: the catalog id where the catalog can express this venue, the
   * stored id otherwise. Two ids per venue are in circulation (`ICLR` from the forms,
   * `iclr2027_paper` from the pre-registration dialog) and the menu can only tick one of them.
   */
  key: string;
  /** What the venue is called, year included -- "ICLR 2027". Written back as the target's label. */
  label: string;
  /** Lifted out of the label so the year select can move it. Null when the label names no year. */
  year: number | null;
  confidence: number;
  /** Not in the catalog: an ARR cycle, or a venue named before the catalog existed. */
  legacy: boolean;
};

/**
 * The venues a card should show as ticked.
 *
 * Reads the effective list, so a paper that only ever declared `artifacts.conference` arrives
 * with that venue ticked rather than with an empty dropdown over a card that plainly names one.
 */
export function cardVenueTargets(paper: AdminBotPaperRecord): CardVenueTarget[] {
  const rows: CardVenueTarget[] = [];
  for (const target of effectiveVenueTargets(paper)) {
    const row = asCardVenueTarget(target);
    // The list arrives sorted by confidence, so the first row for a venue is the stronger bet and
    // any later one is the duplicate -- which is exactly what the dialog and the card produce
    // between them when both write the same venue under different ids.
    if (!rows.some((held) => held.key === row.key)) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Resolve one stored target against the catalog.
 *
 * The label is where the catalog's own wording lives ("EMNLP 2026 (main)"); the id is a bare
 * catalog id when Add a project wrote it. Both are tried before giving up, because giving up
 * means the venue renders as its own ticked box rather than as the catalog row it actually is,
 * and the same venue would then be tickable twice.
 */
function asCardVenueTarget(target: VenueTarget): CardVenueTarget {
  const parsed = parseVenue(target.label);
  const catalogId = parsed.id ?? (findVenue(target.venue_id) ? target.venue_id : null);
  return {
    key: catalogId ?? target.venue_id,
    label: target.label || target.venue_id,
    year: parsed.year,
    confidence: target.confidence,
    legacy: catalogId === null,
  };
}

/** A venue just ticked in the dropdown, at the given year. */
export function newCardVenueTarget(key: string, year: number): CardVenueTarget {
  const label = formatVenue(key, year);
  return {
    key,
    label: label || key,
    year: label ? year : null,
    confidence: DEFAULT_VENUE_CONFIDENCE,
    legacy: !label,
  };
}

/** The card's rows, back in the stored shape. */
export function toVenueTargets(rows: readonly CardVenueTarget[]): VenueTarget[] {
  return rows.map((row) => ({
    venue_id: row.key,
    label: row.label,
    confidence: row.confidence,
  }));
}

/**
 * The one target the legacy pair can carry: the strongest bet.
 *
 * `artifacts.conference` and `artifacts.confidence` predate the list, and the deadline board, the
 * venue-stage nudges and the roster export still read them. They hold one venue, so they hold the
 * likeliest one -- and they are rewritten on every save rather than left behind, because a
 * conference left set after its venue was unticked comes straight back as a derived target (see
 * declaredVenueTarget) and the venue reappears on the card that just cleared it.
 */
export function primaryVenueTarget(rows: readonly CardVenueTarget[]): CardVenueTarget | undefined {
  return rows.toSorted((left, right) => right.confidence - left.confidence)[0];
}
