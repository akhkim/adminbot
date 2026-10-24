// Where lab members are, for the member map.
//
// Every source a member has is resolved in order and the first one that places them wins. A
// country-level answer never beats a city, so countries come last whatever their source:
//
//   0. The member's own device or own words, newest first: the city their browser last put them in
//      (`device_city`, within ADMINBOT_DEVICE_LOCATION_FRESH_DAYS = 7, from the passive "Use my
//      precise location" control or its silent refresh) and a recent check-in answer (rule 2). A
//      device reading is a position the member's own machine reported, reduced to the nearest city
//      on the server; it beats the IP, which only says where the network exits. Whichever of the
//      two is newer wins. Like the IP, skipped for "stated" members and anonymous callers.
//   1. The city of a fresh IP reading (within ADMINBOT_MAP_LOGIN_FRESH_DAYS = 7), from the IP
//      geolocation database. Read on every authenticated request (auth.ts `noteAccountUse`) and
//      rewritten whenever the city changes, else once a UTC day -- the live IP, never the address
//      somebody signed in from weeks ago (`liveIpPlace`, which the meetup intros read too). It is
//      where the person actually was most recently, and it leads -- unless the member set
//      `map_visibility` to "stated", which skips every IP source, or the reading is not trusted:
//      flagged `last_ip_suspected_vpn` when it was taken, or its city keeps a clock more than two
//      hours from the member's device zone (else their Slack zone). A VPN exit city is the IP
//      telling the truth about the wrong machine. Placed at the gazetteer's city centroid, never
//      at the IP's coordinates, which nothing here receives.
//   2. An answer the member gave the retired "Where are you based right now?" check-in, while
//      it is recent (ADMINBOT_LOCATION_CHECKIN_DAYS) and still what `current_city` says. The
//      explicit answer, dated, so the map can say "stated 3d ago". Ranked with the device reading
//      (rule 0) by date, so it leads the IP too.
//   3. Other stated cities: `current_city`, then the roster `location`, then the Slack profile's
//      location field. The member's own words, undated.
//   4. The city an IANA timezone is named for: the zone the member's browser reported
//      (`last_device_tz`, while fresh -- ADMINBOT_DEVICE_TZ_FRESH_DAYS), then the Slack `tz` the
//      directory sync recorded (`slack_tz`, while fresh -- SLACK_TZ_FRESH_DAYS), then a zone in the
//      Slack location field, then the roster `timezone`. "America/Toronto" says Toronto, but it
//      says the same for Montréal, so it is a city-level answer that is less exact than any of the
//      above.
//   5. A country: any of the texts above that names only a country ("Germany"), then the country
//      of the last IP reading unless that reading was ignored. Drawn hollow by the UI so it does
//      not pass for a city.
//
// A member whose IP reading was ignored carries `ip_ignored: "suspected_vpn"`, so the admin map can
// say "IP ignored (VPN?)" next to whatever placed them instead. A member an IP city placed carries
// `approximate: true` and " · approx." in the admin's source label: an IP city is the network's
// exit, which for a campus or a mobile carrier can be a neighbouring city.
//
// A member whose `map_visibility` is "hidden" is not on the map at all; a check-in "Prefer not to
// say" sets exactly that.
//
// The Slack zone is also a cross-check (place-timezone.ts): when a city or timezone places a
// member and their fresh `slack_tz` keeps a clock more than two hours away from that city's, the
// map member carries `tz_mismatch` and the admin map flags it. It never moves a stated pin -- a
// Slack zone is a laptop setting. The one thing it can veto is an IP city (rule 1 above), and only
// when the device zone, which is the better witness, is absent.
//
// Text is read the way a person would read it: free text written by humans ("ETH", "Zürich,
// Tübingen", "Mainly Montreal"), a timezone, or a city with its region and country from the IP
// provider ("London", "Ontario", "CA"). Anything none of the sources can place is reported under
// `unplaced` with what was written, rather than guessed at or dropped.

import type { AdminBotLabMember } from "../../contracts/actions.js";
import { isDoNotContact } from "./do-not-contact.js";
import {
  ADMINBOT_TZ_MISMATCH_HOURS,
  placeTimezone,
  timezoneMismatch,
  zoneOffsetMinutes,
  type AdminBotTimezoneMismatch,
} from "./place-timezone.js";

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

/**
 * What placed a member. `checkin` is their answer to the explicit check-in; `roster` is any other
 * stated field; `slack` is Slack's location field or zone; `login` an IP reading; `device` their
 * own browser -- the city its position reduced to (precision "city"), else its time zone.
 */
