// What time an event is where each attendee actually is.
//
// The lab schedules in one zone and its members are not all in it. Until now the only way to know
// that a 10am Toronto meeting is 4pm for somebody was to know where that somebody was — which is
// the thing the roster was worst at, and what the location timeline exists to fix. This is the
// consumer end of that: given a member and an instant, say what their clock reads.
//
// The zone is resolved through the same ladder the profile uses, most specific first, and the
// source is returned alongside it. That matters on screen: "Europe/Berlin (from their profile)" is
// a fact the member stated, while "(guessed from Toronto)" is an inference the reader should be
// able to discount.
import { tripOnDay, type TripRow } from "./availability.ts";
import { timezoneForLocation } from "./timezone-for-location.ts";

export type AttendeeZoneSource =
  | "trip"
  | "login_city"
  | "timezone"
  | "current_city"
  | "location"
  | "slack_location";

/**
 * How recent a sign-in has to be for the city it came from to mean "where they are".
 *
 * Three days: long enough to cover a weekend away from the console, short enough that it still
 * describes the present. Past that the city is history, and history is what `location` is for.
 */
export const LOGIN_CITY_FRESH_DAYS = 3;

const DAY_MS = 86_400_000;

export type AttendeeZone = {
  zone: string;
  source: AttendeeZoneSource;
  /** The text the zone was derived from, for a tooltip that explains itself. */
  from: string;
};

type ZonedMember = {
  timezone?: string | null;
  current_city?: string | null;
  location?: string | null;
  trips?: TripRow[] | null;
  /** Inferred from the last sign-in's IP, and only usable next to `last_login_at`. */
  last_login_city?: string | null;
  last_login_timezone?: string | null;
  last_login_at?: string | null;
  /** What the member put in their Slack profile, which is not always what the roster says. */
  slack_location?: string | null;
};

/**
 * The best zone available for a member, or undefined when the roster says nothing usable.
 *
 * The ladder, most specific first:
 *
 *   1. a sign-in from the last few days — inferred, but it is *evidence about now*, and someone
 *      who flew somewhere on Friday has a right clock here days before they edit their profile.
 *      Only ever consulted while it is fresh; see LOGIN_CITY_FRESH_DAYS.
 *   2. `timezone` — carried over from their Slack profile or typed in.
 *   3. `current_city` — where they said they are right now, when no timezone is set.
 *   4. `location` — where they live.
 *   5. `slack_location` — the free text on their Slack profile, last because it is the least
 *      structured thing here and often says "🌍" or a team name rather than a place.
 *
 * Rungs 2-4 keep the order they have always had. Only rung 1 is new, and it sits on top because a
 * recent sign-in is the one signal here that is about *today*: everything below it is a standing
 * fact that stays true while someone is away from home, which is exactly when it is wrong. Note
 * this is the only place inference outranks a self-report, and it is scoped to that freshness
 * window — nothing here is ever written back to the member's own fields.
 *
 * Undefined is a real answer and must stay one — showing a made-up local time is worse than
 * showing none, because a reader cannot tell the difference between a guess and a fact once it is
 * a clock face.
 */
export function resolveAttendeeZone(
  member: ZonedMember,
  now: Date = new Date(),
): AttendeeZone | undefined {
  const login = recentLoginZone(member, now);
  if (login) {
    return login;
  }
  const explicit = member.timezone?.trim();
  if (explicit) {
    return { zone: explicit, source: "timezone", from: explicit };
  }
  const current = member.current_city?.trim();
  const fromCurrent = current ? timezoneForLocation(current) : null;
  if (current && fromCurrent) {
    return { zone: fromCurrent, source: "current_city", from: current };
  }
  const home = member.location?.trim();
  const fromHome = home ? timezoneForLocation(home) : null;
  if (home && fromHome) {
    return { zone: fromHome, source: "location", from: home };
  }
  const slack = member.slack_location?.trim();
  const fromSlack = slack ? timezoneForLocation(slack) : null;
  if (slack && fromSlack) {
    return { zone: fromSlack, source: "slack_location", from: slack };
  }
  return undefined;
}

