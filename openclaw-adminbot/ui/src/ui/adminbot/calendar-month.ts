// Laying events out as a month, the way a calendar looks.
//
// The tab used to show Google's own embed in an iframe. That works only for a browser already
// signed into an account with access to the calendar — everyone else got Google's sign-in wall
// where the month was meant to be, and the app cannot even detect that from outside the frame. The
// service already reads the events, so drawing them ourselves means the picture works for whoever
// is looking, matches the list the actions operate on, and needs no third-party session.
//
// Everything here is pure and dateless: `now` and the month are passed in. Time zones are the whole
// difficulty in a calendar grid, so the rule is stated once — every instant is bucketed into a day
// **in the calendar's own zone**, via Intl, never by slicing an ISO string or reading local getters.
// A 9pm Toronto event is on that Toronto day even when the viewer's browser is in Zurich.

/** A day cell in the grid. */
export type CalendarDay = {
  /** `YYYY-MM-DD` in the calendar's zone — the key events are bucketed under. */
  key: string;
  day: number;
  /** False for the leading and trailing days that pad the grid to whole weeks. */
  inMonth: boolean;
  isToday: boolean;
};

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` for an instant, in the given zone. */
export function dayKeyInZone(value: Date | number, timezone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, which is the key format, so no reassembly is needed.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  } catch {
    // An unknown zone must not take the whole grid down with it.
    return new Date(value).toISOString().slice(0, 10);
  }
}

/**
 * The day an event sits on.
 *
 * An all-day event already carries a bare `YYYY-MM-DD` and must not be parsed: turning it into an
 * instant lands at UTC midnight, which is the previous day for anyone west of London — the classic
 * off-by-one that puts a holiday on the wrong square.
 */
export function eventDayKey(event: { start: string; all_day?: boolean }, timezone: string): string {
  if (event.all_day || /^\d{4}-\d{2}-\d{2}$/u.test(event.start)) {
    return event.start.slice(0, 10);
  }
  const parsed = Date.parse(event.start);
  return Number.isNaN(parsed) ? event.start.slice(0, 10) : dayKeyInZone(parsed, timezone);
}

/** First of the month containing `key`, as `YYYY-MM-01`. */
export function monthStartKey(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

/** Steps a `YYYY-MM` key by whole months, wrapping the year. */
export function shiftMonth(monthKey: string, months: number): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const zeroBased = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = zeroBased - nextYear * 12 + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
}

export function monthLabel(monthKey: string, locale?: string): string {
  const [year, month] = [Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7))];
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, 1));
}

/**
 * The weeks of a month, padded with the neighbouring days so every row is seven cells.
 *
 * Built in UTC on purpose: these are calendar squares, not instants. Using UTC arithmetic means the
 * grid is the same everywhere and cannot slip a day across a DST boundary, while the *events* are
 * still bucketed in the calendar's zone by `eventDayKey`.
 */
export function monthGrid(monthKey: string, todayKey: string): CalendarDay[][] {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const first = Date.UTC(year, month - 1, 1);
  const firstWeekday = new Date(first).getUTCDay();
  const start = first - firstWeekday * MS_PER_DAY;
  const nextMonth = Date.UTC(year, month, 1);
  const weeks: CalendarDay[][] = [];
  // Rows until the month runs out — four to six of them, never a trailing row that belongs
  // entirely to the next month.
  for (let cursor = start; cursor < nextMonth; cursor += 7 * MS_PER_DAY) {
    const days: CalendarDay[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const at = new Date(cursor + weekday * MS_PER_DAY);
      const key = at.toISOString().slice(0, 10);
      days.push({
        key,
        day: at.getUTCDate(),
        inMonth: at.getUTCMonth() === month - 1 && at.getUTCFullYear() === year,
        isToday: key === todayKey,
      });
    }
    weeks.push(days);
  }
  return weeks;
}

/** Events grouped by the day they fall on, each group in start order. */
export function eventsByDay<T extends { start: string; all_day?: boolean }>(
  events: readonly T[],
  timezone: string,
): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const event of events) {
    const key = eventDayKey(event, timezone);
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      byDay.set(key, [event]);
    }
  }
  for (const bucket of byDay.values()) {
    bucket.sort((left, right) => left.start.localeCompare(right.start));
  }
  return byDay;
}

/** The clock time to print on an event chip, in the calendar's zone. */
export function eventTimeLabel(
  event: { start: string; all_day?: boolean },
  timezone: string,
  locale?: string,
): string {
  if (event.all_day || /^\d{4}-\d{2}-\d{2}$/u.test(event.start)) {
    return "All day";
  }
  const parsed = Date.parse(event.start);
  if (Number.isNaN(parsed)) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(parsed);
  } catch {
    return "";
  }
}

/** The window to ask the service for, so navigating to a month actually loads that month. */
export function monthWindow(monthKey: string): { from: string; to: string } {
  const start = `${monthKey.slice(0, 7)}-01T00:00:00.000Z`;
  const next = shiftMonth(monthKey, 1);
  return { from: start, to: `${next.slice(0, 7)}-01T00:00:00.000Z` };
}