export type AdminBotMapSource = "slack" | "login" | "roster" | "checkin" | "device";

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
  // Both optional: not every member has a synced Slack avatar. `last_login_at` is only sent when an
  // IP reading is what placed the member, and it is the time of that reading (the latest live
  // observation on a request, `last_ip_observed_at`), so the UI can say "IP today" and show the
  // most recently active faces first; it is never a history, only the one moment behind the pin.
  avatar_url?: string;
  last_login_at?: string;
  /** Same instant as `last_login_at`, under the name that says what it is. IP-placed members only. */
  ip_observed_at?: string;
  /**
   * Set when a fresh IP reading existed but was not used: its city disagrees with the device or
   * Slack zone by more than two hours, most likely a VPN. The pin comes from the next source.
   */
  ip_ignored?: "suspected_vpn";
  /** Placed by an IP reading, which is the network's exit and so only approximately the person. */
  approximate?: true;
  /**
   * The admin map's words for what placed them and how old it is, by UTC day: "IP today", "IP 2d
   * ago", "stated yesterday", "profile", "device time zone", with " · IP ignored (VPN?)" appended
   * when the IP was set aside. A convenience; the structured fields above say the same.
   */
  source_label?: string;
  /**
   * When the source that placed them said so, for the admin map's "IP 2d ago" / "stated 3d
   * ago". Absent for an undated source (a roster field typed at some point).
   */
  located_at?: string;
  /** Set when the member's fresh Slack zone keeps a clock over two hours from where they are placed. */
  tz_mismatch?: AdminBotTimezoneMismatch;
};

export type AdminBotMapPlaceGroup = AdminBotMapPlace & {
  members: AdminBotMapMember[];
};

/**
 * Why an active member is not on the map, for the admin map's search: "Where is Ada?" deserves
 * "location hidden" rather than silence. One reason per member, the first that applies:
 *
 * - `hidden`: they set "Show me on the lab map as" to Hidden (or answered "Prefer not to say").
 * - `ip_off`: they set it to "My stated city only", which stops their IP being looked up at all
 *   (auth.ts `noteAccountUse`), and nothing they stated could be placed.
 * - `suspected_vpn`: their fresh IP reading was set aside as a likely VPN and nothing else placed them.
 * - `browser_blocked`: their browser blocked the location prompt and nothing else placed them.
 * - `unrecognised`: they wrote a location the gazetteer cannot place.
 * - `no_location`: no source says anything yet.
 *
 * Never more than this word: not the text they wrote, a city, or anything else about where they are.
 * Members who opted out of contact, departed, or have no usable name are not listed at all, exactly
 * as they are absent from `places` and `unplaced` (isHiddenFromMemberMap).
 */
export type AdminBotMapAbsenceReason =
  | "hidden"
  | "ip_off"
  | "suspected_vpn"
  | "browser_blocked"
  | "unrecognised"
  | "no_location";

export type AdminBotMapAbsentMember = {
  member_id: string;
  name: string;
  reason: AdminBotMapAbsenceReason;
};

export type AdminBotMemberMap = {
  places: AdminBotMapPlaceGroup[];
  // Members whose location text could not be placed, with what they wrote, so the
  // gazetteer can be extended deliberately instead of the map quietly under-reporting.
  unplaced: Array<{ member_id: string; name: string; raw?: string; source?: AdminBotMapSource }>;
  /**
   * Everyone active who is not in `places`, with why (see AdminBotMapAbsenceReason): the unplaced
   * and those who hid themselves. Admin payload only, as `not_on_map`; never in the summary.
   */
  absent: AdminBotMapAbsentMember[];
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
      located_at?: string;
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
 * How recent an IP reading has to be for the map to place somebody at its city.
 *
 * Seven days. Readings now arrive daily for anyone who uses AdminBot (the daily observation in
 * auth.ts), so an active member's reading is never more than a day old and the window only decides
 * how long somebody who stopped visiting keeps their last IP city. A week covers a weekend, a
 * conference trip or a few days off without the pin flickering back to a stale profile city, and
 * past it the member falls back gracefully to their check-in answer, then what they stated, then
 * their device or Slack zone. It was 14 when a reading only came from signing in, which for most
 * members happened weeks ago.
 */
export const ADMINBOT_MAP_LOGIN_FRESH_DAYS = 7;

/**
 * How long the browser zone a member's requests reported stays usable. Matches the Slack zone's
 * window: a zone is a setting, and one unseen for a month says nothing about this month.
 */
export const ADMINBOT_DEVICE_TZ_FRESH_DAYS = 30;

/**
 * How long the city a member's own device reported keeps placing them: the same week an IP city
 * gets. The silent refresh rewrites it at most daily while the member keeps visiting with the
 * permission granted, so an active member's reading is never more than a day old.
 */
export const ADMINBOT_DEVICE_LOCATION_FRESH_DAYS = 7;

/** The device-reported city fields, as `freshDeviceCity` reads them. */
export type AdminBotDeviceCityFields =
  | "device_city"
  | "device_region"
  | "device_country"
  | "device_located_at";

/** Where the member's own device last put them, when recent enough. Never coordinates. */
export type AdminBotDeviceCity = {
  city: string;
  region?: string;
  /** ISO alpha-2. */
  country?: string;
  located_at: string;
};

/** The device-reported city within `days`, or undefined. Ignores `map_visibility`. */
export function freshDeviceCity(
  member: Pick<AdminBotLabMember, AdminBotDeviceCityFields>,
  now: Date,
  days = ADMINBOT_DEVICE_LOCATION_FRESH_DAYS,
): AdminBotDeviceCity | undefined {
  const city = member.device_city?.trim();
  const at = member.device_located_at?.trim();
  if (!city || !at || !isWithinDays(at, days, now)) {
    return undefined;
  }
  const region = member.device_region?.trim();
  const country = member.device_country?.trim();
  return {
    city,
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    located_at: at,
  };
}

/**
 * The centroid of a city the gazetteer does not know, from the GeoNames table
 * (connectors/reverse-geocode.ts). Injected so this module stays pure and a test can stand in a
 * fixture. `country` is ISO alpha-2.
 */
export type AdminBotCityCentroidResolver = (
  city: string,
  region: string | undefined,
  country: string | undefined,
) => { label: string; country: string; lat: number; lon: number } | undefined;

/**
 * Places a device-reported city: the gazetteer first, so a device in Toronto lands on the same
 * pin as everybody else's Toronto, then the GeoNames centroid for anywhere the gazetteer does not
 * list ("Reggio Emilia"). The centroid is the city's, never the member's position.
 */
export function resolveDevicePlace(
  device: Pick<AdminBotDeviceCity, "city" | "region" | "country">,
  resolveCity?: AdminBotCityCentroidResolver,
): AdminBotMapPlace | undefined {
  const known = resolveLoginCity(device.city, device.region, device.country);
  if (known) {
    return known;
  }
  const centroid = resolveCity?.(device.city, device.region, device.country);
  if (!centroid) {
    return undefined;
  }
  const countryName = resolveCountry(centroid.country)?.country ?? centroid.country;
  const slug = normalize(centroid.label)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    key: `${slug}-${centroid.country.toLowerCase()}`,
    label: centroid.label,
    country: countryName,
    lat: centroid.lat,
    lon: centroid.lon,
  };
}

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

