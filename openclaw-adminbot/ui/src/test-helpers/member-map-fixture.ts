// Synthetic /member-map bodies shaped like a real lab's spread: one very large home city, a second
// large one in Europe, and dense clumps in Europe, the US Northeast and North India, where dots
// collide at world scale. Every name is generated from the two lists below; nothing here is a real
// person or a real roster.

type FixtureCity = {
  key: string;
  label: string;
  country: string;
  lat: number;
  lon: number;
  count: number;
};

// 101 people across 35 places, the distribution the map has to read well at.
export const LAB_CITIES: readonly FixtureCity[] = [
  { key: "toronto", label: "Toronto", country: "Canada", lat: 43.65, lon: -79.38, count: 29 },
  { key: "zurich", label: "Zürich", country: "Switzerland", lat: 47.37, lon: 8.54, count: 14 },
  { key: "tubingen", label: "Tübingen", country: "Germany", lat: 48.52, lon: 9.06, count: 4 },
  { key: "london", label: "London", country: "United Kingdom", lat: 51.51, lon: -0.13, count: 4 },
  {
    key: "new-york",
    label: "New York",
    country: "United States",
    lat: 40.71,
    lon: -74.01,
    count: 4,
  },
  { key: "berlin", label: "Berlin", country: "Germany", lat: 52.52, lon: 13.4, count: 3 },
  { key: "montreal", label: "Montréal", country: "Canada", lat: 45.5, lon: -73.57, count: 3 },
  {
    key: "san-francisco",
    label: "San Francisco",
    country: "United States",
    lat: 37.77,
    lon: -122.42,
    count: 3,
  },
  { key: "darmstadt", label: "Darmstadt", country: "Germany", lat: 49.87, lon: 8.65, count: 2 },
  { key: "vienna", label: "Vienna", country: "Austria", lat: 48.21, lon: 16.37, count: 2 },
  { key: "oxford", label: "Oxford", country: "United Kingdom", lat: 51.75, lon: -1.26, count: 2 },
  { key: "paris", label: "Paris", country: "France", lat: 48.86, lon: 2.35, count: 2 },
  { key: "munich", label: "Munich", country: "Germany", lat: 48.14, lon: 11.58, count: 2 },
  {
    key: "pittsburgh",
    label: "Pittsburgh",
    country: "United States",
    lat: 40.44,
    lon: -80.0,
    count: 2,
  },
  { key: "boston", label: "Boston", country: "United States", lat: 42.36, lon: -71.06, count: 2 },
  { key: "vancouver", label: "Vancouver", country: "Canada", lat: 49.28, lon: -123.12, count: 2 },
  { key: "delhi", label: "Delhi", country: "India", lat: 28.61, lon: 77.21, count: 2 },
  { key: "bengaluru", label: "Bengaluru", country: "India", lat: 12.97, lon: 77.59, count: 2 },
  { key: "prague", label: "Prague", country: "Czechia", lat: 50.08, lon: 14.44, count: 1 },
  {
    key: "ann-arbor",
    label: "Ann Arbor",
    country: "United States",
    lat: 42.28,
    lon: -83.74,
    count: 1,
  },
  {
    key: "providence",
    label: "Providence",
    country: "United States",
    lat: 41.82,
    lon: -71.41,
    count: 1,
  },
  {
    key: "new-jersey",
    label: "New Jersey",
    country: "United States",
    lat: 40.35,
    lon: -74.66,
    count: 1,
  },
  {
    key: "seattle",
    label: "Seattle",
    country: "United States",
    lat: 47.61,
    lon: -122.33,
    count: 1,
  },
  { key: "chandigarh", label: "Chandigarh", country: "India", lat: 30.73, lon: 76.78, count: 1 },
  { key: "islamabad", label: "Islamabad", country: "Pakistan", lat: 33.68, lon: 73.05, count: 1 },
  { key: "mumbai", label: "Mumbai", country: "India", lat: 19.08, lon: 72.88, count: 1 },
  { key: "pune", label: "Pune", country: "India", lat: 18.52, lon: 73.86, count: 1 },
  { key: "singapore", label: "Singapore", country: "Singapore", lat: 1.35, lon: 103.82, count: 1 },
  { key: "tokyo", label: "Tokyo", country: "Japan", lat: 35.68, lon: 139.69, count: 1 },
  { key: "seoul", label: "Seoul", country: "South Korea", lat: 37.57, lon: 126.98, count: 1 },
  { key: "sydney", label: "Sydney", country: "Australia", lat: -33.87, lon: 151.21, count: 1 },
  { key: "sao-paulo", label: "São Paulo", country: "Brazil", lat: -23.55, lon: -46.63, count: 1 },
  { key: "tel-aviv", label: "Tel Aviv", country: "Israel", lat: 32.09, lon: 34.78, count: 1 },
  { key: "amsterdam", label: "Amsterdam", country: "Netherlands", lat: 52.37, lon: 4.9, count: 1 },
  { key: "country:KE", label: "Kenya", country: "Kenya", lat: 0.2, lon: 37.9, count: 1 },
];

