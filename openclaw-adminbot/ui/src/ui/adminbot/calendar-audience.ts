// Who gets invited, worked out from what the roster already knows about people.
//
// The lab's real invite questions are not "pick names from a list" — they are "everyone writing for
// NeurIPS", "everyone actually in Toronto next week", "everyone whose home base is Toronto whether
// or not they are there now". Those are three different answers and the roster holds all three, so
// this module turns each one into a filter rather than making the operator remember who is where.
//
// Two city fields, deliberately kept apart:
//   - `location` is where a member lives. Stable, and the right filter for "the Toronto crowd".
//   - `current_city` is where they are right now — a conference trip, a term abroad. The right
//     filter for "whoever is in town on Thursday".
// Asking for one and silently matching the other is how a dinner invite reaches someone on another
// continent, so a filter that names one never falls back to the other.
//
// Conference comes from the papers, not from the member: a member has no "conference" field, but a
// paper names its venue and its authors. So "writing for NeurIPS" is answered by reading the paper
// records and mapping authors back to the roster.
//
// Every match carries the reason it matched. The tab shows it, because an operator about to mail 40
// people deserves to see why each one is on the list.
// Lives in the UI rather than in the service: the tab already holds the roster and the papers, so
// filtering them here costs no round trip and adds no route. Nothing about it is UI-specific
// though — it is pure over the two record types, which is why it is a module of its own with its
// own tests rather than a helper inside the view.
import type { AdminBotLabMember, AdminBotPaperRecord } from "./controllers/admin.ts";
// The member-type vocabulary is not redeclared here. `member_type` is free text with a
// hand-maintained spelling, and a second copy of "how to split and compare it" is how the Calendar
// tab ends up filtering "coauthor-major" on a rule the Lab Overview tabs have since changed.
import {
  ADMINBOT_MEMBER_TYPE_FILTERS,
  matchesMemberTypeFilter,
  memberTypeTokens,
} from "./member-type-filter.ts";

export type AudienceFilter = {
  /** Venue as written on the paper, matched case- and punctuation-insensitively. */
  conference?: string;
  /** Where the member is right now (`current_city`). */
  currentCity?: string;
  /** Where the member is based (`location`). */
  homeCity?: string;
  /** IANA zone, matched exactly — these are picked from a list, never typed. */
  timezone?: string;
  /**
   * What the lab calls these people: `member_type` tokens, matched as a union.
   *
   * The axis the lab actually reasons about when it asks who belongs on a recurring meeting, and
   * the one `privilegeLevels` cannot answer -- almost every imported row defaults to `member`
   * there (see `AdminBotLabMember.member_type`). Ticking several widens, because these are labels
   * a person holds rather than a ladder: "full, own-pace-advisee, coauthor-major" is the standing
   * definition of the lab's active roster, spelled the same way the Slack active-channel audit
   * spells it.
   */
  memberTypes?: string[];
  /**
   * How the two place filters and the timezone filter combine with each other.
   *
   * "and" (the default, and how every other filter on this panel behaves) narrows: somebody has to
   * be in the city *and* on that clock. "or" widens, and exists because the two describe the same
   * intent from different directions — "everyone I'd be scheduling around European hours" is some
   * people the roster places in Berlin and some it only knows a zone for, and requiring both
   * silently drops whoever is missing one of the two fields.
   *
   * Only these three combine this way. Membership and status stay ANDed on top either way: they
   * are about who someone *is*, not where, and an OR across those would quietly invite people the
   * operator had just excluded.
   */
  placeMode?: "and" | "or";
  privilegeLevels?: string[];
  statuses?: string[];
};

export type AudienceMatch = {
  member_id: string;
  name: string;
  email: string;
  /** One short phrase per filter this member satisfied, in the order the filters are declared. */
  reasons: string[];
};

export type AudienceResult = {
  matches: AudienceMatch[];
  /** Members that satisfied every filter but have no address to invite. */
  unreachable: Array<{ member_id: string; name: string }>;
};

/**
 * Loose text comparison for the free-text fields.
 *
 * "St. Louis", "St Louis" and "st louis" are the same city typed by three people, and a filter that
 * treats them as three cities is a filter nobody trusts twice. Conference names have the same
 * problem ("NeurIPS 2026" vs "neurips-2026").
 */
