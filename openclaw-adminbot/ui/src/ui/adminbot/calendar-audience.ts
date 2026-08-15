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

export type AudienceFilter = {
  /** Venue as written on the paper, matched case- and punctuation-insensitively. */
  conference?: string;
  /** Where the member is right now (`current_city`). */
  currentCity?: string;
  /** Where the member is based (`location`). */
  homeCity?: string;
  /** IANA zone, matched exactly — these are picked from a list, never typed. */
  timezone?: string;
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
function cityMatches(stored: string | undefined, wanted: string): boolean {
  const haystack = fold(stored);
  const needle = fold(wanted);
  if (!haystack || !needle) {
    return false;
  }
  return haystack === needle || haystack.startsWith(`${needle} `);
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
  const privileges = filter.privilegeLevels?.filter((level) => level.trim()) ?? [];
  const statuses = filter.statuses?.filter((status) => status.trim()) ?? [];
  const active =
    Boolean(conference) ||
    Boolean(currentCity) ||
    Boolean(homeCity) ||
    Boolean(timezone) ||
    privileges.length > 0 ||
    statuses.length > 0;
  if (!active) {
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
    if (currentCity) {
      if (!cityMatches(member.current_city, currentCity)) {
        continue;
      }
      reasons.push(`currently in ${member.current_city}`);
    }
    if (homeCity) {
      if (!cityMatches(member.location, homeCity)) {
        continue;
      }
      reasons.push(`based in ${member.location}`);
    }
    if (timezone) {
      if ((member.timezone ?? "") !== timezone) {
        continue;
      }
      reasons.push(timezone);
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
