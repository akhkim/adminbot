/**
 * The lab's publications in a date range, assembled from the paper records themselves.
 *
 * What makes this awkward, and why the rules below are shaped the way they are: **the roster has
 * almost no acceptance data**. Of 158 papers, one carries `venue_decision: "accept"`, and that one
 * has no `accepted_year`. No paper carries a `deadline`. `created_at` spans six weeks because that
 * is when the spreadsheet was imported, not when anything was published. A mailing list keyed on
 * any of those would send an empty email and look like it had worked.
 *
 * The one real date in the data is the arXiv identifier. `arxiv.org/abs/2605.08426` says May 2026
 * in its first four digits -- that is what an arXiv id *is* -- and 86 of the papers carry one,
 * spanning 2018 to 2026. So the preprint's own id is the primary date, with `accepted_year` as the
 * coarser fallback for anything accepted but not on arXiv.
 *
 * Everything with no date at all is *reported*, never silently dropped. A digest that quietly
 * omitted 70 papers because nobody filled in a field would be worse than one that says so: the
 * excluded list is what tells an admin the email is thin because the records are thin.
 *
 * There is a second way to compose a digest, and it exists because the date range cannot answer
 * the question people actually ask: "the papers we got into ICLR 2027". Venue mode selects on
 * *acceptance at one venue* and ignores the range entirely -- a paper accepted at a conference
 * belongs in that conference's list whether or not it ever had an arXiv id to be dated from. It
 * carries the same honesty rule: 8 papers name `ICLR 2027` as where they are going and none of
 * them records a decision, so those are reported as `not_accepted` rather than either listed as
 * publications (they are not, yet) or dropped in silence (which would make an empty ICLR digest
 * look like a bug in the mailing list rather than a gap in the records).
 *
 * Pure. The service does the reading and the sending.
 */
import type { AdminBotPaperRecord } from "../../contracts/actions.js";

/** Where a publication's date came from, so a reader can judge how much to trust it. */
export type PublicationDateSource =
  /** The arXiv id's YYMM. Month precision, and the paper's own statement of when it appeared. */
  | "arxiv"
  /** `accepted_year`. Year precision only -- treated as the whole year, see `withinRange`. */
  | "accepted_year";

export type PublicationDate = {
  /** ISO day. Month-precision dates land on the 1st; year-precision on 1 January. */
  iso: string;
  precision: "month" | "year";
  source: PublicationDateSource;
};

export type Publication = {
  id: string;
  title: string;
  authors: string[];
  /** The venue as the record states it: `accepted_venue` when set, else the target `venue`. */
  venue?: string;
  url?: string;
  /**
   * When it appeared, when the record can say. Always present in a date-ranged digest -- being
   * datable is how a paper got in. Absent only in venue mode, where acceptance is the criterion
   * and a paper with no arXiv id is still a paper the lab got into the conference.
   */
  date?: PublicationDate;
};

export type PublicationExclusion = {
  id: string;
  title: string;
  /** Why this paper is not in the digest, in the words the preview shows. */
  reason: "no_date" | "out_of_range" | "not_accepted";
  /** The date that put it out of range, when it has one. */
  date?: PublicationDate;
};

/**
 * An arXiv id's own month.
 *
 * arXiv ids are `YYMM.NNNNN` since 2007, and the YYMM is the month of first submission. Matched
 * anywhere in the string rather than by parsing the URL, because the field holds `/abs/`, `/pdf/`,
 * http and https, with and without a version suffix -- and every one of those still contains the
 * id. The year is windowed rather than assumed to be 20xx: a `99` would be 1999, and while arXiv
 * ids of that vintage use the old scheme, a two-digit year that silently became 2099 is the kind
 * of thing that sorts a digest wrongly and is never noticed.
 */
