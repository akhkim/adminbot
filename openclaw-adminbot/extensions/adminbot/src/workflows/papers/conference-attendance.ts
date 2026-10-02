// Who is going to which conference, derived rather than remembered.
//
// The attendee table was a free-text list somebody had to think to fill in: no row existed until
// an author typed a name into "Add an author", the nudge pass only ever chased rows that already
// existed, and `isCycleClosed` never looked at whether anybody had answered. An accepted paper
// where nobody touched the box therefore looked identical to one where every author had said no,
// and the lab had no way at all to ask "who is going to EMNLP" -- the question is about a
// conference and every row was about a paper.
//
// Both halves are fixed here by making the roll-call derived. The set of people who owe an answer
// is the paper's own author list, so it exists the moment the acceptance details are in; a stored
// row is an *answer* to that roll-call rather than the only evidence the person exists. Nothing is
// seeded into the store, so there is no backfill and no row to garbage-collect when an author is
// removed from a paper.
//
// External coauthors are on the roll-call, unlike the social-consent rows next door. The reason
// the consent rows exclude them -- AdminBot cannot reach them and has no standing to chase them --
// does not apply here: nobody asks the external author anything. The first author answers for
// everyone on the paper, which is what they were already doing by hand, and "the visiting coauthor
// is presenting the poster" is exactly the fact a conference roster exists to carry.

import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  adminBotAttendeeKey,
  type AdminBotAttendanceState,
  type AdminBotConferenceAttendeeRecord,
} from "../../contracts/paper-cycle.js";

/** One person the paper expects an answer about, before any answer has been given. */
export type ExpectedAttendee = {
  attendee_key: string;
  member_id?: string;
  name: string;
};

/**
 * Everyone the paper has to account for, in print order.
 *
 * `author_links` when the paper has them, because that is the recorded answer to "which roster row
 * does this printed name mean", and keying an attendee by member id survives a rename. A paper
 * filed before author linking existed still has `authors`, so the plain names are the fallback and
 * key by their folded-down spelling -- the same rule `adminBotAttendeeKey` already applies to
 * anybody typed in by hand, so the two agree on what counts as the same person twice.
 */
export function expectedConferenceAttendees(paper: AdminBotPaperRecord): ExpectedAttendee[] {
  const links = paper.author_links ?? [];
  const entries = links.length
    ? links.map((link) => ({ name: link.name, memberId: link.member_id }))
    : paper.authors.map((name) => ({ name, memberId: undefined as string | undefined }));
  const seen = new Set<string>();
  const expected: ExpectedAttendee[] = [];
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name) {
      continue;
    }
    const key = adminBotAttendeeKey(entry.memberId, name);
    // A name printed twice -- a co-first-author asterisk spelled two ways, an import that doubled
    // a row -- is one person owing one answer, not two.
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    expected.push({
      attendee_key: key,
      name,
      ...(entry.memberId ? { member_id: entry.memberId } : {}),
    });
  }
  return expected;
}

/**
 * The roll-call with the answers filled in: every author, plus anyone added by hand who is not one.
 *
 * Authors first and in print order, because that is the order the card should read in and the
 * order the first author is thinking in. The hand-added extras follow -- a lab member going to the
 * conference without being on this paper is a real thing to record, and dropping the row because
 * it matched no author would silently discard somebody's answer.
 */
export function mergeConferenceAttendance(
  paper: AdminBotPaperRecord,
  stored: readonly AdminBotConferenceAttendeeRecord[],
): AdminBotConferenceAttendeeRecord[] {
  const byKey = new Map(stored.map((row) => [row.attendee_key, row]));
  const merged: AdminBotConferenceAttendeeRecord[] = [];
  const used = new Set<string>();
  for (const entry of expectedConferenceAttendees(paper)) {
    used.add(entry.attendee_key);
    const answer = byKey.get(entry.attendee_key);
    merged.push({
      paper_id: paper.id,
      attending: "unknown",
      ...answer,
      attendee_key: entry.attendee_key,
      // The paper's own spelling wins over whatever was typed when the answer was recorded: an
      // author who keyed in as "ada lovelace" is the same row as "Ada Lovelace", and the card is
      // read next to the author list.
      name: entry.name,
      ...(entry.member_id ? { member_id: entry.member_id } : {}),
    });
  }
  for (const row of stored) {
    if (!used.has(row.attendee_key)) {
      merged.push(row);
    }
  }
  return merged;
}

/** The people on a paper who still owe an answer. Empty means its roll-call is complete. */
export function unansweredConferenceAttendees(
  paper: AdminBotPaperRecord,
  stored: readonly AdminBotConferenceAttendeeRecord[],
): AdminBotConferenceAttendeeRecord[] {
  return mergeConferenceAttendance(paper, stored).filter((row) => row.attending === "unknown");
}

// --- the conference roll-up --------------------------------------------------------------

/** One person's line on one paper at the conference. */
export type ConferenceAttendancePaper = {
  paper_id: string;
  title: string;
  attending: AdminBotAttendanceState;
};

/**
 * One person across every accepted paper at one conference.
 *
 * `attending` is the answer about the *trip*, resolved from the per-paper answers: one yes means
 * they are there, whatever the other papers say. That asymmetry is the point -- somebody with two
 * papers who is presenting one of them is going to the conference, and a roster that showed them
 * as unanswered because the second first author has not replied yet would be describing the
 * bookkeeping rather than the travel.
 */
export type ConferenceAttendancePerson = {
  attendee_key: string;
  member_id?: string;
  name: string;
  attending: AdminBotAttendanceState;
  papers: ConferenceAttendancePaper[];
};

