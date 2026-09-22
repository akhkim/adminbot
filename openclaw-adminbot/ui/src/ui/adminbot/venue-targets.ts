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
import { DEADLINE_VENUES, type DeadlineVenue } from "./data/deadlines.ts";
import { parseVenue } from "./data/venue-catalog.ts";

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

// ── which venues the pre-registration board still cares about ────────────────────────────

/** A venue as the board offers it: what to call it, when it is due, and what it is waiting on. */
export type PreRegistrationVenue = {
  venue_id: string;
  label: string;
  /** AoE date of the submission deadline, when the deadline board knows one. */
  deadline?: string;
  /** True once submission has closed and the venue has not released decisions yet. */
  awaiting_results: boolean;
};

/**
 * The deadline-board rows that describe one venue. An id can name several (abstract, paper).
 *
 * The venue is matched as the *target* and the board row as the wanted id, not the other way
 * round, because only one of those two reliably carries a year. A venue derived from a paper's
 * declaration has a catalog id -- `ICLR-main` -- with the year in its label instead, so asking
 * "does row `iclr2027_paper` match `ICLR-main`" skipped the year check and matched every ICLR row
 * ever. A paper declaring "ICLR 2026" then produced a chip reading `ICLR 2026` that counted down
 * to ICLR *2027*'s deadline. Asking it in this direction gives the year on both sides.
 */
function deadlineRowsFor(venueId: string, label: string) {
  const asTarget = { venue_id: venueId, label, confidence: 0 };
  return DEADLINE_VENUES.filter((venue) => venueTargetMatches(asTarget, venue.id));
}

/**
 * When a venue stops being worth pre-registering for.
 *
 * The results date, not the submission deadline. A paper whose venue closed last week is still
 * live work -- the authors are waiting on a decision, and the board is where the lab reads what is
 * outstanding -- so dropping the row the moment submission closes hides exactly the papers whose
 * status is least settled. A venue that publishes no notification date falls back to its
 * submission deadline, which is the old behaviour and the best guess available.
 *
 * The latest across the venue's rows, because an abstract deadline and its full-paper deadline are
 * two rows describing one cycle and the cycle ends when the last of them resolves.
 */
export function venueOpenUntilMs(venueId: string, label = venueId): number | undefined {
  let latest: number | undefined;
  for (const venue of deadlineRowsFor(venueId, label)) {
    const instant = decisionInstantMs(venue) ?? aoeInstantMs(venue.deadline_aoe);
    if (Number.isFinite(instant)) {
      latest = latest === undefined ? instant : Math.max(latest, instant);
    }
  }
  return latest;
}

/**
 * When this row's decisions are due, or undefined when the venue has published no date for them.
 *
 * Three sources because the dataset carries the same fact three ways. `notification_aoe` is the
 * top-level field and 132 of the 163 rows have it -- but the two venues this board exists for do
 * not, and reading only that field left ICLR 2027 and ARR October falling back to their submission
 * deadlines, which is the behaviour this was meant to change. Both publish the date in `schedule`
 * instead: ICLR as a `notification` milestone ("Final decisions", 16 Dec), ARR as `cycle_end`
 * ("Cycle ends", 20 Dec), which is that route's equivalent -- an ARR cycle has no single decision
 * day, and when the cycle is over the bet is settled either way.
 *
 * `conference` is deliberately not one of them. A venue stops being a pre-registration once the
 * answer is known; what happens at the conference four months later belongs to the travel flow.
 */
function decisionInstantMs(venue: DeadlineVenue): number | undefined {
  const dates = [
    venue.notification_aoe?.trim(),
    ...venue.schedule
      .filter((entry) => entry.milestone === "notification" || entry.milestone === "cycle_end")
      .map((entry) => entry.date ?? entry.ends),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    // A milestone carries a bare day where the top-level field carries a full AoE timestamp.
    .map((value) => aoeInstantMs(/[ T]\d{2}:\d{2}/u.test(value) ? value : `${value} 23:59:59`))
    .filter((value) => Number.isFinite(value));
  return dates.length ? Math.max(...dates) : undefined;
}

/** The soonest submission deadline this venue still has ahead of it, else its last one. */
function submissionDeadlineOf(venueId: string, label: string, now: number): string | undefined {
  const dated = deadlineRowsFor(venueId, label)
    .map((venue) => ({ date: venue.deadline_aoe, at: aoeInstantMs(venue.deadline_aoe) }))
    .filter((entry) => Number.isFinite(entry.at))
    .toSorted((left, right) => left.at - right.at);
  const ahead = dated.find((entry) => entry.at >= now);
  return (ahead ?? dated.at(-1))?.date?.slice(0, 10);
}

/**
 * The venues the pre-registration board should offer.
 *
 * Two changes from simply listing the curated set. It keeps a venue until its **results** are out
 * rather than until its submission closes (see venueOpenUntilMs), and it includes every venue a
 * paper is actually aimed at, not only the three the picker offers. The second half is what makes
 * the board honest: a paper aimed at a venue outside the curated list matched no chip, so it was
 * absent from this table entirely while its own card showed the target.
 *
 * Still not the whole deadline board. A chip nothing is aimed at and nobody can pick is a row that
 * buries the ones the lab is working toward, which is the reason the curated list exists.
 */
export function openPreRegistrationVenues(
  papers: readonly AdminBotPaperRecord[],
  now = new Date(),
): PreRegistrationVenue[] {
  const at = now.getTime();
  const candidates: Array<{ venue_id: string; label: string }> = [...PRE_REGISTRATION_VENUES];
  for (const paper of papers) {
    for (const target of effectiveVenueTargets(paper)) {
      // Deduplicated with the same matcher the chips filter rows by, not by id. Two chips that
      // `venueTargetMatches` cannot tell apart -- "ARR August 2026" against the curated "ARR
      // October", which share a family and a year -- would each select the other's papers, so the
      // second one is a duplicate wearing a different name rather than a venue of its own. The
      // curated entry wins, because its label is what the lab calls the venue while a target's is
      // whatever the author typed into Add a project.
      if (!candidates.some((venue) => venueTargetMatches(target, venue.venue_id))) {
        candidates.push({ venue_id: target.venue_id, label: target.label });
      }
    }
  }
  return (
    candidates
      .flatMap((venue) => {
        const until = venueOpenUntilMs(venue.venue_id, venue.label);
        if (until === undefined || until < at) {
          return [];
        }
        const deadline = submissionDeadlineOf(venue.venue_id, venue.label, at);
        const due = deadline ? aoeInstantMs(`${deadline} 23:59:59`) : Number.NaN;
        return [
          {
            venue_id: venue.venue_id,
            label: venue.label,
            deadline,
            awaiting_results: Number.isFinite(due) && due < at,
          },
        ];
      })
      // Still-open submissions first and soonest-first inside that, then the ones being waited on.
      // The first group is work somebody can still act on; the second is work already handed over.
      .toSorted(
        (left, right) =>
          Number(left.awaiting_results) - Number(right.awaiting_results) ||
          (daysUntil(left.deadline, now) ?? Number.POSITIVE_INFINITY) -
            (daysUntil(right.deadline, now) ?? Number.POSITIVE_INFINITY) ||
          left.label.localeCompare(right.label),
      )
  );
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
