// Where lab members are, for the member map.
//
// Every source a member has is resolved in order and the first one that places them wins. A
// country-level answer never beats a city, so countries come last whatever their source:
//
//   1. The city of a fresh sign-in (within ADMINBOT_MAP_LOGIN_FRESH_DAYS), from the local IP
//      geolocation database. It is where the person actually was most recently, so it leads -- unless
//      the member set `map_visibility` to "stated", which skips every sign-in source. Placed at the
//      gazetteer's city centroid, never at the IP's coordinates, which nothing here ever receives.
//   2. A stated city: `current_city` (where they say they are now), then the roster `location`,
//      then the Slack profile's location field. The member's own words.
//   3. The city an IANA timezone is named for: Slack's `tz`, then the roster `timezone`.
//      "America/Toronto" says Toronto, but it says the same for Montréal, so it is a city-level
//      answer that is less exact than either of the above.
//   4. A country: any of the texts above that names only a country ("Germany"), then the country
//      of the last sign-in. Drawn hollow by the UI so it does not pass for a city.
//
// A member whose `map_visibility` is "hidden" is not on the map at all.
//
// Text is read the way a person would read it: free text written by humans ("ETH", "Zürich,
// Tübingen", "Mainly Montreal"), a timezone, or a city with its region and country from the IP
// provider ("London", "Ontario", "CA"). Anything none of the sources can place is reported under
// `unplaced` with what was written, rather than guessed at or dropped.

