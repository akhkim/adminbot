/**
 * Answers a question from the guidebook, entirely on this machine.
 *
 * Retrieval and synthesis both run against loopback endpoints, and only the prose
 * the local model writes is returned to the caller. Guidebook passages are never
 * part of the return value, so they cannot reach the main agent context and from
 * there a hosted model. Every failure mode returns `answered: false` rather than
 * degrading to a remote call.
 */
import { completeLocally, embedLocally, type GuidebookFetch } from "./local-client.js";
import { rankGuidebookChunks } from "./retrieve.js";
import { readGuidebookIndex, resolveGuidebookIndexPath } from "./store.js";

export type GuidebookAskConfig = {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKeyEnv: string;
  answerBaseUrl: string;
  answerModel: string;
  answerApiKeyEnv: string;
  indexPath?: string;
};

export const defaultGuidebookAskConfig: GuidebookAskConfig = {
  // Matches agents.defaults.memorySearch.remote in openclaw.json — the same local
  // Ollama that already serves this box's embeddings.
  embeddingBaseUrl: "http://127.0.0.1:11434/v1",
  embeddingModel: "embeddinggemma",
  embeddingApiKeyEnv: "OLLAMA_API_KEY",
  answerBaseUrl: "http://127.0.0.1:11434/v1",
  answerModel: "gemma4:e4b-it-qat",
  answerApiKeyEnv: "OLLAMA_API_KEY",
};

export type GuidebookAskResult = {
  answered: boolean;
  /** Prose written by the local model. Safe to hand to the main agent. */
  answer: string;
  /** Heading trails the answer drew on, so the reader can find the source. */
  sources: string[];
  /** Present when `answered` is false; explains what to fix. */
  reason?: string;
};

const SYSTEM_PROMPT = [
  "You answer questions about a research lab's internal guidebook.",
  "Use only the excerpts provided. If they do not cover the question, say so plainly instead of guessing.",
  "Quote specific figures, deadlines and form names exactly as written.",
  "Write the answer as prose for a colleague. Do not mention that you were given excerpts.",
].join(" ");

function readApiKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

export async function askGuidebook(
  params: { question: string; maxResults?: number },
  options: {
    config?: GuidebookAskConfig;
    fetchImpl?: GuidebookFetch;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
): Promise<GuidebookAskResult> {
  const config = options.config ?? defaultGuidebookAskConfig;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as GuidebookFetch);
  const question = params.question.trim();
  if (!question) {
    return { answered: false, answer: "", sources: [], reason: "no question was provided" };
  }

  const indexPath = resolveGuidebookIndexPath(config.indexPath);
  const index = await readGuidebookIndex(indexPath).catch((error: unknown) => {
    throw new Error(
      `guidebook index unreadable at ${indexPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (!index || index.chunks.length === 0) {
    return {
      answered: false,
      answer: "",
      sources: [],
      reason: `no guidebook index at ${indexPath}; run scripts/adminbot-guidebook-sync.ts`,
    };
  }
  if (index.embeddingModel !== config.embeddingModel) {
    // Comparing vectors from two different embedding models produces confident
    // nonsense, which is worse than refusing.
    return {
      answered: false,
      answer: "",
      sources: [],
      reason: `guidebook index was built with ${index.embeddingModel} but this host embeds with ${config.embeddingModel}; re-sync it`,
    };
  }

  const [queryVector] = await embedLocally({
    fetchImpl,
    baseUrl: config.embeddingBaseUrl,
    model: config.embeddingModel,
    apiKey: readApiKey(env, config.embeddingApiKeyEnv),
    inputs: [question],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!queryVector) {
    return { answered: false, answer: "", sources: [], reason: "local embedding returned nothing" };
  }

  const hits = rankGuidebookChunks({
    chunks: index.chunks,
    queryVector,
    ...(params.maxResults === undefined ? {} : { maxResults: params.maxResults }),
  });
  if (hits.length === 0) {
    return {
      answered: false,
      answer: "",
      sources: [],
      reason: "the guidebook has nothing close enough to this question",
    };
  }

  const excerpts = hits
    .map((hit, position) => `[${position + 1}] ${hit.chunk.label}\n${hit.chunk.text}`)
    .join("\n\n---\n\n");
  const answer = await completeLocally({
    fetchImpl,
    baseUrl: config.answerBaseUrl,
    model: config.answerModel,
    apiKey: readApiKey(env, config.answerApiKeyEnv),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Question: ${question}\n\nGuidebook excerpts:\n\n${excerpts}` },
    ],
    ...(options.signal ? { signal: options.signal } : {}),
  });

  return { answered: true, answer, sources: hits.map((hit) => hit.chunk.label) };
}
