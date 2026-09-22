// Scoring the lab's own papers against a domain, a keyword, or a whole research proposal.
//
// The sibling of venue-relevance.ts, pointed the other way. That module asks "which of this
// conference's 4,000 papers should this member read"; this one asks "which of our ~100 papers
// answer to this grant", and the reversal changes almost every decision, so it is a separate
// module rather than another option on `rankPapers`:
//
//   * **The corpus is small and the answer is not a fixed fraction.** `rankPapers` cuts at the
//     venue's own median plus half the spread, which is the right call over thousands of papers
//     and the wrong one over a hundred: a median-relative cutoff returns roughly the same *share*
//     of the corpus whether a proposal is squarely the lab's subject or has nothing to do with it.
//     A grant report needs "eleven of our papers cover Part 1.1.1 and none cover Part 1.2.4" to be
//     an answer it can actually give.
//   * **The documents are much thinner.** A venue paper arrives with an abstract and the authors'
//     own keywords. An `AdminBotPaperRecord` has a title and, if somebody typed them, an alias and
//     some notes. A placement made off eight words of title is a real answer but not an equally
//     confident one, which is what `evidence` records -- see labPaperEvidence.
//   * **The query can be a document.** "causality" and a 40-page proposal are both legitimate
//     inputs. Embedding the proposal whole would average its sections into a generic "AI safety"
//     centroid that matches everything weakly and nothing well, so a proposal is split into its
//     own sections and a paper scores as the best section it answers -- which also happens to be
//     the thing a grant report wants to print next to the paper.
//
// Pure: vectors in, placements out. No embedder, no store, no HTTP. The half that needs a model
// is lab-relevance-search.ts, for the same reason venue-relevance.ts and venue-index.ts are split
// -- "is this ordering any good" is the interesting question and it should be answerable without a
// network.

import { textMatchesNeedles } from "./openreview-matching.js";
import { cosineSimilarity, interestTerms } from "./venue-relevance.js";

// --- what a lab paper looks like to this module ------------------------------------------

/**
 * The fields a placement is made from.
 *
 * Structural rather than `AdminBotPaperRecord` so the classifier can also be handed a row that is
 * not in the store yet (a sheet import, an agent tool's draft) and so tests do not have to build a
 * full record to check a ranking. An `AdminBotPaperRecord` satisfies it as-is.
 *
 * `abstract` and `keywords` are optional and nothing in the store writes them today. They are here
 * because the moment a record is enriched from arXiv or OpenReview -- which `artifacts` already
 * carries the ids for -- the classifier should use that text without a signature change, and
 * because a caller that has the abstract in hand should never be forced to throw it away.
 */
export type LabPaperInput = {
  id: string;
  title: string;
  alias?: string;
  venue?: string;
  accepted_venue?: string;
  notes?: string;
  author_roles?: string;
  abstract?: string;
  keywords?: readonly string[];
};

/**
 * How much text the placement was actually made from.
 *
 * Reported on every row because the same cosine means different things over an abstract and over
 * a title: eight words is a high-variance estimate of what a paper is about, and a grant report
 * that presented both with one confidence would be overclaiming. A reader seeing `title_only` on a
 * `core` placement knows to check it; without the field there is nothing to check against.
 */
export type LabPaperEvidence = "rich" | "thin" | "title_only";

/** Below this many characters of body text a record is barely more than its own title. */
const THIN_EVIDENCE_CHARS = 120;

export function labPaperEvidence(paper: LabPaperInput): LabPaperEvidence {
  if (paper.abstract?.trim()) {
    return "rich";
  }
  const body = labPaperBodyText(paper);
  if (!body) {
    return "title_only";
  }
  return body.length >= THIN_EVIDENCE_CHARS ? "thin" : "title_only";
}

