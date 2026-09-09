// The major conferences the lab might travel to, read off the deadline dataset.
//
// The dataset is organized around submission deadlines, not around events: 143 of its 157 rows are
// workshops and the other 14 are main-track and ARR cycle deadlines. Nothing in it is a record of
// "a conference is happening in Budapest in November". What it does carry, on every workshop row,
// is `parent_conference_key` and `conference_location` -- so the set of conferences the lab has
// business at is derivable, and that is what this builds.
//
// Derived rather than a second hand-maintained list for the obvious reason: a curated list of
// conferences goes stale the year nobody updates it, and the deadline dataset is already
// regenerated. What is *not* derivable is what a conference is -- the dataset has no prose about
// any venue -- so descriptions are a small static table below, keyed by venue family, with an
// honest fallback for anything not in it.

import type { AdminBotConferenceSummary } from "../../contracts/conference-trips.js";
import type { DeadlineWorkshopRecord } from "../papers/workshop-nudges.js";

/**
 * What each venue is, in one sentence a member deciding whether to go can use.
 *
 * Keyed by venue family as the dataset spells it, uppercased. Hand-written and deliberately short:
 * this is orientation for somebody who has not been, not a substitute for the call for papers,
 * which the homepage link covers. Anything absent gets the fallback below rather than a blank --
 * a card with no description reads as a broken card.
 */
const CONFERENCE_DESCRIPTIONS: Record<string, string> = {
  EMNLP:
    "Empirical Methods in Natural Language Processing. One of the three main ACL-family venues, " +
    "strongest on empirical and applied NLP work, with a large workshop programme attached.",
  ACL:
    "The Association for Computational Linguistics' flagship meeting, and the field's most " +
    "selective general venue. Broad scope across all of computational linguistics.",
  NAACL:
    "The ACL's North American chapter meeting. Same scope and standards as ACL, held in the " +
    "Americas, and often the easier of the two to reach for a lab based here.",
  AACL:
    "The ACL's Asia-Pacific chapter meeting, including IJCNLP. Broad NLP scope with a stronger " +
    "showing of work on Asian languages than the other ACL-family venues.",
  NEURIPS:
    "Neural Information Processing Systems. The largest machine-learning conference, spanning " +
    "theory, methods and applications, with a workshop programme bigger than most conferences.",
  ICLR:
    "International Conference on Learning Representations. Representation and deep learning, " +
    "with fully open review -- submissions, reviews and rebuttals are public.",
  ICML:
    "International Conference on Machine Learning. Core machine-learning methods and theory, " +
    "and the summer counterpart to NeurIPS.",
  AAAI:
    "The AAAI Conference on Artificial Intelligence. Broad AI scope well beyond learning, " +
    "including planning, reasoning and knowledge representation.",
  COLING:
    "International Conference on Computational Linguistics. Broad scope, and historically more " +
    "welcoming to linguistic and resource work than the ACL-family venues.",
  ARR: "ACL Rolling Review — the shared reviewing cycle the ACL-family venues commit papers from.",
};

/** Said rather than left blank: an empty description reads as a card that failed to load. */
function describe(family: string): string {
  return (
    CONFERENCE_DESCRIPTIONS[family.trim().toUpperCase()] ??
    "No description on file for this venue yet. The homepage link is the authority on scope and dates."
  );
}

/** AoE is noon-UTC-minus-twelve, the same reading the rest of the deadline code uses. */
function aoeInstant(value: string): number {
  return Date.parse(value.replace(" ", "T") + "-12:00");
}

/** "emnlp-2026" -> 2026. The key is the only place the year appears on a workshop row. */
function yearFromKey(key: string): number | undefined {
  const match = /(\d{4})/u.exec(key);
  return match ? Number(match[1]) : undefined;
}

/** "emnlp-2026" -> "EMNLP 2026", falling back to the group name the rows carry. */
function labelFor(key: string, venueGroup: string, family: string, year?: number): string {
  const trimmedFamily = family.trim();
  if (trimmedFamily && year) {
    return `${trimmedFamily} ${year}`;
  }
  // `venue_group` is "EMNLP 2026 Workshops" on a workshop row; the suffix is about the rows, not
  // about the conference somebody is deciding whether to fly to.
  const group = venueGroup.replace(/\s+Workshops$/iu, "").trim();
  return group || key;
}

