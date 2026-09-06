// Turns a member's sign-in log into a travel timeline.
//
// The input is one row per login, each carrying where the IP said it came from. That is a noisy
// shape to read as travel: somebody working from home for a month is thirty rows saying the same
// city, and the question a reader actually has -- "when was she in Singapore, and for how long" --
// is about the boundaries between those rows, not the rows.
//
// So the rows are collapsed into *stays*: a maximal run of consecutive sign-ins from one place.
// A stay is the honest unit here, because it is exactly as much as a login log can support. It
// says "she signed in from Zurich on the 3rd and again on the 9th, and nothing in between says
// otherwise". It does not say she was there on the 6th, and nothing below pretends it does --
// `first_seen` / `last_seen` are observations, and the gap between two stays is unobserved rather
// than travel time.
//
// Nothing here reads a member's self-reported `location`. This is the inferred side of the wall
// described in contracts/actions.ts, and it stays on its own side of it.

import type { AdminBotLoginEvent } from "../../contracts/activity-log.js";

/** One continuous run of sign-ins from a single place. */
export type AdminBotTravelStay = {
  /** Stable within one response, for list keys and for linking a row to a map marker. */
  id: string;
  city?: string;
  country?: string;
  continent?: string;
  timezone?: string;
  /** ISO-8601 of the earliest sign-in in the run. */
  first_seen: string;
  /** ISO-8601 of the latest. Equal to `first_seen` for a place seen exactly once. */
  last_seen: string;
  /** How many sign-ins were folded in. A one-login stay is weak evidence and reads as such. */
  login_count: number;
  /**
   * Whole days between the first and last sign-in, so a stay seen once reads 0 rather than 1.
   *
   * Deliberately not "days spent there": the true arrival is somewhere in the unobserved gap
   * before `first_seen` and the departure somewhere after `last_seen`, so this is the *observed*
   * span and always an underestimate. A reimbursement claim needs the boarding pass anyway; what
   * this is for is finding the trip, not evidencing it.
   */
  observed_days: number;
  /** False for the home base. The trip list is the stays where this is true. */
  away: boolean;
};

/** A member's timeline, plus the home base every "away" judgement is relative to. */
export type AdminBotTravelHistory = {
  member_id: string;
  member_name?: string;
  /**
   * Where this person is normally, derived rather than configured -- see {@link resolveHomeBase}.
   * Absent when the log is too thin to have an opinion, in which case no stay is marked away and
   * the timeline is still perfectly readable as a list of places.
   */
  home_city?: string;
  home_country?: string;
  /** Most recent first, which is the order the timeline is read in. */
  stays: AdminBotTravelStay[];
  /** How many sign-ins the timeline is built from, before collapsing. */
  login_count: number;
  /**
   * Sign-ins whose location was never resolved: an unconfigured IPinfo token, a private IP, a
   * provider timeout, or any login recorded before this feature existed. Surfaced rather than
   * silently dropped -- a timeline built from 4 of 300 logins is not a timeline, and the reader
   * has to be able to see that it is one.
   */
  unlocated_login_count: number;
};

const DAY_MS = 86_400_000;

/**
 * Collapse a login log into a travel timeline.
 *
 * Accepts events in any order and sorts them itself: the store hands them back newest-first, the
 * run detection below needs oldest-first, and a caller that has to remember which would eventually
 * pass the wrong one.
 */
export function buildTravelHistory(
  events: readonly AdminBotLoginEvent[],
  options: { memberId: string; memberName?: string } = { memberId: "" },
): AdminBotTravelHistory {
  const located = events.filter((event) => placeKey(event) !== undefined);
  const ordered = located.toSorted((a, b) => a.at.localeCompare(b.at));
  const stays: AdminBotTravelStay[] = [];
  for (const event of ordered) {
    const key = placeKey(event)!;
    const open = stays.at(-1);
    // Same place as the run we are already in: extend it rather than start a new one. A member
    // who signs in twice a day from one desk must produce one stay, not sixty.
    if (open && open.id === key) {
      open.last_seen = event.at;
      open.login_count += 1;
      // A later sign-in can carry detail an earlier one lacked. Only the zone: the city is part
      // of the key, so a run cannot gain one halfway through without having been a different run.
      if (!open.timezone && event.timezone) {
        open.timezone = event.timezone;
      }
      if (!open.continent && event.continent) {
        open.continent = event.continent;
      }
      continue;
    }
    stays.push({
      id: key,
      ...(event.city ? { city: event.city } : {}),
      ...(event.country ? { country: event.country } : {}),
      ...(event.continent ? { continent: event.continent } : {}),
      ...(event.timezone ? { timezone: event.timezone } : {}),
      first_seen: event.at,
      last_seen: event.at,
      login_count: 1,
      observed_days: 0,
      away: false,
    });
  }
  for (const stay of stays) {
    stay.observed_days = Math.floor(
      (Date.parse(stay.last_seen) - Date.parse(stay.first_seen)) / DAY_MS,
    );
  }
  const home = resolveHomeBase(stays);
  for (const stay of stays) {
    stay.away = home !== undefined && placeOf(stay) !== home.key;
  }
  // Ids are only unique per place, and a member who leaves and comes back has two stays in one
  // city. Suffix by position so a list key still identifies a row.
  stays.forEach((stay, index) => {
    stay.id = `${stay.id}#${index}`;
  });
  return {
    member_id: options.memberId,
    ...(options.memberName ? { member_name: options.memberName } : {}),
    ...(home?.city ? { home_city: home.city } : {}),
    ...(home?.country ? { home_country: home.country } : {}),
    stays: stays.toReversed(),
    login_count: events.length,
    unlocated_login_count: events.length - located.length,
  };
}

