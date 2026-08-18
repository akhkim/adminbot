// The zone list every deadline control on this surface picks from.
//
// One module rather than one list per view: a milestone, a school's application cutoff and a
// proposed meeting slot are all "a time, in a zone", and three copies of the list would be three
// chances for the same member to meet three different spellings of their own zone.
//
// Offered through a <datalist> on a text input, never a <select>. There are around six hundred IANA
// zones, and a select per table row would put six hundred option elements into the DOM for every
// row a member adds; a datalist is written once per table and typing "toro" narrows it, which is
// how anyone finds their zone anyway. It also leaves the field free text, so a zone this engine has
// never heard of is still typable.

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
