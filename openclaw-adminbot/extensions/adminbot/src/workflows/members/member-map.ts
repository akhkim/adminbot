// Where lab members are, for the member map.
//
// Three sources, tried in a fixed order, each one falling through to the next whenever it
// doesn't resolve to a place (not just when it's empty):
//   1. Slack's IANA timezone (or workspace location field) — a specific city, and the most
//      likely to be current, since people's Slack clients keep it in sync automatically.
//   2. The country/continent stamped on their most recent login, from IP geolocation — coarser
//      (country-level, no city), but still self-updating and current as of their last sign-in.
//   3. The roster `location` — self-typed once, at signup or when an admin adds them. Kept
//      last on purpose: it is whatever they wrote once and never updates itself.
//
// All three are resolved the same way a person would read them: free text written by humans
// ("ETH", "Zürich, Tübingen", "Mainly Montreal") for the first and third, a plain country name
// ("Switzerland") for the second. Anything none of the three can place is reported rather than
// guessed at or dropped.

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

// Approximate centroid (or capital, where that reads better on a low-zoom world map) per
// country, for placing a member by last-login geolocation, which only ever gives a country —
// there is no city to look up in GAZETTEER. Deliberately coarser than a real city dot; the UI
// marks a member placed this way rather than let it pass for city-level precision it doesn't
// have. A country IPinfo returns that isn't listed here reports here — same "add an entry
// deliberately" philosophy as an unresolved GAZETTEER lookup.
const COUNTRY_CENTROIDS: Record<string, { lat: number; lon: number }> = {
  "united states": { lat: 39.8283, lon: -98.5795 },
  canada: { lat: 56.1304, lon: -106.3468 },
  mexico: { lat: 23.6345, lon: -102.5528 },
  "united kingdom": { lat: 54, lon: -2 },
  ireland: { lat: 53.4129, lon: -8.2439 },
  france: { lat: 46.6034, lon: 1.8883 },
  germany: { lat: 51.1657, lon: 10.4515 },
  switzerland: { lat: 46.8182, lon: 8.2275 },
  austria: { lat: 47.5162, lon: 14.5501 },
  netherlands: { lat: 52.1326, lon: 5.2913 },
  belgium: { lat: 50.5039, lon: 4.4699 },
  luxembourg: { lat: 49.8153, lon: 6.1296 },
  spain: { lat: 40.4637, lon: -3.7492 },
  portugal: { lat: 39.3999, lon: -8.2245 },
  italy: { lat: 41.8719, lon: 12.5674 },
  poland: { lat: 51.9194, lon: 19.1451 },
  "czech republic": { lat: 49.8175, lon: 15.473 },
  czechia: { lat: 49.8175, lon: 15.473 },
  slovakia: { lat: 48.669, lon: 19.699 },
  hungary: { lat: 47.1625, lon: 19.5033 },
  romania: { lat: 45.9432, lon: 24.9668 },
  bulgaria: { lat: 42.7339, lon: 25.4858 },
  greece: { lat: 39.0742, lon: 21.8243 },
  croatia: { lat: 45.1, lon: 15.2 },
  slovenia: { lat: 46.1512, lon: 14.9955 },
  serbia: { lat: 44.0165, lon: 21.0059 },
  denmark: { lat: 56.2639, lon: 9.5018 },
  sweden: { lat: 60.1282, lon: 18.6435 },
  norway: { lat: 60.472, lon: 8.4689 },
  finland: { lat: 61.9241, lon: 25.7482 },
  iceland: { lat: 64.9631, lon: -19.0208 },
  estonia: { lat: 58.5953, lon: 25.0136 },
  latvia: { lat: 56.8796, lon: 24.6032 },
  lithuania: { lat: 55.1694, lon: 23.8813 },
  cyprus: { lat: 35.1264, lon: 33.4299 },
  malta: { lat: 35.9375, lon: 14.3754 },
  ukraine: { lat: 48.3794, lon: 31.1656 },
  russia: { lat: 61.524, lon: 105.3188 },
  turkey: { lat: 38.9637, lon: 35.2433 },
  india: { lat: 20.5937, lon: 78.9629 },
  pakistan: { lat: 30.3753, lon: 69.3451 },
  bangladesh: { lat: 23.685, lon: 90.3563 },
  "sri lanka": { lat: 7.8731, lon: 80.7718 },
  nepal: { lat: 28.3949, lon: 84.124 },
  china: { lat: 35.8617, lon: 104.1954 },
  "hong kong": { lat: 22.3193, lon: 114.1694 },
  taiwan: { lat: 23.6978, lon: 120.9605 },
  japan: { lat: 36.2048, lon: 138.2529 },
  "south korea": { lat: 35.9078, lon: 127.7669 },
  singapore: { lat: 1.3521, lon: 103.8198 },
  malaysia: { lat: 4.2105, lon: 101.9758 },
  indonesia: { lat: -0.7893, lon: 113.9213 },
  thailand: { lat: 15.87, lon: 100.9925 },
  vietnam: { lat: 14.0583, lon: 108.2772 },
  philippines: { lat: 12.8797, lon: 121.774 },
  israel: { lat: 31.0461, lon: 34.8516 },
  "united arab emirates": { lat: 23.4241, lon: 53.8478 },
  "saudi arabia": { lat: 23.8859, lon: 45.0792 },
  qatar: { lat: 25.3548, lon: 51.1839 },
  iran: { lat: 32.4279, lon: 53.688 },
  iraq: { lat: 33.2232, lon: 43.6793 },
  egypt: { lat: 26.8206, lon: 30.8025 },
  morocco: { lat: 31.7917, lon: -7.0926 },
  tunisia: { lat: 33.8869, lon: 9.5375 },
  algeria: { lat: 28.0339, lon: 1.6596 },
  nigeria: { lat: 9.082, lon: 8.6753 },
  ghana: { lat: 7.9465, lon: -1.0232 },
  kenya: { lat: -0.0236, lon: 37.9062 },
  rwanda: { lat: -1.9403, lon: 29.8739 },
  tanzania: { lat: -6.369, lon: 34.8888 },
  uganda: { lat: 1.3733, lon: 32.2903 },
  ethiopia: { lat: 9.145, lon: 40.4897 },
  "south africa": { lat: -30.5595, lon: 22.9375 },
  "ivory coast": { lat: 7.54, lon: -5.5471 },
  senegal: { lat: 14.4974, lon: -14.4524 },
  cameroon: { lat: 7.3697, lon: 12.3547 },
  zimbabwe: { lat: -19.0154, lon: 29.1549 },
  australia: { lat: -25.2744, lon: 133.7751 },
  "new zealand": { lat: -40.9006, lon: 174.886 },
  brazil: { lat: -14.235, lon: -51.9253 },
  argentina: { lat: -38.4161, lon: -63.6167 },
  chile: { lat: -35.6751, lon: -71.543 },
  colombia: { lat: 4.5709, lon: -74.2973 },
  peru: { lat: -9.19, lon: -75.0152 },
  ecuador: { lat: -1.8312, lon: -78.1834 },
  venezuela: { lat: 6.4238, lon: -66.5897 },
  uruguay: { lat: -32.5228, lon: -55.7658 },
  paraguay: { lat: -23.4425, lon: -58.4438 },
  bolivia: { lat: -16.2902, lon: -63.5887 },
  cuba: { lat: 21.5218, lon: -77.7812 },
  jamaica: { lat: 18.1096, lon: -77.2975 },
  "costa rica": { lat: 9.7489, lon: -83.7534 },
  panama: { lat: 8.538, lon: -80.7821 },
};

