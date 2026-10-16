// Which clock a gazetteer city keeps, and whether a member's Slack zone agrees with it.
//
// The timezone cross-check asks one question: when something places a member in a city, does the
// zone their Slack account reports (`slack_tz`, which their device sets) keep roughly the same
// time? If not -- by more than ADMINBOT_TZ_MISMATCH_HOURS -- one of the two is wrong, and the admin
// map says so instead of silently trusting either.
//
// The gazetteer carries coordinates, not zones, so a city's zone is derived here: every country the
// gazetteer spans maps to its zone, and the handful of countries that span several are split by
// longitude (with the few cities that keep their own rules -- Phoenix, Regina -- named). That is
// exact for every city the gazetteer holds today; a city added in a multi-zone country later lands
// in the band its longitude falls in, which is right everywhere except near a zone border, and a
// border error is one hour -- inside the two-hour tolerance.
//
// Offsets are always compared at a given instant, never as fixed numbers: Reykjavík and Helsinki
// are two hours apart in winter and three in summer, and only the instant knows which.

import type { AdminBotMapPlace } from "./member-map.js";

/** How far apart a city's clock and the Slack zone may be before the map flags a mismatch. */
export const ADMINBOT_TZ_MISMATCH_HOURS = 2;

const COUNTRY_ZONE: Readonly<Record<string, string>> = {
  Argentina: "America/Argentina/Buenos_Aires",
  Austria: "Europe/Vienna",
  Bangladesh: "Asia/Dhaka",
  Belgium: "Europe/Brussels",
  Brazil: "America/Sao_Paulo",
  Bulgaria: "Europe/Sofia",
  Chile: "America/Santiago",
  China: "Asia/Shanghai",
  Colombia: "America/Bogota",
  Croatia: "Europe/Zagreb",
  Czechia: "Europe/Prague",
  Denmark: "Europe/Copenhagen",
  Egypt: "Africa/Cairo",
  Estonia: "Europe/Tallinn",
  Ethiopia: "Africa/Addis_Ababa",
  Finland: "Europe/Helsinki",
  France: "Europe/Paris",
  Germany: "Europe/Berlin",
  Ghana: "Africa/Accra",
  Greece: "Europe/Athens",
  "Hong Kong": "Asia/Hong_Kong",
  Hungary: "Europe/Budapest",
  Iceland: "Atlantic/Reykjavik",
  India: "Asia/Kolkata",
  Indonesia: "Asia/Jakarta",
  Iran: "Asia/Tehran",
  Ireland: "Europe/Dublin",
  Israel: "Asia/Jerusalem",
  Italy: "Europe/Rome",
  Japan: "Asia/Tokyo",
  Kenya: "Africa/Nairobi",
  Latvia: "Europe/Riga",
  Lithuania: "Europe/Vilnius",
  Malaysia: "Asia/Kuala_Lumpur",
  Mexico: "America/Mexico_City",
  Morocco: "Africa/Casablanca",
  Nepal: "Asia/Kathmandu",
  Netherlands: "Europe/Amsterdam",
  "New Zealand": "Pacific/Auckland",
  Nigeria: "Africa/Lagos",
  Norway: "Europe/Oslo",
  Pakistan: "Asia/Karachi",
  Peru: "America/Lima",
  Philippines: "Asia/Manila",
  Poland: "Europe/Warsaw",
  Portugal: "Europe/Lisbon",
  Qatar: "Asia/Qatar",
  Romania: "Europe/Bucharest",
  Russia: "Europe/Moscow",
  Rwanda: "Africa/Kigali",
  "Saudi Arabia": "Asia/Riyadh",
  Serbia: "Europe/Belgrade",
  Singapore: "Asia/Singapore",
  Slovakia: "Europe/Bratislava",
  Slovenia: "Europe/Ljubljana",
  "South Africa": "Africa/Johannesburg",
  "South Korea": "Asia/Seoul",
  Spain: "Europe/Madrid",
  "Sri Lanka": "Asia/Colombo",
  Sweden: "Europe/Stockholm",
  Switzerland: "Europe/Zurich",
  Taiwan: "Asia/Taipei",
  Thailand: "Asia/Bangkok",
  Turkey: "Europe/Istanbul",
  Ukraine: "Europe/Kyiv",
  "United Arab Emirates": "Asia/Dubai",
  "United Kingdom": "Europe/London",
  Uruguay: "America/Montevideo",
  Vietnam: "Asia/Ho_Chi_Minh",
};

