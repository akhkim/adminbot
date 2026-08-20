// The zone list every deadline control on this surface picks from.
//
// One module rather than one list per view: a milestone, a school's application cutoff and a
// proposed meeting slot are all "a time, in a zone", and three copies of the list would be three
// chances for the same member to meet three different spellings of their own zone.
//
// Two controls read it. A <select> where a form has one zone field (the Time Availability
// editors): it shows a labelled shortlist, because a dropdown of all six hundred IANA zones is a
// wall of slashes and the zones a lab actually uses are a couple of dozen. A <datalist> on a text
// input where a row of many controls each need one (the school application rows in logistics),
// where six hundred option nodes would be repeated per row and typing narrows the list anyway.

/** The id the datalist is written under, and what an input's `list` attribute points at. */
export const TIMEZONE_LIST_ID = "adminbot-timezone-options";

// AoE is UTC-12. Written as the IANA name so the stored value means the same thing to Intl as it
// does to a reader, and kept here because it is the zone most conference deadlines are stated in.
export const AOE_TIMEZONE = "Etc/GMT+12";

/** The viewer's own zone, or "UTC" where the runtime will not say. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A zone with the label a person reads. The zone stays the IANA name the engine prints with. */
export type TimezoneOption = { zone: string; label: string };

// The zones a member is likely to mean, labelled how a person reads them. The abbreviation in
// parentheses is the zone's usual clock label, enough to tell two cities of the same hour apart
// without pretending the label is exact across daylight-saving changes.
const COMMON_ZONES: readonly TimezoneOption[] = [
  { zone: "UTC", label: "UTC" },
  { zone: "Etc/GMT+12", label: "Anywhere on Earth (UTC−12)" },
  { zone: "America/New_York", label: "New York (ET)" },
  { zone: "America/Chicago", label: "Chicago (CT)" },
  { zone: "America/Denver", label: "Denver (MT)" },
  { zone: "America/Los_Angeles", label: "Los Angeles (PT)" },
  { zone: "America/Toronto", label: "Toronto (ET)" },
  { zone: "America/Vancouver", label: "Vancouver (PT)" },
  { zone: "America/Mexico_City", label: "Mexico City (CST)" },
  { zone: "America/Sao_Paulo", label: "São Paulo (BRT)" },
  { zone: "Europe/London", label: "London (GMT)" },
  { zone: "Europe/Dublin", label: "Dublin (GMT)" },
  { zone: "Europe/Lisbon", label: "Lisbon (WET)" },
  { zone: "Europe/Paris", label: "Paris (CET)" },
  { zone: "Europe/Berlin", label: "Berlin (CET)" },
  { zone: "Europe/Madrid", label: "Madrid (CET)" },
  { zone: "Europe/Rome", label: "Rome (CET)" },
  { zone: "Europe/Amsterdam", label: "Amsterdam (CET)" },
  { zone: "Europe/Zurich", label: "Zurich (CET)" },
  { zone: "Europe/Vienna", label: "Vienna (CET)" },
  { zone: "Europe/Brussels", label: "Brussels (CET)" },
  { zone: "Europe/Stockholm", label: "Stockholm (CET)" },
  { zone: "Europe/Oslo", label: "Oslo (CET)" },
  { zone: "Europe/Copenhagen", label: "Copenhagen (CET)" },
  { zone: "Europe/Warsaw", label: "Warsaw (CET)" },
  { zone: "Europe/Prague", label: "Prague (CET)" },
  { zone: "Europe/Kyiv", label: "Kyiv (EET)" },
  { zone: "Europe/Athens", label: "Athens (EET)" },
  { zone: "Europe/Bucharest", label: "Bucharest (EET)" },
  { zone: "Europe/Helsinki", label: "Helsinki (EET)" },
  { zone: "Europe/Istanbul", label: "Istanbul (TRT)" },
  { zone: "Europe/Moscow", label: "Moscow (MSK)" },
  { zone: "Africa/Cairo", label: "Cairo (EET)" },
  { zone: "Africa/Johannesburg", label: "Johannesburg (SAST)" },
  { zone: "Asia/Dubai", label: "Dubai (GST)" },
  { zone: "Asia/Kolkata", label: "Mumbai (IST)" },
  { zone: "Asia/Karachi", label: "Karachi (PKT)" },
  { zone: "Asia/Dhaka", label: "Dhaka (BST)" },
  { zone: "Asia/Bangkok", label: "Bangkok (ICT)" },
  { zone: "Asia/Singapore", label: "Singapore (SGT)" },
  { zone: "Asia/Hong_Kong", label: "Hong Kong (HKT)" },
  { zone: "Asia/Shanghai", label: "Shanghai (CST)" },
  { zone: "Asia/Taipei", label: "Taipei (CST)" },
  { zone: "Asia/Tokyo", label: "Tokyo (JST)" },
  { zone: "Asia/Seoul", label: "Seoul (KST)" },
  { zone: "Australia/Perth", label: "Perth (AWST)" },
  { zone: "Australia/Adelaide", label: "Adelaide (ACST)" },
  { zone: "Australia/Sydney", label: "Sydney (AEDT)" },
  { zone: "Australia/Melbourne", label: "Melbourne (AEDT)" },
  { zone: "Australia/Brisbane", label: "Brisbane (AEST)" },
  { zone: "Pacific/Auckland", label: "Auckland (NZDT)" },
];

