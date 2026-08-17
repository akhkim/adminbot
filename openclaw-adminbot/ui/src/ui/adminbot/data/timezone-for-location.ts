// Guesses an IANA time zone from the free-text location a member typed.
//
// Why guess at all: `location` and `timezone` are both mandatory on the member sheet, and one is
// derivable from the other for almost everybody. Asking a person to scroll a 400-entry dropdown to
// restate a fact they just typed one field earlier is how "timezone" ended up blank on most of the
// roster. The profile prefills the control with this guess instead, and the member overrides it if
// the guess is wrong -- so the dropdown is a correction, not data entry.
//
// This is deliberately a suggestion and never a silent write: profile.ts shows what was inferred
// and from what, and the value only reaches the record through the same autosave as any field the
// member typed themselves. A wrong guess is therefore always visible before it is stored.
//
// Matching is "first place mentioned wins", because people write their primary location first --
// "Toronto (soon Berkeley)" is a Toronto person, and "Zurich/Tuebingen/Toronto" is a Zurich one.

// Zones whose own city name is not what people write. Keyed by the phrase as it appears in a
// location, mapped to the zone that phrase implies.
//
// Everything here was drawn from the locations actually on the roster rather than invented: US
// cities (IANA names one zone per region, not per city), Indian and Chinese cities (one zone for
// the whole country), and country/region names people give instead of a city.
const LOCATION_ALIASES: Record<string, string> = {
  // United States and Canada, by city or state, since IANA names regions.
  "ann arbor": "America/Detroit",
  "bay area": "America/Los_Angeles",
  berkeley: "America/Los_Angeles",
  boston: "America/New_York",
  "college park": "America/New_York",
  champaign: "America/Chicago",
  dallas: "America/Chicago",
  illinois: "America/Chicago",
  "new jersey": "America/New_York",
  montreal: "America/Toronto",
  ottawa: "America/Toronto",
  palo_alto: "America/Los_Angeles",
  philadelphia: "America/New_York",
  pittsburgh: "America/New_York",
  princeton: "America/New_York",
  providence: "America/New_York",
  "san francisco": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  sf: "America/Los_Angeles",
  "st louis": "America/Chicago",
  vancouver: "America/Vancouver",
  waterloo: "America/Toronto",
  "west lafayette": "America/Indiana/Indianapolis",

  // Europe.
  cambridge: "Europe/London",
  edinburgh: "Europe/London",
  geneva: "Europe/Zurich",
  lausanne: "Europe/Zurich",
  milan: "Europe/Rome",
  munich: "Europe/Berlin",
  oxford: "Europe/London",
  tubingen: "Europe/Berlin",
  heidelberg: "Europe/Berlin",

  // Asia, Africa and the Middle East.
  abuja: "Africa/Lagos",
  bangalore: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata",
  "cape town": "Africa/Johannesburg",
  chandigarh: "Asia/Kolkata",
  daejeon: "Asia/Seoul",
  delhi: "Asia/Kolkata",
  hyderabad: "Asia/Kolkata",
  islamabad: "Asia/Karachi",
  kharagpur: "Asia/Kolkata",
  lahore: "Asia/Karachi",
  mumbai: "Asia/Kolkata",
  pune: "Asia/Kolkata",
  tangier: "Africa/Casablanca",

  // Countries and regions, as the coarse fallback when no city in the string is recognised. A
  // country spanning several zones is deliberately absent rather than guessed at.
  canada: "America/Toronto",
  china: "Asia/Shanghai",
  czechia: "Europe/Prague",
  england: "Europe/London",
  france: "Europe/Paris",
  germany: "Europe/Berlin",
  india: "Asia/Kolkata",
  ireland: "Europe/Dublin",
  italy: "Europe/Rome",
  japan: "Asia/Tokyo",
  kenya: "Africa/Nairobi",
  korea: "Asia/Seoul",
  morocco: "Africa/Casablanca",
  netherlands: "Europe/Amsterdam",
  nigeria: "Africa/Lagos",
  norway: "Europe/Oslo",
  pakistan: "Asia/Karachi",
  poland: "Europe/Warsaw",
  portugal: "Europe/Lisbon",
  rwanda: "Africa/Kigali",
  singapore: "Asia/Singapore",
  "south africa": "Africa/Johannesburg",
  spain: "Europe/Madrid",
  sweden: "Europe/Stockholm",
  switzerland: "Europe/Zurich",
  taiwan: "Asia/Taipei",
  uk: "Europe/London",
  zimbabwe: "Africa/Harare",
};