// Cities whose rules differ from their longitude band.
const CITY_ZONE: Readonly<Record<string, string>> = {
  phoenix: "America/Phoenix",
  regina: "America/Regina",
  honolulu: "Pacific/Honolulu",
  anchorage: "America/Anchorage",
};

function unitedStatesZone(place: AdminBotMapPlace): string {
  if (place.lat < 25 && place.lon < -150) {
    return "Pacific/Honolulu";
  }
  if (place.lat > 50 && place.lon < -130) {
    return "America/Anchorage";
  }
  if (place.lon > -87.5) {
    return "America/New_York";
  }
  if (place.lon > -101) {
    return "America/Chicago";
  }
  if (place.lon > -115) {
    return "America/Denver";
  }
  return "America/Los_Angeles";
}

function canadaZone(place: AdminBotMapPlace): string {
  if (place.lon > -55) {
    return "America/St_Johns";
  }
  if (place.lon > -67) {
    return "America/Halifax";
  }
  if (place.lon > -90) {
    return "America/Toronto";
  }
  if (place.lon > -102) {
    return "America/Winnipeg";
  }
  if (place.lon > -120) {
    return "America/Edmonton";
  }
  return "America/Vancouver";
}

function australiaZone(place: AdminBotMapPlace): string {
  if (place.lon < 129) {
    return "Australia/Perth";
  }
  if (place.lon < 141) {
    return place.lat > -20 ? "Australia/Darwin" : "Australia/Adelaide";
  }
  // Queensland keeps no daylight saving; the rest of the east coast does.
  return place.lat > -29 ? "Australia/Brisbane" : "Australia/Sydney";
}

/** The IANA zone a gazetteer city keeps, or undefined for a country the table does not know. */
export function placeTimezone(place: AdminBotMapPlace): string | undefined {
  const named = CITY_ZONE[place.key];
  if (named) {
    return named;
  }
  switch (place.country) {
    case "United States":
      return unitedStatesZone(place);
    case "Canada":
      return canadaZone(place);
    case "Australia":
      return australiaZone(place);
    default:
      return COUNTRY_ZONE[place.country];
  }
}

/**
 * Minutes east of UTC that `zone` keeps at `at`, or undefined for a zone Intl does not know.
 * Read from Intl at that instant, so daylight saving is whatever it actually was then.
 */
export function zoneOffsetMinutes(zone: string, at: Date): number | undefined {
  let name: string | undefined;
  try {
    name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
  if (!name) {
    return undefined;
  }
  if (name === "GMT") {
    return 0;
  }
  const match = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(name);
  if (!match) {
    return undefined;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

export type AdminBotTimezoneMismatch = {
  /** The zone Slack reports. */
  slack_tz: string;
  /** The zone the placed city keeps. */
  place_tz: string;
  /** How far apart the two clocks are at that instant, in hours (absolute, may be fractional). */
  hours: number;
};

/**
 * Whether the Slack zone disagrees with a placed city by more than the tolerance, at `at`.
 * Undefined when they agree, or when either zone cannot be read -- an unknown is not a conflict.
 */
export function timezoneMismatch(
  place: AdminBotMapPlace,
  slackTz: string | undefined,
  at: Date,
  toleranceHours: number = ADMINBOT_TZ_MISMATCH_HOURS,
): AdminBotTimezoneMismatch | undefined {
  const reported = slackTz?.trim();
  const placeTz = placeTimezone(place);
  if (!reported || !placeTz) {
    return undefined;
  }
  const slackOffset = zoneOffsetMinutes(reported, at);
  const placeOffset = zoneOffsetMinutes(placeTz, at);
  if (slackOffset === undefined || placeOffset === undefined) {
    return undefined;
  }
  const hours = Math.abs(slackOffset - placeOffset) / 60;
  return hours > toleranceHours ? { slack_tz: reported, place_tz: placeTz, hours } : undefined;
}
