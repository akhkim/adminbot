// Letter deadlines that were typed without a year.
//
// New requests must carry an ISO date, but older rows hold whatever the member typed into a free
// text box: "Dec 15", "12/15", "15 December". Read literally those have no instant, so they fell
// to the bottom of the desk as undated; read with `Date.parse` they land in 2001. Neither is what
// the member meant. The member meant the next Dec 15, so that is the date the desk shows, sorts on
// and counts days to, with a marker so nobody mistakes the inferred year for one that was typed.
//
// This module is pure and browser-safe: the service's list read and the PI's desk resolve the same
// text to the same date.

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DAY_MS = 86_400_000;

/**
 * How long an inferred date stays on this year's occurrence after it passes.
 *
 * "Next upcoming occurrence" taken literally would turn an open letter that was due yesterday into
 * one due in a year, which hides exactly the overdue row the desk exists to surface. For a month
 * after the date it is read as overdue; after that it rolls to the following year.
 */
export const YEARLESS_DEADLINE_GRACE_DAYS = 30;

export type MonthDay = { month: number; day: number };

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function monthDay(month: number, day: number): MonthDay | undefined {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12) {
    return undefined;
  }
  return day >= 1 && day <= DAYS_IN_MONTH[month - 1]! ? { month, day } : undefined;
}

function monthNamed(word: string): number | undefined {
  const key = word.toLowerCase().replace(/\.$/u, "");
  return MONTHS[key] ?? MONTHS[key.slice(0, 3)];
}

/**
 * A month and day with no year, or undefined.
 *
 * Accepts `MM-DD`, `--MM-DD` (ISO 8601's year-less form), `M/D`, `Dec 15`, `December 15th`,
 * `15 Dec` and `Dec. 15`. Anything carrying a four-digit year is not year-less and is rejected so
 * an explicit (even malformed) year is never silently replaced. Slashed dates read month first,
 * unless the first number cannot be a month (`15/12`).
 */
export function parseMonthDay(raw: string | undefined): MonthDay | undefined {
  const value = (raw ?? "").trim().replace(/,/gu, " ").replace(/\s+/gu, " ");
  if (!value || /\d{4}/u.test(value)) {
    return undefined;
  }
  const numeric = /^(?:--)?(\d{1,2})[-/.](\d{1,2})$/u.exec(value);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    return first > 12 && !value.startsWith("--")
      ? monthDay(second, first)
      : monthDay(first, second);
  }
  const named = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?$/iu.exec(value);
  if (named) {
    const month = monthNamed(named[1]!);
    return month ? monthDay(month, Number(named[2])) : undefined;
  }
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+\.?)$/iu.exec(value);
  if (dayFirst) {
    const month = monthNamed(dayFirst[2]!);
    return month ? monthDay(month, Number(dayFirst[1])) : undefined;
  }
  return undefined;
}

/**
 * The ISO date a year-less month-day stands for, given the instant each candidate resolves to.
 *
 * `instantOf` turns a candidate ISO date into the deadline instant (with the letter's own time and
 * timezone), so "upcoming" is judged at the real cutoff rather than at UTC midnight. Feb 29 skips
 * to the next leap year rather than rolling into March.
 */
export function resolveYearlessDate(
  parsed: MonthDay,
  instantOf: (isoDate: string) => string | undefined,
  now: Date,
): string | undefined {
  const floor = now.getTime() - YEARLESS_DEADLINE_GRACE_DAYS * DAY_MS;
  const startYear = now.getUTCFullYear() - 1;
  for (let year = startYear; year <= startYear + 9; year += 1) {
    const iso = `${year}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
    const at = instantOf(iso);
    if (at && Date.parse(at) >= floor) {
      return iso;
    }
  }
  return undefined;
}