export function arxivMonth(url: string | undefined): PublicationDate | undefined {
  const match = /(?:^|[^\d])(\d{2})(\d{2})\.\d{4,5}/u.exec(url ?? "");
  if (!match) {
    return undefined;
  }
  const yy = Number(match[1]);
  const mm = Number(match[2]);
  if (mm < 1 || mm > 12) {
    return undefined;
  }
  // arXiv's numbering started in 1991 and the identifier scheme this parses in 2007, so anything
  // below 91 is a 20xx year and anything above it is 19xx.
  const year = yy >= 91 ? 1900 + yy : 2000 + yy;
  return {
    iso: `${year}-${String(mm).padStart(2, "0")}-01`,
    precision: "month",
    source: "arxiv",
  };
}

/**
 * When this paper was published, as well as the record can say.
 *
 * arXiv first: it is a real month, and it is the date a reader of the digest would recognise.
 * `accepted_year` second, for work accepted somewhere with no preprint. A paper with neither is
 * undated rather than guessed -- see the module header for why `created_at` is not a candidate.
 */
export function publicationDateOf(paper: AdminBotPaperRecord): PublicationDate | undefined {
  const fromArxiv = arxivMonth(paper.artifacts?.arxiv_url);
  if (fromArxiv) {
    return fromArxiv;
  }
  const year = paper.accepted_year;
  if (typeof year === "number" && year >= 1900 && year <= 2200) {
    return { iso: `${year}-01-01`, precision: "year", source: "accepted_year" };
  }
  return undefined;
}

/**
 * Does this date fall in the range?
 *
 * A year-precision date counts if *any* of its year overlaps the range, not if 1 January does.
 * Otherwise a paper accepted in 2026 would be missing from a digest covering July to December
 * 2026, which is exactly the request somebody makes when writing an annual report.
 */
export function withinRange(date: PublicationDate, fromIso: string, toIso: string): boolean {
  if (date.precision === "year") {
    const year = date.iso.slice(0, 4);
    return year >= fromIso.slice(0, 4) && year <= toIso.slice(0, 4);
  }
  const day = date.iso.slice(0, 10);
  return day >= fromIso.slice(0, 10) && day <= toIso.slice(0, 10);
}

/**
 * One venue as the Mailing List tab offers it, counted out of the records themselves.
 *
 * `accepted` is what a digest for this venue would contain; `pending` is what names it as a target
 * with no decision recorded. Both are on screen because an admin picking "ICLR 2027" out of a list
 * that says `0 accepted, 8 pending` has already been told why the email will be empty.
 */
export type VenueOption = {
  key: string;
  /** The venue as the records spell it, in the commonest spelling if they disagree. */
  label: string;
  accepted: number;
  pending: number;
};

/**
 * A venue string reduced to something two records can be compared on.
 *
 * The field is free text typed by authors, and the live roster holds `ICLR 2027`, `ACL 2026
 * (main)`, `EMNLP 2026 (demo)` and `NAACL 2027 (main)`. The parenthetical is the track, not the
 * venue: a digest of "what we got into EMNLP 2026" wants the demo paper in it, so the bracket is
 * dropped before comparing. Case and inner spacing go the same way, and everything else is left
 * alone -- normalising harder (stripping the year, mapping acronyms) would start merging venues
 * that are genuinely different, which is the failure nobody would spot in a sent email.
 */
export function venueKey(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/\([^)]*\)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * The venue this paper was *accepted* at, if the record says it was accepted anywhere.
 *
 * `accepted_venue` is the author's own statement of where it landed and wins outright. Failing
 * that, a paper whose `venue_decision` is `accept` was accepted at the venue it was aimed at --
 * that pairing is the whole meaning of the decision field. A paper with neither has not been
 * recorded as accepted, and this returns nothing for it; `venue` alone is where a paper is *going*
 * and is never enough (see the note on `accepted_venue` in the contract).
 */
export function acceptedVenueOf(paper: AdminBotPaperRecord): string | undefined {
  const accepted = paper.accepted_venue?.trim();
  if (accepted) {
    return accepted;
  }
  return paper.venue_decision === "accept" ? paper.venue?.trim() || undefined : undefined;
}

/**
 * Every venue the records mention, commonest spelling first within a key.
 *
 * Built from the papers rather than from a venue table because the venue table is the deadline
 * board -- what the lab is aiming at this cycle -- and a publication list has to be able to name
 * a conference from 2019 that no board still carries.
 */