import type { AdminBotLabMember } from "../../contracts/actions.js";
import { isDoNotContact } from "./do-not-contact.js";

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
  // Conference cities and the hubs people fly through to reach them. The Travel tab names a
  // browser location fix by its nearest entry here -- there is deliberately no reverse-geocoding
  // service, because sending a member's coordinates to a third party is the disclosure the whole
  // opt-in is built to avoid -- so a gap in this list shows up as "120 km from Lyon" rather than as
  // the city somebody is actually in.
  { key: "atlanta", label: "Atlanta", country: "United States", lat: 33.749, lon: -84.388 },
  { key: "budapest", label: "Budapest", country: "Hungary", lat: 47.4979, lon: 19.0402 },
  { key: "athens", label: "Athens", country: "Greece", lat: 37.9838, lon: 23.7275 },
  { key: "zhuhai", label: "Zhuhai", country: "China", lat: 22.2711, lon: 113.5767 },
  { key: "shenzhen", label: "Shenzhen", country: "China", lat: 22.5431, lon: 114.0579 },
  { key: "hangzhou", label: "Hangzhou", country: "China", lat: 30.2741, lon: 120.1551 },
  { key: "lisbon", label: "Lisbon", country: "Portugal", lat: 38.7223, lon: -9.1393 },
  { key: "dublin", label: "Dublin", country: "Ireland", lat: 53.3498, lon: -6.2603 },
  { key: "brussels", label: "Brussels", country: "Belgium", lat: 50.8503, lon: 4.3517 },
  { key: "prague", label: "Prague", country: "Czechia", lat: 50.0755, lon: 14.4378 },
  { key: "helsinki", label: "Helsinki", country: "Finland", lat: 60.1699, lon: 24.9384 },
  { key: "oslo", label: "Oslo", country: "Norway", lat: 59.9139, lon: 10.7522 },
  { key: "lyon", label: "Lyon", country: "France", lat: 45.764, lon: 4.8357 },
  { key: "hamburg", label: "Hamburg", country: "Germany", lat: 53.5511, lon: 9.9937 },
  { key: "frankfurt", label: "Frankfurt", country: "Germany", lat: 50.1109, lon: 8.6821 },
  { key: "lausanne", label: "Lausanne", country: "Switzerland", lat: 46.5197, lon: 6.6323 },
  { key: "krakow", label: "Kraków", country: "Poland", lat: 50.0647, lon: 19.945 },
  { key: "istanbul", label: "Istanbul", country: "Turkey", lat: 41.0082, lon: 28.9784 },
  { key: "kyoto", label: "Kyoto", country: "Japan", lat: 35.0116, lon: 135.7681 },
  { key: "osaka", label: "Osaka", country: "Japan", lat: 34.6937, lon: 135.5023 },
  { key: "bangkok", label: "Bangkok", country: "Thailand", lat: 13.7563, lon: 100.5018 },
  {
    key: "kuala-lumpur",
    label: "Kuala Lumpur",
    country: "Malaysia",
    lat: 3.139,
    lon: 101.6869,
  },
  {
    key: "abu-dhabi",
    label: "Abu Dhabi",
    country: "United Arab Emirates",
    lat: 24.4539,
    lon: 54.3773,
  },
  { key: "doha", label: "Doha", country: "Qatar", lat: 25.2854, lon: 51.531 },
  { key: "honolulu", label: "Honolulu", country: "United States", lat: 21.3069, lon: -157.8583 },
  {
    key: "new-orleans",
    label: "New Orleans",
    country: "United States",
    lat: 29.9511,
    lon: -90.0715,
  },
  { key: "austin", label: "Austin", country: "United States", lat: 30.2672, lon: -97.7431 },
  { key: "san-diego", label: "San Diego", country: "United States", lat: 32.7157, lon: -117.1611 },
  {
    key: "philadelphia",
    label: "Philadelphia",
    country: "United States",
    lat: 39.9526,
    lon: -75.1652,
  },
  { key: "denver", label: "Denver", country: "United States", lat: 39.7392, lon: -104.9903 },
  { key: "ottawa", label: "Ottawa", country: "Canada", lat: 45.4215, lon: -75.6972 },
  { key: "waterloo", label: "Waterloo", country: "Canada", lat: 43.4643, lon: -80.5204 },
  { key: "brisbane", label: "Brisbane", country: "Australia", lat: -27.4698, lon: 153.0251 },
  { key: "auckland", label: "Auckland", country: "New Zealand", lat: -36.8485, lon: 174.7633 },
  {
    key: "rio-de-janeiro",
    label: "Rio de Janeiro",
    country: "Brazil",
    lat: -22.9068,
    lon: -43.1729,
  },
  {
    key: "buenos-aires",
    label: "Buenos Aires",
    country: "Argentina",
    lat: -34.6037,
    lon: -58.3816,
  },
  // Cities IANA timezones are named for, and university towns the lab's people move between, so a
  // Slack `tz` or a login city places someone instead of reporting them unplaced.
  { key: "london-on", label: "London, ON", country: "Canada", lat: 42.9849, lon: -81.2453 },
  { key: "kingston-on", label: "Kingston, ON", country: "Canada", lat: 44.2312, lon: -76.486 },
  { key: "hamilton-on", label: "Hamilton, ON", country: "Canada", lat: 43.2557, lon: -79.8711 },
  { key: "edmonton", label: "Edmonton", country: "Canada", lat: 53.5461, lon: -113.4938 },
  { key: "calgary", label: "Calgary", country: "Canada", lat: 51.0447, lon: -114.0719 },
  { key: "winnipeg", label: "Winnipeg", country: "Canada", lat: 49.8951, lon: -97.1384 },
  { key: "regina", label: "Regina", country: "Canada", lat: 50.4452, lon: -104.6189 },
  { key: "halifax", label: "Halifax", country: "Canada", lat: 44.6488, lon: -63.5752 },
  { key: "quebec-city", label: "Québec City", country: "Canada", lat: 46.8139, lon: -71.208 },
  {
    key: "washington-dc",
    label: "Washington, DC",
    country: "United States",
    lat: 38.9072,
    lon: -77.0369,
  },
  { key: "baltimore", label: "Baltimore", country: "United States", lat: 39.2904, lon: -76.6122 },
  { key: "princeton", label: "Princeton", country: "United States", lat: 40.3573, lon: -74.6672 },
  { key: "new-haven", label: "New Haven", country: "United States", lat: 41.3083, lon: -72.9279 },
  { key: "providence", label: "Providence", country: "United States", lat: 41.824, lon: -71.4128 },
  { key: "ithaca", label: "Ithaca", country: "United States", lat: 42.444, lon: -76.5019 },
  { key: "durham-nc", label: "Durham, NC", country: "United States", lat: 35.994, lon: -78.8986 },
  { key: "detroit", label: "Detroit", country: "United States", lat: 42.3314, lon: -83.0458 },
  {
    key: "indianapolis",
    label: "Indianapolis",
    country: "United States",
    lat: 39.7684,
    lon: -86.1581,
  },
  { key: "columbus", label: "Columbus", country: "United States", lat: 39.9612, lon: -82.9988 },
  { key: "madison", label: "Madison", country: "United States", lat: 43.0731, lon: -89.4012 },
  {
    key: "minneapolis",
    label: "Minneapolis",
    country: "United States",
    lat: 44.9778,
    lon: -93.265,
  },
  { key: "houston", label: "Houston", country: "United States", lat: 29.7604, lon: -95.3698 },
  { key: "miami", label: "Miami", country: "United States", lat: 25.7617, lon: -80.1918 },
  { key: "phoenix", label: "Phoenix", country: "United States", lat: 33.4484, lon: -112.074 },
  {
    key: "salt-lake-city",
    label: "Salt Lake City",
    country: "United States",
    lat: 40.7608,
    lon: -111.891,
  },
  { key: "portland", label: "Portland", country: "United States", lat: 45.5152, lon: -122.6784 },
  { key: "palo-alto", label: "Palo Alto", country: "United States", lat: 37.4419, lon: -122.143 },
  { key: "san-jose", label: "San Jose", country: "United States", lat: 37.3382, lon: -121.8863 },
  { key: "irvine", label: "Irvine", country: "United States", lat: 33.6846, lon: -117.8265 },
  { key: "anchorage", label: "Anchorage", country: "United States", lat: 61.2181, lon: -149.9003 },
  { key: "manchester", label: "Manchester", country: "United Kingdom", lat: 53.4808, lon: -2.2426 },
  { key: "bristol", label: "Bristol", country: "United Kingdom", lat: 51.4545, lon: -2.5879 },
  { key: "glasgow", label: "Glasgow", country: "United Kingdom", lat: 55.8642, lon: -4.2518 },
  { key: "cologne", label: "Cologne", country: "Germany", lat: 50.9375, lon: 6.9603 },
  { key: "stuttgart", label: "Stuttgart", country: "Germany", lat: 48.7758, lon: 9.1829 },
  { key: "heidelberg", label: "Heidelberg", country: "Germany", lat: 49.3988, lon: 8.6724 },
  { key: "darmstadt", label: "Darmstadt", country: "Germany", lat: 49.8728, lon: 8.6512 },
  { key: "dresden", label: "Dresden", country: "Germany", lat: 51.0504, lon: 13.7373 },
  { key: "basel", label: "Basel", country: "Switzerland", lat: 47.5596, lon: 7.5886 },
  { key: "bern", label: "Bern", country: "Switzerland", lat: 46.948, lon: 7.4474 },
  { key: "delft", label: "Delft", country: "Netherlands", lat: 52.0116, lon: 4.3571 },
  { key: "utrecht", label: "Utrecht", country: "Netherlands", lat: 52.0907, lon: 5.1214 },
  { key: "eindhoven", label: "Eindhoven", country: "Netherlands", lat: 51.4416, lon: 5.4697 },
  { key: "leuven", label: "Leuven", country: "Belgium", lat: 50.8798, lon: 4.7005 },
  { key: "aarhus", label: "Aarhus", country: "Denmark", lat: 56.1629, lon: 10.2039 },
  { key: "gothenburg", label: "Gothenburg", country: "Sweden", lat: 57.7089, lon: 11.9746 },
  { key: "grenoble", label: "Grenoble", country: "France", lat: 45.1885, lon: 5.7245 },
  { key: "turin", label: "Turin", country: "Italy", lat: 45.0703, lon: 7.6869 },
  { key: "reykjavik", label: "Reykjavík", country: "Iceland", lat: 64.1466, lon: -21.9426 },
  { key: "tallinn", label: "Tallinn", country: "Estonia", lat: 59.437, lon: 24.7536 },
  { key: "riga", label: "Riga", country: "Latvia", lat: 56.9496, lon: 24.1052 },
  { key: "vilnius", label: "Vilnius", country: "Lithuania", lat: 54.6872, lon: 25.2797 },
  { key: "bratislava", label: "Bratislava", country: "Slovakia", lat: 48.1486, lon: 17.1077 },
  { key: "ljubljana", label: "Ljubljana", country: "Slovenia", lat: 46.0569, lon: 14.5058 },
  { key: "zagreb", label: "Zagreb", country: "Croatia", lat: 45.815, lon: 15.9819 },
  { key: "belgrade", label: "Belgrade", country: "Serbia", lat: 44.7866, lon: 20.4489 },
  { key: "bucharest", label: "Bucharest", country: "Romania", lat: 44.4268, lon: 26.1025 },
  { key: "sofia", label: "Sofia", country: "Bulgaria", lat: 42.6977, lon: 23.3219 },
  { key: "kyiv", label: "Kyiv", country: "Ukraine", lat: 50.4501, lon: 30.5234 },
  { key: "moscow", label: "Moscow", country: "Russia", lat: 55.7558, lon: 37.6173 },
  { key: "jerusalem", label: "Jerusalem", country: "Israel", lat: 31.7683, lon: 35.2137 },
  { key: "haifa", label: "Haifa", country: "Israel", lat: 32.794, lon: 34.9896 },
  { key: "tehran", label: "Tehran", country: "Iran", lat: 35.6892, lon: 51.389 },
  { key: "riyadh", label: "Riyadh", country: "Saudi Arabia", lat: 24.7136, lon: 46.6753 },
  { key: "karachi", label: "Karachi", country: "Pakistan", lat: 24.8607, lon: 67.0011 },
  { key: "kolkata", label: "Kolkata", country: "India", lat: 22.5726, lon: 88.3639 },
  { key: "chennai", label: "Chennai", country: "India", lat: 13.0827, lon: 80.2707 },
  { key: "kanpur", label: "Kanpur", country: "India", lat: 26.4499, lon: 80.3319 },
  { key: "dhaka", label: "Dhaka", country: "Bangladesh", lat: 23.8103, lon: 90.4125 },
  { key: "kathmandu", label: "Kathmandu", country: "Nepal", lat: 27.7172, lon: 85.324 },
  { key: "colombo", label: "Colombo", country: "Sri Lanka", lat: 6.9271, lon: 79.8612 },
  { key: "jakarta", label: "Jakarta", country: "Indonesia", lat: -6.2088, lon: 106.8456 },
  {
    key: "ho-chi-minh-city",
    label: "Ho Chi Minh City",
    country: "Vietnam",
    lat: 10.8231,
    lon: 106.6297,
  },
  { key: "hanoi", label: "Hanoi", country: "Vietnam", lat: 21.0278, lon: 105.8342 },
  { key: "manila", label: "Manila", country: "Philippines", lat: 14.5995, lon: 120.9842 },
  { key: "guangzhou", label: "Guangzhou", country: "China", lat: 23.1291, lon: 113.2644 },
  { key: "nanjing", label: "Nanjing", country: "China", lat: 32.0603, lon: 118.7969 },
  { key: "wuhan", label: "Wuhan", country: "China", lat: 30.5928, lon: 114.3055 },
  { key: "chengdu", label: "Chengdu", country: "China", lat: 30.5728, lon: 104.0668 },
  { key: "daejeon", label: "Daejeon", country: "South Korea", lat: 36.3504, lon: 127.3845 },
  { key: "nagoya", label: "Nagoya", country: "Japan", lat: 35.1815, lon: 136.9066 },
  { key: "casablanca", label: "Casablanca", country: "Morocco", lat: 33.5731, lon: -7.5898 },
  { key: "accra", label: "Accra", country: "Ghana", lat: 5.6037, lon: -0.187 },
  { key: "addis-ababa", label: "Addis Ababa", country: "Ethiopia", lat: 9.03, lon: 38.74 },
  {
    key: "johannesburg",
    label: "Johannesburg",
    country: "South Africa",
    lat: -26.2041,
    lon: 28.0473,
  },
  { key: "perth", label: "Perth", country: "Australia", lat: -31.9505, lon: 115.8605 },
  { key: "adelaide", label: "Adelaide", country: "Australia", lat: -34.9285, lon: 138.6007 },
  { key: "canberra", label: "Canberra", country: "Australia", lat: -35.2809, lon: 149.13 },
  { key: "wellington", label: "Wellington", country: "New Zealand", lat: -41.2865, lon: 174.7762 },
  { key: "bogota", label: "Bogotá", country: "Colombia", lat: 4.711, lon: -74.0721 },
  { key: "lima", label: "Lima", country: "Peru", lat: -12.0464, lon: -77.0428 },
  { key: "santiago", label: "Santiago", country: "Chile", lat: -33.4489, lon: -70.6693 },
  { key: "montevideo", label: "Montevideo", country: "Uruguay", lat: -34.9011, lon: -56.1645 },
];

