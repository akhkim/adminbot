// The rules behind "meet the lab members who are where you are": who counts as near, who has said
// yes, when a message may go out, and who has already been introduced to whom.
//
// Matching is by research interest; place is only the filter that says an introduction is worth
// making this week (an event both people are at, or a city both signed in from). Nothing here ever
// tracks anybody: a place is the city-level text the login stamp or the member's profile already
// holds, compared as a metro, and the only coordinates involved are the gazetteer's city centres.
//
// Pure and deterministic, so the service can hold the I/O and these can be tested on their own.
import type { AdminBotLabMember } from "../../contracts/actions.js";
import { isoDay, samePlace, travelPlace } from "./lab-travel.js";

// --- near ---------------------------------------------------------------------------------------

/**
 * Metros whose suburbs a login city or a profile names separately.
 *
 * The gazetteer knows city centres, and a 50 km radius joins most of a metro, but not all of it:
 * San Jose is 68 km from San Francisco, and IP geolocation happily reports "Mountain View" for
 * somebody at a conference downtown. Kept short on purpose: only places a lab member plausibly signs
 * in from, and only where the radius gets it wrong. An entry `name|cc` matches only in that
 * country, which is what keeps Cambridge, MA and Cambridge, UK apart.
 */
const METROS: ReadonlyArray<{ key: string; label: string; places: readonly string[] }> = [
  {
    key: "sf-bay-area",
    label: "San Francisco Bay Area",
    places: [
      "san francisco",
      "sf",
      "bay area",
      "san francisco bay area",
      "oakland",
      "berkeley",
      "emeryville",
      "san jose",
      "palo alto",
      "stanford",
      "menlo park",
      "mountain view",
      "sunnyvale",
      "santa clara",
      "cupertino",
      "redwood city",
      "san mateo",
      "south san francisco",
    ],
  },
  {
    key: "new-york",
    label: "New York",
    places: [
      "new york",
      "new york city",
      "nyc",
      "manhattan",
      "brooklyn",
      "queens",
      "jersey city",
      "hoboken",
    ],
  },
  {
    key: "boston",
    label: "Boston",
    places: ["boston", "cambridge|us", "somerville", "brookline"],
  },
  {
    key: "seattle",
    label: "Seattle",
    places: ["seattle", "bellevue", "redmond", "kirkland"],
  },
  {
    key: "los-angeles",
    label: "Los Angeles",
    places: ["los angeles", "la", "santa monica", "pasadena", "culver city"],
  },
  {
    key: "toronto",
    label: "Toronto",
    places: ["toronto", "mississauga", "markham", "north york", "scarborough", "etobicoke"],
  },
  {
    key: "london",
    label: "London",
    places: ["london|gb", "london|uk", "london, england", "london, united kingdom"],
  },
];

const COUNTRY_SYNONYMS: Record<string, string> = {
  us: "us",
  usa: "us",
  "united states": "us",
  "united states of america": "us",
  gb: "gb",
  uk: "gb",
  "united kingdom": "gb",
  england: "gb",
  ca: "ca",
  canada: "ca",
  // A state written where a country would be ("Cambridge, MA") still says which Cambridge.
  ma: "us",
  massachusetts: "us",
};

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9,| ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Where somebody is, at the grain the rules work in: a city name and, when known, a country. */
export type MeetupPlace = { city: string; country?: string };

export type Metro = { key: string; label: string };

/** The metro a place belongs to, or undefined for anywhere the table does not list. */
export function metroFor(place: MeetupPlace): Metro | undefined {
  const parts = fold(place.city)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const city = parts[0];
  if (!city) {
    return undefined;
  }
  const rawCountry = place.country ? fold(place.country) : parts.at(-1);
  const country = rawCountry ? COUNTRY_SYNONYMS[rawCountry] : undefined;
  const full = parts.join(", ");
  for (const metro of METROS) {
    for (const entry of metro.places) {
      const [name, onlyIn] = entry.split("|");
      if (onlyIn ? name === city && country === onlyIn : name === city || name === full) {
        return { key: metro.key, label: metro.label };
      }
    }
  }
  return undefined;
}

/**
 * Whether two places are near enough to meet: the same metro, or the gazetteer's 50 km radius, or
 * (for two places neither table knows) the same typed city name.
 */
export function nearEachOther(left: MeetupPlace, right: MeetupPlace): boolean {
  const a = metroFor(left);
  const b = metroFor(right);
  if (a && b) {
    return a.key === b.key;
  }
  return samePlace(travelPlace(left.city), travelPlace(right.city));
}

