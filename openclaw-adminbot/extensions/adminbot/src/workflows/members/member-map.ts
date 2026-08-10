// Where lab members are, for the member map.
//
// Two sources, in a fixed order: whatever Slack knows about a person wins, and the
// roster location (imported from the contact spreadsheet) is used only when Slack has
// nothing for them. Slack is preferred because people keep it current — a spreadsheet
// entry is whatever they typed when they joined.
//
// Both sources are free text written by humans: "ETH", "Zürich, Tübingen", "Mainly
// Montreal (can visit Toronto too)". Resolving that is the whole job of this module,
// and anything it cannot place is reported rather than guessed at or dropped.

import type { AdminBotLabMember } from "../../contracts/actions.js";

export type AdminBotMapPlace = {
  key: string;
  label: string;
  country: string;
  lat: number;
  lon: number;
};

// Coordinates for the places the roster actually uses, plus the hubs people move to.
// A city missing from here is not a failure: the member shows up under `unplaced` with
// the text they wrote, which is the signal to add an entry.
const GAZETTEER: AdminBotMapPlace[] = [
  { key: "toronto", label: "Toronto", country: "Canada", lat: 43.6532, lon: -79.3832 },
  { key: "montreal", label: "Montréal", country: "Canada", lat: 45.5019, lon: -73.5674 },
  { key: "vancouver", label: "Vancouver", country: "Canada", lat: 49.2827, lon: -123.1207 },
  { key: "zurich", label: "Zürich", country: "Switzerland", lat: 47.3769, lon: 8.5417 },
  { key: "geneva", label: "Geneva", country: "Switzerland", lat: 46.2044, lon: 6.1432 },
  { key: "tuebingen", label: "Tübingen", country: "Germany", lat: 48.5216, lon: 9.0576 },
  { key: "berlin", label: "Berlin", country: "Germany", lat: 52.52, lon: 13.405 },
  { key: "munich", label: "Munich", country: "Germany", lat: 48.1351, lon: 11.582 },
  { key: "saarbruecken", label: "Saarbrücken", country: "Germany", lat: 49.2402, lon: 6.9969 },
  { key: "london", label: "London", country: "United Kingdom", lat: 51.5074, lon: -0.1278 },
  { key: "oxford", label: "Oxford", country: "United Kingdom", lat: 51.752, lon: -1.2577 },
  {
    key: "cambridge-uk",
    label: "Cambridge (UK)",
    country: "United Kingdom",
    lat: 52.2053,
    lon: 0.1218,
  },
  { key: "edinburgh", label: "Edinburgh", country: "United Kingdom", lat: 55.9533, lon: -3.1883 },
  { key: "paris", label: "Paris", country: "France", lat: 48.8566, lon: 2.3522 },
  { key: "amsterdam", label: "Amsterdam", country: "Netherlands", lat: 52.3676, lon: 4.9041 },
  { key: "warsaw", label: "Warsaw", country: "Poland", lat: 52.2297, lon: 21.0122 },
  { key: "alicante", label: "Alicante", country: "Spain", lat: 38.3452, lon: -0.481 },
  { key: "madrid", label: "Madrid", country: "Spain", lat: 40.4168, lon: -3.7038 },
  { key: "barcelona", label: "Barcelona", country: "Spain", lat: 41.3874, lon: 2.1686 },
  { key: "milan", label: "Milan", country: "Italy", lat: 45.4642, lon: 9.19 },
  { key: "rome", label: "Rome", country: "Italy", lat: 41.9028, lon: 12.4964 },
  { key: "vienna", label: "Vienna", country: "Austria", lat: 48.2082, lon: 16.3738 },
  { key: "copenhagen", label: "Copenhagen", country: "Denmark", lat: 55.6761, lon: 12.5683 },
  { key: "stockholm", label: "Stockholm", country: "Sweden", lat: 59.3293, lon: 18.0686 },
  { key: "pittsburgh", label: "Pittsburgh", country: "United States", lat: 40.4406, lon: -79.9959 },
  { key: "boston", label: "Boston", country: "United States", lat: 42.3601, lon: -71.0589 },
  {
    key: "cambridge-ma",
    label: "Cambridge, MA",
    country: "United States",
    lat: 42.3736,
    lon: -71.1097,
  },
  { key: "new-york", label: "New York", country: "United States", lat: 40.7128, lon: -74.006 },
  { key: "new-jersey", label: "New Jersey", country: "United States", lat: 40.0583, lon: -74.4057 },
  {
    key: "san-francisco",
    label: "San Francisco",
    country: "United States",
    lat: 37.7749,
    lon: -122.4194,
  },
  {
    key: "los-angeles",
    label: "Los Angeles",
    country: "United States",
    lat: 34.0522,
    lon: -118.2437,
  },
  { key: "seattle", label: "Seattle", country: "United States", lat: 47.6062, lon: -122.3321 },
  { key: "chicago", label: "Chicago", country: "United States", lat: 41.8781, lon: -87.6298 },
  { key: "dallas", label: "Dallas", country: "United States", lat: 32.7767, lon: -96.797 },
  { key: "ann-arbor", label: "Ann Arbor", country: "United States", lat: 42.2808, lon: -83.743 },
  { key: "michigan", label: "Michigan", country: "United States", lat: 44.3148, lon: -85.6024 },
  { key: "mumbai", label: "Mumbai", country: "India", lat: 19.076, lon: 72.8777 },
  { key: "bengaluru", label: "Bengaluru", country: "India", lat: 12.9716, lon: 77.5946 },
  { key: "delhi", label: "Delhi", country: "India", lat: 28.6139, lon: 77.209 },
  { key: "chandigarh", label: "Chandigarh", country: "India", lat: 30.7333, lon: 76.7794 },
  { key: "pune", label: "Pune", country: "India", lat: 18.5204, lon: 73.8567 },
  { key: "hyderabad", label: "Hyderabad", country: "India", lat: 17.385, lon: 78.4867 },
  { key: "islamabad", label: "Islamabad", country: "Pakistan", lat: 33.6844, lon: 73.0479 },
  { key: "lahore", label: "Lahore", country: "Pakistan", lat: 31.5204, lon: 74.3587 },
  { key: "taipei", label: "Taipei", country: "Taiwan", lat: 25.033, lon: 121.5654 },
  { key: "beijing", label: "Beijing", country: "China", lat: 39.9042, lon: 116.4074 },
  { key: "shanghai", label: "Shanghai", country: "China", lat: 31.2304, lon: 121.4737 },
  { key: "hong-kong", label: "Hong Kong", country: "Hong Kong", lat: 22.3193, lon: 114.1694 },
  { key: "singapore", label: "Singapore", country: "Singapore", lat: 1.3521, lon: 103.8198 },
  { key: "tokyo", label: "Tokyo", country: "Japan", lat: 35.6762, lon: 139.6503 },
  { key: "seoul", label: "Seoul", country: "South Korea", lat: 37.5665, lon: 126.978 },
  { key: "kigali", label: "Kigali", country: "Rwanda", lat: -1.9441, lon: 30.0619 },
  { key: "cape-town", label: "Cape Town", country: "South Africa", lat: -33.9249, lon: 18.4241 },
  { key: "nairobi", label: "Nairobi", country: "Kenya", lat: -1.2921, lon: 36.8219 },
  { key: "lagos", label: "Lagos", country: "Nigeria", lat: 6.5244, lon: 3.3792 },
  { key: "cairo", label: "Cairo", country: "Egypt", lat: 30.0444, lon: 31.2357 },
  { key: "tel-aviv", label: "Tel Aviv", country: "Israel", lat: 32.0853, lon: 34.7818 },
  { key: "dubai", label: "Dubai", country: "United Arab Emirates", lat: 25.2048, lon: 55.2708 },
  { key: "sydney", label: "Sydney", country: "Australia", lat: -33.8688, lon: 151.2093 },
  { key: "melbourne", label: "Melbourne", country: "Australia", lat: -37.8136, lon: 144.9631 },
  { key: "sao-paulo", label: "São Paulo", country: "Brazil", lat: -23.5505, lon: -46.6333 },
  { key: "mexico-city", label: "Mexico City", country: "Mexico", lat: 19.4326, lon: -99.1332 },
];

