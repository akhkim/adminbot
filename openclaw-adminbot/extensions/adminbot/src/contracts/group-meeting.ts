// When the lab's weekly group meeting is, and whether a reminder is due before it.
//
// A nudge aimed at a meeting has to arrive in the run-up to that meeting: too early and it is
// filed and forgotten, too late and the person is already sitting in the room. "Within twenty
// hours before" is the window the lab asked for -- Sunday afternoon for a Monday morning meeting,
// which is when somebody can still do something about it.
//
// The window lives here rather than in a crontab because a crontab is a schedule, not a rule: a
// job that fires hourly, a manual run and a retry must all agree about whether a reminder is due,
// and they only do if the answer is computed from the clock rather than from who called.

/** Minutes past midnight, in the meeting's own timezone. */
export type GroupMeetingSchedule = {
  /** 0 Sunday .. 6 Saturday. Monday by default, which is what the lab runs. */
  weekday: number;
  /** "HH:MM", 24-hour, in `timezone`. */
  time: string;
  /** IANA name. The lab is in Toronto; a member in Zurich still gets the Toronto meeting time. */
  timezone: string;
};

export const adminBotDefaultGroupMeeting: GroupMeetingSchedule = {
  weekday: 1,
  time: "09:30",
  timezone: "America/Toronto",
};

/** How long before the meeting a reminder may go out. */
export const adminBotGroupMeetingNudgeWindowHours = 20;

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(time.trim());
  if (!match) {
    return { hour: 9, minute: 30 };
  }
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return { hour, minute };
}

/**
 * What `instant` reads as on a wall clock in `timezone`.
 *
 * Intl rather than an offset table: the lab is in a place that observes daylight saving, and a
 * fixed -05:00 would put the reminder an hour wrong for half the year -- which for a twenty-hour
 * window is survivable and for the "is the meeting today" test is not.
 */
function zonedParts(instant: Date, timezone: string): { weekday: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = weekdays.indexOf(String(parts.weekday));
  // "24" appears at midnight in some ICU versions with hour12:false.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return { weekday: weekday < 0 ? 0 : weekday, minutes: hour * 60 + minute };
}

/**
 * Hours from `now` until the next meeting, in the meeting's timezone.
 *
 * Returns the *next* one: at 11:00 on a Monday the meeting an hour ago is over, and the number
 * that matters is the 167 hours until the next one -- which is exactly what keeps a reminder from
 * going out the moment the meeting ends.
 */
export function hoursUntilGroupMeeting(now: Date, schedule: GroupMeetingSchedule): number {
  const { hour, minute } = parseTime(schedule.time);
  const meetingMinutes = hour * 60 + minute;
  const current = zonedParts(now, schedule.timezone);
  let deltaDays = (schedule.weekday - current.weekday + 7) % 7;
  let deltaMinutes = deltaDays * 24 * 60 + (meetingMinutes - current.minutes);
  if (deltaMinutes <= 0) {
    // Today's meeting has started or passed: the next one is a week out.
    deltaDays += 7;
    deltaMinutes = deltaDays * 24 * 60 + (meetingMinutes - current.minutes);
  }
  return deltaMinutes / 60;
}

/**
 * Is a pre-meeting reminder due right now?
 *
 * True only inside the window, so a job that fires hourly all week sends on one afternoon and
 * stays quiet the rest of the time. The caller still keeps its own ledger -- this says the moment
 * is right, not that this particular person has not already been told.
 */
export function isGroupMeetingNudgeDue(
  now: Date,
  schedule: GroupMeetingSchedule,
  windowHours = adminBotGroupMeetingNudgeWindowHours,
): boolean {
  const hours = hoursUntilGroupMeeting(now, schedule);
  return hours > 0 && hours <= windowHours;
}