/** Everything about a paper that is not its title, in the order it earns a place in the vector. */
function labPaperBodyText(paper: LabPaperInput): string {
  const parts: string[] = [];
  if (paper.keywords?.length) {
    parts.push(`Keywords: ${paper.keywords.join(", ")}.`);
  }
  if (paper.abstract?.trim()) {
    parts.push(paper.abstract.trim().slice(0, ABSTRACT_EMBED_CHARS));
  }
  // The lab's short name for the project ("CAIS" for Causal AI Scientist) is frequently the only
  // subject word a record carries beyond its title, and it is chosen by a person rather than
  // slugged, so it is worth more per character than anything else here.
  if (paper.alias?.trim()) {
    parts.push(`Project: ${paper.alias.trim()}.`);
  }
  // Notes last, and capped. This is the paper's scratchpad, so it is a mix of subject matter and
  // logistics ("waiting on the camera-ready", "Zhijing to read by Friday"); the logistics are
  // topical noise. Including it still wins on balance -- for many records it is the only sentence
  // about the actual work -- but it must not be able to outweigh the title, which is why it sits
  // after the cut-sensitive fields rather than before them.
  const prose = [paper.author_roles, paper.notes]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ");
  if (prose) {
    parts.push(prose.slice(0, NOTES_EMBED_CHARS));
  }
  return parts.join(" ").trim();
}

const ABSTRACT_EMBED_CHARS = 600;
const NOTES_EMBED_CHARS = 400;

/**
 * The text a lab paper is embedded as.
 *
 * Deliberately the same shape venue-relevance.ts uses for a conference paper, prefixes and all:
 * the two sides of this comparison have to be embedded the same way or the scores are not
 * comparable, and the measured benefit of EmbeddingGemma's own prefixes (roughly doubling the gap
 * between an on-topic and an off-topic paper) is what makes the control calibration below able to
 * find an edge at all.
 */
export function labPaperEmbeddingText(paper: LabPaperInput): string {
  return documentEmbeddingText(paper.title, labPaperBodyText(paper));
}

/**
 * A title and a body in EmbeddingGemma's document form.
 *
 * A record with no body repeats its title rather than sending an empty `text:` half, because the
 * model's document form expects both fields and an empty one measurably drags the vector toward
 * whatever other empty documents look like -- which would make the thinnest records cluster with
 * each other instead of with their subject.
 */
function documentEmbeddingText(title: string, body: string): string {
  const trimmed = body.trim();
  return `title: ${title} | text: ${trimmed || title}`;
}

// --- the query: a keyword, a domain, or a whole proposal ----------------------------------

export type RelevanceQueryKind = "keywords" | "proposal";

export type RelevanceQuerySegment = {
  /** Stable within one query. "q" for a keyword query, "s1", "s2"… for a document's sections. */
  id: string;
  /** The heading this came from, which is what a report prints beside a matched paper. */
  label: string;
  /** What actually gets embedded: the heading, then its body. */
  text: string;
};

export type RelevanceQuery = {
  kind: RelevanceQueryKind;
  segments: RelevanceQuerySegment[];
  /** Folded terms, for the literal-overlap note on a row. Explanation only, never the test. */
  terms: string[];
  /** What was asked, kept so a caller can show it back. */
  source: string;
};

/**
 * A query is a document once it is long enough or structured enough to have parts.
 *
 * Both tests are about the failure they prevent rather than about prose in general: under ~400
 * characters there is nothing to gain by splitting, and a single short paragraph cut into
 * sentences produces segments too unspecific to score. Anything carrying headings is a document
 * however short, because the author has already said where its parts are.
 */
const PROPOSAL_MIN_CHARS = 400;

/**
 * How much of a section is embedded as one segment.
 *
 * Roughly an abstract's worth, and that is the point: a query and a document that differ wildly in
 * length and specificity produce cosines dominated by that mismatch rather than by subject --
 * venue-relevance.ts measured the same member's "causality" topping out at 0.40 against their
 * longer "AI Safety, Mechanistic Interpretability" at 0.52. Segmenting a proposal to about the
 * length of the thing it is being compared against removes most of that.
 */
const SEGMENT_MAX_CHARS = 1_200;

/** Turns whatever was typed into the segments that will be embedded. */
export function parseRelevanceQuery(raw: string): RelevanceQuery {
  const source = raw.trim();
  const terms = interestTerms(source);
  if (!source) {
    return { kind: "keywords", segments: [], terms, source };
  }
  const lines = source.split(/\r?\n/u);
  const structured = lines.some((line) => headingOf(line) !== undefined);
  if (!structured && source.length < PROPOSAL_MIN_CHARS) {
    return {
      kind: "keywords",
      segments: [{ id: "q", label: source, text: source }],
      terms,
      source,
    };
  }
  return { kind: "proposal", segments: splitIntoSegments(lines), terms, source };
}