// Same normalize/candidate-fragment approach as resolvePlace, minus the timezone/gazetteer
// machinery a plain country name has no use for.
export function resolveCountry(raw: string | undefined): AdminBotMapPlace | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const key = normalize(raw);
  const coords = COUNTRY_CENTROIDS[key];
  if (!coords) {
    return undefined;
  }
  return { key: `country:${key}`, label: raw.trim(), country: raw.trim(), ...coords };
}

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

export type AdminBotMapSource = "slack" | "login" | "roster";

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

type MemberPlaceResolution =
  | { place: AdminBotMapPlace; source: AdminBotMapSource; raw: string }
  | { place?: undefined; raw?: string; source?: AdminBotMapSource };

// Tries Slack, then last-login, then roster, in that order — each one skipped in favor of the
// next whenever it fails to resolve, not just when it is empty, so one person's unresolvable
// Slack text does not hide a perfectly good roster location underneath it.
function resolveMemberPlace(
  member: AdminBotLabMember,
  slackRaw: string | undefined,
): MemberPlaceResolution {
  const slackText = slackRaw?.trim();
  if (slackText) {
    const place = resolvePlace(slackText);
    if (place) {
      return { place, source: "slack", raw: slackText };
    }
  }
  const loginText = member.last_login_country?.trim();
  if (loginText) {
    const place = resolveCountry(loginText);
    if (place) {
      return { place, source: "login", raw: loginText };
    }
  }
  const rosterText = member.location?.trim();
  if (rosterText) {
    const place = resolvePlace(rosterText);
    if (place) {
      return { place, source: "roster", raw: rosterText };
    }
  }
  // Nothing resolved: still report whatever the highest-priority source with any text wrote,
  // so an unplaced entry always points at the thing worth fixing.
  const raw = slackText || loginText || rosterText;
  const source: AdminBotMapSource | undefined = slackText ? "slack" : loginText ? "login" : rosterText ? "roster" : undefined;
  return raw && source ? { raw, source } : {};
}

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
    const slackRaw = member.slack_user_id ? slackLocations.get(member.slack_user_id) : undefined;
    const resolution = resolveMemberPlace(member, slackRaw);
    if (!resolution.place) {
      if (!resolution.raw || !resolution.source) {
        unknown += 1;
        unplaced.push({ member_id: member.id, name: member.name });
      } else {
        unplaced.push({
          member_id: member.id,
          name: member.name,
          raw: resolution.raw,
          source: resolution.source,
        });
      }
      continue;
    }
    const group = groups.get(resolution.place.key) ?? { ...resolution.place, members: [] };
    group.members.push({ member_id: member.id, name: member.name, source: resolution.source });
    groups.set(resolution.place.key, group);
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

export type AdminBotMapPlaceSummary = AdminBotMapPlace & { count: number };

export type AdminBotMemberMapSummary = {
  places: AdminBotMapPlaceSummary[];
  counts: AdminBotMemberMap["counts"];
};

// Where people are, without who: for callers who have not earned the right to read 100+
// individual names off a map (see the "Privileged rather than public" comment on GET
// /member-map in mock-service.ts). A headcount per city is not the thing that comment is
// about, so this stays available to everyone.
export function toPublicMemberMapSummary(map: AdminBotMemberMap): AdminBotMemberMapSummary {
  return {
    places: map.places.map(({ members, ...place }) => ({ ...place, count: members.length })),
    counts: map.counts,
  };
}
