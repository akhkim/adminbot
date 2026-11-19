/**
 * One reading of a free-text venue, shared by the venue picker, the outreach drafts and the
 * acceptance sheet.
 *
 * A venue string reaches the records three ways -- an author typing it, the OpenReview sync
 * deriving it from a venue id, and a person typing it into the acceptance tab -- so one conference
 * shows up as `EMNLP`, `EMNLP ARR Commitment`, `EMNLP 2025 System Demonstrations`, `EMNLP 2026
 * (demo)` and `Findings of EMNLP`. They are one conference with a track, and the lab files them
 * together. The OpenReview sync also stores the venue without its year (the year goes in
 * `accepted_year`), and a hand-typed cell can lose its last digit (`LREC-COLING 202`); both are
 * resolved here, against the record's own year.
 *
 * Read-only: nothing here rewrites a stored venue. The record keeps what it was given, and every
 * consumer normalises at the moment it compares or prints.
 */

export type VenueTrack = "main" | "findings" | "demo" | "workshop";

export type NormalizedVenue = {
  /**
   * The conference as the label spells it (`EMNLP`, `LREC-COLING`). For a workshop, the
   * workshop's own name (`NeurIPS Workshop on Causal Learning`): a workshop is a venue of its own,
   * and its papers are not the main conference's.
   */
  family: string;
  track: VenueTrack;
  /** Four digits, or "" when neither the label nor the record says. */
  year: string;
};

const YEAR = /\b(20\d{2})\b/gu;
// A year cut short at the end of a cell: `LREC-COLING 202`, `ACL 20`. Only read when no full year
// is present, and only at the very end, so a `Track 2` in the middle of a name is left alone.
const TRUNCATED_YEAR = /\s+2(?:0\d?)?$/u;
const PARENTHETICAL = /\([^)]*\)/gu;
const WORKSHOP = /\bworkshops?\b/iu;
const FINDINGS = /\bfindings\b(?:\s+of(?:\s+the)?(?:\s+(?:association\s+for\s+computational\s+linguistics|acl)\b)?)?\s*:?/iu;
const DEMO = /\b(?:system\s+)?demo(?:nstration)?s?(?:\s+track)?\b/iu;
// Words that say "the main track" or describe the paper rather than the venue. An ARR commitment
// is how a paper reaches an ACL-family main conference, not a separate venue.
const MAIN_NOISE = [
  /\barr\s+commitments?\b/giu,
  /\bmain(?:\s+(?:conference|track|papers?))?\b/giu,
  /\b(?:long|short)\s+papers?\b/giu,
  /\b(?:oral|poster|spotlight)s?\b/giu,
];

const TRACK_ORDER: Record<VenueTrack, number> = { main: 0, findings: 1, demo: 2, workshop: 3 };

function collapse(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(/^[\s:,;\-–—]+|[\s:,;\-–—]+$/gu, "")
    .trim();
}

/**
 * The venue a label names, or undefined for an empty one.
 *
 * `fallbackYear` is the record's own acceptance year, used when the label carries none (the
 * OpenReview sync stores `EMNLP` next to `accepted_year: 2025`) or carries a truncated one.
 */
export function normalizeVenue(
  raw: string | undefined,
  fallbackYear?: number | string,
): NormalizedVenue | undefined {
  const text = (raw ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text) {
    return undefined;
  }
  const years = [...text.matchAll(YEAR)].map((match) => match[1]!);
  const fallback = fallbackYear === undefined ? "" : String(fallbackYear).trim();
  const year = years[0] ?? (/^20\d{2}$/u.test(fallback) ? fallback : "");
  let rest = text.replace(YEAR, " ");
  if (years.length === 0) {
    rest = rest.replace(TRUNCATED_YEAR, "");
  }

  if (WORKSHOP.test(rest)) {
    const family = collapse(rest.replace(PARENTHETICAL, " "));
    return { family: family || collapse(rest), track: "workshop", year };
  }
  // The track is read from the whole label, brackets included: `EMNLP 2026 (demo)` is a demo.
  const track: VenueTrack = FINDINGS.test(rest) ? "findings" : DEMO.test(rest) ? "demo" : "main";
  let family = rest.replace(PARENTHETICAL, " ").replace(FINDINGS, " ").replace(DEMO, " ");
  for (const noise of MAIN_NOISE) {
    family = family.replace(noise, " ");
  }
  family = collapse(family);
  if (!family) {
    // "Findings of the Association for Computational Linguistics" on its own is ACL's.
    family = track === "findings" ? "ACL" : collapse(rest.replace(PARENTHETICAL, " ")) || text;
  }
  return { family, track, year };
}

/**
 * What two records are compared on to say "the same venue": the conference and year, track
 * dropped -- a digest of what the lab got into EMNLP 2026 wants its demo and Findings papers in it.
 * A workshop keys on its own name.
 */
export function venueGroupKey(venue: NormalizedVenue | undefined): string {
  if (!venue) {
    return "";
  }
  return `${venue.family.toLocaleLowerCase()} ${venue.year}`.trim();
}

/** How the picker names a venue group: `EMNLP 2026`. Its key reads back to itself. */
export function venueGroupLabel(venue: NormalizedVenue): string {
  return `${venue.family} ${venue.year}`.trim();
}

/**
 * The acceptance sheet's conference cell. The year has its own column, so it is left out; the
 * track stays, because the CV entry a formula builds from this cell has to say "Findings".
 */
export function sheetConference(venue: NormalizedVenue): string {
  switch (venue.track) {
    case "main":
    case "workshop":
      return venue.family;
    case "findings":
      return `Findings of ${venue.family}`;
    case "demo":
      return `${venue.family} System Demonstrations`;
  }
}

/**
 * Orders two venues within one year: by conference, then main before Findings before demos before
 * workshops, so one conference's rows sit together.
 */
export function compareVenuesWithinYear(left: NormalizedVenue, right: NormalizedVenue): number {
  return (
    left.family.localeCompare(right.family, "en", { sensitivity: "base" }) ||
    TRACK_ORDER[left.track] - TRACK_ORDER[right.track]
  );
}

/** Whether two venues are one conference and track, case aside. */
export function sameVenueTrack(left: NormalizedVenue, right: NormalizedVenue): boolean {
  return (
    left.track === right.track &&
    left.family.localeCompare(right.family, "en", { sensitivity: "base" }) === 0
  );
}
