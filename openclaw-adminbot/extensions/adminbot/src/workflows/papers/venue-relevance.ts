// Ranking accepted conference papers against what a member says they work on.
//
// Pure functions over vectors and strings: no OpenReview, no model, no store. The two connectors
// supply the numbers and this decides what they mean, which is what makes the interesting part --
// "is this ordering any good" -- testable without a network.
//
// Semantic rather than keyword matching, because the roster's own topics do not survive keyword
// matching: 68 of 201 members have any, and across 140 distinct values the same idea is written
// "AI Safety", "AI safety", "Alignment" and "Mechanistic Interpretability". Requiring a literal
// overlap would drop most of the lab. Keywords still earn their place on screen -- see
// `overlappingKeywords` -- but as an explanation of a match, never as the test for one.

import type { OpenReviewPaper } from "../../connectors/openreview-notes.js";

export type RankedPaper = {
  paper: OpenReviewPaper;
  /** Raw cosine similarity. Kept for diagnosis; not what the console shows. */
  score: number;
  /**
   * Match strength within this venue for this query: 1 is the best paper here, 0 the median one.
   * This is what a reader sees, because raw similarity is not comparable between two searches.
   */
  relevance: number;
  /** The paper's own keywords that echo the member's interests, for the "why" on the row. */
  matched_keywords: string[];
};

/**
 * The text a paper is embedded as.
 *
 * Title, then keywords, then a bounded slice of the abstract. The order is deliberate: the title
 * is the densest statement of what a paper is, and truncation eats the tail, so anything that
 * matters must come before the cut. The abstract is capped because embedding quality stops
 * improving well before a full one and cost does not.
 */
export function paperEmbeddingText(paper: OpenReviewPaper): string {
  const body: string[] = [];
  if (paper.keywords.length) {
    body.push(`Keywords: ${paper.keywords.join(", ")}.`);
  }
  if (paper.abstract) {
    body.push(paper.abstract.slice(0, ABSTRACT_EMBED_CHARS));
  }
  // EmbeddingGemma's documented document form. The prefixes are not decoration: with them the
  // gap between an on-topic and an off-topic paper roughly doubles on this corpus (a "causality"
  // query's median similarity fell from 0.24 to 0.14 while its best match held at 0.40), which is
  // what makes the adaptive cutoff below able to find an edge at all.
  return `title: ${paper.title} | text: ${body.join(" ")}`;
}

const ABSTRACT_EMBED_CHARS = 600;

/**
 * The text a member's interests are embedded as.
 *
 * The query half of EmbeddingGemma's retrieval pair, matching the document form above. Both sides
 * have to use the model's own prefixes or neither should: mixing a prefixed document with a bare
 * query is the one combination that scores worse than using neither.
 */
export function interestsEmbeddingText(interests: string): string {
  const trimmed = interests.trim().replace(/\s+/gu, " ");
  return `task: search result | query: ${trimmed}`;
}

/**
 * Cosine similarity, or 0 for vectors that cannot be compared.
 *
 * Mismatched lengths return 0 rather than throwing: that only happens when an index was built
 * with a different embedding model than the query, and a wrong-looking score is a better failure
 * than a crashed search. The index records its model so the caller can spot the real cause.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export type RankOptions = {
  /** How many to return at most. The tail of a 4,000-paper venue is noise nobody scrolls to. */
  limit?: number;
};

export const DEFAULT_RESULT_LIMIT = 25;

/**
 * Similarity below which a whole venue is declared "nothing here is in your field".
 *
 * Deliberately low. Measured against the live model over ICLR 2025, real lab interests top out
 * between 0.31 ("reasoning") and 0.52 ("AI Safety, Mechanistic Interpretability"), while genuinely
 * foreign subjects top out at 0.11 (marine biology) to 0.26 (bread baking). Those bands very
 * nearly touch — "quantum chemistry of protein folding" reaches 0.35 against an ML venue, and
 * arguably deserves to — so this floor is only trying to catch the absurd case, not to decide
 * relevance. That job belongs to the adaptive cutoff below, which is scale-free.
 */
export const ABSOLUTE_FLOOR = 0.28;

/**
 * How far above the venue's own median a paper has to sit to be worth showing, as a fraction of
 * the distance from that median to the best match.
 *
 * A fixed similarity threshold cannot work here: the same member's "causality" tops out at 0.40
 * and their "AI Safety, Mechanistic Interpretability" at 0.52, purely because one string is longer
 * and more specific than the other. Any constant is therefore either empty for one query or
 * flooded for the other. Measuring each query against its own distribution sidesteps that
 * entirely, and at 0.5 it returned 3-8 papers from a 120-paper sample across every interest tried.
 */
export const RELATIVE_MARGIN = 0.5;

export type VenueRanking = {
  results: RankedPaper[];
  /**
   * True when the venue was searched and nothing in it came close. Distinct from an empty result
   * for any other reason, because it is the one case with a real answer for the member: this
   * conference is not about what you work on.
   */
  nothing_relevant: boolean;
};

