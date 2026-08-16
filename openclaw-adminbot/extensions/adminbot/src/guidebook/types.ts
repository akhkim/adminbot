/**
 * Shared shapes for the guidebook corpus.
 *
 * The guidebook is lab-sensitive: chunk text and its vectors never leave the
 * box. Everything in this module is designed so the only thing that can cross
 * to a remote model is prose a local model wrote.
 */

export type GuidebookChunk = {
  /** Stable id, derived from the source doc and the chunk's heading path. */
  id: string;
  /** Heading trail, outermost first, used for citations and for retrieval context. */
  headings: string[];
  /** Page or section label shown to the reader when the answer cites this chunk. */
  label: string;
  text: string;
  /** Unit-length embedding of `text`, produced by the local embedding model. */
  vector: number[];
};

export type GuidebookIndex = {
  version: 1;
  /** Google Doc id the corpus was exported from. */
  documentId: string;
  documentTitle: string;
  /** Embedding model that produced every vector here; a change invalidates the index. */
  embeddingModel: string;
  syncedAt: string;
  chunks: GuidebookChunk[];
};

export type GuidebookHit = {
  chunk: GuidebookChunk;
  score: number;
};