/**
 * How long the "Where are you based right now?" answer counts as recent, and so how often a
 * member can be asked it. Read once from ADMINBOT_LOCATION_CHECKIN_DAYS; 60 when unset or invalid.
 */
export const ADMINBOT_LOCATION_CHECKIN_DAYS = positiveDays(
  process.env.ADMINBOT_LOCATION_CHECKIN_DAYS,
  60,
);

/**
 * How long a Slack `tz` from the directory sync stays usable. The sync runs daily and re-stamps a
 * zone it has not seen for a week, so a zone older than this means the sync stopped seeing it.
 */
export const SLACK_TZ_FRESH_DAYS = 30;

function positiveDays(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Whether an ISO stamp is within `days` of `now` (a day of future skew tolerated). */
export function isWithinDays(at: string | undefined, days: number, now: Date): boolean {
  const seen = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(seen)) {
    return false;
  }
  const age = now.getTime() - seen;
  return age <= days * DAY_MS && age >= -DAY_MS;
}

/** The member's Slack zone, when the directory sync saw it recently enough to use. */
export function freshSlackTz(
  member: Pick<AdminBotLabMember, "slack_tz" | "slack_tz_observed_at">,
  now: Date,
): string | undefined {
  const zone = member.slack_tz?.trim();
  return zone && isWithinDays(member.slack_tz_observed_at, SLACK_TZ_FRESH_DAYS, now)
    ? zone
    : undefined;
}

/**
 * The check-in answer the map may use: recent, and still what `current_city` says. A later profile
 * edit to a different city is newer than the check-in, so the answer stops speaking for them.
 */
export function recentCheckinCity(member: AdminBotLabMember, now: Date): string | undefined {
  const city = member.location_checkin_city?.trim();
  if (!city || !isWithinDays(member.location_checkin_at, ADMINBOT_LOCATION_CHECKIN_DAYS, now)) {
    return undefined;
  }
  const current = member.current_city?.trim();
  return !current || normalize(current) === normalize(city) ? city : undefined;
}

/**
 * A browser-reported zone worth comparing against, or undefined.
 *
 * Must be an IANA zone Intl knows, with a region ("Europe/Zurich"). UTC and the `Etc/` zones are
 * refused: privacy-hardened browsers report UTC whatever the clock says, and treating that as a
 * statement would flag every Toronto member as a VPN user.
 */