/**
 * Which place this person is normally in.
 *
 * By observed days rather than by login count or by most recent: a conference week can easily
 * out-login a quiet fortnight at the desk, and "where were they last" is the one answer that is
 * wrong precisely when it matters -- read on the Monday after a trip, it would call home the trip
 * and the trip home, inverting every row on the page.
 *
 * Ties break on login count, then on recency, so a member with two genuinely balanced bases gets a
 * stable answer instead of one that flips between requests.
 *
 * Returns undefined when there is only one place, or none: with nothing to contrast against,
 * "home" is not a claim the data supports, and marking the single known city as home would put a
 * confident label on a member who has signed in twice.
 */
function resolveHomeBase(
  stays: readonly AdminBotTravelStay[],
): { key: string; city?: string; country?: string } | undefined {
  const totals = new Map<
    string,
    { days: number; logins: number; last: string; city?: string; country?: string }
  >();
  for (const stay of stays) {
    const key = placeOf(stay);
    const running = totals.get(key);
    if (running) {
      running.days += stay.observed_days;
      running.logins += stay.login_count;
      if (stay.last_seen > running.last) {
        running.last = stay.last_seen;
      }
      continue;
    }
    totals.set(key, {
      days: stay.observed_days,
      logins: stay.login_count,
      last: stay.last_seen,
      ...(stay.city ? { city: stay.city } : {}),
      ...(stay.country ? { country: stay.country } : {}),
    });
  }
  if (totals.size < 2) {
    return undefined;
  }
  const ranked = [...totals.entries()].toSorted(
    ([, a], [, b]) => b.days - a.days || b.logins - a.logins || b.last.localeCompare(a.last),
  );
  // Safe to destructure: `ranked` has at least the two entries the size check above required.
  const [key, winner] = ranked[0];
  return {
    key,
    ...(winner.city ? { city: winner.city } : {}),
    ...(winner.country ? { country: winner.country } : {}),
  };
}

/**
 * The identity of a place, for run detection.
 *
 * City when there is one, country otherwise. Mixing the two grains is what makes this subtle: a
 * week of core-tier answers reading "Zurich, CH" followed by a Lite-tier "CH" is one desk, and
 * keying on the raw pair would split it into two stays and invent a departure. Keying the second
 * one as its own place is the price of that -- a country-only run is a stay of its own, labelled
 * with the country and nothing finer, which is exactly what is known.
 */
function placeKey(event: AdminBotLoginEvent): string | undefined {
  const city = event.city?.trim();
  const country = event.country?.trim();
  if (city) {
    return `${city}, ${country ?? "?"}`;
  }
  return country || undefined;
}

function placeOf(stay: AdminBotTravelStay): string {
  return stay.city ? `${stay.city}, ${stay.country ?? "?"}` : (stay.country ?? "");
}

/**
 * The away stays, newest first -- the reimbursement and planning view of the same timeline.
 *
 * A separate read rather than a flag the caller filters on, because "trip" carries one extra rule
 * the timeline does not: a single sign-in from an airport lounge on the way somewhere is a real
 * observation but not a trip anybody files an expense for, so a stay has to be observed on more
 * than one day to count. That threshold belongs next to the word "trip" and nowhere else.
 */
export function tripsFrom(history: AdminBotTravelHistory): AdminBotTravelStay[] {
  return history.stays.filter(
    (stay) => stay.away && (stay.login_count > 1 || stay.observed_days > 0),
  );
}
