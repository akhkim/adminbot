import type { AdminBotLabMember } from "../../contracts/actions.js";
/**
 * The lab's standing meetings, and who is on each -- what the Lab Members form's Meetings
 * checkboxes offer and tick.
 *
 * Three families live on the lab calendar and nothing else there is a meeting a member is "on": the
 * Monday group meeting (the configured series), the Wednesday `Theme:` meetings and the `Proj:`
 * project calls. Birthdays and deadlines are recurring too, which is why this goes by family rather
 * than by "recurs".
 *
 * A meeting is keyed by its base series id. Editing a meeting "this and following" in Google
 * splits it into `<base>_R<instant>` series whose occurrences still carry the base prefix, so the
 * splits are one meeting here and every live series is a write target -- the same reasoning the
 * group-meeting membership sweep documents.
 */
import { groupMeetingSeriesId } from "../../contracts/group-meeting.js";
import { projectOfEvent, themeOfEvent } from "../members/topic-channels.js";
import type { AdminBotCalendarEvent } from "./events.js";

export type AdminBotStandingMeeting = {
  /** The base series id. What the form submits. */
  id: string;
  title: string;
  kind: "group" | "theme" | "project";
  /** Every live series behind this meeting; writes go to each. */
  event_ids: string[];
  /** Lowercased addresses on any of those series. */
  attendees: string[];
};

export function standingMeetings(
  events: readonly AdminBotCalendarEvent[],
  groupSeriesId: string,
): AdminBotStandingMeeting[] {
  const byId = new Map<string, AdminBotStandingMeeting>();
  for (const event of events) {
    const id = groupMeetingSeriesId(event.id);
    const kind =
      id === groupSeriesId
        ? "group"
        : event.recurring_event_id && themeOfEvent(event.summary)
          ? "theme"
          : event.recurring_event_id && projectOfEvent(event.summary)
            ? "project"
            : undefined;
    if (!kind) {
      continue;
    }
    const meeting = byId.get(id) ?? {
      id,
      title: event.summary.trim() || id,
      kind,
      event_ids: [],
      attendees: [],
    };
    const target = event.recurring_event_id ?? event.id;
    if (!meeting.event_ids.includes(target)) {
      meeting.event_ids.push(target);
    }
    for (const address of event.attendees ?? []) {
      const normalized = address.trim().toLowerCase();
      if (normalized && !meeting.attendees.includes(normalized)) {
        meeting.attendees.push(normalized);
      }
    }
    byId.set(id, meeting);
  }
  const order = { group: 0, theme: 1, project: 2 } as const;
  return [...byId.values()].toSorted(
    (left, right) => order[left.kind] - order[right.kind] || left.title.localeCompare(right.title),
  );
}

/** Every address the roster knows for a member; an invite may carry any of them. */
export function memberAddresses(member: AdminBotLabMember): string[] {
  return [
    ...new Set(
      [member.calendar_email, member.email, member.correspondence_email]
        .map((email) => (email ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function memberAttends(
  meeting: AdminBotStandingMeeting,
  member: AdminBotLabMember,
): boolean {
  const addresses = new Set(memberAddresses(member));
  return meeting.attendees.some((address) => addresses.has(address));
}

/**
 * What ticking `selected` means against the calendar as it stands.
 *
 * Ids the calendar no longer has are ignored rather than failed: a meeting deleted while the form
 * was open is not something to add anybody to.
 */
export function planMeetingMembership(
  meetings: readonly AdminBotStandingMeeting[],
  member: AdminBotLabMember,
  selected: readonly string[],
): { add: AdminBotStandingMeeting[]; remove: AdminBotStandingMeeting[] } {
  const wanted = new Set(selected);
  const add: AdminBotStandingMeeting[] = [];
  const remove: AdminBotStandingMeeting[] = [];
  for (const meeting of meetings) {
    const attends = memberAttends(meeting, member);
    if (wanted.has(meeting.id) && !attends) {
      add.push(meeting);
    } else if (!wanted.has(meeting.id) && attends) {
      remove.push(meeting);
    }
  }
  return { add, remove };
}