function fold(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * A city filter matches the front of the stored value, not any word inside it.
 *
 * People write a city with the region trailing — "Toronto, ON", "New York, NY" — so the city
 * itself leads and a filter is a prefix of it. Matching any word run instead would make "York"
 * select everyone in New York, which is the kind of quiet over-invite nobody checks for until the
 * mail has gone out. The trade-off is deliberate: a stored "Greater Toronto Area" does not answer
 * a "Toronto" filter, and should be typed as the city it is.
 */
/**
 * Whether a member satisfies the place filters, and the reasons they did.
 *
 * Returns undefined for "not in the audience", which is distinct from an empty reason list: a
 * member passes trivially when no place filter is set at all, and that has to read as a pass
 * rather than as a match with nothing to show for it.
 */
function matchPlace(
  member: AdminBotLabMember,
  wanted: { currentCity?: string; homeCity?: string; timezone?: string },
  mode: "and" | "or",
): string[] | undefined {
  const checks: Array<{ set: boolean; hit: boolean; reason: string }> = [
    {
      set: Boolean(wanted.currentCity),
      hit: cityMatches(member.current_city, wanted.currentCity ?? ""),
      reason: `currently in ${member.current_city}`,
    },
    {
      set: Boolean(wanted.homeCity),
      hit: cityMatches(member.location, wanted.homeCity ?? ""),
      reason: `based in ${member.location}`,
    },
    {
      set: Boolean(wanted.timezone),
      hit: (member.timezone ?? "") === wanted.timezone,
      reason: wanted.timezone ?? "",
    },
  ];
  const active = checks.filter((check) => check.set);
  if (!active.length) {
    return [];
  }
  const hits = active.filter((check) => check.hit);
  // In "or" one hit is enough, and only the filters actually met are given as reasons -- listing
  // a filter someone failed as their reason for being included is worse than saying nothing.
  if (mode === "or") {
    return hits.length ? hits.map((check) => check.reason) : undefined;
  }
  return hits.length === active.length ? hits.map((check) => check.reason) : undefined;
}

function cityMatches(stored: string | undefined, wanted: string): boolean {
  const haystack = fold(stored);
  const needle = fold(wanted);
  if (!haystack || !needle) {
    return false;
  }
  return haystack === needle || haystack.startsWith(`${needle} `);
}

/**
 * The labels for the types a member holds and the operator asked for, in the order the filter
 * declares them.
 *
 * Intersected rather than echoing the filter, so somebody carrying "alumni, coauthor-major" is
 * shown the one token that put them in the audience and not the three that were ticked.
 */
function memberTypeLabels(memberType: string | undefined, wanted: readonly string[]): string[] {
  const held = memberTypeTokens(memberType);
  return ADMINBOT_MEMBER_TYPE_FILTERS.filter(
    (option) => wanted.includes(option.value) && held.has(option.value),
  ).map((option) => option.label);
}

function conferenceOf(paper: AdminBotPaperRecord): string | undefined {
  const conference = paper.artifacts?.conference;
  return typeof conference === "string" && conference.trim() ? conference.trim() : undefined;
}

/**
 * Member ids writing for a venue.
 *
 * A paper names its authors as free text, so they are matched to the roster by folded name — the
 * same comparison the rest of this module uses. `submitted_by_member_id` is taken as well: the
 * person who filed the paper is writing for it whether or not they spelled their own name the way
 * the roster does.
 */
export function memberIdsWritingFor(
  papers: readonly AdminBotPaperRecord[],
  members: readonly AdminBotLabMember[],
  conference: string,
): Set<string> {
  const wanted = fold(conference);
  const byName = new Map<string, string>();
  for (const member of members) {
    const key = fold(member.name);
    if (key) {
      byName.set(key, member.id);
    }
  }
  const ids = new Set<string>();
  for (const paper of papers) {
    const venue = conferenceOf(paper);
    if (!venue || fold(venue) !== wanted) {
      continue;
    }
    if (paper.submitted_by_member_id) {
      ids.add(paper.submitted_by_member_id);
    }
    for (const author of paper.authors ?? []) {
      const id = byName.get(fold(author));
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/** The address an invite should go to: the calendar account first, since that is what Google reads. */
export function invitableEmail(member: AdminBotLabMember): string | undefined {
  const candidates = [member.calendar_email, member.email, member.correspondence_email];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (trimmed.includes("@")) {
      return trimmed;
    }
  }
  return undefined;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Every address the roster knows for a member.
 *
 * An invite may carry any one of them: somebody invited two years ago is on the event at their
 * `email`, and `invitableEmail` would send today's invite to their `calendar_email`. Matching on
 * one field alone is how an exclusive pass decides a person is not on an event they are on, and
 * then adds them a second time while removing the first.
 */
function addressesOf(member: AdminBotLabMember): string[] {
  return [member.calendar_email, member.email, member.correspondence_email]
    .map((email) => (typeof email === "string" ? normalizeEmail(email) : ""))
    .filter(Boolean);
}

/** Somebody on the event who is coming off it, and why. */
export type AudienceRemoval = {
  /** The address exactly as the event spells it, so the write can match it back. */
  email: string;
  member_id: string;
  name: string;
  /** Why they are being dropped, in the words the panel shows before the send. */
  reason: string;
};

/**
 * What one exclusive send does to an event: who joins, who stays, who comes off.
 *
 * `remaining` is the whole list the event ends up with rather than a diff, because the underlying
 * `gog calendar update` has no remove-attendee flag -- the only way to drop somebody is to write
 * the entire attendee list back. So the plan has to name the exact set it intends to leave behind,
 * which is also the set worth reading before saying yes.
 */
export type AudiencePlan = {
  /** Chosen, and not on the event yet. */
  invite: string[];
  /** Chosen, and already on it. Nothing is written for these; they are here so the panel can say so. */
  keep: string[];
  remove: AudienceRemoval[];
  /**
   * Addresses on the event that match nobody on the roster. Kept, never removed, and reported.
   *
   * The same rule the nightly membership sweep follows (workflows/members/surface-membership.ts),
   * and it matters more here, not less: this audience is an ad-hoc filter rather than a membership
   * predicate, so an unrecognized address is overwhelmingly a guest speaker, a room resource, or
   * somebody whose calendar account differs from the one on file. Uninviting a real guest from a
   * real meeting is not a cost worth paying to tidy a list.
   */
  unrecognized: string[];
  /**
   * Roster members the member-type filter cannot decide about, because their `member_type` is
   * blank. Kept, never removed, and reported.
   *
   * The column is hand-maintained and plenty of imported rows have never been filled in, so an
   * empty cell means "the roster has not been told", not "this person is none of those things".
   * Reading it the second way is what would take the head professor off the group meeting the
   * first time somebody syncs a guest list -- the same reason the Slack active-channel audit
   * (workflows/members/active-channel-audit.ts) proposes removals only for `not_entitled` and
   * leaves its `unknown` bucket for a human. An operator who genuinely wants them gone can fix
   * the roster row, which is the fix that also holds next time.
   *
   * Only populated when a member-type filter is actually set; with the other filters a blank
   * field is just a non-match like any other.
   */
  undecided: Array<{ email: string; member_id: string; name: string }>;
  /** Exactly who is on the event afterwards: `keep` + `unrecognized` + `undecided` + `invite`. */
  remaining: string[];
};

/**
 * Reconcile an event's guest list against the chosen audience.
 *
 * The filters answer "who should be on this event", and this makes the event say that -- it adds
 * the people the filters chose and takes off the roster members they did not. That is a different
 * question from `selectAudience` alone, which only ever answered the first half; an event kept
 * current by repeated additive sends accumulates everyone who ever matched any filter.
 *
 * Three things are never removed, and all three are deliberate:
 *
 *   - An address no roster row explains. See `unrecognized` above.
 *   - A roster member whose `member_type` is blank while the filter turns on member type. See
 *     `undecided` above.
 *   - Anything in `protectedEmails` -- the organizer and the calendar the event lives on. Google
 *     lists the organizing calendar among the attendees on plenty of events, and a list built to
 *     exclude it would hand the connector a write that drops the organizer off the meeting.
 *
 * A member the operator unticked is treated as not chosen, removals included: the ticked list is
 * the guest list this send means to leave behind, and a checkbox that suppresses the invite while
 * quietly keeping somebody on the event would make the panel's own count wrong. Nothing about that
 * is silent -- every removal is named in the panel before the confirm click.
 */
export function reconcileAudience(params: {
  members: readonly AdminBotLabMember[];
  papers: readonly AdminBotPaperRecord[];
  filter: AudienceFilter;
  /** Currently on the event, as Google spells them. */
  attendees: readonly string[];
  /** Matches the operator unticked; they are neither invited nor kept. */
  excludedMemberIds?: readonly string[];
  /** Addresses that must survive whatever the filters say -- organizer, calendar, rooms. */
  protectedEmails?: readonly string[];
}): AudiencePlan {
  // No filter set is "no audience has been chosen", not "the audience is nobody". Read the second
  // way -- which is what falling through to the loop below would do -- this returns a plan that
  // takes every attendee off the event, and the panel would offer it as a click.
  if (!hasAudienceFilter(params.filter)) {
    return {
      invite: [],
      keep: [],
      remove: [],
      unrecognized: [],
      undecided: [],
      remaining: [...params.attendees],
    };
  }
  const excluded = new Set(params.excludedMemberIds ?? []);
  const chosen = selectAudience(params.members, params.papers, params.filter).matches.filter(
    (match) => !excluded.has(match.member_id),
  );
  const chosenIds = new Set(chosen.map((match) => match.member_id));

  const byAddress = new Map<string, AdminBotLabMember>();
  for (const member of params.members) {
    for (const address of addressesOf(member)) {
      // First writer wins, so the plan does not depend on roster ordering; two rows sharing an
      // address is a duplicate to fix on the roster.
      if (!byAddress.has(address)) {
        byAddress.set(address, member);
      }
    }
  }

  const protectedSet = new Set(
    (params.protectedEmails ?? []).map((email) => normalizeEmail(email)).filter(Boolean),
  );

  const keep: string[] = [];
  const remove: AudienceRemoval[] = [];
  const unrecognized: string[] = [];
  const undecided: AudiencePlan["undecided"] = [];
  const decidesOnMemberType = Boolean(params.filter.memberTypes?.some((type) => type.trim()));
  const onEvent = new Set<string>();
  const seen = new Set<string>();

  for (const raw of params.attendees) {
    const email = raw.trim();
    if (!email) {
      continue;
    }
    const key = normalizeEmail(email);
    // An event listing the same person twice must not produce two removals of one address.
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    onEvent.add(key);

    const member = byAddress.get(key);
    if (!member) {
      unrecognized.push(email);
      continue;
    }
    if (chosenIds.has(member.id) || protectedSet.has(key)) {
      keep.push(email);
      continue;
    }
    // Unticking somebody is a decision about that person and outranks a blank cell; only a member
    // the filters merely failed to match gets the benefit of the doubt.
    if (
      decidesOnMemberType &&
      !excluded.has(member.id) &&
      !memberTypeTokens(member.member_type).size
    ) {
      undecided.push({ email, member_id: member.id, name: member.name });
      continue;
    }
    remove.push({
      email,
      member_id: member.id,
      name: member.name,
      // Unticked and unmatched are different mistakes to spot, so they read differently.
      reason: excluded.has(member.id) ? "unticked on this send" : "does not match the filters",
    });
  }

  // Somebody already on the event at another of their addresses is not invited again -- that is
  // what the address union above is for.
  const invite: string[] = [];
  for (const match of chosen) {
    const member = params.members.find((row) => row.id === match.member_id);
    const known = member ? addressesOf(member) : [normalizeEmail(match.email)];
    if (known.some((address) => onEvent.has(address))) {
      continue;
    }
    invite.push(match.email);
    onEvent.add(normalizeEmail(match.email));
  }

  return {
    invite,
    keep,
    remove,
    unrecognized,
    undecided,
    remaining: [...keep, ...unrecognized, ...undecided.map((person) => person.email), ...invite],
  };
}

/**
 * Whether the operator has actually chosen an audience.
 *
 * Exported and shared rather than recomputed, because two readings of "no filters set" is the
 * difference between a no-op and clearing an event. `selectAudience` treats it as "nobody is
 * chosen", which is the safe answer for an additive send; `reconcileAudience` has to see the same
 * thing and stop, because "nobody is chosen" run exclusively means "take everybody off".
 */
export function hasAudienceFilter(filter: AudienceFilter): boolean {
  return Boolean(
    filter.conference?.trim() ||
    filter.currentCity?.trim() ||
    filter.homeCity?.trim() ||
    filter.timezone?.trim() ||
    filter.memberTypes?.some((type) => type.trim()) ||
    filter.privilegeLevels?.some((level) => level.trim()) ||
    filter.statuses?.some((status) => status.trim()),
  );
}

/**
 * Members matching every filter given. An empty filter set matches nobody rather than everybody:
 * "invite the whole lab" is a decision an operator should have to state, not the thing that happens
 * when they forget to pick anything.
 */
export function selectAudience(
  members: readonly AdminBotLabMember[],
  papers: readonly AdminBotPaperRecord[],
  filter: AudienceFilter,
): AudienceResult {
  const conference = filter.conference?.trim();
  const currentCity = filter.currentCity?.trim();
  const homeCity = filter.homeCity?.trim();
  const timezone = filter.timezone?.trim();
  const memberTypes = filter.memberTypes?.filter((type) => type.trim()) ?? [];
  const placeMode = filter.placeMode ?? "and";
  const privileges = filter.privilegeLevels?.filter((level) => level.trim()) ?? [];
  const statuses = filter.statuses?.filter((status) => status.trim()) ?? [];
  if (!hasAudienceFilter(filter)) {
    return { matches: [], unreachable: [] };
  }

  const writers = conference ? memberIdsWritingFor(papers, members, conference) : undefined;
  const matches: AudienceMatch[] = [];
  const unreachable: Array<{ member_id: string; name: string }> = [];

  for (const member of members) {
    const reasons: string[] = [];
    if (conference) {
      if (!writers?.has(member.id)) {
        continue;
      }
      reasons.push(`writing for ${conference}`);
    }
    // Evaluated together rather than as three independent gates, because in "or" mode a member
    // who fails one of them can still be in the audience on the strength of another.
    const place = matchPlace(member, { currentCity, homeCity, timezone }, placeMode);
    if (!place) {
      continue;
    }
    reasons.push(...place);
    if (memberTypes.length) {
      if (!matchesMemberTypeFilter(member.member_type, memberTypes)) {
        continue;
      }
      // The labels rather than the raw tokens, and only the ones this person actually holds: a row
      // reading "Full member" beside somebody who matched on "coauthor-major" is a reason that
      // does not survive being checked.
      reasons.push(...memberTypeLabels(member.member_type, memberTypes));
    }
    if (privileges.length) {
      if (!privileges.includes(member.privilege_level ?? "")) {
        continue;
      }
      reasons.push(member.privilege_level ?? "");
    }
    if (statuses.length) {
      if (!statuses.includes(member.status ?? "")) {
        continue;
      }
      reasons.push(member.status ?? "");
    }
    const email = invitableEmail(member);
    if (!email) {
      unreachable.push({ member_id: member.id, name: member.name });
      continue;
    }
    matches.push({ member_id: member.id, name: member.name, email, reasons });
  }

  return { matches, unreachable };
}

/**
 * Roster names by every address they might be invited at.
 *
 * An attendee list is a column of raw addresses otherwise, and "who is on this meeting" is a
 * question about people. Falls back to the address for anyone outside the lab, which is most guests
 * on most events.
 */
export function memberNamesByEmail(members: readonly AdminBotLabMember[]): Map<string, string> {
  const byEmail = new Map<string, string>();
  for (const member of members) {
    for (const candidate of [member.calendar_email, member.email, member.correspondence_email]) {
      const key = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
      if (key && !byEmail.has(key)) {
        byEmail.set(key, member.name);
      }
    }
  }
  return byEmail;
}

/** The distinct venues on record, for the tab's conference picker. */
export function knownConferences(papers: readonly AdminBotPaperRecord[]): string[] {
  const seen = new Map<string, string>();
  for (const paper of papers) {
    const venue = conferenceOf(paper);
    if (venue && !seen.has(fold(venue))) {
      seen.set(fold(venue), venue);
    }
  }
  return [...seen.values()].toSorted((left, right) => left.localeCompare(right));
}

/** The distinct cities on record for a given field, for the two city pickers. */
export function knownCities(
  members: readonly AdminBotLabMember[],
  field: "location" | "current_city",
): string[] {
  const seen = new Map<string, string>();
  for (const member of members) {
    const value = member[field];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed && !seen.has(fold(trimmed))) {
      seen.set(fold(trimmed), trimmed);
    }
  }
  return [...seen.values()].toSorted((left, right) => left.localeCompare(right));
}