/**
 * A place as other people may read it: the metro's name, else the gazetteer's city label.
 *
 * Coarse on purpose. "San Francisco Bay Area" says the same thing as "Mountain View" for meeting
 * up, and says less about where one person slept.
 */
export function placeLabel(place: MeetupPlace): string {
  return metroFor(place)?.label ?? travelPlace(place.city).label;
}

/** A grouping key: the metro, else the gazetteer key, else the folded city text. */
export function placeKey(place: MeetupPlace): string {
  return (
    metroFor(place)?.key ??
    travelPlace(place.city).key ??
    fold(place.city)
      .split(",")[0]!
      .replace(/[^a-z0-9]+/gu, "-")
  );
}

// --- where a member is ----------------------------------------------------------------------------

/** How long a sign-in city says anything about where somebody is. Mirrors the UI's ladder. */
export const LOGIN_CITY_FRESH_DAYS = 3;

/** How far back a sign-in still counts for a city meetup: "both in San Francisco this week". */
export const CITY_MEETUP_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

function within(at: string | undefined, now: Date, days: number): boolean {
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) && now.getTime() - ms <= days * DAY_MS && ms <= now.getTime() + DAY_MS;
}

/** The sign-in city, if it is recent enough to say where the member is. */
export function signInPlace(
  member: Pick<AdminBotLabMember, "last_login_city" | "last_login_country" | "last_login_at">,
  now: Date,
  days = LOGIN_CITY_FRESH_DAYS,
): MeetupPlace | undefined {
  const city = member.last_login_city?.trim();
  if (!city || !within(member.last_login_at, now, days)) {
    return undefined;
  }
  return { city, ...(member.last_login_country ? { country: member.last_login_country } : {}) };
}

export type ViewerLocation = {
  label: string;
  /** sign_in: inferred from the last sign-in; profile/slack: what the member wrote. */
  source: "sign_in" | "profile" | "slack";
  place?: MeetupPlace;
};

/**
 * Where the viewer is, for their own eyes: the fresh sign-in city first, then what they stated
 * (current city, home, Slack), then the sign-in country alone. Never coordinates.
 */
export function viewerLocation(member: AdminBotLabMember, now: Date): ViewerLocation | undefined {
  // The viewer's own city, not the metro: this label is only ever shown to the member it is about.
  const signIn = signInPlace(member, now);
  if (signIn) {
    return { label: travelPlace(signIn.city).label, source: "sign_in", place: signIn };
  }
  const stated = member.current_city?.trim() || member.location?.trim();
  if (stated) {
    const place = { city: stated };
    return { label: travelPlace(stated).label, source: "profile", place };
  }
  const slack = member.slack_location?.trim();
  if (slack) {
    const place = { city: slack };
    return { label: travelPlace(slack).label, source: "slack", place };
  }
  const country = member.last_login_country?.trim();
  return country && within(member.last_login_at, now, LOGIN_CITY_FRESH_DAYS)
    ? { label: country, source: "sign_in" }
    : undefined;
}

/**
 * Whether `here` is the member's own stated home metro (profile city, else location, else Slack).
 *
 * Two people who both live in Toronto see each other at the lab; "you're both in Toronto this week"
 * is noise. A city intro or a Nearby now face needs somebody away from home. No stated home reads
 * as away, which is the generous answer for a member who never filled the field in.
 */
export function isAtHome(
  member: Pick<AdminBotLabMember, "current_city" | "location" | "slack_location">,
  here: MeetupPlace,
): boolean {
  const stated =
    member.current_city?.trim() || member.location?.trim() || member.slack_location?.trim();
  return Boolean(stated && nearEachOther({ city: stated }, here));
}

// --- opt-in ---------------------------------------------------------------------------------------

export type MeetupPreferences = {
  /** Intros to lab members at an event you are going to (or are in town for). Default on. */
  events: boolean;
  /** Intros to lab members who signed in from your metro this week. Default on. */
  city: boolean;
  /** No intros of either kind through this day (YYYY-MM-DD, inclusive). */
  snoozed_until?: string;
};

/**
 * The member's choices, with the defaults filled in.
 *
 * Both on: zero setup. Nobody fills in a form to be introduced; the only controls are the footer
 * link in every intro, the Events tab and the profile toggle. What keeps the city default honest is
 * what it reveals: only "around <metro> this week", only to other members around the same metro,
 * and never outside the lab's home metro (see LAB_HOME_METROS).
 */
