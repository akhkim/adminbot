// A member's birthday, and the recurring all-day event that puts it on the lab calendar.
//
// Stored as `MM-DD` with no year, and that is a deliberate narrowing rather than a shortcut. The
// question the lab is answering is "when do we say happy birthday", which a month and a day answer
// completely; a year additionally publishes everybody's age to the whole roster, which nobody
// asked for and which is the kind of field people are asked to fill in once and then cannot take
// back. If a birth year is ever genuinely needed for something, it should be its own field with
// its own visibility rules, not a side effect of wanting cake.
//
// The calendar event is yearly-recurring rather than one event created per year. A single RRULE
// means no annual job to forget to run, no way for the lab to skip somebody because a sweep failed
// in March, and one thing to delete when a member leaves rather than a trail of past events.
import type { AdminBotLabMember } from "../../contracts/actions.js";

/**
 * The zone stamped on the event.
 *
 * `Europe/Berlin` rather than the bare `CET` tzdata alias: both observe CET/CEST, but the alias is
 * a legacy compatibility entry that some clients refuse, and a real location zone is what Google
 * stores for every other event this lab creates.
 *
 * Worth knowing what this does and does not do. An all-day event is date-only in Google's data
 * model -- it starts on a date, not at an instant -- so the zone does not shift which day the
 * birthday lands on for anyone, and a member in Toronto sees it on the same date as one in Zurich.
 * What it sets is the zone the event's own reminders anchor to.
 */
export const BIRTHDAY_EVENT_TIMEZONE = "Europe/Berlin";

const BIRTHDAY_PATTERN = /^(\d{2})-(\d{2})$/u;

// Days per month, 1-indexed, with February at its leap-year maximum: this validates a recurring
// month-day, which has no year to be judged against, so 02-29 is a legitimate answer.
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The stored shape: month and day, both zero-padded, no year. */
export type Birthday = { month: number; day: number };

/**
 * Parse `MM-DD`, or undefined when the text is not one.
 *
 * Strict about the padding because the field round-trips through a spreadsheet column and a CSV,
 * and "3-4" sorts and compares differently from "03-04" in both.
 */
export function parseBirthday(value: string): Birthday | undefined {
  const match = BIRTHDAY_PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12) {
    return undefined;
  }
  if (day < 1 || day > (DAYS_IN_MONTH[month] ?? 0)) {
    return undefined;
  }
  return { month, day };
}

/** The validation message the service returns, or undefined when the value is acceptable. */
export function validateBirthday(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return "member birthday must be a string";
  }
  if (!value.trim()) {
    return undefined;
  }
  return parseBirthday(value)
    ? undefined
    : "member birthday must be MM-DD, for example 03-14 (no year)";
}

/**
 * The first date the recurrence should land on: this year's occurrence, or next year's once it has
 * passed.
 *
 * Anchoring forward rather than at some fixed past year keeps the calendar from filling with
 * birthdays somebody never had as a member -- a person who joins in November should not acquire
 * ten years of retroactive events on a shared calendar.
 */
export function nextOccurrence(birthday: Birthday, today: Date): { year: number } {
  const year = today.getUTCFullYear();
  const thisYear = Date.UTC(year, birthday.month - 1, birthday.day);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return { year: thisYear >= todayUtc ? year : year + 1 };
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The `calendar.create_birthday` payload for one member, or undefined when they have no birthday.
 *
 * A 29 February birthday recurs only in leap years, which is what the rule below actually says and
 * therefore what this stores. Moving it to the 28th or the 1st would put a date on the calendar
 * that is not the person's birthday, and picking which of the two on their behalf is not this
 * module's decision to make -- someone who wants to be wished on the 28th can enter 02-28.
 */
export function birthdayEventPayload(
  member: AdminBotLabMember,
  calendarId: string,
  today: Date,
): Record<string, unknown> | undefined {
  const raw = member.birthday?.trim();
  if (!raw) {
    return undefined;
  }
  const birthday = parseBirthday(raw);
  if (!birthday) {
    return undefined;
  }
  const { year } = nextOccurrence(birthday, today);
  const start = iso(year, birthday.month, birthday.day);
  const name = member.preferred_name?.trim() || member.name.trim();
  return {
    calendar_id: calendarId,
    summary: `🎂 ${name}'s birthday`,
    // Google's all-day end date is exclusive, so a single-day event ends on the following day.
    // Passing the same date for both produces a zero-length event that some clients hide entirely.
    from: start,
    to: exclusiveEnd(year, birthday),
    all_day: true,
    timezone: BIRTHDAY_EVENT_TIMEZONE,
    rrule: `RRULE:FREQ=YEARLY;BYMONTH=${birthday.month};BYMONTHDAY=${birthday.day}`,
    // No attendees. The event belongs on the shared calendar for everyone to see; inviting the
    // whole roster to each other's birthdays would put 199 notifications in 199 inboxes.
    description: "Added from the lab profile birthday field.",
  };
}

/**
 * The day after the birthday, carrying into the next month or year as needed.
 *
 * Written out rather than done with Date arithmetic on the birthday itself because 29 February in
 * a non-leap anchor year is not a date Date() will accept without silently rolling it to 1 March,
 * which is the exact substitution the doc comment above refuses to make.
 */
function exclusiveEnd(year: number, birthday: Birthday): string {
  const lastDay = birthday.month === 2 ? 29 : (DAYS_IN_MONTH[birthday.month] ?? 0);
  if (birthday.day < lastDay) {
    return iso(year, birthday.month, birthday.day + 1);
  }
  if (birthday.month === 12) {
    return iso(year + 1, 1, 1);
  }
  return iso(year, birthday.month + 1, 1);
}
