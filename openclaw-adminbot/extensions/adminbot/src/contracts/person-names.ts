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
  if (author.length === 0 || member.length === 0) {
    return false;
  }
  if (author === member) {
    return true;
  }
  // A middle name on one side only.
  //
  // People sign papers with their full name and join the roster with the short one -- "Terry
  // Jingchen Zhang" on five submissions, "Terry Zhang" on the member list. Requiring an exact
  // match made him invisible to the author matcher, which silently moved every duty he owned onto
  // the next person down the author list. That is a worse failure than the collision this guards
  // against, because it is invisible: nothing looks wrong, the wrong person is just asked.
  //
  // Deliberately narrow. Both first and last name must match in full, and the two spellings must
  // differ only by extra middle tokens on one side. "Terry Zhang" still does not match "Terry
  // Chen", and an initial does not stand in for a name -- `normalizePersonName` has already
  // dropped the periods that would make "T" look like a match for "Terry".
  const authorParts = author.split(" ");
  const memberParts = member.split(" ");
  if (authorParts.length < 2 || memberParts.length < 2) {
    return false;
  }
  const sameEnds =
    authorParts[0] === memberParts[0] &&
    authorParts[authorParts.length - 1] === memberParts[memberParts.length - 1];
  if (!sameEnds) {
    return false;
  }
  // One side has to be the plain first-last form; two different middle names are two people.
  return authorParts.length === 2 || memberParts.length === 2;
}