const PLACES_BY_KEY = new Map(GAZETTEER.map((place) => [place.key, place]));

// What people write instead of a city name. Institutions dominate: "ETH" is where
// somebody works, and the map wants where they are.
const ALIASES: Record<string, string> = {
  eth: "zurich",
  ethz: "zurich",
  "eth zurich": "zurich",
  epfl: "geneva",
  "mpi is": "tuebingen",
  mpi: "tuebingen",
  "max planck": "tuebingen",
  tubingen: "tuebingen",
  tuebingen: "tuebingen",
  uoft: "toronto",
  "university of toronto": "toronto",
  vector: "toronto",
  mila: "montreal",
  cmu: "pittsburgh",
  mit: "cambridge-ma",
  harvard: "cambridge-ma",
  stanford: "san-francisco",
  berkeley: "san-francisco",
  "bay area": "san-francisco",
  nyc: "new-york",
  "new york city": "new-york",
  sf: "san-francisco",
  bangalore: "bengaluru",
  bombay: "mumbai",
  "washington dc": "new-york",
  uk: "london",
  england: "london",
};

// Strip accents so "Zürich" and "Zurich" resolve alike, then reduce to comparable words.
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/,;&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// People list several places ("Zurich/Tuebingen/Toronto", "Warsaw, Poland; Alicante,
// Spain (starting November)"). The first one is where they are now; the rest are travel
// plans or a second affiliation, so only the first is placed.
// Hedges people write in front of a place: "Mainly Montreal", "currently Berlin".
const LEADING_QUALIFIERS = /^(mainly|mostly|primarily|currently|usually|based in|now in)\s+/i;

