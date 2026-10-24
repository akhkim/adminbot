// Running the lab-paper classifier against the live embedding model.
//
// The impure half of lab-relevance.ts, split the same way venue-index.ts is split from
// venue-relevance.ts: everything here either talks to the model or arranges what is sent to it,
// and nothing here decides what a score means.
//
// Unlike a venue, this corpus is not indexed ahead of time. A conference is thousands of papers
// that change when decisions are released, so it earns a stored index; the lab's own papers are
// ~100 rows whose text changes whenever somebody edits a record, and embedding all of them is one
// batched request. Re-embedding per search is therefore both simpler and more correct than a cache
// that would have to be invalidated on every paper edit. `vectorFor` is the escape hatch for a
// caller that does keep them -- a nightly grant report placing the same corpus on two taxonomies
// should not pay for it twice.

import type { Embedder } from "../../connectors/embeddings.js";
import {
  classifyLabPapers,
  controlDocumentTexts,
  labPaperEmbeddingText,
  parseRelevanceQuery,
  type LabPaperInput,
  type LabRelevanceOptions,
  type LabRelevanceReport,
  type RelevanceQuery,
} from "./lab-relevance.js";
import { interestsEmbeddingText } from "./venue-relevance.js";

export type FindRelevantLabPapersParams = {
  papers: readonly LabPaperInput[];
  /** Free text -- a keyword, a list of them, or a whole proposal -- or an already-built query. */
  query: string | RelevanceQuery;
  embed: Embedder;
  options?: LabRelevanceOptions;
  /**
   * A vector the caller already holds for a paper, by id.
   *
   * Only safe when it was produced by the same model from the same `labPaperEmbeddingText`; a
   * vector from another model scores as noise rather than failing, so a caller that caches these
   * has to store the model alongside them and drop the cache when it changes. Papers with no entry
   * here are embedded normally, so a partial cache is fine.
   */
  vectorFor?: (paper: LabPaperInput) => readonly number[] | undefined;
};

/**
 * Scores every paper given against the query, best first.
 *
 * One `embed` call for the whole run -- papers, then query segments, then the controls -- because
 * the connector batches internally and three calls would pay the per-request overhead three times
 * for no benefit. The order is positional and the slices below depend on it, which is why they are
 * cut by counted length rather than by searching for anything.
 *
 * A query with no segments (an empty string) returns an empty report rather than throwing: "you
 * have not said what to look for" is the caller's error message to write, and it has more context
 * for writing it than this does.
 */
export async function findRelevantLabPapers(
  params: FindRelevantLabPapersParams,
): Promise<LabRelevanceReport> {
  const query = typeof params.query === "string" ? parseRelevanceQuery(params.query) : params.query;
  const papers = [...params.papers];
  if (!query.segments.length || !papers.length) {
    // Hand the papers through unscored rather than dropping them, so the report's `scored` still
    // says how big the corpus was. A caller showing "0 of 104" and one showing "0 of 0" are
    // telling the reader different things, and only one of them is true.
    return classifyLabPapers({
      papers: papers.map((paper) => ({ paper, vector: [] })),
      query,
      segmentVectors: [],
      options: params.options,
    });
  }

  const cached = papers.map((paper) => params.vectorFor?.(paper));
  const toEmbed = papers.filter((_, index) => cached[index] === undefined);
  const segmentTexts = query.segments.map((segment) => interestsEmbeddingText(segment.text));
  const controlTexts = controlDocumentTexts();

  const vectors = await params.embed([
    ...toEmbed.map((paper) => labPaperEmbeddingText(paper)),
    ...segmentTexts,
    ...controlTexts,
  ]);

  // The connector already refuses a short answer, so this can only fire if a different `Embedder`
  // is passed in. Checked anyway: a miscounted batch misaligns every vector with the wrong paper,
  // and the results would look entirely plausible.
  const expected = toEmbed.length + segmentTexts.length + controlTexts.length;
  if (vectors.length !== expected) {
    throw new Error(`the embedder returned ${vectors.length} vectors for ${expected} inputs`);
  }

  const embeddedPapers = vectors.slice(0, toEmbed.length);
  const segmentVectors = vectors.slice(toEmbed.length, toEmbed.length + segmentTexts.length);
  const controlVectors = vectors.slice(toEmbed.length + segmentTexts.length);

  let next = 0;
  const scored = papers.map((paper, index) => ({
    paper,
    vector: cached[index] ?? embeddedPapers[next++] ?? [],
  }));

  return classifyLabPapers({
    papers: scored,
    query,
    segmentVectors,
    controlVectors,
    options: params.options,
  });
}