export function meetupPreferences(
  member: Pick<AdminBotLabMember, "meetup_intros">,
): MeetupPreferences {
  const stored = member.meetup_intros;
  return {
    events: stored?.events ?? true,
    city: stored?.city ?? true,
    ...(stored?.snoozed_until ? { snoozed_until: stored.snoozed_until } : {}),
  };
}

/**
 * Whether this member may be named in an intro of this kind today. Every send path asks this.
 * An admin's do-not-contact wins over everything, including the member's own Say hi.
 */
export function meetupIntrosAllowed(
  member: Pick<AdminBotLabMember, "meetup_intros" | "do_not_contact">,
  kind: "event" | "city",
  today: string,
): boolean {
  if (member.do_not_contact) {
    return false;
  }
  const prefs = meetupPreferences(member);
  if (prefs.snoozed_until && today <= prefs.snoozed_until) {
    return false;
  }
  return kind === "event" ? prefs.events : prefs.city;
}

// --- quiet hours ----------------------------------------------------------------------------------

/** Intros go out between 10:00 and 20:00 in every recipient's own time zone. */
export const INTRO_FIRST_HOUR = 10;
export const INTRO_LAST_HOUR = 20;

/** The hour (0-23) in a zone, or undefined for a zone Intl does not know. */
export function localHour(zone: string, now: Date): number | undefined {
  try {
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now);
    const parsed = Number(hour);
    return Number.isInteger(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The member's clock: a fresh sign-in zone (they travelled), else the zone they set. */
export function memberZone(
  member: Pick<AdminBotLabMember, "last_login_timezone" | "last_login_at" | "timezone">,
  now: Date,
): string | undefined {
  const fresh = within(member.last_login_at, now, LOGIN_CITY_FRESH_DAYS)
    ? member.last_login_timezone?.trim()
    : undefined;
  for (const zone of [fresh, member.timezone?.trim()]) {
    if (zone && localHour(zone, now) !== undefined) {
      return zone;
    }
  }
  return undefined;
}

/**
 * Whether it is daytime for everybody in the intro.
 *
 * A zone nobody has told us is skipped rather than guessed: guessing the lab's home zone for a
 * member who is abroad is exactly how a message lands at 3am. With no zone at all the intro goes
 * now, which is what it did before quiet hours existed.
 */
export function isIntroSendTime(zones: ReadonlyArray<string | undefined>, now: Date): boolean {
  return zones.every((zone) => {
    if (!zone) {
      return true;
    }
    const hour = localHour(zone, now);
    return hour === undefined || (hour >= INTRO_FIRST_HOUR && hour < INTRO_LAST_HOUR);
  });
}

// --- history --------------------------------------------------------------------------------------

/** At most one city intro per member per place in this many days. */
export const CITY_INTRO_COOLDOWN_DAYS = 14;

export const CITY_INTRO_KEY_PREFIX = "city-intro:";

/** `city-intro:<place>:<member>:<day>`: one attempt per subject per place per day. */
export function cityIntroKey(place: string, memberId: string, day: string): string {
  return `${CITY_INTRO_KEY_PREFIX}${place}:${memberId}:${day}`;
}

type IntroRecord = {
  status: string;
  idempotency_key?: string;
  proposed_payload?: unknown;
};

function memberIdsOf(proposal: IntroRecord): string[] {
  const ids = (proposal.proposed_payload as { member_ids?: unknown } | undefined)?.member_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * Everyone who has already been in an intro together, event or city, as unordered pairs.
 *
 * Donut's rule: a pairing that happened is spent. Only executed intros count; a deferred or
 * rejected one introduced nobody.
 */
export function introPairs(history: readonly IntroRecord[]): Set<string> {
  const pairs = new Set<string>();
  for (const proposal of history) {
    if (proposal.status !== "executed") {
      continue;
    }
    const ids = memberIdsOf(proposal);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        pairs.add(pairKey(ids[i]!, ids[j]!));
      }
    }
  }
  return pairs;
}

/** Whether the member was in an executed city intro for this place within the cooldown. */
export function onCityCooldown(
  history: readonly IntroRecord[],
  place: string,
  memberId: string,
  today: string,
): boolean {
  const since = isoDay(
    new Date(Date.parse(`${today}T00:00:00Z`) - (CITY_INTRO_COOLDOWN_DAYS - 1) * DAY_MS),
  );
  const prefix = `${CITY_INTRO_KEY_PREFIX}${place}:`;
  return history.some((proposal) => {
    if (proposal.status !== "executed" || !proposal.idempotency_key?.startsWith(prefix)) {
      return false;
    }
    const day = proposal.idempotency_key.slice(-10);
    return day >= since && day <= today && memberIdsOf(proposal).includes(memberId);
  });
}