const PLACES_BY_KEY = new Map(GAZETTEER.map((place) => [place.key, place]));

/** Every city the gazetteer knows, for callers that place a coordinate rather than a name. */
export function gazetteerPlaces(): readonly AdminBotMapPlace[] {
  return GAZETTEER;
}

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

// ISO 3166-1 alpha-2 codes for every country above. IPinfo's core endpoint (the one that also
// returns a city) answers `country` with the code -- "CH", not "Switzerland" -- and that is what
// lands in `last_login_country` whenever the core lookup succeeds. Without this table every such
// login fell through as unplaceable text, so login geolocation silently placed nobody once the
// core endpoint went in. Lite answers with the name, which the table above already covers.
const COUNTRY_CODES: Record<string, string> = {
  us: "united states",
  ca: "canada",
  mx: "mexico",
  gb: "united kingdom",
  ie: "ireland",
  fr: "france",
  de: "germany",
  ch: "switzerland",
  at: "austria",
  nl: "netherlands",
  be: "belgium",
  lu: "luxembourg",
  es: "spain",
  pt: "portugal",
  it: "italy",
  pl: "poland",
  cz: "czechia",
  sk: "slovakia",
  hu: "hungary",
  ro: "romania",
  bg: "bulgaria",
  gr: "greece",
  hr: "croatia",
  si: "slovenia",
  rs: "serbia",
  dk: "denmark",
  se: "sweden",
  no: "norway",
  fi: "finland",
  is: "iceland",
  ee: "estonia",
  lv: "latvia",
  lt: "lithuania",
  cy: "cyprus",
  mt: "malta",
  ua: "ukraine",
  ru: "russia",
  tr: "turkey",
  in: "india",
  pk: "pakistan",
  bd: "bangladesh",
  lk: "sri lanka",
  np: "nepal",
  cn: "china",
  hk: "hong kong",
  tw: "taiwan",
  jp: "japan",
  kr: "south korea",
  sg: "singapore",
  my: "malaysia",
  id: "indonesia",
  th: "thailand",
  vn: "vietnam",
  ph: "philippines",
  il: "israel",
  ae: "united arab emirates",
  sa: "saudi arabia",
  qa: "qatar",
  ir: "iran",
  iq: "iraq",
  eg: "egypt",
  ma: "morocco",
  tn: "tunisia",
  dz: "algeria",
  ng: "nigeria",
  gh: "ghana",
  ke: "kenya",
  rw: "rwanda",
  tz: "tanzania",
  ug: "uganda",
  et: "ethiopia",
  za: "south africa",
  ci: "ivory coast",
  sn: "senegal",
  cm: "cameroon",
  zw: "zimbabwe",
  au: "australia",
  nz: "new zealand",
  br: "brazil",
  ar: "argentina",
  cl: "chile",
  co: "colombia",
  pe: "peru",
  ec: "ecuador",
  ve: "venezuela",
  uy: "uruguay",
  py: "paraguay",
  bo: "bolivia",
  cu: "cuba",
  jm: "jamaica",
  cr: "costa rica",
  pa: "panama",
};

