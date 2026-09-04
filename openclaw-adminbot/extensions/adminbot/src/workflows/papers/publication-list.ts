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
  date: PublicationDate;
};

export type PublicationExclusion = {
  id: string;
  title: string;
  /** Why this paper is not in the digest, in the words the preview shows. */
  reason: "no_date" | "out_of_range";
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
 * The publications in a range, newest first, plus everything left out and why.
 *
 * Sorted newest first because that is the order a reader scans a publication list in, and ties are
 * broken on title so the same range always renders the same email -- an unstable order would make
 * two sends of the same digest look like different documents.
 */
export function selectPublications(params: {
  papers: readonly AdminBotPaperRecord[];
  fromIso: string;
  toIso: string;
}): { included: Publication[]; excluded: PublicationExclusion[] } {
  const included: Publication[] = [];
  const excluded: PublicationExclusion[] = [];
  for (const paper of params.papers) {
    const date = publicationDateOf(paper);
    if (!date) {
      excluded.push({ id: paper.id, title: paper.title, reason: "no_date" });
      continue;
    }
    if (!withinRange(date, params.fromIso, params.toIso)) {
      excluded.push({ id: paper.id, title: paper.title, reason: "out_of_range", date });
      continue;
    }
    const venue = paper.accepted_venue?.trim() || paper.venue?.trim();
    const url = paper.artifacts?.arxiv_url?.trim();
    included.push({
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      ...(venue ? { venue } : {}),
      ...(url ? { url } : {}),
      date,
    });
  }
  included.sort((left, right) =>
    left.date.iso === right.date.iso
      ? left.title.localeCompare(right.title)
      : right.date.iso.localeCompare(left.date.iso),
  );
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
}): { subject: string; body: string } {
  const range = formatRange(params.fromIso, params.toIso);
  const lines: string[] = [`Publications from the Jinesis Lab, ${range}.`, ""];
  if (params.publications.length === 0) {
    lines.push("No publications in our records fall in this range.");
  }
  for (const publication of params.publications) {
    const authors = publication.authors.length
      ? publication.authors.join(", ")
      : "Authors not recorded";
    lines.push(`${publication.title}`);
    lines.push(`  ${authors}`);
    lines.push(
      `  ${[formatDate(publication.date), publication.venue].filter(Boolean).join(" — ")}`,
    );
    if (publication.url) {
      lines.push(`  ${publication.url}`);
    }
    lines.push("");
  }
  if (params.undatedCount > 0) {
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
    subject: `Jinesis Lab publications, ${range}`,
    body: lines.join("\n"),
  };
}
