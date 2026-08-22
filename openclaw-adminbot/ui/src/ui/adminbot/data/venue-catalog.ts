// The venues a paper can be aimed at, as a year and a venue rather than one long list.
//
// The deadline board (data/deadlines.ts) is a scrape: it knows what is open right now, in whatever
// wording each call for papers used, and it forgets a venue the moment its deadline passes. That
// is the wrong shape for "where is this paper going" -- the lab targets ACL or NeurIPS as venues,
// years ahead of any deadline being posted, and keeps naming them long after. So the target is
// picked from this hand-kept list of the venues the lab actually submits to, crossed with a year.
//
// Kept deliberately short. A venue nobody in the lab has ever submitted to is noise in a dropdown
// that gets opened on every paper; anything missing can still be typed into the deadline board and
// arrives as a kept custom value (see parseVenue).
export type CatalogVenue = {
  /** Stable across years, so the venue select survives changing the year. */
  id: string;
  /** Conference family the year attaches to, e.g. "ACL" in "ACL 2026 (main)". */
  family: string;
  /** Track, rendered after the year. Empty for venues with a single track. */
  suffix: string;
  /** Option text in the venue select, where the year lives in its own select. */
  label: string;
  /** False for workshops and IASEAI: submitting there leaves the paper free to go elsewhere. */
  archival: boolean;
};

function venue(family: string, track: string, archival: boolean): CatalogVenue {
  return {
    id: track ? `${family}-${track}` : family,
    family,
    suffix: track ? ` (${track})` : "",
    label: track ? `${family} (${track})` : family,
    archival,
  };
}

/** Publishing here consumes the paper. Listed roughly in the order the lab aims at them. */
export const ARCHIVAL_VENUES: CatalogVenue[] = [
  venue("ACL", "main", true),
  venue("ACL", "demo", true),
  venue("EMNLP", "main", true),
  venue("EMNLP", "demo", true),
  venue("NAACL", "main", true),
  venue("NAACL", "demo", true),
  venue("EACL", "main", true),
  venue("EACL", "demo", true),
  venue("NeurIPS", "", true),
  venue("ICML", "", true),
  venue("ICLR", "", true),
  venue("COLM", "", true),
  venue("CLeaR", "", true),
  venue("AAAI", "", true),
];

/** Non-archival: the paper can still be submitted somewhere archival afterwards. */
export const NON_ARCHIVAL_VENUES: CatalogVenue[] = [
  venue("IASEAI", "", false),
  venue("ACL", "workshop", false),
  venue("EMNLP", "workshop", false),
  venue("NAACL", "workshop", false),
  venue("EACL", "workshop", false),
  venue("NeurIPS", "workshop", false),
  venue("ICML", "workshop", false),
  venue("ICLR", "workshop", false),
  venue("COLM", "workshop", false),
];

export const CATALOG_VENUES: CatalogVenue[] = [...ARCHIVAL_VENUES, ...NON_ARCHIVAL_VENUES];

export function findVenue(id: string): CatalogVenue | undefined {
  return CATALOG_VENUES.find((entry) => entry.id === id);
}

/**
 * Years worth offering: last year through two years out.
 *
 * Backwards by one because a paper registered late still names the venue it was submitted to, and
 * forwards by two because next year's cycle is planned well before its call for papers exists.
 */
export function venueYears(now = new Date()): number[] {
  const current = now.getUTCFullYear();
  return [current - 1, current, current + 1, current + 2];
}

/** The stored form, matching how the deadline board words a venue: "EMNLP 2026 (main)". */
export function formatVenue(id: string, year: number): string {
  const entry = findVenue(id);
  if (!entry) {
    return "";
  }
  return `${entry.family} ${year}${entry.suffix}`;
}

export type ParsedVenue = {
  /** The catalog entry this value names, or null when it names something else. */
  id: string | null;
  /** The year in the value, or null when it carries none. */
  year: number | null;
};

/**
 * Read a stored venue back into the two selects.
 *
 * Deliberately forgiving about the tail: values written before this list existed came from the
 * deadline board and read like "EMNLP 2026 (main, ARR commitment)". Those still resolve to a year,
 * and to the venue when the track matches; when they do not, the raw string is kept as its own
 * option rather than being silently retargeted.
 */
export function parseVenue(value: string): ParsedVenue {
  const match = /^(.*?)\s+(\d{4})\b(.*)$/u.exec(value.trim());
  if (!match) {
    return { id: null, year: null };
  }
  const [, family, year, tail] = match;
  const track = /^\s*\(\s*([a-z ]+)/iu.exec(tail)?.[1]?.trim().toLowerCase() ?? "";
  const entry = CATALOG_VENUES.find(
    (candidate) =>
      candidate.family.toLowerCase() === family.toLowerCase() &&
      candidate.suffix.toLowerCase() === (track ? ` (${track})` : ""),
  );
  return { id: entry?.id ?? null, year: Number(year) };
}
