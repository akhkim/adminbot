// Who has stopped turning up to the group meeting, and what to say to them.
//
// The lab's rule is two in a row: missing one meeting is a dentist appointment, missing two is a
// pattern somebody should be asked about. That threshold is the whole feature, and everything here
// exists to keep it from firing on people it should not.
//
// Three guards, all of them about the difference between "was absent" and "is not recorded as
// present". Attendance is assembled by hand from a CSV a host remembers to export, so a meeting
// with no roster at all says nothing about anybody -- countable meetings are only the ones where
// somebody's attendance is actually known (`hasKnownAttendance`). A member who joined after a
// meeting cannot have missed it, so meetings that predate them are not counted against them. And
// the audience is narrowed to the people the meeting is actually for: whoever is on the calendar
// invite, plus the lab's full members. A one-paper collaborator who was never expected on Monday
// is not somebody to chase.
import type { AdminBotLabMember, AdminBotMeetingRecord } from "../../contracts/actions.js";
import { adminBotIsAlumniType, adminBotIsFullMemberType } from "../../contracts/actions.js";
import type { GroupMeetingSchedule } from "../../contracts/group-meeting.js";
import type { AdminBotCalendarEvent } from "../calendar/events.js";
import { normalizeName } from "./attendance.js";

/** How many consecutive absences make a pattern worth a message. */
export const adminBotMeetingAbsenceStreak = 2;

/** One person who has missed the streak, and which meetings they missed. */
export type AdminBotMeetingAbsence = {
  member_id: string;
  name: string;
  /** Newest first, same order as the meeting list they came from. */
  missed_meeting_ids: string[];
  missed_topics: string[];
  /** Why they are in the audience at all, which is what the admin preview shows. */
  reason: "invite" | "full_member";
};

/**
 * Whether this meeting's roster is knowable at all.
 *
 * A record with an empty attendee list is the normal state of a meeting for the hours between
 * Zoom's notice landing and a host exporting the participant CSV. Counting it as "everybody was
 * absent" would send the whole lab a warning every Monday lunchtime.
 */
export function hasKnownAttendance(meeting: AdminBotMeetingRecord): boolean {
  return (meeting.attendees ?? []).some((attendee) => attendee.present);
}

/**
 * The meetings a streak is measured over: the most recent `streak` with a known roster.
 *
 * `meetings` is expected newest-first, which is the order every service read hands back.
 */
export function streakMeetings(
  meetings: readonly AdminBotMeetingRecord[],
  streak: number = adminBotMeetingAbsenceStreak,
): AdminBotMeetingRecord[] {
  return meetings.filter(hasKnownAttendance).slice(0, Math.max(0, streak));
}

/** Whether the roster records this member as present, by member id or by name. */
function wasPresent(meeting: AdminBotMeetingRecord, member: AdminBotLabMember): boolean {
  const name = normalizeName(member.name);
  return (meeting.attendees ?? []).some((attendee) => {
    if (!attendee.present) {
      return false;
    }
    if (attendee.member_id) {
      return attendee.member_id === member.id;
    }
    // A guest line that was never matched to the roster is still evidence the person was there:
    // the matcher gives up on "Ana (phone)" but a human reading it would not. Falling back to the
    // name here is the safe direction -- it can only ever excuse somebody, never accuse them.
    return normalizeName(attendee.display_name) === name;
  });
}

/**
 * Whether the member could have attended this meeting at all.
 *
 * `joined_month` is a month ("2026-03"), so this is deliberately coarse: somebody who joined in the
 * same month as the meeting is given the benefit of the doubt rather than counted absent from a
 * meeting that may have happened before their first day.
 */
function couldHaveAttended(meeting: AdminBotMeetingRecord, member: AdminBotLabMember): boolean {
  const joined = member.joined_month?.trim();
  if (!joined) {
    return true;
  }
  return meeting.started_at.slice(0, 7) > joined;
}

/**
 * The audience for a group-meeting attendance nudge.
 *
 * Two sources, unioned. The calendar invite is the authoritative one -- it is the actual list of
 * people the meeting was sent to -- but it is an external read that can fail, so full membership
 * from the roster carries the feature on its own when the calendar is unreachable. Alumni are out
 * of both: the spreadsheet keeps somebody's member type after they leave.
 */
