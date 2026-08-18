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
import { timezoneForLocation } from "./timezone-for-location.ts";

export type AttendeeZoneSource = "timezone" | "current_city" | "location";

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
};

/**
 * The best zone available for a member, or undefined when the roster says nothing usable.
 *
 * Ordered by how directly the member said it: an explicit timezone is a statement, where they are
 * now is a statement a zone can be derived from, and where they live is the fallback. Undefined is
 * a real answer and must stay one — showing a made-up local time is worse than showing none,
 * because a reader cannot tell the difference between a guess and a fact once it is a clock face.
 */
export function resolveAttendeeZone(member: ZonedMember): AttendeeZone | undefined {
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
  return undefined;
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
export function attendeeHourVerdict(zone: string, instant: string): AttendeeHourVerdict | undefined {
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