/**
 * Builds a query from a taxonomy rather than from prose.
 *
 * This is the "which domain is this paper in" half of the job. The taxonomy itself is not imported
 * -- the safety areas live in the Control UI and `extensions/` may not reach into it, and a funder
 * asking about a different taxonomy next year should not require a code change here. The caller
 * supplies whatever set of labelled domains it wants placed and gets one segment per domain, which
 * makes `segments` on each result the paper's domain assignment.
 */
export function relevanceQueryFromDomains(
  domains: readonly { id: string; label: string; description: string }[],
): RelevanceQuery {
  const segments = domains
    .map((domain) => ({
      id: domain.id,
      label: domain.label,
      text: `${domain.label}. ${domain.description}`.trim().slice(0, SEGMENT_MAX_CHARS),
    }))
    .filter((segment) => segment.text.length > 0);
  const labels = domains.map((domain) => domain.label).join(", ");
  return { kind: "proposal", segments, terms: interestTerms(labels), source: labels };
}

/**
 * The heading a line is, or nothing.
 *
 * Four shapes because grant documents arrive in all of them: pasted markdown, the proposal's own
 * "Part 1.1.1 Evaluation hacking" numbering, the "A." / "B." sub-items that numbering bottoms out
 * in, and the bare capitalised line that a Word export leaves behind once its styling is gone.
 */
function headingOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > HEADING_MAX_CHARS) {
    return undefined;
  }
  const markdown = /^#{1,6}\s+(.+?)\s*#*$/u.exec(trimmed);
  if (markdown) {
    return markdown[1];
  }
  if (/^(?:part\s+)?\d+(?:\.\d+)*\.?\s+\S/iu.test(trimmed)) {
    return trimmed;
  }
  if (/^[A-Z][.)]\s+\S/u.test(trimmed)) {
    return trimmed;
  }
  // A capitalised line with no sentence-ending punctuation is a heading that lost its styling.
  // The letter floor keeps "AI" and stray initials from starting a section of their own.
  if (/^[A-Z][^a-z]{3,}$/u.test(trimmed) && !/[.!?]$/u.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

// A heading is a line somebody would put in a table of contents. Past this it is a sentence that
// happens to start with a number, and treating it as a heading would shatter the body into pieces.
const HEADING_MAX_CHARS = 120;

function splitIntoSegments(lines: readonly string[]): RelevanceQuerySegment[] {
  const sections: { label: string; body: string[] }[] = [];
  let current: { label: string; body: string[] } | undefined;
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading !== undefined) {
      current = { label: heading, body: [] };
      sections.push(current);
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    if (!current) {
      // Text before the first heading is still part of the proposal. Labelled from its own opening
      // words rather than dropped, because an executive summary is often the densest statement of
      // what the whole document is about.
      current = { label: openingLabel(line), body: [] };
      sections.push(current);
    }
    current.body.push(line.trim());
  }
  return sections.flatMap((section, index) => toSegments(section, index));
}

