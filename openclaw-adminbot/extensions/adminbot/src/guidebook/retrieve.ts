/** Ranks guidebook chunks against a query vector. Pure, local, no I/O. */
import type { GuidebookChunk, GuidebookHit } from "./types.js";

/** Vectors are stored unit-length, so a dot product is the cosine similarity. */
function similarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    return 0;
  }
  let total = 0;
  for (const [index, value] of left.entries()) {
    total += value * (right[index] ?? 0);
  }
  return total;
}

export function rankGuidebookChunks(params: {
  chunks: GuidebookChunk[];
  queryVector: number[];
  maxResults?: number;
  /** Hits below this score are dropped rather than padded in — a weak match is
   *  worse than no match, because it invites the model to answer from it anyway. */
  minScore?: number;
}): GuidebookHit[] {
  const minScore = params.minScore ?? 0.35;
  return params.chunks
    .map((chunk) => ({ chunk, score: similarity(chunk.vector, params.queryVector) }))
    .filter((hit) => hit.score >= minScore)
    .toSorted((left, right) => right.score - left.score)
    .slice(0, Math.max(1, params.maxResults ?? 6));
}
