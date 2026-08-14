// Turning the wall-clock times a draft carries into instants Google will accept.
//
// The drafting model is asked for "YYYY-MM-DDTHH:mm" local to the operator's zone, because that is
// what a person means by "Thursday at 3" and asking a model for an offset invites it to invent one.
// The Calendar API wants RFC3339, and a zoneless "2026-09-01T13:00" is not RFC3339 — it has no
// offset and no seconds. Sent as-is it comes back as `Google API error (400 badRequest)`, which is
// exactly what every calendar write was failing with.
//
// So the wall-clock time plus the calendar's zone is resolved here into an absolute instant. Why an
// absolute UTC instant rather than a local time with an offset: an offset has to be *correct for
// that date*, which means knowing whether daylight saving is in effect, and getting that wrong
// moves a meeting by an hour twice a year. Resolving to an instant does the same arithmetic once,
// here, where it is tested.

const ZONELESS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/u;
const MINUTE_MS = 60_000;

/**
 * The offset, in minutes, that `zone` is from UTC at a given instant.
 *
 * Derived by asking Intl what wall-clock time the zone shows for that instant and comparing: the
 * difference is the offset. `en-CA` with these options formats as `YYYY-MM-DD, HH:mm:ss`, which
 * parses back predictably.
 */
function zoneOffsetMinutes(instantMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instantMs);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  // Hour 24 appears at midnight in some locales' formatting; normalise it to 0 so the arithmetic
  // below does not land a day out.
  const hour = read("hour") % 24;
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );
  return (asUtc - instantMs) / MINUTE_MS;
}

/**
 * A wall-clock time in `zone`, as an absolute instant.
 *
 * Two passes because the offset depends on the instant, and the instant is what we are solving for:
 * the first pass guesses using the offset at the UTC-interpreted time, the second corrects it if
 * that guess landed on the other side of a daylight-saving change.
 */
function resolveZonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = zoneOffsetMinutes(naive, zone);
  const firstGuess = naive - firstOffset * MINUTE_MS;
  const secondOffset = zoneOffsetMinutes(firstGuess, zone);
  return secondOffset === firstOffset ? firstGuess : naive - secondOffset * MINUTE_MS;
}

/**
 * An RFC3339 instant for a draft time, or `undefined` when the value is not a time at all.
 *
 * A value that already carries an offset or `Z` is returned untouched — it is already unambiguous,
 * and rewriting it could only introduce error. A bare `YYYY-MM-DD` is left alone too: that is an
 * all-day date, which Google takes in its own field and must not become midnight anywhere.
 */
export function toAbsoluteRfc3339(value: string, zone: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (HAS_OFFSET.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    return trimmed;
  }
  const match = ZONELESS.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second] = match;
  const instant = resolveZonedTime(
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? "0"),
    zone,
  );
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}