// Spellings of the same country that would otherwise become two dots in one place.
const COUNTRY_ALIASES: Record<string, string> = {
  "czech republic": "czechia",
  turkiye: "turkey",
  "cote d ivoire": "ivory coast",
  "viet nam": "vietnam",
  "korea republic of": "south korea",
  "republic of korea": "south korea",
  uk: "united kingdom",
  usa: "united states",
  "united states of america": "united states",
};

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// Same normalize/candidate-fragment approach as resolvePlace, minus the timezone/gazetteer
// machinery a plain country name has no use for. Accepts a name or an alpha-2 code, and labels
// the place with the canonical name either way, so "CH" and "Switzerland" share one dot reading
// "Switzerland" rather than two dots, one of them captioned "CH".
export function resolveCountry(raw: string | undefined): AdminBotMapPlace | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const normalized = normalize(raw);
  const key =
    (normalized.length === 2 ? COUNTRY_CODES[normalized] : undefined) ??
    COUNTRY_ALIASES[normalized] ??
    normalized;
  const coords = COUNTRY_CENTROIDS[key];
  if (!coords) {
    return undefined;
  }
  const label = titleCase(key);
  return { key: `country:${key}`, label, country: label, ...coords };
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
  "washington dc": "washington-dc",
  "washington, dc": "washington-dc",
  "washington d c": "washington-dc",
  dc: "washington-dc",
  // IANA zone names and older spellings that differ from the city's label.
  calcutta: "kolkata",
  madras: "chennai",
  kiev: "kyiv",
  saigon: "ho-chi-minh-city",
  "ho chi minh": "ho-chi-minh-city",
  katmandu: "kathmandu",
  koln: "cologne",
  koeln: "cologne",
  goteborg: "gothenburg",
  quebec: "quebec-city",
  "quebec city": "quebec-city",
  // London, Ontario is the only shared city name the lab actually has both halves of.
  "london, ontario": "london-on",
  "london, on": "london-on",
  "london ontario": "london-on",
  "kingston, ontario": "kingston-on",
  "kingston, on": "kingston-on",
  "hamilton, ontario": "hamilton-on",
  "hamilton, on": "hamilton-on",
  "durham, nc": "durham-nc",
  "durham, north carolina": "durham-nc",
  uwo: "london-on",
  "western university": "london-on",
  "queens university": "kingston-on",
  mcmaster: "hamilton-on",
  uwaterloo: "waterloo",
  ubc: "vancouver",
  mcgill: "montreal",
  yale: "new-haven",
  brown: "providence",
  cornell: "ithaca",
  duke: "durham-nc",
  jhu: "baltimore",
  "johns hopkins": "baltimore",
  "uw madison": "madison",
  "ut austin": "austin",
  ucsd: "san-diego",
  ucla: "los-angeles",
  uci: "irvine",
  "tu delft": "delft",
  "ku leuven": "leuven",
  "tu darmstadt": "darmstadt",
  kaist: "daejeon",
  "iit kanpur": "kanpur",
  "iit madras": "chennai",
  "iit delhi": "delhi",
  "iit bombay": "mumbai",
  technion: "haifa",
  uk: "london",
  england: "london",
  // AACL-IJCNLP 2026 meets in Hengqin, which is a district of Zhuhai.
  hengqin: "zhuhai",
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
  // "London, ON, Canada": the city with its region is tried before the city alone, so the region
  // can pick between two places that share a name.
  const parts = fragment.split(",").map((part) => part.trim());
  const candidates = [
    fragment,
    ...(parts.length > 2 ? [`${parts[0]}, ${parts[1]}`] : []),
    ...parts,
  ].filter(Boolean);
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

