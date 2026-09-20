// The lab's standing meetings, as a list a member can pick from.
//
// Everything else that touches themed meetings starts from a Slack channel or from what somebody
// wrote in their research interests, and works out which calendar event that implies. This starts
// from the other end: it is the answer to "which meetings am I in", asked of the person who knows,
// and the calendar is what the question offers as choices. `Theme: Causal Inference` and
// `Proj: Law to Benchmark` are the two families (ADMINBOT_MEETING_FAMILIES); an event in neither is
// not a standing meeting and is not offered.
//
// Two properties the profile field depends on:
//
//   1. One entry per meeting, not per occurrence. A calendar read covers a window, so a weekly
//      meeting comes back as eight events with eight ids. A picker built from that list would ask
//      somebody to choose between eight copies of the same Wednesday.
//   2. A topic resolves to exactly one meeting or to none. Two events answering to one topic is a
//      calendar problem the lab should fix, and guessing which of them somebody meant is how a
//      person ends up on an invite nobody can explain -- the same rule sweepResearchThemeInvites
//      already applies when it finds two events for one theme.
import {
  ADMINBOT_MEETING_FAMILIES,
  type AdminBotMeetingFamilyId,
} from "../members/topic-channels.js";

/**
 * One standing meeting: the event it is, and the name a member picks it by.
 *
 * `topic` is the part after the title's prefix -- the "Causal Inference" of
 * "Theme: Causal Inference" -- because that is what the meeting is called when people talk about
 * it. The full `summary` rides along so an approval card names the event as the calendar does.
 */
export type AdminBotMeetingCatalogEntry = {
  /** The series id, never an occurrence's (see seriesEventId). */
  event_id: string;
  calendar_id?: string;
  family: AdminBotMeetingFamilyId;
  topic: string;
  summary: string;
  /** Earliest start seen for this meeting in the window that produced the entry. */
  starts_at?: string;
  updated_at: string;
};

/** What a calendar read hands this module. A subset of AdminBotCalendarEvent, so tests can fake it. */
export type AdminBotMeetingCatalogSource = {
  id: string;
  summary?: string;
  start?: string;
  calendar_id?: string;
};

/**
 * The id of the series an event belongs to.
 *
 * Google names one occurrence of a recurring event `<seriesId>_<20260923T130000Z>`, and a calendar
 * read over a window returns occurrences. The series is what the catalog holds and what an invite
 * targets: adding somebody to a single occurrence puts them on one Wednesday and no other, which
 * is never what "I am in this meeting" means.
 *
 * The suffix is matched rather than split on, because a bare `_` is legal inside an ordinary event
 * id and cutting at the first one would turn distinct events into one.
 */
export function seriesEventId(eventId: string): string {
  return (eventId ?? "").trim().replace(/_(\d{8}T\d{6}Z|\d{8})$/u, "");
}

/** The family and topic an event title carries, or null when it is not a standing meeting. */
export function meetingTitleParts(
  summary: string,
): { family: AdminBotMeetingFamilyId; topic: string } | null {
  for (const family of ADMINBOT_MEETING_FAMILIES) {
    const topic = family.titleTopic(summary);
    if (topic) {
      return { family: family.id, topic };
    }
  }
  return null;
}

/**
 * The catalog a window of calendar events implies: one entry per meeting, sorted by topic.
 *
 * Occurrences of one series collapse onto the earliest of them, which is what keeps `starts_at`
 * meaning "next time this meets" rather than "some Wednesday". Two *different* series that carry
 * the same topic both survive: this module does not get to decide which of a duplicated meeting is
 * the real one, and `resolveMeetingChoice` refuses the pair rather than picking.
 */
export function meetingCatalogFromEvents(
  events: readonly AdminBotMeetingCatalogSource[],
  options: { calendarId?: string; now?: string } = {},
): AdminBotMeetingCatalogEntry[] {
  const updatedAt = options.now ?? new Date().toISOString();
  const byEvent = new Map<string, AdminBotMeetingCatalogEntry>();
  for (const event of events) {
    const parts = meetingTitleParts(event.summary ?? "");
    const eventId = seriesEventId(event.id);
    if (!parts || !eventId) {
      continue;
    }
    const calendarId = event.calendar_id?.trim() || options.calendarId?.trim();
    const entry: AdminBotMeetingCatalogEntry = {
      event_id: eventId,
      ...(calendarId ? { calendar_id: calendarId } : {}),
      family: parts.family,
      topic: parts.topic,
      summary: (event.summary ?? "").trim(),
      ...(event.start?.trim() ? { starts_at: event.start.trim() } : {}),
      updated_at: updatedAt,
    };
    const seen = byEvent.get(eventId);
    if (!seen) {
      byEvent.set(eventId, entry);
      continue;
    }
    // Keep the earliest occurrence, which is what makes the collapse deterministic rather than
    // "whichever the calendar listed first" -- and what makes `starts_at` mean "next time this
    // meets". An entry with no start loses to one that has it, for the same reason.
    if (entry.starts_at && (!seen.starts_at || entry.starts_at < seen.starts_at)) {
      byEvent.set(eventId, entry);
    }
  }
  return [...byEvent.values()].toSorted(
    (left, right) =>
      left.topic.localeCompare(right.topic) || left.event_id.localeCompare(right.event_id),
  );
}

/** The topics a picker offers, in the catalog's own order and without repeats. */
export function meetingCatalogTopics(catalog: readonly AdminBotMeetingCatalogEntry[]): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const entry of catalog) {
    const key = entry.topic.toLowerCase();
    if (entry.topic && !seen.has(key)) {
      seen.add(key);
      topics.push(entry.topic);
    }
  }
  return topics;
}

export type AdminBotMeetingChoice =
  | { ok: true; entry: AdminBotMeetingCatalogEntry }
  /**
   * `unknown`: nothing on the calendar answers to this topic -- a meeting that ended, was renamed,
   * or a value that predates the catalog. `ambiguous`: several do, which is a calendar to look at
   * rather than a coin to flip.
   */
  | { ok: false; reason: "unknown" | "ambiguous" };

/** The meeting a stored answer names, matched on the topic the member picked. */
export function resolveMeetingChoice(
  topic: string,
  catalog: readonly AdminBotMeetingCatalogEntry[],
): AdminBotMeetingChoice {
  const wanted = (topic ?? "").trim().toLowerCase();
  if (!wanted) {
    return { ok: false, reason: "unknown" };
  }
  const matches = catalog.filter((entry) => entry.topic.trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    return { ok: false, reason: "unknown" };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: true, entry: matches[0] };
}

/**
 * The meetings a member has said they are in, cleaned up.
 *
 * Blanks and repeats go; everything else is kept exactly as stored, including an answer the
 * catalog no longer offers. A meeting that disappeared from the calendar is not evidence that
 * somebody stopped attending it, so nothing here rewrites what a member said about themselves.
 */
export function memberMeetingTopics(member: { meetings?: readonly string[] }): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const entry of member.meetings ?? []) {
    const topic = (entry ?? "").trim();
    const key = topic.toLowerCase();
    if (topic && !seen.has(key)) {
      seen.add(key);
      topics.push(topic);
    }
  }
  return topics;
}