export function usableDeviceZone(raw: string | undefined): string | undefined {
  const zone = raw?.trim();
  if (!zone || zone.length > 64 || !zone.includes("/") || /^(etc|utc|gmt)\b/iu.test(zone)) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** The member's browser zone, when their requests reported it recently enough to use. */
export function freshDeviceTz(
  member: Pick<AdminBotLabMember, "last_device_tz" | "last_device_tz_at">,
  now: Date,
): string | undefined {
  const zone = usableDeviceZone(member.last_device_tz);
  return zone && isWithinDays(member.last_device_tz_at, ADMINBOT_DEVICE_TZ_FRESH_DAYS, now)
    ? zone
    : undefined;
}

/**
 * The zone an IP city is checked against: the device's if it reported one, else Slack's. The
 * device wins because it is the machine actually making the requests; Slack's zone is whatever
 * that account's last device said, possibly days ago.
 */
export function referenceZone(
  member: Pick<
    AdminBotLabMember,
    "last_device_tz" | "last_device_tz_at" | "slack_tz" | "slack_tz_observed_at"
  >,
  now: Date,
): string | undefined {
  return freshDeviceTz(member, now) ?? freshSlackTz(member, now);
}

/**
 * When the member's latest live IP reading was taken. Never the sign-in time: a session outlives
 * the login that opened it by weeks, and the sign-in address says where somebody was then, not now.
 * A member with no live reading yet has no IP place until their next request takes one.
 */
export function ipReadingAt(
  member: Pick<AdminBotLabMember, "last_ip_observed_at">,
): string | undefined {
  return member.last_ip_observed_at?.trim() || undefined;
}

export type AdminBotIpCityState =
  | { trusted: { city: string; at: string; place?: AdminBotMapPlace }; ignored?: undefined }
  | { trusted?: undefined; ignored: "suspected_vpn" }
  | { trusted?: undefined; ignored?: undefined };

/**
 * Whether the member's fresh IP city may say where they are. Ignores `map_visibility`; callers
 * apply it.
 *
 * Ignored when the reading was flagged as a likely VPN when it was taken, or -- for a reading taken
 * before that check existed, or when the zones arrived later -- when its city keeps a clock more
 * than ADMINBOT_TZ_MISMATCH_HOURS from the reference zone now.
 */
export function ipCityState(member: AdminBotLabMember, now: Date): AdminBotIpCityState {
  const at = ipReadingAt(member);
  if (!at || !isWithinDays(at, ADMINBOT_MAP_LOGIN_FRESH_DAYS, now)) {
    return {};
  }
  if (ipReadingSetAside(member, now)) {
    return { ignored: "suspected_vpn" };
  }
  const city = member.last_login_city?.trim();
  if (!city) {
    return {};
  }
  const place = resolveLoginCity(city, member.last_login_region, member.last_login_country);
  return { trusted: { city, at, ...(place ? { place } : {}) } };
}

/** What `ipReadingSetAside` reads: the reading, its flag, and the zones it is checked against. */
export type AdminBotIpReadingCheckFields =
  | "last_login_city"
  | "last_login_region"
  | "last_login_country"
  | "last_login_timezone"
  | "last_ip_suspected_vpn"
  | "last_device_tz"
  | "last_device_tz_at"
  | "slack_tz"
  | "slack_tz_observed_at";

/**
 * Whether the member's latest IP reading must not say where they are: flagged as a likely VPN when
 * it was taken, or its city keeps a clock more than ADMINBOT_TZ_MISMATCH_HOURS from the device (else
 * Slack) zone now. The one rule for every reader of the IP city -- the map and the meetup intros --
 * so a VPN exit can never place somebody in one and introduce them in the other.
 */
export function ipReadingSetAside(
  member: Pick<AdminBotLabMember, AdminBotIpReadingCheckFields>,
  now: Date,
): boolean {
  if (member.last_ip_suspected_vpn) {
    return true;
  }
  const city = member.last_login_city?.trim();
  if (!city) {
    return false;
  }
  const reference = referenceZone(member, now);
  const place = resolveLoginCity(city, member.last_login_region, member.last_login_country);
  if (place) {
    return Boolean(timezoneMismatch(place, reference, now));
  }
  // A city the gazetteer does not know still came with the zone the IP database gave it, and that
  // zone is checked instead (else the country's, as the verdict at sign-in does): otherwise an
  // unlisted city is the one reading no clock can set aside.
  const countryPlace = resolveCountry(member.last_login_country);
  const ipZone =
    usableDeviceZone(member.last_login_timezone) ??
    (countryPlace ? placeTimezone(countryPlace) : undefined);
  const ipOffset = ipZone ? zoneOffsetMinutes(ipZone, now) : undefined;
  const referenceOffset = reference ? zoneOffsetMinutes(reference, now) : undefined;
  return (
    ipOffset !== undefined &&
    referenceOffset !== undefined &&
    Math.abs(ipOffset - referenceOffset) / 60 > ADMINBOT_TZ_MISMATCH_HOURS
  );
}

/**
 * The live IP place a meetup intro may use: `liveIpPlace`, and only when the member has a clock to
 * check it against. With no fresh device or Slack zone there is no way to tell a VPN exit from a
 * trip, so the reading can still place a pin on the map but never introduces anybody.
 */
export function introIpPlace(
  member: Pick<AdminBotLabMember, AdminBotLiveIpFields>,
  now: Date,
  days = ADMINBOT_MAP_LOGIN_FRESH_DAYS,
): AdminBotLiveIpPlace | undefined {
  return referenceZone(member, now) ? liveIpPlace(member, now, days) : undefined;
}

/** What `liveIpPlace` reads. */
export type AdminBotLiveIpFields = "last_ip_observed_at" | AdminBotIpReadingCheckFields;

/** Where the member's latest trusted live IP reading puts them. Never coordinates. */
export type AdminBotLiveIpPlace = {
  city: string;
  region?: string;
  country?: string;
  /** When the reading was taken (`last_ip_observed_at`). */
  observed_at: string;
};

/**
 * The one answer to "where does the live IP put this member", for the map and the meetup intros
 * alike: the latest reading taken on a request (`last_ip_observed_at`, never `last_login_at` or the
 * sign-in row), within `days`, and not set aside as a likely VPN exit (`ipReadingSetAside`).
 * Undefined when there is no such reading or it located only a country -- see `liveIpCountry`.
 */
export function liveIpPlace(
  member: Pick<AdminBotLabMember, AdminBotLiveIpFields>,
  now: Date,
  days = ADMINBOT_MAP_LOGIN_FRESH_DAYS,
): AdminBotLiveIpPlace | undefined {
  const at = liveIpObservedAt(member, now, days);
  const city = member.last_login_city?.trim();
  if (!at || !city) {
    return undefined;
  }
  const region = member.last_login_region?.trim();
  const country = member.last_login_country?.trim();
  return {
    city,
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    observed_at: at,
  };
}

/** The country of the latest trusted live IP reading, by the same rule as `liveIpPlace`. */
export function liveIpCountry(
  member: Pick<AdminBotLabMember, AdminBotLiveIpFields>,
  now: Date,
  days = ADMINBOT_MAP_LOGIN_FRESH_DAYS,
): string | undefined {
  return liveIpObservedAt(member, now, days)
    ? member.last_login_country?.trim() || undefined
    : undefined;
}

/** When the latest live IP reading was taken, if it is within `days` and trusted; else undefined. */
export function liveIpObservedAt(
  member: Pick<AdminBotLabMember, AdminBotLiveIpFields>,
  now: Date,
  days = ADMINBOT_MAP_LOGIN_FRESH_DAYS,
): string | undefined {
  const at = ipReadingAt(member);
  if (!at || !isWithinDays(at, days, now) || ipReadingSetAside(member, now)) {
    return undefined;
  }
  return at;
}

/**
 * The verdict for one IP reading as it is taken: does its city keep roughly the same clock as the
 * zone the request's device reported (else the member's Slack zone)?
 *
 * The IP's zone is the one the provider returned with the city, else the zone the gazetteer city
 * keeps, else the country's. Offsets are compared at `at` through Intl, so daylight saving is
 * whatever it was at that instant. The reference is the zone this request's browser sent, else the
 * offset it sent with no zone, else the member's stored device zone while fresh (so a request that
 * sent no headers is still checked), else Slack's. With nothing to compare against there is no
 * evidence of a VPN and the reading is not suspected, but `against` is then absent, and callers
 * must not let an unchecked reading start intros.
 */
export function ipReadingVerdict(params: {
  location: { city?: string; region?: string; country?: string; timezone?: string };
  deviceTz?: string;
  /** Minutes east of UTC the device reported, used only when no usable zone name came with it. */
  deviceOffsetMinutes?: number;
  /** The member's stored device zone (`freshDeviceTz`), for a request that sent none. */
  storedDeviceTz?: string;
  slackTz?: string;
  at: Date;
}): { suspected_vpn: boolean; hours?: number; against?: "device" | "slack" } {
  const { location, at } = params;
  const cityPlace = resolveLoginCity(location.city, location.region, location.country);
  const countryPlace = resolveCountry(location.country);
  const ipZone =
    usableDeviceZone(location.timezone) ??
    (cityPlace ? placeTimezone(cityPlace) : undefined) ??
    (countryPlace ? placeTimezone(countryPlace) : undefined);
  const ipOffset = ipZone ? zoneOffsetMinutes(ipZone, at) : undefined;
  if (ipOffset === undefined) {
    return { suspected_vpn: false };
  }
  const deviceZone = usableDeviceZone(params.deviceTz);
  const storedZone = usableDeviceZone(params.storedDeviceTz);
  const deviceOffset = deviceZone
    ? zoneOffsetMinutes(deviceZone, at)
    : Number.isFinite(params.deviceOffsetMinutes) &&
        Math.abs(params.deviceOffsetMinutes ?? 0) <= 14 * 60
      ? params.deviceOffsetMinutes
      : storedZone
        ? zoneOffsetMinutes(storedZone, at)
        : undefined;
  const slackZone = params.slackTz?.trim();
  const slackOffset = slackZone ? zoneOffsetMinutes(slackZone, at) : undefined;
  const reference =
    deviceOffset !== undefined
      ? { offset: deviceOffset, against: "device" as const }
      : slackOffset !== undefined
        ? { offset: slackOffset, against: "slack" as const }
        : undefined;
  if (!reference) {
    return { suspected_vpn: false };
  }
  const hours = Math.abs(ipOffset - reference.offset) / 60;
  return { suspected_vpn: hours > ADMINBOT_TZ_MISMATCH_HOURS, hours, against: reference.against };
}

export type BuildMemberMapOptions = {
  /**
   * Whether sign-in cities may place members at all. On for signed-in callers (members and
   * admins); off for an anonymous visitor, who gets only what members stated. Each member's own
   * `map_visibility` still applies on top. The map only ever carries the city -- never the IP, its
   * coordinates, or a history of sign-ins.
   */
  loginCity?: boolean;
  now?: Date;
  /** Centroids for device cities the gazetteer does not know. Absent: gazetteer only. */
  resolveCity?: AdminBotCityCentroidResolver;
};

/**
 * The gazetteer city of a fresh, trusted IP reading, or undefined. Ignores `map_visibility`:
 * callers that place the member on a map apply it themselves.
 */
export function freshLoginPlace(
  member: AdminBotLabMember,
  now: Date,
): AdminBotMapPlace | undefined {
  return ipCityState(member, now).trusted?.place;
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
  located_at?: string;
  resolve: () => { place: AdminBotMapPlace; precision: AdminBotMapPrecision } | undefined;
};

/** An ISO stamp as epoch ms, with a missing or unparseable one sorting last. */
function stampMs(at: string | undefined): number {
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

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
  options: { loginCity: boolean; now: Date; resolveCity?: AdminBotCityCentroidResolver },
): MemberPlaceResolution {
  const slackText = slackRaw?.trim() || undefined;
  const currentCity = member.current_city?.trim() || undefined;
  const rosterText = member.location?.trim() || undefined;
  const rosterZone = member.timezone?.trim() || undefined;
  const checkinCity = recentCheckinCity(member, options.now);
  const slackZone = freshSlackTz(member, options.now);
  const deviceZone = freshDeviceTz(member, options.now);
  // "My stated city only" skips every sign-in source. The country of a sign-in is coarse enough
  // for any caller (it was on the public map before cities were); the city is not, so it needs
  // `options.loginCity` as well.
  const auto = memberMapVisibility(member) === "auto";
  const ip = auto ? ipCityState(member, options.now) : {};
  // The same helper the meetup intros read, so the map and the intros can never disagree.
  const live = auto && options.loginCity ? liveIpPlace(member, options.now) : undefined;
  const loginCity = live?.city;
  // A reading set aside as a likely VPN takes its country with it: the exit node's country is no
  // truer than its city.
  const loginCountry =
    auto && !ip.ignored ? member.last_login_country?.trim() || undefined : undefined;
  // The member's own device, under the same two gates as an IP city: inferred, so never for a
  // "stated" member or an anonymous caller.
  const device = auto && options.loginCity ? freshDeviceCity(member, options.now) : undefined;

  // 0. The device city and the check-in answer, newest first. Both are the member's own: one their
  //    machine reported, one they typed. Whichever came later says where they are now.
  const ownSources: Candidate[] = [
    {
      raw: device?.city,
      source: "device",
      located_at: device?.located_at,
      resolve: () => {
        const place = device ? resolveDevicePlace(device, options.resolveCity) : undefined;
        return place ? { place, precision: "city" } : undefined;
      },
    },
    {
      raw: checkinCity,
      source: "checkin",
      located_at: member.location_checkin_at,
      resolve: cityFrom(checkinCity),
    },
  ];
  const personal = ownSources.toSorted(
    (left, right) => stampMs(right.located_at) - stampMs(left.located_at),
  );

  const candidates: Candidate[] = [
    ...personal,
    // 1. The city of a fresh, trusted IP reading. Only a city: a reading that resolves no further
    //    than its country waits until every stated city has had its turn.
    {
      raw: loginCity,
      source: "login",
      located_at: live?.observed_at,
      resolve: () => {
        const place = resolveLoginCity(loginCity, member.last_login_region, loginCountry);
        return place ? { place, precision: "city" } : undefined;
      },
    },
    // 3. Other stated cities. (2, the check-in answer, is ranked with the device city above.)
    { raw: currentCity, source: "roster", resolve: cityFrom(currentCity) },
    { raw: rosterText, source: "roster", resolve: cityFrom(rosterText) },
    {
      raw: slackText,
      source: "slack",
      located_at: member.slack_location_updated_at,
      resolve: cityFrom(slackText),
    },
    // 4. Cities named by a timezone: the browser's zone first, then the synced Slack zone, while
    //    fresh. Device and Slack zones are both the member's own devices; the browser's is the one
    //    in front of them today.
    {
      raw: deviceZone,
      source: "device",
      located_at: member.last_device_tz_at,
      resolve: zoneFrom(deviceZone),
    },
    {
      raw: slackZone,
      source: "slack",
      located_at: member.slack_tz_observed_at,
      resolve: zoneFrom(slackZone),
    },
    {
      raw: slackText,
      source: "slack",
      located_at: member.slack_location_updated_at,
      resolve: zoneFrom(slackText),
    },
    { raw: rosterZone, source: "roster", resolve: zoneFrom(rosterZone) },
    // 5. Countries: the device's first, since it is the member's own machine, then what they wrote,
    //    then the IP's.
    {
      raw: device?.country,
      source: "device",
      located_at: device?.located_at,
      resolve: () => {
        const place = resolveCountry(device?.country);
        return place ? { place, precision: "country" } : undefined;
      },
    },
    { raw: currentCity, source: "roster", resolve: countryFrom(currentCity) },
    { raw: rosterText, source: "roster", resolve: countryFrom(rosterText) },
    { raw: slackText, source: "slack", resolve: countryFrom(slackText) },
    {
      raw: loginCountry,
      source: "login",
      located_at: ipReadingAt(member),
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
      return {
        ...resolved,
        source: candidate.source,
        raw: candidate.raw,
        ...(candidate.located_at ? { located_at: candidate.located_at } : {}),
      };
    }
  }
  // Nothing resolved: report the most trusted text that was written, so an unplaced entry always
  // points at the thing worth fixing (usually a city the gazetteer should learn). The roster
  // timezone is left out: an unplaceable zone is a typo, not a city to add.
  const written = candidates.find(
    (candidate) =>
      candidate.raw &&
      candidate.raw !== rosterZone &&
      candidate.raw !== slackZone &&
      candidate.raw !== deviceZone &&
      candidate.raw !== loginCity &&
      candidate.raw !== device?.city &&
      candidate.raw !== device?.country,
  );
  return written?.raw ? { raw: written.raw, source: written.source } : {};
}

export function buildMemberMap(
  members: readonly AdminBotLabMember[],
  slackLocations: ReadonlyMap<string, string> = new Map(),
  options: BuildMemberMapOptions = {},
): AdminBotMemberMap {
  const resolveOptions = {
    loginCity: options.loginCity ?? false,
    now: options.now ?? new Date(),
    ...(options.resolveCity ? { resolveCity: options.resolveCity } : {}),
  };
  const groups = new Map<string, AdminBotMapPlaceGroup>();
  const unplaced: AdminBotMemberMap["unplaced"] = [];
  const absent: AdminBotMemberMap["absent"] = [];
  let unknown = 0;

  for (const member of members) {
    if (DEPARTED_STATUSES.has(member.status ?? "") || isHiddenFromMemberMap(member)) {
      continue;
    }
    if (memberMapVisibility(member) === "hidden") {
      absent.push({ member_id: member.id, name: member.name, reason: "hidden" });
      continue;
    }
    const slackRaw = member.slack_user_id ? slackLocations.get(member.slack_user_id) : undefined;
    const resolution = resolveMemberPlace(member, slackRaw, resolveOptions);
    // Only said where the caller may see IP cities at all, and only for "auto" members: a member
    // who chose "stated" never had their IP considered, so there is nothing to have ignored.
    const ipIgnored =
      resolveOptions.loginCity && memberMapVisibility(member) === "auto"
        ? ipCityState(member, resolveOptions.now).ignored
        : undefined;
    if (!resolution.place) {
      absent.push({
        member_id: member.id,
        name: member.name,
        reason: absenceReason(member, resolution, ipIgnored),
      });
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
      // Only the time of the IP reading that placed them, so the UI can say "IP today".
      ...(resolution.source === "login" && resolution.located_at
        ? { last_login_at: resolution.located_at, ip_observed_at: resolution.located_at }
        : {}),
      ...(resolution.located_at ? { located_at: resolution.located_at } : {}),
      ...(ipIgnored ? { ip_ignored: ipIgnored } : {}),
      ...(resolution.source === "login" ? { approximate: true as const } : {}),
      source_label: sourceLabel(resolution, ipIgnored, resolveOptions.now),
      ...mismatchFor(member, resolution, resolveOptions.now),
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
    absent: absent.toSorted((left, right) => left.name.localeCompare(right.name)),
    counts: {
      placed: places.reduce((sum, place) => sum + place.members.length, 0),
      unplaced: unplaced.length - unknown,
      unknown,
    },
  };
}

/**
 * Why a member nothing placed is off the map; see AdminBotMapAbsenceReason. The member's own
 * setting comes first because it is the answer they gave; the browser's refusal only explains the
 * gap when no reading of theirs was set aside, and written-but-unknown text before "nothing at all".
 */
function absenceReason(
  member: AdminBotLabMember,
  resolution: { raw?: string; source?: AdminBotMapSource },
  ipIgnored: "suspected_vpn" | undefined,
): AdminBotMapAbsenceReason {
  if (memberMapVisibility(member) === "stated") {
    return "ip_off";
  }
  if (ipIgnored) {
    return "suspected_vpn";
  }
  if (member.location_permission === "denied") {
    return "browser_blocked";
  }
  return resolution.raw && resolution.source ? "unrecognised" : "no_location";
}

/** Whole UTC days from `at` to `now`, never negative; undefined for an unparseable stamp. */
function utcDaysAgo(at: string | undefined, now: Date): number | undefined {
  const ms = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(ms)) {
    return undefined;
  }
  const day = (time: number) => Math.floor(time / DAY_MS);
  return Math.max(0, day(now.getTime()) - day(ms));
}

function agoPhrase(prefix: string, at: string | undefined, now: Date): string {
  const days = utcDaysAgo(at, now);
  if (days === undefined) {
    return prefix;
  }
  return days === 0
    ? `${prefix} today`
    : days === 1
      ? `${prefix} yesterday`
      : `${prefix} ${days}d ago`;
}

/** See `AdminBotMapMember.source_label`. */
function sourceLabel(
  resolution: { source: AdminBotMapSource; precision: AdminBotMapPrecision; located_at?: string },
  ipIgnored: "suspected_vpn" | undefined,
  now: Date,
): string {
  const zone = resolution.precision === "timezone";
  const base =
    resolution.source === "login"
      ? `${agoPhrase("IP", resolution.located_at, now)} · approx.`
      : resolution.source === "checkin"
        ? agoPhrase("stated", resolution.located_at, now)
        : resolution.source === "device"
          ? zone
            ? "device time zone"
            : agoPhrase("device", resolution.located_at, now)
          : resolution.source === "slack"
            ? zone
              ? "Slack time zone"
              : "Slack"
            : zone
              ? "profile time zone"
              : "profile";
  return ipIgnored ? `${base} · IP ignored (VPN?)` : base;
}

/**
 * The Slack-zone cross-check for one placed member. Only a city or a timezone city is compared --
 * a country centroid keeps no single clock -- and the pin never moves because of it.
 */
function mismatchFor(
  member: AdminBotLabMember,
  resolution: { place: AdminBotMapPlace; precision: AdminBotMapPrecision },
  now: Date,
): { tz_mismatch?: AdminBotTimezoneMismatch } {
  if (resolution.precision === "country") {
    return {};
  }
  const mismatch = timezoneMismatch(resolution.place, freshSlackTz(member, now), now);
  return mismatch ? { tz_mismatch: mismatch } : {};
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
  options?: {
    loginCity?: boolean;
    now?: Date;
    resolveCity?: AdminBotCityCentroidResolver;
    /** Changes when the centroid table does (a GeoNames refresh), so the cache rebuilds. */
    placesVersion?: number;
  },
) => AdminBotMemberMap {
  const last = new Map<
    boolean,
    { version: number; hour: number; places: number; map: AdminBotMemberMap }
  >();
  return (store, options = {}) => {
    const loginCity = options.loginCity ?? false;
    const now = options.now ?? new Date();
    const places = options.placesVersion ?? 0;
    const build = () =>
      memberMapFromRoster(store.listLabMembers(), {
        loginCity,
        now,
        ...(options.resolveCity ? { resolveCity: options.resolveCity } : {}),
      });
    const version = store.labMemberVersion?.();
    if (version === undefined) {
      return build();
    }
    const hour = memberMapHour(now);
    const cached = last.get(loginCity);
    if (cached?.version === version && cached.hour === hour && cached.places === places) {
      return cached.map;
    }
    const map = build();
    last.set(loginCity, { version, hour, places, map });
    return map;
  };
}

/** One entry of `not_on_map`: a name and why, and nothing else -- no id, text, city or time. */
export type AdminBotNotOnMapEntry = { name: string; reason: AdminBotMapAbsenceReason };

/**
 * The privileged map as sent: who is where, and how many are unplaced. The unplaced entries with
 * what they wrote go only to a caller that asks for them (the standalone map page lists them to fix
 * the gazetteer); the dashboard card gets a count of those.
 *
 * `not_on_map` is always sent, so the card's search can say "Ada: location hidden" instead of
 * finding nobody. It is a name and a reason word per member and nothing else: the reason comes
 * from settings admins can already read (map visibility on the roster, the browser's answer in
 * GET /member-map/coverage), and never the raw text, a place, or a time. A few dozen bytes each.
 */
export function toPrivilegedMemberMap(
  map: AdminBotMemberMap,
  options: { listUnplaced: boolean },
): Omit<AdminBotMemberMap, "unplaced" | "absent"> &
  Partial<Pick<AdminBotMemberMap, "unplaced">> & {
    unplaced_count: number;
    not_on_map: AdminBotNotOnMapEntry[];
  } {
  const { unplaced, absent, ...rest } = map;
  return {
    ...rest,
    unplaced_count: unplaced.length,
    ...(options.listUnplaced ? { unplaced } : {}),
    not_on_map: absent.map(({ name, reason }) => ({ name, reason })),
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