/**
 * Every conference the deadline dataset knows the lab has business at, soonest deadline first.
 *
 * Built from the workshop rows because they are the only ones carrying `parent_conference_key` and
 * `conference_location`. That is also why a conference with no workshops in the dataset does not
 * appear: there is nothing in the data that says it exists as an event, and inventing a card for a
 * venue the lab has no deadline against would be a card nobody can act on.
 *
 * `now` filters the deadlines, not the conferences: a conference whose workshop calls have all
 * closed is still ahead of the lab and still worth signing up to attend, so it keeps its card and
 * simply names no next deadline. That is the difference between this and the workshop-nudge
 * schedule next door, which is about calls and drops a conference the moment they close.
 */
export function conferenceCatalog(
  records: readonly DeadlineWorkshopRecord[],
  now: Date,
): AdminBotConferenceSummary[] {
  const byKey = new Map<
    string,
    {
      key: string;
      family: string;
      venueGroup: string;
      location?: string;
      homepage?: string;
      workshopCount: number;
      nextDeadline?: { aoe: string; label: string };
    }
  >();

  for (const record of records) {
    if (record.entry_type !== "workshop" && record.venue_type !== "workshop") {
      continue;
    }
    const key = record.parent_conference_key?.trim();
    if (!key) {
      continue;
    }
    const entry = byKey.get(key) ?? {
      key,
      family: record.venue_family?.trim() || "",
      venueGroup: record.venue_group ?? "",
      workshopCount: 0,
      ...(record.conference_location?.trim()
        ? { location: record.conference_location.trim() }
        : {}),
    };
    entry.workshopCount += 1;
    // The conference's own homepage is not in the dataset; a workshop's is the closest thing, and
    // is deliberately not used as one. Only the parent-level fields are trusted here.
    const instant = aoeInstant(record.deadline_aoe);
    if (
      Number.isFinite(instant) &&
      instant > now.getTime() &&
      (!entry.nextDeadline || instant < aoeInstant(entry.nextDeadline.aoe))
    ) {
      entry.nextDeadline = {
        aoe: record.deadline_aoe,
        label: `${record.name} — ${record.deadline_label}`,
      };
    }
    byKey.set(key, entry);
  }

  return [...byKey.values()]
    .map((entry) => {
      const year = yearFromKey(entry.key);
      return {
        key: entry.key,
        label: labelFor(entry.key, entry.venueGroup, entry.family, year),
        family: entry.family,
        ...(year ? { year } : {}),
        ...(entry.location ? { location: entry.location } : {}),
        description: describe(entry.family || entry.key),
        ...(entry.homepage ? { homepage_url: entry.homepage } : {}),
        ...(entry.nextDeadline
          ? {
              next_deadline_aoe: entry.nextDeadline.aoe,
              next_deadline_label: entry.nextDeadline.label,
            }
          : {}),
        workshop_count: entry.workshopCount,
      } satisfies AdminBotConferenceSummary;
    })
    .toSorted((left, right) => {
      // A conference with an open call sorts by how soon it closes; one with none has nothing left
      // to be urgent about, so it falls to the bottom rather than to some invented date.
      const leftAt = left.next_deadline_aoe ? aoeInstant(left.next_deadline_aoe) : Infinity;
      const rightAt = right.next_deadline_aoe ? aoeInstant(right.next_deadline_aoe) : Infinity;
      return leftAt - rightAt || left.label.localeCompare(right.label);
    });
}

/** The bed count and the nights, from the trips that asked for one. */
export function lodgingNeedFrom(
  trips: ReadonlyArray<{
    member_id: string;
    intent: string;
    needs_lodging: boolean;
    arrival_on?: string;
    departure_on?: string;
  }>,
  nameOf: (memberId: string) => string,
): AdminBotConferenceSummary["roster"] extends infer R
  ? R extends { lodging: infer L }
    ? L
    : never
  : never {
  // Only people who are actually going. An undecided member who ticked "I'd want a bed" is a
  // maybe, and booking against maybes is how the lab pays for empty rooms.
  const wanting = trips.filter((trip) => trip.intent === "going" && trip.needs_lodging);
  const arrivals = wanting.map((trip) => trip.arrival_on).filter((v): v is string => Boolean(v));
  const departures = wanting
    .map((trip) => trip.departure_on)
    .filter((v): v is string => Boolean(v));
  return {
    guests: wanting.length,
    // Earliest in, latest out: one booking has to span everyone in it.
    ...(arrivals.length ? { first_night: arrivals.toSorted()[0] } : {}),
    ...(departures.length ? { last_night: departures.toSorted().at(-1) } : {}),
    members: wanting.map((trip) => ({
      member_id: trip.member_id,
      name: nameOf(trip.member_id),
      ...(trip.arrival_on ? { arrival_on: trip.arrival_on } : {}),
      ...(trip.departure_on ? { departure_on: trip.departure_on } : {}),
    })),
  };
}