export function collectVenues(papers: readonly AdminBotPaperRecord[]): VenueOption[] {
  type Tally = { spellings: Map<string, number>; accepted: number; pending: number };
  const byKey = new Map<string, Tally>();
  for (const paper of papers) {
    const accepted = acceptedVenueOf(paper);
    const raw = accepted ?? paper.venue?.trim();
    const key = venueKey(raw);
    if (!key || !raw) {
      continue;
    }
    const entry = byKey.get(key) ?? { spellings: new Map(), accepted: 0, pending: 0 };
    entry.spellings.set(raw, (entry.spellings.get(raw) ?? 0) + 1);
    if (accepted) {
      entry.accepted += 1;
    } else {
      entry.pending += 1;
    }
    byKey.set(key, entry);
  }
  const options: VenueOption[] = [];
  for (const [key, entry] of byKey) {
    // The commonest spelling, ties broken alphabetically so the label does not depend on the
    // order the papers happened to be read in.
    const label = [...entry.spellings.entries()].toSorted(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0];
    if (label) {
      options.push({ key, label, accepted: entry.accepted, pending: entry.pending });
    }
  }
  options.sort(
    (left, right) => right.accepted - left.accepted || left.label.localeCompare(right.label),
  );
  return options;
}

/** One paper, as the digest prints it. Shared by both ways of choosing papers. */
function publicationOf(paper: AdminBotPaperRecord, date?: PublicationDate): Publication {
  const venue = paper.accepted_venue?.trim() || paper.venue?.trim();
  const url = paper.artifacts?.arxiv_url?.trim();
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors ?? [],
    ...(venue ? { venue } : {}),
    ...(url ? { url } : {}),
    ...(date ? { date } : {}),
  };
}

/**
 * The publications for a digest, newest first, plus everything left out and why.
 *
 * Two ways to choose them, and `venue` decides which. Without it the range selects, and a paper
 * needs a date to be placed in one. With it the *acceptance* selects: the range is ignored, and an
 * accepted paper is in the list whether or not anything can date it -- an ICLR 2027 list that
 * dropped the accepted papers with no arXiv id would be wrong in the one way nobody checks for.
 *
 * Sorted newest first because that is the order a reader scans a publication list in, and ties are
 * broken on title so the same range always renders the same email -- an unstable order would make
 * two sends of the same digest look like different documents. Undated papers in venue mode sort
 * last, after everything that can say when it appeared.
 */
export function selectPublications(params: {
  papers: readonly AdminBotPaperRecord[];
  fromIso: string;
  toIso: string;
  /** Compose by acceptance at this venue instead of by date. Matched with `venueKey`. */
  venue?: string;
}): { included: Publication[]; excluded: PublicationExclusion[] } {
  const included: Publication[] = [];
  const excluded: PublicationExclusion[] = [];
  const wantedVenue = venueKey(params.venue);
  for (const paper of params.papers) {
    const date = publicationDateOf(paper);
    if (wantedVenue) {
      const accepted = acceptedVenueOf(paper);
      if (accepted && venueKey(accepted) === wantedVenue) {
        included.push(publicationOf(paper, date));
        continue;
      }
      // Aimed here, not landed here. Reported rather than dropped: this is the list that explains
      // an empty digest, and it is the one an admin should read as "chase these decisions".
      if (!accepted && venueKey(paper.venue) === wantedVenue) {
        excluded.push({
          id: paper.id,
          title: paper.title,
          reason: "not_accepted",
          ...(date ? { date } : {}),
        });
      }
      // Everything else is a paper about a different venue, which is not an omission worth
      // reporting -- listing 150 unrelated titles would bury the ones that are.
      continue;
    }
    if (!date) {
      excluded.push({ id: paper.id, title: paper.title, reason: "no_date" });
      continue;
    }
    if (!withinRange(date, params.fromIso, params.toIso)) {
      excluded.push({ id: paper.id, title: paper.title, reason: "out_of_range", date });
      continue;
    }
    included.push(publicationOf(paper, date));
  }
  included.sort((left, right) => {
    // "" sorts below every real ISO day, which puts the undated papers at the end of a venue list.
    const leftIso = left.date?.iso ?? "";
    const rightIso = right.date?.iso ?? "";
    return leftIso === rightIso
      ? left.title.localeCompare(right.title)
      : rightIso.localeCompare(leftIso);
  });
  excluded.sort((left, right) => left.title.localeCompare(right.title));
  return { included, excluded };
}