/**
 * How exact a member's pin is, which the map's popup says out loud.
 * - `city`: a city somebody named, or the city of a fresh sign-in.
 * - `timezone`: the city an IANA zone is named for ("America/Toronto"), which also covers its
 *   neighbours -- right region, not necessarily the right city.
 * - `country`: only a country is known; the pin is on its centroid.
 */
export type AdminBotMapPrecision = "city" | "timezone" | "country";

export type AdminBotMapMember = {
  member_id: string;
  name: string;
  source: AdminBotMapSource;
  precision: AdminBotMapPrecision;
  // Both optional: not every member has a synced Slack avatar. `last_login_at` is only sent when a
  // sign-in is what placed the member, so the UI can say "from sign-in today" and show the most
  // recently active faces first; it is never a history, only the one moment behind the pin.
  avatar_url?: string;
  last_login_at?: string;
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

// Names a roster row gets when the name cell holds no name at all: a blank exported as "null", a
// stub typed while testing an import. Matched whole and case-insensitively, so a real "Nullah" or
// "Testa" is untouched.
const PLACEHOLDER_NAMES = new Set([
  "null",
  "undefined",
  "none",
  "n/a",
  "na",
  "nan",
  "test",
  "test user",
  "test member",
  "placeholder",
]);

/**
 * Whether a roster row should stay off the map entirely -- out of `places` and `unplaced` both, so
 * no shape of `GET /member-map` returns it.
 *
 * Two reasons, kept deliberately narrow because a false positive hides a real member from the
 * lab's own map:
 * - the member opted out (isDoNotContact). These are real people; a map is exactly the
 *   advertising they asked to be left out of.
 * - the row has no usable name, so there is nobody to show and the card would print "Null".
 * It does not read `test_onboard_batch` (that marks a real person onboarding in a batch) or email
 * domains (fixtures across the suite use @example.com for real-shaped members).
 */
export function isHiddenFromMemberMap(
  member: Pick<AdminBotLabMember, "name" | "preferred_name">,
): boolean {
  if (isDoNotContact(member)) {
    return true;
  }
  const name = typeof member.name === "string" ? member.name.trim() : "";
  return !name || PLACEHOLDER_NAMES.has(name.toLowerCase().replace(/\s+/g, " "));
}

type MemberPlaceResolution =
  | {
      place: AdminBotMapPlace;
      source: AdminBotMapSource;
      precision: AdminBotMapPrecision;
      raw: string;
    }
  | { place?: undefined; raw?: string; source?: AdminBotMapSource };

/**
 * How recent a sign-in has to be for the city it came from to say where somebody is.
 *
 * The same three days the Control UI's attendee clocks use (LOGIN_CITY_FRESH_DAYS in
 * ui/src/ui/adminbot/data/attendee-time.ts), and the window contracts/actions.ts names for
 * `last_login_city`: a city is a statement about one moment, and a month-old one says nothing about
 * today. Past it the member still gets their login country, which carries no such rule.
 */
export const ADMINBOT_LOGIN_CITY_FRESH_DAYS = 3;

/**
 * How recent a sign-in has to be for the map to place somebody at its city. Longer than the clocks'
 * three days because the map answers "where is the lab based", not "what time is it for them now":
 * somebody who signed in from home last week still lives there. Past it the map falls back to what
 * the member stated.
 */
export const ADMINBOT_MAP_LOGIN_FRESH_DAYS = 14;

export type AdminBotMapVisibility = "auto" | "stated" | "hidden";

export const ADMINBOT_MAP_VISIBILITIES: readonly AdminBotMapVisibility[] = [
  "auto",
  "stated",
  "hidden",
];

/** The member's own choice from Profile; anything missing or unrecognised means "auto". */
export function memberMapVisibility(
  member: Pick<AdminBotLabMember, "map_visibility">,
): AdminBotMapVisibility {
  const value = member.map_visibility;
  return value === "stated" || value === "hidden" ? value : "auto";
}

const DAY_MS = 86_400_000;

export type BuildMemberMapOptions = {
  /**
   * Whether sign-in cities may place members at all. On for signed-in callers (members and
   * admins); off for an anonymous visitor, who gets only what members stated. Each member's own
   * `map_visibility` still applies on top. The map only ever carries the city -- never the IP, its
   * coordinates, or a history of sign-ins.
   */
  loginCity?: boolean;
  now?: Date;
};

function freshLoginCity(member: AdminBotLabMember, now: Date): string | undefined {
  const city = member.last_login_city?.trim();
  const at = member.last_login_at?.trim();
  if (!city || !at) {
    return undefined;
  }
  const seen = Date.parse(at);
  if (Number.isNaN(seen)) {
    return undefined;
  }
  const age = now.getTime() - seen;
  // A little clock skew into the future is tolerated; a sign-in from next month is a bad record.
  return age > ADMINBOT_MAP_LOGIN_FRESH_DAYS * DAY_MS || age < -DAY_MS ? undefined : city;
}

/**
 * Places a login city given the region and country the IP provider reported with it.
 *
 * Tried as "city, region" first, so "London" + "Ontario" lands in London, ON; then the city alone.
 * Either way the place has to be in the reported country: "London" with country "CA" and no region
 * is not London, England, and a city the gazetteer only knows in another country is no answer at
 * all -- the caller falls back to the country, which is still true.
 */
export function resolveLoginCity(
  city: string | undefined,
  region: string | undefined,
  country: string | undefined,
): AdminBotMapPlace | undefined {
  const name = city?.trim();
  if (!name) {
    return undefined;
  }
  const inCountry = resolveCountry(country);
  const accept = (place: AdminBotMapPlace | undefined) =>
    place && (!inCountry || place.country === inCountry.country) ? place : undefined;
  const withRegion = region?.trim() ? accept(resolvePlace(`${name}, ${region.trim()}`)) : undefined;
  if (withRegion) {
    return withRegion;
  }
  const alone = accept(resolvePlace(name));
  if (alone) {
    return alone;
  }
  // The gazetteer's first match for the name was in another country; look for a namesake in the
  // right one ("London" in CA is London, ON).
  if (!inCountry) {
    return undefined;
  }
  const wanted = normalize(name);
  return GAZETTEER.find(
    (place) =>
      place.country === inCountry.country &&
      normalize(place.label).split(",")[0]?.trim() === wanted,
  );
}

type Candidate = {
  raw: string | undefined;
  source: AdminBotMapSource;
  resolve: () => { place: AdminBotMapPlace; precision: AdminBotMapPrecision } | undefined;
};

const cityFrom = (raw: string | undefined) => () => {
  const place = raw && !fragmentFromTimezone(raw) ? resolvePlace(raw) : undefined;
  return place ? { place, precision: "city" as const } : undefined;
};

const zoneFrom = (raw: string | undefined) => () => {
  const place = raw && fragmentFromTimezone(raw) ? resolvePlace(raw) : undefined;
  return place ? { place, precision: "timezone" as const } : undefined;
};

const countryFrom = (raw: string | undefined) => () => {
  // Only the text's primary fragment and its last comma part: "Germany" and "Somewhere, Germany"
  // name a country, "Berlin" does not, and a timezone never does.
  if (!raw || fragmentFromTimezone(raw)) {
    return undefined;
  }
  const fragment = primaryFragment(raw);
  const place = resolveCountry(fragment) ?? resolveCountry(fragment.split(",").at(-1));
  return place ? { place, precision: "country" as const } : undefined;
};

/**
 * Resolves every source in the order the comment at the top of this file gives.
 *
 * The Slack value is either the profile's location field (free text) or Slack's `tz`, and which
 * one it is decides its level, so it is read as both and only one of the two ever resolves.
 */
function resolveMemberPlace(
  member: AdminBotLabMember,
  slackRaw: string | undefined,
  options: { loginCity: boolean; now: Date },
): MemberPlaceResolution {
  const slackText = slackRaw?.trim() || undefined;
  const currentCity = member.current_city?.trim() || undefined;
  const rosterText = member.location?.trim() || undefined;
  const rosterZone = member.timezone?.trim() || undefined;
  // "My stated city only" skips every sign-in source. The country of a sign-in is coarse enough
  // for any caller (it was on the public map before cities were); the city is not, so it needs
  // `options.loginCity` as well.
  const auto = memberMapVisibility(member) === "auto";
  const loginCity = auto && options.loginCity ? freshLoginCity(member, options.now) : undefined;
  const loginCountry = auto ? member.last_login_country?.trim() || undefined : undefined;

  const candidates: Candidate[] = [
    // 1. The city of a fresh sign-in. Only a city: a sign-in that resolves no further than its
    //    country waits until every stated city has had its turn.
    {
      raw: loginCity,
      source: "login",
      resolve: () => {
        const place = resolveLoginCity(loginCity, member.last_login_region, loginCountry);
        return place ? { place, precision: "city" } : undefined;
      },
    },
    // 2. Stated cities.
    { raw: currentCity, source: "roster", resolve: cityFrom(currentCity) },
    { raw: rosterText, source: "roster", resolve: cityFrom(rosterText) },
    { raw: slackText, source: "slack", resolve: cityFrom(slackText) },
    // 3. Cities named by a timezone.
    { raw: slackText, source: "slack", resolve: zoneFrom(slackText) },
    { raw: rosterZone, source: "roster", resolve: zoneFrom(rosterZone) },
    // 4. Countries.
    { raw: currentCity, source: "roster", resolve: countryFrom(currentCity) },
    { raw: rosterText, source: "roster", resolve: countryFrom(rosterText) },
    { raw: slackText, source: "slack", resolve: countryFrom(slackText) },
    {
      raw: loginCountry,
      source: "login",
      resolve: () => {
        const place = resolveCountry(loginCountry);
        return place ? { place, precision: "country" } : undefined;
      },
    },
  ];
  for (const candidate of candidates) {
    if (!candidate.raw) {
      continue;
    }
    const resolved = candidate.resolve();
    if (resolved) {
      return { ...resolved, source: candidate.source, raw: candidate.raw };
    }
  }
  // Nothing resolved: report the most trusted text that was written, so an unplaced entry always
  // points at the thing worth fixing (usually a city the gazetteer should learn). The roster
  // timezone is left out: an unplaceable zone is a typo, not a city to add.
  const written = candidates.find(
    (candidate) => candidate.raw && candidate.raw !== rosterZone && candidate.raw !== loginCity,
  );
  return written?.raw ? { raw: written.raw, source: written.source } : {};
}

export function buildMemberMap(
  members: readonly AdminBotLabMember[],
  slackLocations: ReadonlyMap<string, string> = new Map(),
  options: BuildMemberMapOptions = {},
): AdminBotMemberMap {
  const resolveOptions = { loginCity: options.loginCity ?? false, now: options.now ?? new Date() };
  const groups = new Map<string, AdminBotMapPlaceGroup>();
  const unplaced: AdminBotMemberMap["unplaced"] = [];
  let unknown = 0;

  for (const member of members) {
    if (
      DEPARTED_STATUSES.has(member.status ?? "") ||
      isHiddenFromMemberMap(member) ||
      memberMapVisibility(member) === "hidden"
    ) {
      continue;
    }
    const slackRaw = member.slack_user_id ? slackLocations.get(member.slack_user_id) : undefined;
    const resolution = resolveMemberPlace(member, slackRaw, resolveOptions);
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
    group.members.push({
      member_id: member.id,
      name: member.name,
      source: resolution.source,
      precision: resolution.precision,
      ...(member.avatar_url ? { avatar_url: member.avatar_url } : {}),
      // Only the time of the sign-in that placed them, so the UI can say "from sign-in today".
      ...(resolution.source === "login" && member.last_login_at
        ? { last_login_at: member.last_login_at }
        : {}),
    });
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

/** The map for a roster read, with each member's synced Slack location as their first choice. */
export function memberMapFromRoster(
  members: readonly AdminBotLabMember[],
  options: BuildMemberMapOptions = {},
): AdminBotMemberMap {
  const slackLocations = new Map<string, string>();
  for (const member of members) {
    if (member.slack_user_id && member.slack_location) {
      slackLocations.set(member.slack_user_id, member.slack_location);
    }
  }
  return buildMemberMap(members, slackLocations, options);
}

/**
 * The clock bucket memberMapMemo rebuilds on. A route that versions the map's ETag puts it in the
 * tag for the same reason the memo keys on it.
 */
export function memberMapHour(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 3_600_000);
}

/**
 * Remembers the last map built for each sign-in-city entitlement, keyed on the store's roster
 * version and the hour.
 *
 * The dashboard asks for the map on every load; at 1000+ members rebuilding it means a gazetteer
 * pass over everyone each time. Apart from the roster it depends on two things: whether the caller
 * may see sign-in cities (so the anonymous map and the signed-in one are never the same entry), and
 * the clock, since a sign-in city ages out after ADMINBOT_MAP_LOGIN_FRESH_DAYS with no roster write.
 * Keying on the hour bounds how long an aged-out city can linger. A store with no version (the
 * in-memory one) is rebuilt every call.
 */
export function memberMapMemo(): (
  store: {
    labMemberVersion?(): number;
    listLabMembers(): readonly AdminBotLabMember[];
  },
  options?: { loginCity?: boolean; now?: Date },
) => AdminBotMemberMap {
  const last = new Map<boolean, { version: number; hour: number; map: AdminBotMemberMap }>();
  return (store, options = {}) => {
    const loginCity = options.loginCity ?? false;
    const now = options.now ?? new Date();
    const build = () => memberMapFromRoster(store.listLabMembers(), { loginCity, now });
    const version = store.labMemberVersion?.();
    if (version === undefined) {
      return build();
    }
    const hour = memberMapHour(now);
    const cached = last.get(loginCity);
    if (cached?.version === version && cached.hour === hour) {
      return cached.map;
    }
    const map = build();
    last.set(loginCity, { version, hour, map });
    return map;
  };
}

/**
 * The privileged map as sent: who is where, and how many are unplaced. The names of the unplaced
 * go only to a caller that asks for them (the standalone map page lists them to fix the
 * gazetteer); the dashboard card shows a count, and a lab of 1000 can have hundreds unplaced.
 */
export function toPrivilegedMemberMap(
  map: AdminBotMemberMap,
  options: { listUnplaced: boolean },
): Omit<AdminBotMemberMap, "unplaced"> &
  Partial<Pick<AdminBotMemberMap, "unplaced">> & {
    unplaced_count: number;
  } {
  const { unplaced, ...rest } = map;
  return {
    ...rest,
    unplaced_count: unplaced.length,
    ...(options.listUnplaced ? { unplaced } : {}),
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