function primaryFragment(value: string): string {
  const withoutParentheticals = value.replace(/\([^)]*\)/g, " ");
  const [first] = withoutParentheticals.split(/[/;]|\bor\b|\band\b/i);
  return (first ?? withoutParentheticals).replace(LEADING_QUALIFIERS, "").trim();
}

// An IANA timezone names a representative city, which is exactly what the map needs:
// "America/Toronto" -> "Toronto". Slack reports these for every active account.
//
// The region prefix is checked against the real IANA set rather than any word before a
// slash: people write "Toronto/London" to mean two cities, and treating that as a
// timezone would silently place them in the last one.
const IANA_REGIONS = new Set([
  "africa",
  "america",
  "antarctica",
  "arctic",
  "asia",
  "atlantic",
  "australia",
  "europe",
  "indian",
  "pacific",
  "etc",
  "us",
]);

function fragmentFromTimezone(value: string): string | undefined {
  const match = /^([a-z]+)\/(?:[a-z_]+\/)?([a-z_]+)$/i.exec(value.trim());
  if (!match || !IANA_REGIONS.has(match[1].toLowerCase())) {
    return undefined;
  }
  return match[2].replaceAll("_", " ");
}

export function resolvePlace(raw: string | undefined): AdminBotMapPlace | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const timezoneCity = fragmentFromTimezone(raw);
  const fragment = normalize(primaryFragment(timezoneCity ?? raw));
  if (!fragment) {
    return undefined;
  }
  // "Toronto, Canada" and "Pittsburgh, US" put the city first; try the whole fragment
  // before its head so "cambridge, ma" does not resolve as plain "cambridge".
  const candidates = [fragment, ...fragment.split(",").map((part) => part.trim())].filter(Boolean);
  for (const candidate of candidates) {
    const aliased = ALIASES[candidate];
    if (aliased && PLACES_BY_KEY.has(aliased)) {
      return PLACES_BY_KEY.get(aliased);
    }
    const direct = candidate.replaceAll(" ", "-");
    if (PLACES_BY_KEY.has(direct)) {
      return PLACES_BY_KEY.get(direct);
    }
    const byLabel = GAZETTEER.find((place) => normalize(place.label) === candidate);
    if (byLabel) {
      return byLabel;
    }
  }
  return undefined;
}

export type AdminBotMapSource = "slack" | "roster";

export type AdminBotMapMember = {
  member_id: string;
  name: string;
  source: AdminBotMapSource;
};

export type AdminBotMapPlaceGroup = AdminBotMapPlace & {
  members: AdminBotMapMember[];
};

export type AdminBotMemberMap = {
  places: AdminBotMapPlaceGroup[];
  // Members whose location text could not be placed, with what they wrote, so the
  // gazetteer can be extended deliberately instead of the map quietly under-reporting.
  unplaced: Array<{ member_id: string; name: string; raw?: string; source?: AdminBotMapSource }>;
  counts: { placed: number; unplaced: number; unknown: number };
};

// Statuses whose members have left; keeping them would show the lab as bigger and more
// spread out than it is.
const DEPARTED_STATUSES = new Set(["alumni"]);

export function buildMemberMap(
  members: readonly AdminBotLabMember[],
  slackLocations: ReadonlyMap<string, string> = new Map(),
): AdminBotMemberMap {
  const groups = new Map<string, AdminBotMapPlaceGroup>();
  const unplaced: AdminBotMemberMap["unplaced"] = [];
  let unknown = 0;

  for (const member of members) {
    if (DEPARTED_STATUSES.has(member.status ?? "")) {
      continue;
    }
    // Slack first, roster only when Slack has nothing for this person.
    const slackRaw = member.slack_user_id ? slackLocations.get(member.slack_user_id) : undefined;
    const raw = slackRaw?.trim() || member.location?.trim();
    const source: AdminBotMapSource | undefined = slackRaw?.trim()
      ? "slack"
      : member.location?.trim()
        ? "roster"
        : undefined;
    if (!raw || !source) {
      unknown += 1;
      unplaced.push({ member_id: member.id, name: member.name });
      continue;
    }
    const place = resolvePlace(raw);
    if (!place) {
      unplaced.push({ member_id: member.id, name: member.name, raw, source });
      continue;
    }
    const group = groups.get(place.key) ?? { ...place, members: [] };
    group.members.push({ member_id: member.id, name: member.name, source });
    groups.set(place.key, group);
  }

  for (const group of groups.values()) {
    group.members.sort((left, right) => left.name.localeCompare(right.name));
  }
  const places = [...groups.values()].toSorted(
    (left, right) =>
      right.members.length - left.members.length || left.label.localeCompare(right.label),
  );

  return {
    places,
    unplaced: unplaced.toSorted((left, right) => left.name.localeCompare(right.name)),
    counts: {
      placed: places.reduce((sum, place) => sum + place.members.length, 0),
      unplaced: unplaced.length - unknown,
      unknown,
    },
  };
}