export function meetingAudience(
  members: readonly AdminBotLabMember[],
  inviteEmails: readonly string[] = [],
): Array<{ member: AdminBotLabMember; reason: AdminBotMeetingAbsence["reason"] }> {
  const invited = new Set(inviteEmails.map((email) => email.trim().toLowerCase()).filter(Boolean));
  const audience: Array<{ member: AdminBotLabMember; reason: AdminBotMeetingAbsence["reason"] }> =
    [];
  for (const member of members) {
    if (member.status === "alumni" || member.status === "external") {
      continue;
    }
    if (adminBotIsAlumniType(member.member_type)) {
      continue;
    }
    const onInvite = [member.email, member.calendar_email, member.correspondence_email].some(
      (email) => email && invited.has(email.trim().toLowerCase()),
    );
    if (onInvite) {
      audience.push({ member, reason: "invite" });
      continue;
    }
    if (adminBotIsFullMemberType(member.member_type)) {
      audience.push({ member, reason: "full_member" });
    }
  }
  return audience;
}

/**
 * Everyone in the audience who was absent from every one of the streak meetings.
 *
 * Returns nothing at all when there are fewer than `streak` meetings with a known roster: a lab
 * that has recorded one meeting cannot yet have anybody who missed two.
 */
export function consecutiveAbsences(params: {
  meetings: readonly AdminBotMeetingRecord[];
  members: readonly AdminBotLabMember[];
  inviteEmails?: readonly string[];
  streak?: number;
}): AdminBotMeetingAbsence[] {
  const streak = params.streak ?? adminBotMeetingAbsenceStreak;
  const recent = streakMeetings(params.meetings, streak);
  if (recent.length < streak) {
    return [];
  }
  const absences: AdminBotMeetingAbsence[] = [];
  for (const { member, reason } of meetingAudience(params.members, params.inviteEmails ?? [])) {
    const missed = recent.filter(
      (meeting) => couldHaveAttended(meeting, member) && !wasPresent(meeting, member),
    );
    // Every one of them, not just `streak` of them: a member who could only have attended one of
    // the two has not missed two.
    if (missed.length < streak) {
      continue;
    }
    absences.push({
      member_id: member.id,
      name: member.name,
      missed_meeting_ids: missed.map((meeting) => meeting.id),
      missed_topics: missed.map((meeting) => meeting.topic),
      reason,
    });
  }
  return absences;
}

/**
 * A stable key for "this pair of meetings", so a member is asked once about a given streak.
 *
 * Built from the meeting ids rather than from the date the nudge ran: an hourly cron, a retry and
 * an admin pressing the button all describe the same two meetings, and all three should collapse
 * into one message. The next meeting produces a new pair and so a new key, which is what lets a
 * third absence in a row be worth saying something about again.
 */
export function absenceStreakKey(meetingIds: readonly string[]): string {
  return meetingIds.toSorted().join("|");
}

/** What the Slack DM, the dashboard card and the popup all say. Plain text: it is styled nowhere. */
export function buildMeetingAttendanceMessage(params: {
  missedTopics: readonly string[];
  meetingLabel?: string;
}): string {
  const label = params.meetingLabel?.trim() || "the group meeting";
  const topics = params.missedTopics.filter((topic) => topic.trim()).slice(0, 2);
  const which = topics.length ? ` (${topics.join("; ")})` : "";
  return (
    `You have missed the last ${params.missedTopics.length} ${label}s${which}. ` +
    "Please make sure to join the next one — if something makes that hard, tell an admin so the " +
    "lab can plan around it rather than guess."
  );
}

/**
 * The addresses on the group meeting's calendar invite, from a window of upcoming events.
 *
 * Matched on the schedule rather than on the event's title: the lab's meeting is a recurring event
 * whose summary has been renamed twice, and the one thing that has not changed is that it is on
 * Monday morning. Every event that starts on the scheduled weekday counts, and their attendee lists
 * are unioned -- a recurring series can carry per-occurrence guest edits, and somebody who was
 * added to next week's instance is on the invite.
 *
 * Returns an empty list when nothing matched, which callers must read as "unknown", not "nobody":
 * an empty invite is exactly what an unauthenticated calendar CLI produces.
 */
export function groupMeetingInviteEmails(
  events: readonly AdminBotCalendarEvent[],
  schedule: GroupMeetingSchedule,
): string[] {
  const emails = new Set<string>();
  for (const event of events) {
    if (event.all_day) {
      continue;
    }
    const start = new Date(event.start);
    if (Number.isNaN(start.getTime())) {
      continue;
    }
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.timezone,
      weekday: "short",
    }).format(start);
    const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
    if (index !== schedule.weekday) {
      continue;
    }
    for (const attendee of event.attendees ?? []) {
      const email = attendee.trim().toLowerCase();
      if (email) {
        emails.add(email);
      }
    }
  }
  return [...emails];
}