/** One conference, and everyone the lab knows about at it. */
export type ConferenceAttendanceView = {
  /** Stable across spellings, so "EMNLP" and "emnlp " are one conference. */
  key: string;
  /** The venue as the papers spell it, from the earliest-created paper that names it. */
  venue: string;
  year: number;
  label: string;
  paper_count: number;
  /** Everyone on the roll-call, going first, then undecided, then the people staying home. */
  people: ConferenceAttendancePerson[];
  going_count: number;
  unanswered_count: number;
  /** Accepted papers here that still owe at least one answer, for the chase list. */
  papers_awaiting: Array<{ paper_id: string; title: string; unanswered: number }>;
};

/**
 * The key two spellings of the same conference have to agree on.
 *
 * Case and punctuation only. Nothing tries to know that "EMNLP" and "Conference on Empirical
 * Methods in NLP" are the same event: guessing that wrong merges two conferences into one roster,
 * which is worse than showing two rows an admin can see are the same.
 */
export function conferenceKey(venue: string, year: number): string {
  return `${venue
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "")}:${year}`;
}

/**
 * The trip key for one paper, or undefined when it has no conference yet.
 *
 * Gated on the same four acceptance details the rest of the conference branch is: before those are
 * in, the paper has no venue to travel to. Keyed by venue and year rather than by paper, because a
 * person with three papers at one conference takes one trip -- all three cards resolve to the same
 * key, so answering on one fills in the others.
 */
export function paperConferenceKey(paper: {
  venue_decision?: string;
  accepted_venue?: string;
  accepted_year?: number;
  is_archival?: boolean;
  presentation_type?: string;
}): string | undefined {
  if (
    paper.venue_decision !== "accept" ||
    !paper.accepted_venue?.trim() ||
    typeof paper.accepted_year !== "number" ||
    typeof paper.is_archival !== "boolean" ||
    !paper.presentation_type
  ) {
    return undefined;
  }
  return conferenceKey(paper.accepted_venue, paper.accepted_year);
}

/** "EMNLP 2026", without saying 2026 twice when the venue text already carries it. */
export function conferenceLabel(venue: string, year: number): string {
  const trimmed = venue.trim();
  return trimmed.includes(String(year)) ? trimmed : `${trimmed} ${year}`;
}

/** How a person's per-paper answers resolve into one answer about the trip. */
function resolveTripAttendance(
  papers: readonly ConferenceAttendancePaper[],
): AdminBotAttendanceState {
  if (papers.some((entry) => entry.attending === "yes")) {
    return "yes";
  }
  return papers.every((entry) => entry.attending === "no") ? "no" : "unknown";
}

const ATTENDANCE_ORDER: Record<AdminBotAttendanceState, number> = { yes: 0, unknown: 1, no: 2 };

/**
 * Every conference the lab has an accepted paper at, and who is going to each.
 *
 * Takes the papers already filtered to the ones whose conference branch is open -- the caller owns
 * that rule, because "accepted, with all four acceptance details in" is the same gate the nudge
 * pass and the card use, and a second copy of it here could drift from theirs.
 *
 * Sorted by year descending then label, so the conference somebody is about to travel to is at the
 * top rather than one from three years ago.
 */
export function buildConferenceAttendance(
  entries: ReadonlyArray<{
    paper: AdminBotPaperRecord;
    attendees: readonly AdminBotConferenceAttendeeRecord[];
  }>,
): ConferenceAttendanceView[] {
  const conferences = new Map<
    string,
    {
      venue: string;
      year: number;
      papers: Array<{ paper_id: string; title: string; unanswered: number }>;
      people: Map<string, ConferenceAttendancePerson>;
    }
  >();

  for (const entry of entries) {
    const venue = entry.paper.accepted_venue?.trim();
    const year = entry.paper.accepted_year;
    if (!venue || typeof year !== "number") {
      continue;
    }
    const key = conferenceKey(venue, year);
    let conference = conferences.get(key);
    if (!conference) {
      conference = { venue, year, papers: [], people: new Map() };
      conferences.set(key, conference);
    }
    const roll = mergeConferenceAttendance(entry.paper, entry.attendees);
    conference.papers.push({
      paper_id: entry.paper.id,
      title: entry.paper.title,
      unanswered: roll.filter((row) => row.attending === "unknown").length,
    });
    for (const row of roll) {
      const person = conference.people.get(row.attendee_key) ?? {
        attendee_key: row.attendee_key,
        name: row.name,
        attending: "unknown" as AdminBotAttendanceState,
        papers: [],
        ...(row.member_id ? { member_id: row.member_id } : {}),
      };
      person.papers.push({
        paper_id: entry.paper.id,
        title: entry.paper.title,
        attending: row.attending,
      });
      conference.people.set(row.attendee_key, person);
    }
  }

  return [...conferences.entries()]
    .map(([key, conference]) => {
      const people = [...conference.people.values()]
        .map((person) => ({ ...person, attending: resolveTripAttendance(person.papers) }))
        .toSorted(
          (a, b) =>
            ATTENDANCE_ORDER[a.attending] - ATTENDANCE_ORDER[b.attending] ||
            a.name.localeCompare(b.name),
        );
      return {
        key,
        venue: conference.venue,
        year: conference.year,
        label: conferenceLabel(conference.venue, conference.year),
        paper_count: conference.papers.length,
        people,
        going_count: people.filter((person) => person.attending === "yes").length,
        unanswered_count: people.filter((person) => person.attending === "unknown").length,
        papers_awaiting: conference.papers
          .filter((paper) => paper.unanswered > 0)
          .toSorted((a, b) => b.unanswered - a.unanswered || a.title.localeCompare(b.title)),
      };
    })
    .toSorted((a, b) => b.year - a.year || a.label.localeCompare(b.label));
}