/** How a month-precision date reads in the email: "May 2026". Year-precision drops the month. */
function formatDate(date: PublicationDate): string {
  const [year, month] = date.iso.split("-");
  if (date.precision === "year" || !month) {
    return year ?? date.iso;
  }
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : `${year}-${month}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The range as the subject line and the opening sentence say it. */
export function formatRange(fromIso: string, toIso: string): string {
  return `${fromIso.slice(0, 10)} to ${toIso.slice(0, 10)}`;
}

/**
 * The email itself.
 *
 * Plain text, rendered to HTML by the same `renderEmailBodyHtml` every other lab email uses, so
 * the one body is both. Authors are printed as the paper prints them -- `authors` is the paper's
 * own spelling, which is what a reader recognises (see the field's own note in the contract).
 *
 * The "not included" count is in the body, not just the preview. Somebody forwarding this to a
 * funder should be able to see that it covers what the lab has recorded rather than what the lab
 * has done, without going back to the tab that produced it.
 */
export function renderPublicationDigest(params: {
  publications: readonly Publication[];
  undatedCount: number;
  fromIso: string;
  toIso: string;
  /** Set in venue mode: the venue as the email should name it, e.g. "ICLR 2027". */
  venue?: string;
  /** Venue mode only: papers naming this venue with no decision recorded. */
  pendingCount?: number;
}): { subject: string; body: string } {
  const venue = params.venue?.trim();
  const range = formatRange(params.fromIso, params.toIso);
  const heading = venue
    ? `Publications from the Jinesis Lab accepted at ${venue}.`
    : `Publications from the Jinesis Lab, ${range}.`;
  const lines: string[] = [heading, ""];
  if (params.publications.length === 0) {
    lines.push(
      venue
        ? `No papers in our records are recorded as accepted at ${venue}.`
        : "No publications in our records fall in this range.",
    );
  }
  for (const publication of params.publications) {
    const authors = publication.authors.length
      ? publication.authors.join(", ")
      : "Authors not recorded";
    lines.push(`${publication.title}`);
    lines.push(`  ${authors}`);
    // In venue mode the venue is the heading, so the line under a title carries only what that
    // paper adds: its date, when there is one. Repeating "ICLR 2027" under every entry of an ICLR
    // list is noise.
    const detail = venue
      ? publication.date && formatDate(publication.date)
      : [publication.date && formatDate(publication.date), publication.venue]
          .filter(Boolean)
          .join(" — ");
    if (detail) {
      lines.push(`  ${detail}`);
    }
    if (publication.url) {
      lines.push(`  ${publication.url}`);
    }
    lines.push("");
  }
  const pending = venue ? (params.pendingCount ?? 0) : 0;
  if (pending > 0) {
    // The counterpart of the undated note, for the other way of composing: somebody reading a
    // three-paper ICLR list should be told the lab has more in flight there, not left to assume
    // three is all there was.
    lines.push(
      `${pending} further ${pending === 1 ? "paper names" : "papers name"} ${venue} in our` +
        ` records without an acceptance decision, so ${
          pending === 1 ? "it is" : "they are"
        } not listed here.`,
    );
    lines.push("");
  }
  if (!venue && params.undatedCount > 0) {
    lines.push(
      `${params.undatedCount} further ${
        params.undatedCount === 1 ? "paper is" : "papers are"
      } in our records without a publication date, so ${
        params.undatedCount === 1 ? "it is" : "they are"
      } not listed here.`,
    );
    lines.push("");
  }
  lines.push("— AdminBot, on behalf of the Jinesis Lab");
  return {
    subject: venue ? `Jinesis Lab papers at ${venue}` : `Jinesis Lab publications, ${range}`,
    body: lines.join("\n"),
  };
}