/** The tail of an IANA path read as a name: "America/New_York" -> "New York". */
function friendlyZoneLabel(zone: string): string {
  const last = zone.split("/").at(-1) ?? zone;
  return last.replaceAll("_", " ");
}

/**
 * The options a single zone `<select>` should offer, with the value always present.
 *
 * The viewer's own zone leads, labelled as theirs, then the common shortlist, then any value the
 * caller needs (a stored zone or a city guess) that is none of those -- a select can only show the
 * zone it actually lists, and a member's real zone must never silently fall back to the first row.
 */
export function timezoneOptions(value: string): readonly TimezoneGroup[] {
  const seen = new Set<string>();
  const common: TimezoneOption[] = [];
  const push = (zone: string, label: string) => {
    if (zone && !seen.has(zone)) {
      seen.add(zone);
      common.push({ zone, label });
    }
  };
  const own = localTimezone();
  push(own, `Local timezone (${friendlyZoneLabel(own)})`);
  push(value, friendlyZoneLabel(value));
  for (const option of COMMON_ZONES) {
    push(option.zone, option.label);
  }

  // The rest of the table, grouped by region: "any zone is reachable" stays true without six
  // hundred rows in one wall. Rows already offered above are skipped so no zone appears twice.
  const rest = timezoneSuggestions().filter((zone) => !seen.has(zone));
  const byRegion = new Map<string, TimezoneOption[]>();
  for (const zone of rest) {
    const region = zone.split("/")[0] ?? zone;
    const list = byRegion.get(region) ?? [];
    list.push({ zone, label: zone });
    byRegion.set(region, list);
  }

  const groups: TimezoneGroup[] = [
    { label: "Local", options: common.slice(0, 1) },
    { label: "Common zones", options: common.slice(1) },
  ];
  for (const [region, options] of byRegion) {
    groups.push({ label: region, options });
  }
  return groups;
}

/** One optgroup in a zone `<select>`: a header and the zones beneath it. */
export type TimezoneGroup = { label: string; options: readonly TimezoneOption[] };

/**
 * Every zone this engine knows, with the three worth reaching first at the front.
 *
 * Read from Intl rather than from a bundled list: a shipped list goes stale, and the only zones
 * worth offering are the ones the formatter on the other end can print. UTC and AoE lead because
 * deadlines are usually stated in one of the two and nobody thinks to look for Anywhere-on-Earth
 * under "Etc"; the viewer's own zone leads because it is the answer most of the time.
 */
export function timezoneSuggestions(): readonly string[] {
  let zones: readonly string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // A locked-down engine, or a test environment without the table. The input stays free text --
    // only the suggestions are lost.
    zones = [];
  }
  const preferred = [localTimezone(), AOE_TIMEZONE, "UTC"];
  return [...new Set([...preferred, ...zones.filter((zone) => !preferred.includes(zone))])];
}