// Strips accents and punctuation so "Zürich, CH" and "St. Louis" match the same phrases plain
// ASCII spellings do. Everything collapses to single-spaced lowercase.
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function supportedTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    // Older engines may not implement this. The alias table alone still resolves most locations,
    // and an unresolved one just leaves the field blank -- which is where it was anyway.
    return [];
  }
}

// The phrase → zone table the scan runs against: every zone's own city name, plus the aliases.
// Built once; the zone list is fixed for the life of the page.
let phraseTable: Array<{ phrase: string; zone: string }> | undefined;

function phrases(): Array<{ phrase: string; zone: string }> {
  if (phraseTable) {
    return phraseTable;
  }
  const table = new Map<string, string>();
  for (const zone of supportedTimeZones()) {
    // "Etc/GMT+5" and friends are offsets, not places, and would match nothing useful anyway.
    if (zone.startsWith("Etc/") || !zone.includes("/")) {
      continue;
    }
    const city = normalize(zone.slice(zone.lastIndexOf("/") + 1));
    // Short names ("Rio", "Lima") are too collision-prone inside free text to be worth having.
    if (city.length < 4) {
      continue;
    }
    // First zone wins, so America/New_York beats a later zone sharing a city name.
    if (!table.has(city)) {
      table.set(city, zone);
    }
  }
  // Aliases override zone city names: "cambridge" should be London, not America/Cambridge_Bay.
  for (const [phrase, zone] of Object.entries(LOCATION_ALIASES)) {
    table.set(normalize(phrase), zone);
  }
  phraseTable = [...table].map(([phrase, zone]) => ({ phrase, zone }));
  return phraseTable;
}

// True when `phrase` appears in `haystack` on whole-word boundaries, so "pune" does not match
// inside "Punenagar" and "sf" does not match inside "Dusseldorf".
function wordIndexOf(haystack: string, phrase: string): number {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(phrase, from);
    if (at < 0) {
      return -1;
    }
    const before = at === 0 || haystack[at - 1] === " ";
    const afterAt = at + phrase.length;
    const after = afterAt === haystack.length || haystack[afterAt] === " ";
    if (before && after) {
      return at;
    }
    from = at + 1;
  }
}

/**
 * The IANA time zone a location implies, or `null` when nothing in it is recognised.
 *
 * A location that already *is* a zone id ("Europe/London" — several roster rows carry one) is
 * returned as-is. Otherwise the first recognised place name in the string decides, so a member who
 * lists a move ("Toronto (soon Berkeley)") gets where they are now rather than where they are
 * going. Ties on position go to the longer phrase, so "south africa" beats a bare country word
 * inside it.
 */
export function timezoneForLocation(location: string): string | null {
  const raw = location.trim();
  if (!raw) {
    return null;
  }
  const zones = supportedTimeZones();
  const exact = zones.find((zone) => zone.toLowerCase() === raw.toLowerCase());
  if (exact) {
    return exact;
  }
  const haystack = normalize(raw);
  if (!haystack) {
    return null;
  }
  let best: { at: number; phrase: string; zone: string } | null = null;
  for (const { phrase, zone } of phrases()) {
    const at = wordIndexOf(haystack, phrase);
    if (at < 0) {
      continue;
    }
    if (!best || at < best.at || (at === best.at && phrase.length > best.phrase.length)) {
      best = { at, phrase, zone };
    }
  }
  return best?.zone ?? null;
}
