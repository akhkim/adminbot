// Turns text into vectors with the embedding model already running beside AdminBot.
//
// Ollama rather than the vLLM endpoint the reasoning tasks use: the embedding model is small
// enough to sit on the box permanently, and going through Ollama means paper relevance keeps
// working when the Aurora tunnel is down — which it has been. Nothing here is Ollama-specific
// beyond the two URLs, so a different provider is a different `embed`, not a different caller.
//
// `/api/embed` takes a batch and is what makes indexing a conference practical: one paper at a
// time measures ~250ms of which most is request overhead, where batches run at ~70ms per paper.

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "embeddinggemma:latest";
// Generous: a full batch of long abstracts on a loaded box is still well inside this, and the
// caller has nothing useful to do with a half-finished batch anyway.
const REQUEST_TIMEOUT_MS = 180_000;
// Chosen against the live model: 64 abstracts is a ~2s request, small enough that one failure
// costs little and large enough that per-request overhead stops mattering.
export const EMBED_BATCH_SIZE = 64;

export type Embedder = (texts: string[]) => Promise<number[][]>;

export type EmbedderOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
};

/**
 * Builds an embedder over the configured Ollama instance.
 *
 * Always returns one, unlike the OpenReview reader: there is no credential to be missing, and a
 * host that is simply not running should surface as "the embedding model is not reachable" at the
 * moment of use rather than as a silently absent feature.
 */
export function createOllamaEmbedder(options: EmbedderOptions = {}): Embedder {
  const env = options.env ?? process.env;
  const baseUrl = (env.ADMINBOT_EMBED_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const model = env.ADMINBOT_EMBED_MODEL?.trim() || DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return async (texts: string[]) => {
    if (!texts.length) {
      return [];
    }
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: batch }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(
          `could not reach the embedding model at ${baseUrl} (${model}): ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      if (!response.ok) {
        throw new Error(`the embedding model answered ${response.status} for ${model}`);
      }
      const body = (await response.json()) as { embeddings?: unknown };
      const embeddings = Array.isArray(body.embeddings) ? body.embeddings : [];
      // A short answer would silently misalign every vector with the wrong paper, which is far
      // worse than a failed index: the results would look plausible and be wrong.
      if (embeddings.length !== batch.length) {
        throw new Error(
          `the embedding model returned ${embeddings.length} vectors for ${batch.length} inputs`,
        );
      }
      for (const embedding of embeddings) {
        if (!Array.isArray(embedding) || !embedding.length) {
          throw new Error("the embedding model returned an empty vector");
        }
        vectors.push(embedding as number[]);
      }
    }
    return vectors;
  };
}
