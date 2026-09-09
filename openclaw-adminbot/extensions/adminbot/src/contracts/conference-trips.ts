// Who is going to a conference in person, what they need the lab to pay for, and where they sleep.
//
// Distinct from the per-paper attendance roll-call in paper-cycle.ts, and the distinction is the
// whole reason this exists. That one answers "is this author accounted for on this paper" -- it is
// bookkeeping the first author fills in, one row per author per paper, and its unit is the paper.
// This one is the member's own statement about their own trip: one row per person per conference,
// written by them, carrying the things only they know. A member with three accepted papers at
// EMNLP takes one trip and needs one bed.
//
// Everything here is asked rather than inferred. The lab cannot work out from a paper record
// whether somebody already has funding from their scholarship, whether they are staying with
// family in Budapest, or whether they need a visa letter six weeks in advance -- and guessing any
// of it produces either a bed nobody sleeps in or a member who quietly pays their own airfare.

/**
 * Whether the member is going, in their own words.
 *
 * `undecided` is a real answer and the default is *no row at all*, which is a different thing:
 * nobody has asked yet. Keeping them apart is what lets the roster say "four of nine have not
 * replied" instead of counting silence as a no and booking too small.
 */
export const adminBotConferenceTripIntents = ["going", "not_going", "undecided"] as const;

export type AdminBotConferenceTripIntent = (typeof adminBotConferenceTripIntents)[number];

/**
 * What the member needs the lab to cover.
 *
 * Four answers, ordered by what they cost the lab, and deliberately not a set of independent
 * checkboxes. "Registration and flights but not the hotel" is a real shape, but every extra
 * combination is another cell in the budget table and another thing to get wrong; the lab's
 * question is which of four buckets somebody is in, and `notes` carries the exception.
 *
 * `none` is worth asking for explicitly rather than reading off a blank: a member funded by their
 * own scholarship looks identical to one who has not answered, and the difference is a plane
 * ticket.
 */
export const adminBotConferenceFundingNeeds = [
  "none",
  "fee_only",
  "flight_only",
  "full_travel",
] as const;

export type AdminBotConferenceFundingNeed = (typeof adminBotConferenceFundingNeeds)[number];

/** One member's plan for one conference. Their statement, and only ever theirs to write. */
export type AdminBotConferenceTripRecord = {
  /** The conference key from the deadline dataset, e.g. `emnlp-2026`. */
  conference_key: string;
  member_id: string;
  intent: AdminBotConferenceTripIntent;
  funding: AdminBotConferenceFundingNeed;
  /**
   * Whether they want a bed in whatever the lab books.
   *
   * Separate from `funding` on purpose. Somebody who needs no money at all may still want to be in
   * the lab's house -- sharing is how a first-timer ends up with people to walk in with -- and
   * somebody on full travel may be staying with family. Folding the two together would size the
   * booking off the budget, which is the wrong number.
   */
  needs_lodging: boolean;
  /**
   * The nights they need covered, as YYYY-MM-DD.
   *
   * Both are required to size a booking and neither can be inferred: a conference runs five days
   * and people arrive the night before, leave the morning after, or stay the weekend. Without the
   * span the lab knows how many beds and not for how long, which books the wrong thing.
   */
  arrival_on?: string;
  departure_on?: string;
  /**
   * A visa invitation letter, which somebody has to sign weeks ahead.
   *
   * Asked because the lab spans continents and this is the one item on the list with a lead time
   * longer than the booking. A member who needs one and says so in the week before the conference
   * has already missed it.
   */
  needs_visa_letter: boolean;
  /**
   * The paper they are presenting, when they are presenting one.
   *
   * Optional and deliberately so: people go to conferences without presenting, and a required
   * field here would either block them from signing up or collect a fiction.
   */
  paper_id?: string;
  /** Anything the four buckets above cannot say. Free text, read by a person. */
  notes?: string;
  updated_at: string;
};

/**
 * What the lab has to book, derived from the rows above.
 *
 * The lodging headcount is the answer to "how big an Airbnb", and it counts only people who both
 * said they are going *and* asked for a bed -- an undecided member is not a bed, and counting them
 * as one is how the lab ends up paying for empty rooms.
 */
export type AdminBotConferenceLodgingNeed = {
  /** People who want a bed. */
  guests: number;
  /** Earliest arrival and latest departure across those people, so the booking spans everyone. */
  first_night?: string;
  last_night?: string;
  /** Who they are, for the person doing the booking. */
  members: Array<{ member_id: string; name: string; arrival_on?: string; departure_on?: string }>;
};

/** One conference as the overview tab draws it: the facts, plus what the lab has committed to. */
export type AdminBotConferenceSummary = {
  key: string;
  /** "EMNLP 2026". */
  label: string;
  /** The venue family, e.g. `EMNLP`, used to look up the description. */
  family: string;
  year?: number;
  location?: string;
  description: string;
  /** Where to read more, when the dataset carries a homepage. */
  homepage_url?: string;
  /** The next submission deadline still open under this conference, for context on the card. */
  next_deadline_aoe?: string;
  next_deadline_label?: string;
  workshop_count: number;
  /** Headcounts, admin-only. A member sees their own row and nothing about anybody else. */
  roster?: {
    going: number;
    not_going: number;
    undecided: number;
    /** Funding asks, so the card can say what this conference costs before anybody books. */
    funding: Record<AdminBotConferenceFundingNeed, number>;
    visa_letters: number;
    lodging: AdminBotConferenceLodgingNeed;
    trips: Array<AdminBotConferenceTripRecord & { member_name: string; paper_title?: string }>;
  };
};

export function isAdminBotConferenceTripIntent(
  value: string,
): value is AdminBotConferenceTripIntent {
  return (adminBotConferenceTripIntents as readonly string[]).includes(value);
}

export function isAdminBotConferenceFundingNeed(
  value: string,
): value is AdminBotConferenceFundingNeed {
  return (adminBotConferenceFundingNeeds as readonly string[]).includes(value);
}
