// One text search for the queues the PI and admins work through.
//
// The Requests queue (paged on the service) and My Desk (filtered in the browser over what it
// already holds) both answer "show me only Jane's" or "only the NeurIPS one". They use this one
// matcher so a name that finds a request on one screen finds it on the other.
//
// The rule: the query is split on whitespace, and every word must appear somewhere among the
// row's fields. Case and accents are ignored, so "jose" finds "José" and "jane mit" finds Jane's
// MIT letter even though the name and the school are different fields.
//
// Browser-safe: imports nothing.

/** Lowercase with accents stripped, so "José" and "jose" compare equal. */
export function foldSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase();
}

/** The words of a query, folded. An empty list means "no filter". */
export function searchTokens(query: string | undefined): string[] {
  return foldSearchText(query ?? "")
    .split(/\s+/u)
    .filter(Boolean);
}

/** Whether every word of the query appears in at least one of the fields. */
export function matchesSearch(
  fields: readonly (string | null | undefined)[],
  query: string | readonly string[] | undefined,
): boolean {
  const tokens = typeof query === "string" || query === undefined ? searchTokens(query) : query;
  if (tokens.length === 0) {
    return true;
  }
  const haystack = fields
    .filter((field): field is string => typeof field === "string" && field.length > 0)
    .map(foldSearchText);
  return tokens.every((token) => haystack.some((field) => field.includes(token)));
}

/** The fields a recommendation-letter request is found by: who asked, and where it is going. */
export function letterRequestSearchFields(request: {
  member_name?: string;
  schools?: readonly { school?: string; program?: string }[];
}): string[] {
  return [
    request.member_name ?? "",
    ...(request.schools ?? []).flatMap((school) => [school.school ?? "", school.program ?? ""]),
  ];
}

/**
 * The fields a paper on the PI's review queue is found by: title, people, venue.
 *
 * Takes the loose shape both the service row and the browser row share, so the same paper is found
 * by the same words on either side.
 */
export function paperReviewSearchFields(row: {
  title?: string;
  authors?: readonly string[] | string;
  venue?: string;
  proofreading?: { venue?: string } | null;
  feedback?: { label?: string } | null;
}): string[] {
  const authors = Array.isArray(row.authors)
    ? row.authors
    : typeof row.authors === "string"
      ? [row.authors]
      : [];
  return [
    row.title ?? "",
    ...authors,
    row.venue ?? "",
    row.proofreading?.venue ?? "",
    row.feedback?.label ?? "",
  ];
}