/**
 * The zone of a sign-in recent enough to still describe where someone is, or undefined.
 *
 * The provider's own IANA zone is preferred over guessing one from the city name: it is the same
 * lookup done better, and the gazetteer here only knows the cities the lab has met in. Either way
 * the *city* is what gets reported as the source, because "Zurich" is what a reader can check and
 * "Europe/Zurich" is what they would have to take on trust.
 */
function recentLoginZone(member: ZonedMember, now: Date): AttendeeZone | undefined {
  const city = member.last_login_city?.trim();
  const at = member.last_login_at?.trim();
  if (!city || !at) {
    return undefined;
  }
  const seen = new Date(at);
  if (Number.isNaN(seen.getTime())) {
    return undefined;
  }
  const age = now.getTime() - seen.getTime();
  // A clock skew that puts the sign-in slightly in the future is not a reason to discard it; a
  // sign-in from next month is, because something is wrong with the record.
  if (age > LOGIN_CITY_FRESH_DAYS * DAY_MS || age < -DAY_MS) {
    return undefined;
  }
  const zone = member.last_login_timezone?.trim() || timezoneForLocation(city);
  return zone ? { zone, source: "login_city", from: city } : undefined;
}

/**
 * The wall-clock time an instant reads as in a zone, or undefined for a zone Intl rejects.
 *
 * A member can type any string into the timezone field, so an invalid zone reaches here as a
 * matter of course; it must degrade to "unknown" rather than throwing inside a render.
 */
export function localTimeAt(zone: string, instant: string): string | undefined {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat([], {
      timeZone: zone,
      hour: "numeric",
      minute: "2-digit",
      weekday: "short",
    }).format(parsed);
  } catch {
    return undefined;
  }
}

export type AttendeeHourVerdict = "fine" | "early" | "late";

/**
 * Whether an instant lands at a reasonable hour for the attendee.
 *
 * Before 08:00 and from 21:00 are flagged. The point is not to forbid anything -- labs really do
 * meet across ten zones and somebody has to take the early call -- it is that whoever picks the
 * time should see they are picking it, rather than finding out from the person who got up at 5am.
 */
export function attendeeHourVerdict(
  zone: string,
  instant: string,
): AttendeeHourVerdict | undefined {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hour12: false }).format(
        parsed,
      ),
    );
  } catch {
    return undefined;
  }
  if (!Number.isFinite(hour)) {
    return undefined;
  }
  if (hour < 8) {
    return "early";
  }
  return hour >= 21 ? "late" : "fine";
}

/**
 * The zone a member is in on the day of a given instant.
 *
 * A logged trip covering that day wins over everything on the profile, and that is the point of
 * logging one: a member who wrote down "Berlin, 1-30 September" gets September invites read in
 * Berlin time and October invites back in home time, without touching their profile twice. The
 * trip's own zone is used when it has one, and guessed from its city when it does not.
 *
 * The day is taken in UTC. A trip is a range of dates rather than instants, so the boundary is
 * approximate by construction -- the flight home does not land at midnight either -- and being a
 * few hours out on the first or last day of a trip is not worth carrying a second zone to resolve.
 */
export function resolveAttendeeZoneAt(
  member: ZonedMember,
  instant: string,
  now: Date = new Date(),
): AttendeeZone | undefined {
  const parsed = new Date(instant);
  if (!Number.isNaN(parsed.getTime())) {
    const trip = tripOnDay(member.trips ?? [], parsed.toISOString().slice(0, 10));
    const zone = trip?.timezone?.trim() || (trip ? timezoneForLocation(trip.city) : null);
    if (trip && zone) {
      return { zone, source: "trip", from: trip.city };
    }
  }
  return resolveAttendeeZone(member, now);
}