function openingLabel(line: string): string {
  const trimmed = line.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77)}…`;
}

/**
 * One section as one or more segments.
 *
 * The heading is prepended to its own body for the same reason a paper's title leads its vector:
 * it is the densest statement of what the section is, and truncation eats the tail. A section
 * longer than the budget becomes several segments rather than being cut, because the overflow of a
 * long section is exactly where its specifics live -- and each part keeps the heading, so a match
 * on part three still reports the section a reader recognises.
 */
function toSegments(
  section: { label: string; body: string[] },
  index: number,
): RelevanceQuerySegment[] {
  const body = section.body.join(" ").replace(/\s+/gu, " ").trim();
  const head = section.label.trim();
  const whole = body ? `${head}. ${body}` : head;
  if (!whole) {
    return [];
  }
  if (whole.length <= SEGMENT_MAX_CHARS) {
    return [{ id: `s${index + 1}`, label: head, text: whole }];
  }
  const chunks: string[] = [];
  // The body is chunked, not the heading, so every part is `heading + a slice of the body`. The
  // floor keeps a pathologically long heading from producing a zero-width budget and looping.
  const budget = Math.max(SEGMENT_MAX_CHARS - head.length - 2, MIN_CHUNK_CHARS);
  for (let start = 0; start < body.length; start += budget) {
    chunks.push(body.slice(start, start + budget));
  }
  return chunks.map((chunk, part) => ({
    id: `s${index + 1}.${part + 1}`,
    label: part === 0 ? head : `${head} (part ${part + 1})`,
    text: `${head}. ${chunk}`,
  }));
}

const MIN_CHUNK_CHARS = 200;

// --- calibration -------------------------------------------------------------------------

/**
 * Deliberately foreign documents, embedded alongside the real ones to measure what this particular
 * query scores against something it has nothing to do with.
 *
 * This is what replaces `rankPapers`'s median. The problem both are solving is that a raw cosine
 * is not comparable between two queries -- a one-word "causality" and a 1,200-character proposal
 * section sit on different scales purely because of length and specificity -- so no constant
 * threshold can work for both. `rankPapers` solves it by measuring each query against the corpus
 * it is searching, which needs the corpus to be mostly irrelevant; over a hundred lab papers and a
 * proposal written for that lab, it usually is not.
 *
 * Measuring against a fixed set of known-irrelevant documents instead keeps the scale-free
 * property without assuming anything about the corpus. It costs six extra embeddings per run and
 * it answers the question a grant report actually asks: not "is this paper in the top decile" but
 * "is this paper about this, more than an unrelated paper would be".
 *
 * The subjects echo the controls venue-relevance.ts was measured against (marine biology at 0.11,
 * bread baking through to 0.26), which is where the margins below come from. They have to stay
 * foreign to *this* lab specifically: a control about statistics or about software would score
 * against half the corpus and quietly raise the bar on the papers the report exists to find.
 */
export const CONTROL_DOCUMENTS: readonly { title: string; body: string }[] = [
  {
    title: "Feeding ecology of reef-associated parrotfish",
    body: "Grazing rates, bite scars and algal turf recovery measured across three seasons on a fringing coral reef.",
  },
  {
    title: "A practical guide to sourdough fermentation",
    body: "Hydration, starter maintenance, bulk proof timing and oven spring for home bakers working without a proofing cabinet.",
  },
  {
    title: "Land tenure disputes in twelfth-century Burgundy",
    body: "Charter evidence for monastic land holdings, seigneurial obligations and the settlement of boundary claims.",
  },
  {
    title: "Fatigue cracking in prestressed concrete bridge girders",
    body: "Load cycling, crack propagation and inspection intervals for post-tensioned highway structures in service.",
  },
  {
    title: "Rainfall variability and smallholder maize yields",
    body: "Season onset, dry spell frequency and their effect on planting decisions and harvest outcomes.",
  },
  {
    title: "Amateur astrophotography of deep-sky objects",
    body: "Tracking mounts, stacking exposures and narrowband filters for imaging emission nebulae from suburban skies.",
  },
];

/** The control set as embeddable document text, on the same footing as a lab paper. */
export function controlDocumentTexts(): string[] {
  return CONTROL_DOCUMENTS.map((control) => documentEmbeddingText(control.title, control.body));
}

export type LabRelevanceBand = "core" | "related" | "peripheral" | "off_topic";

/**
 * How far above the noise floor a paper has to sit to earn each band.
 *
 * Derived from venue-relevance.ts's measurements against the live model: genuinely foreign
 * subjects scored 0.11-0.26 there and real lab interests 0.31-0.52, so the usable signal is a band
 * roughly 0.05 to 0.25 wide above whatever an unrelated document scores. `core` is set inside the
 * top of that, `peripheral` just clear of its bottom.
 *
 * These are the one part of this module that is a calibration rather than a derivation, and they
 * were fixed against a different corpus than the one they run on. Until they are re-measured
 * against the lab's own papers, treat a `core` placement as a strong suggestion rather than a
 * fact -- which is what `evidence` here, and the curated/inferred tiers the grant report already
 * uses, are both for.
 */
export const CORE_MARGIN = 0.18;
export const RELATED_MARGIN = 0.1;
export const PERIPHERAL_MARGIN = 0.04;

/**
 * Below this raw cosine nothing is a match whatever the controls did.
 *
 * A guard against the degenerate case, not a threshold: if every control happens to score very
 * low, a paper that is also nearly unrelated would still clear the margins. Kept well under
 * venue-relevance.ts's own 0.28 floor, because that floor is applied once to a whole venue's best
 * paper and this one is applied to every paper.
 */
export const ABSOLUTE_MIN = 0.15;

export function bandForMargin(margin: number, score: number): LabRelevanceBand {
  if (score < ABSOLUTE_MIN) {
    return "off_topic";
  }
  if (margin >= CORE_MARGIN) {
    return "core";
  }
  if (margin >= RELATED_MARGIN) {
    return "related";
  }
  return margin >= PERIPHERAL_MARGIN ? "peripheral" : "off_topic";
}

const BAND_ORDER: Readonly<Record<LabRelevanceBand, number>> = {
  core: 3,
  related: 2,
  peripheral: 1,
  off_topic: 0,
};

/** True when `band` is at least as strong as `floor`. */
export function bandAtLeast(band: LabRelevanceBand, floor: LabRelevanceBand): boolean {
  return BAND_ORDER[band] >= BAND_ORDER[floor];
}

// --- placing the papers -------------------------------------------------------------------

export type LabSegmentScore = {
  segment_id: string;
  label: string;
  /** Raw cosine. Kept for diagnosis; not what a reader should be shown. */
  score: number;
  /** Score less what an unrelated document scores on this segment. This is what bands. */
  margin: number;
  band: LabRelevanceBand;
};

export type LabPaperRelevance = {
  paper_id: string;
  title: string;
  /** The raw cosine of the segment that placed this paper. */
  score: number;
  /** That segment's margin over its own noise floor. This is what produced `band`. */
  margin: number;
  band: LabRelevanceBand;
  /**
   * Every segment this paper is at least peripheral to, best first. For a proposal this is the
   * paper's section assignment, and it is a list because one paper routinely serves several.
   */
  segments: LabSegmentScore[];
  /** The strongest of `segments`, absent when the paper matched nothing. */
  best_segment?: LabSegmentScore;
  /** Query terms that literally appear in the paper's text. Says why, never decides. */
  matched_terms: string[];
  evidence: LabPaperEvidence;
};

export type LabRelevanceReport = {
  query_kind: RelevanceQueryKind;
  segment_count: number;
  /** How many papers were scored, so a caller can say "11 of 104". */
  scored: number;
  /** Everything at or above `minBand`, strongest first. */
  matches: LabPaperRelevance[];
  /** The rest, kept rather than dropped: on a corpus this size the misses are triage, not noise. */
  off_topic: LabPaperRelevance[];
  /** True when the whole corpus came back empty -- a real answer, not an error. */
  nothing_relevant: boolean;
  /**
   * Segments no paper reached `related` on.
   *
   * The half of a grant report that is hard to get any other way: not "what have we published" but
   * "which parts of this proposal have no track record behind them". A section listed here is a
   * gap to answer before the application goes out.
   */
  uncovered_segments: RelevanceQuerySegment[];
};

export type ScoredLabPaper = {
  paper: LabPaperInput;
  vector: readonly number[];
};

export type LabRelevanceOptions = {
  /** How many matches to return. Absent means all of them; this corpus is small on purpose. */
  limit?: number;
  /** The weakest band that still counts as a match. Defaults to `peripheral`. */
  minBand?: LabRelevanceBand;
};

/**
 * Places every paper against every segment of the query.
 *
 * A paper's band is the best it does on any one segment, never an average across them. Averaging
 * would punish exactly the paper a grant report is looking for -- one that answers Part 1.1.1
 * precisely and has nothing to do with the other thirty sections -- and reward a paper vaguely
 * adjacent to all of them.
 *
 * `segmentVectors` is positional against `query.segments`; a length mismatch scores nothing rather
 * than silently pairing a section with another section's vector, which would produce placements
 * that look plausible and are wrong.
 *
 * `controlVectors` may be omitted, and then every noise floor is 0 and the margin is just the raw
 * cosine. That degrades sensibly rather than breaking, but it is not the intended mode: with no
 * floor to clear, `ABSOLUTE_MIN` (0.15) sits above `PERIPHERAL_MARGIN` (0.04) and the peripheral
 * band becomes unreachable, so placements collapse to "related or better, or nothing". Pass the
 * controls -- findRelevantLabPapers does it for you.
 */
export function classifyLabPapers(params: {
  papers: readonly ScoredLabPaper[];
  query: RelevanceQuery;
  segmentVectors: readonly (readonly number[])[];
  controlVectors?: readonly (readonly number[])[];
  options?: LabRelevanceOptions;
}): LabRelevanceReport {
  const { papers, query, segmentVectors, controlVectors = [], options = {} } = params;
  const minBand = options.minBand ?? "peripheral";
  const usable = query.segments.length > 0 && segmentVectors.length === query.segments.length;
  if (!usable || !papers.length) {
    return {
      query_kind: query.kind,
      segment_count: query.segments.length,
      scored: papers.length,
      matches: [],
      off_topic: [],
      // False, not true. `nothing_relevant` is a finding about the corpus -- "we searched and none
      // of it is about this" -- and nothing was searched here. Reporting it would tell a caller
      // the lab has no work on a subject when what actually happened is that the query was empty
      // or the vectors did not line up.
      nothing_relevant: false,
      uncovered_segments: [...query.segments],
    };
  }

  // One noise floor per segment, because specificity varies between sections of the same document
  // as much as it does between two separate queries.
  const noise = query.segments.map((_, index) => {
    const vector = segmentVectors[index] ?? [];
    let worst = 0;
    for (const control of controlVectors) {
      worst = Math.max(worst, cosineSimilarity(vector, control));
    }
    return worst;
  });

  const placed = papers.map((entry) =>
    placePaper(entry, query.segments, segmentVectors, noise, query.terms),
  );
  const byStrength = (left: LabPaperRelevance, right: LabPaperRelevance): number =>
    right.margin - left.margin || left.title.localeCompare(right.title);
  const matches = placed.filter((paper) => bandAtLeast(paper.band, minBand)).toSorted(byStrength);
  const offTopic = placed.filter((paper) => !bandAtLeast(paper.band, minBand)).toSorted(byStrength);

  // "Covered" is deliberately stricter than "matched": a peripheral hit is not a track record, and
  // a report that counted one would tell a funder a section is answered when it is not.
  const covered = new Set(
    matches.flatMap((paper) =>
      paper.segments.filter((seg) => bandAtLeast(seg.band, "related")).map((seg) => seg.segment_id),
    ),
  );

  return {
    query_kind: query.kind,
    segment_count: query.segments.length,
    scored: papers.length,
    matches: options.limit === undefined ? matches : matches.slice(0, options.limit),
    off_topic: offTopic,
    nothing_relevant: matches.length === 0,
    uncovered_segments: query.segments.filter((segment) => !covered.has(segment.id)),
  };
}

function placePaper(
  entry: ScoredLabPaper,
  segments: readonly RelevanceQuerySegment[],
  segmentVectors: readonly (readonly number[])[],
  noise: readonly number[],
  terms: readonly string[],
): LabPaperRelevance {
  const scored: LabSegmentScore[] = segments.map((segment, index) => {
    const score = cosineSimilarity(entry.vector, segmentVectors[index] ?? []);
    const margin = score - (noise[index] ?? 0);
    return {
      segment_id: segment.id,
      label: segment.label,
      score,
      margin,
      band: bandForMargin(margin, score),
    };
  });
  // One ordering, used for both the reported placement and the segment list, so a row's
  // "0.44 on Part 1.1.1" is a single measurement rather than two maxima taken independently.
  const ranked = scored.toSorted((left, right) => right.margin - left.margin);
  const strongest = ranked[0];
  const matched = ranked.filter((segment) => segment.band !== "off_topic");
  return {
    paper_id: entry.paper.id,
    title: entry.paper.title,
    score: strongest?.score ?? 0,
    margin: strongest?.margin ?? 0,
    band: strongest?.band ?? "off_topic",
    segments: matched,
    best_segment: matched[0],
    matched_terms: matchedTerms(entry.paper, terms),
    evidence: labPaperEvidence(entry.paper),
  };
}

/**
 * Which of the query's terms literally appear in the paper.
 *
 * Display only, exactly as in venue-relevance.ts: a row with no matched term is still a real match
 * on meaning, which is the entire reason this ranks by embedding. Reuses the service's own needle
 * matcher so "RL" does not match inside "world" and the two matchers cannot drift apart.
 */
function matchedTerms(paper: LabPaperInput, terms: readonly string[]): string[] {
  if (!terms.length) {
    return [];
  }
  const haystack = `${paper.title} ${labPaperBodyText(paper)}`;
  return terms.filter((term) => textMatchesNeedles(haystack, [term]));
}
