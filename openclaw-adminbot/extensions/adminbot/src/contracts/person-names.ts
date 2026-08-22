// Comparing a name on a paper to a name on the roster.
//
// A contract rather than a helper, because two surfaces have to agree about it and they used to
// disagree: the LinkedIn draft's roster cross-check folded accents and punctuation, while
// "My Projects & Papers" compared `trim().toLowerCase()` strings outright. That is how a
// co-first author came to be invisible on their own paper -- the author list said "Joeun Yook*"
// and the roster said "Joeun Yook", and one asterisk was enough.
//
// Author lists carry marks that are about authorship, not identity: `*` and `†` for equal
// contribution, superscript digits for affiliations, commas for "Last, First". None of them
// change who the person is, so none of them survive normalization.

/**
 * Fold a name to something two records for the same person can agree on.
 *
 * The accent strip is what makes "Schölkopf" match "Scholkopf"; the catch-all that follows is
 * what makes "Joeun Yook*" match "Joeun Yook". Dropping every character outside a-z is blunt on
 * purpose -- it needs no list of which footnote symbols a venue happens to use this year.
 */
export function normalizePersonName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z ]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** arXiv and BibTeX render authors as "Last, First"; everything downstream wants "First Last". */
export function toFirstLast(author: string): string {
  const comma = author.indexOf(",");
  if (comma < 0) {
    return author.trim();
  }
  const last = author.slice(0, comma).trim();
  const first = author.slice(comma + 1).trim();
  return first ? `${first} ${last}` : last;
}

/**
 * Is this author entry the same person as this roster name?
 *
 * Exact after normalization only. No surname-plus-initial fallback here: this decides whose work
 * list a paper appears on, and the cost of a wrong match is showing someone a paper that is not
 * theirs. `verifyAuthorsAgainstMembers` does take that fuzzier step, because there the result is
 * a suggestion a human reads before it goes anywhere.
 */
export function isSamePerson(authorEntry: string, memberName: string): boolean {
  const author = normalizePersonName(toFirstLast(authorEntry));
  const member = normalizePersonName(memberName);
  return author.length > 0 && author === member;
}