// Extra places for the 250-person / 60-city load case.
const EXTRA_CITIES: readonly FixtureCity[] = [
  ["madrid", "Madrid", "Spain", 40.42, -3.7],
  ["barcelona", "Barcelona", "Spain", 41.39, 2.17],
  ["milan", "Milan", "Italy", 45.46, 9.19],
  ["rome", "Rome", "Italy", 41.9, 12.5],
  ["copenhagen", "Copenhagen", "Denmark", 55.68, 12.57],
  ["stockholm", "Stockholm", "Sweden", 59.33, 18.07],
  ["edinburgh", "Edinburgh", "United Kingdom", 55.95, -3.19],
  ["cambridge-uk", "Cambridge", "United Kingdom", 52.2, 0.12],
  ["heidelberg", "Heidelberg", "Germany", 49.4, 8.67],
  ["lausanne", "Lausanne", "Switzerland", 46.52, 6.63],
  ["chicago", "Chicago", "United States", 41.88, -87.63],
  ["waterloo", "Waterloo", "Canada", 43.46, -80.52],
  ["ottawa", "Ottawa", "Canada", 45.42, -75.7],
  ["philadelphia", "Philadelphia", "United States", 39.95, -75.17],
  ["austin", "Austin", "United States", 30.27, -97.74],
  ["los-angeles", "Los Angeles", "United States", 34.05, -118.24],
  ["hyderabad", "Hyderabad", "India", 17.39, 78.49],
  ["chennai", "Chennai", "India", 13.08, 80.27],
  ["lahore", "Lahore", "Pakistan", 31.55, 74.34],
  ["beijing", "Beijing", "China", 39.9, 116.4],
  ["shanghai", "Shanghai", "China", 31.23, 121.47],
  ["hong-kong", "Hong Kong", "China", 22.32, 114.17],
  ["melbourne", "Melbourne", "Australia", -37.81, 144.96],
  ["cape-town", "Cape Town", "South Africa", -33.92, 18.42],
  ["mexico-city", "Mexico City", "Mexico", 19.43, -99.13],
].map(([key, label, country, lat, lon], index) => ({
  key: key as string,
  label: label as string,
  country: country as string,
  lat: lat as number,
  lon: lon as number,
  count: 1 + (index % 4),
}));

const FIRST = [
  "Avery",
  "Blake",
  "Casey",
  "Devon",
  "Elliot",
  "Finley",
  "Harper",
  "Indra",
  "Jules",
  "Kai",
  "Lior",
  "Marlo",
  "Noor",
  "Oakley",
  "Parisa",
  "Quinn",
  "Remy",
  "Sage",
  "Tamsin",
  "Umi",
  "Vesna",
  "Wren",
  "Xiomara",
  "Yael",
  "Zarek",
];
const LAST = [
  "Example",
  "Sample",
  "Placeholder",
  "Testwood",
  "Fixture",
  "Mockridge",
  "Demo",
  "Synthwell",
  "Fauxley",
  "Stubbs",
  "Dummett",
  "Proto",
];

// Source strings the service may attach for an admin. Rotated so the admin detail has variety.
const SOURCE_LABELS = ["IP today", "IP 2d ago", "stated 3d ago", "profile", "IP ignored (VPN?)"];

function personName(index: number): string {
  return `${FIRST[index % FIRST.length]} ${LAST[Math.floor(index / FIRST.length) % LAST.length]}`;
}

export type MemberMapFixtureOptions = {
  mode?: "full" | "summary";
  /** "lab" is 101 people in 35 places; "large" adds places and people up to ~250 in 60. */
  size?: "lab" | "large";
};

/** A /member-map response body as the service would send it. */
export function memberMapFixture(options: MemberMapFixtureOptions = {}): Record<string, unknown> {
  const mode = options.mode ?? "full";
  const cities =
    options.size === "large"
      ? [
          ...LAB_CITIES.map((city) => ({ ...city, count: Math.round(city.count * 2.1) })),
          ...EXTRA_CITIES,
        ]
      : LAB_CITIES;
  let person = 0;
  const places = cities.map((city) => {
    if (mode === "summary") {
      return { ...city };
    }
    const members = Array.from({ length: city.count }, () => {
      const index = person++;
      const sourceLabel = SOURCE_LABELS[index % SOURCE_LABELS.length]!;
      return {
        member_id: `fixture-${index}`,
        name: personName(index),
        last_login_at: new Date(Date.UTC(2026, 9, 15) - index * 3_600_000).toISOString(),
        source:
          sourceLabel.startsWith("IP") && !sourceLabel.includes("ignored") ? "login" : "roster",
        source_label: sourceLabel,
        ...(sourceLabel.includes("ignored") ? { ip_ignored: "suspected_vpn" } : {}),
      };
    });
    return {
      key: city.key,
      label: city.label,
      country: city.country,
      lat: city.lat,
      lon: city.lon,
      members,
    };
  });
  const placed = cities.reduce((sum, city) => sum + city.count, 0);
  return {
    mode,
    places,
    unplaced_count: 2,
    counts: { placed, unplaced: 2, unknown: 0 },
    ...(mode === "full" ? { ip_geolocation: { active: true, provider: "DB-IP Lite" } } : {}),
  };
}