/**
 * Ranks an indexed venue against one interest vector, best first.
 *
 * Selection is relative, not absolute: the cutoff is drawn from where this particular query's
 * scores actually fall over this particular venue. `relevance` is reported on the same footing --
 * 1 for the best match, 0 at the venue median -- because a bare cosine of 0.42 tells a member
 * nothing, while "this is the strongest thing here for you" does.
 */
export function rankPapers(
  papers: readonly { paper: OpenReviewPaper; vector: readonly number[] }[],
  interestVector: readonly number[],
  interests: string,
  options: RankOptions = {},
): VenueRanking {
  const limit = options.limit ?? DEFAULT_RESULT_LIMIT;
  const terms = interestTerms(interests);
  if (!papers.length) {
    return { results: [], nothing_relevant: false };
  }
  const scored = papers
    .map((entry) => ({
      paper: entry.paper,
      score: cosineSimilarity(interestVector, entry.vector),
    }))
    .toSorted(
      (left, right) =>
        right.score - left.score || left.paper.title.localeCompare(right.paper.title),
    );

  const best = scored[0]?.score ?? 0;
  if (best < ABSOLUTE_FLOOR) {
    return { results: [], nothing_relevant: true };
  }
  // The median rather than the mean: a handful of very strong matches would drag a mean upward and
  // raise the bar against the very papers the member came for.
  const median = scored[Math.floor(scored.length / 2)]?.score ?? 0;
  const spread = best - median;
  const cutoff = median + RELATIVE_MARGIN * spread;

  return {
    results: scored
      .filter((entry) => entry.score >= cutoff)
      .slice(0, limit)
      .map((entry) => ({
        paper: entry.paper,
        score: entry.score,
        // A venue where everything scores identically has no spread to normalise against; every
        // survivor is equally the best match, so they are all reported as one.
        relevance: spread > 0 ? clamp((entry.score - median) / spread) : 1,
        matched_keywords: overlappingKeywords(entry.paper.keywords, terms),
      })),
    nothing_relevant: false,
  };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The member's interests as comparable terms.
 *
 * Split on commas *and* on "and"/"/" because members write the field every way: "AI Safety,
 * Reasoning", "causality and RL", "NLP/IR". Case-folded and stripped of punctuation so
 * "AI Safety" and "ai safety" are one term, which is exactly the near-duplication the roster has.
 *
 * Two-character terms are kept. An earlier length floor of three dropped "RL" and "ML", which are
 * between them the most common topics on this roster — the floor is a stopword list instead, so
 * "of" goes and "RL" stays.
 */
export function interestTerms(interests: string): string[] {
  return [
    ...new Set(
      interests
        .split(/[,;/]|\band\b/giu)
        .map((term) => fold(term))
        .filter((term) => term.length >= 2 && !STOPWORDS.has(term)),
    ),
  ];
}

// Only the joining words that survive splitting a topic list. Not a general stopword list: this
// is filtering fragments like "of" out of "theory of mind", not doing information retrieval.
const STOPWORDS = new Set(["of", "in", "on", "for", "the", "and", "or", "to", "with", "at", "by"]);

/**
 * Which of a paper's keywords a member would recognise as theirs.
 *
 * Substring matching in both directions, so "interpretability" claims "mechanistic
 * interpretability" and vice versa. This is display only -- it says *why* a row is here, and a
 * row with no matched keyword is still a real match on meaning, which is the whole point of
 * ranking by embedding rather than by keyword.
 */
export function overlappingKeywords(
  keywords: readonly string[],
  terms: readonly string[],
): string[] {
  if (!terms.length) {
    return [];
  }
  return keywords.filter((keyword) => {
    const folded = fold(keyword);
    if (folded.length < 2) {
      return false;
    }
    return terms.some((term) => matches(folded, term));
  });
}

// Short terms match whole words only. "RL" has to stay a usable interest, but as a substring it
// also sits inside "world models" and "early stopping", and highlighting those as the reason a
// paper matched would be worse than highlighting nothing.
const SHORT_TERM_MAX = 3;

function matches(keyword: string, term: string): boolean {
  if (term.length <= SHORT_TERM_MAX || keyword.length <= SHORT_TERM_MAX) {
    return wholeWord(keyword, term) || wholeWord(term, keyword);
  }
  return keyword.includes(term) || term.includes(keyword);
}

function wholeWord(haystack: string, needle: string): boolean {
  return haystack === needle || haystack.split(/[\s-]+/u).includes(needle);
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * A member's stored topics as one interest string, for prefilling the box.
 *
 * Joined with commas rather than sent as a list because the box is free text the member edits:
 * what they see has to be what gets embedded, or an edit would silently change the shape of the
 * query rather than its content.
 */
export function interestsFromTopics(topics: readonly string[] | undefined): string {
  return (topics ?? [])
    .map((topic) => topic.trim())
    .filter(Boolean)
    .join(", ");
}
