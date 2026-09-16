import { createHash } from "node:crypto";
/**
 * Answers a question from the guidebook, entirely on this machine.
 *
 * Retrieval and synthesis run against loopback endpoints. The answer can quote
 * source text, so callers must enforce the audience before returning it. Local
 * generation is not sanitization and does not authorize forwarding to hosted models.
 */
import type { InferenceGate } from "../inference/gate.js";
import { taskStep } from "../tasks/context.js";
import { completeLocally, embedLocally, type GuidebookFetch } from "./local-client.js";
import { rankGuidebookChunks } from "./retrieve.js";
import { readGuidebookIndex, resolveGuidebookIndexPath } from "./store.js";
import type { GuidebookIndex } from "./types.js";

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
  // Synthesis runs on the vLLM Qwen the privacy broker also uses. Embeddings stay
  // on Ollama because vLLM does not serve embeddinggemma; both are loopback, so
  // the isolation guarantee is unchanged by the split.
  answerBaseUrl: "http://127.0.0.1:8000/v1",
  answerModel: "nvidia/Qwen3.5-122B-A10B-NVFP4",
  answerApiKeyEnv: "VLLM_API_KEY",
};

export type GuidebookAskResult = {
  answered: boolean;
  /** Prose written by the local model; may contain verbatim source text. */
  answer: string;
  /** Heading trails the answer drew on, so the reader can find the source. */
  sources: string[];
  /** Present when `answered` is false; explains what to fix. */
  reason?: string;
};

// The guidebook is the authority, not this model: a paraphrase invents wording the lab never
// approved and gives the reader nothing to check it against. So the answer either reproduces the
// guidebook's own text verbatim or names the section to go read — never a summary of either.
const SYSTEM_PROMPT = [
  "You answer questions about a research lab's internal guidebook.",
  "Use only the excerpts provided. If they do not cover the question, say so plainly instead of guessing.",
  "Do not summarize, paraphrase or rewrite the guidebook.",
  "Either copy the relevant passage across word for word, or tell the reader which section to check — and prefer copying it when the passage is short enough to paste.",
  "When you copy a passage, reproduce it exactly, including figures, deadlines and form names.",
  "Name the section heading you are drawing on so the reader can find it in the guidebook itself.",
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
    /** Model time once admitted. A caller wanting a shorter budget sends this, never a signal. */
    timeoutMs?: number;
    gate?: InferenceGate;
    /** A caller-specific audience gate, evaluated before retrieval or model calls. */
    allowIndex?: (index: GuidebookIndex) => boolean;
  } = {},
): Promise<GuidebookAskResult> {
  const config = options.config ?? defaultGuidebookAskConfig;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as GuidebookFetch);
  const question = params.question.trim();
  if (!question) {
    return {
      answered: false,
      answer: "",
      sources: [],
      reason: "no question was provided",
    };
  }

  const indexPath = resolveGuidebookIndexPath(config.indexPath);
  const prepared = await taskStep<
    { failure: GuidebookAskResult } | { excerpts: string; sources: string[] }
  >(
    "guidebook.context",
    { indexPath, question, maxResults: params.maxResults },
    async () => {
      const unavailable = (reason: string) => ({
        failure: { answered: false, answer: "", sources: [], reason },
      });
      const index = await readGuidebookIndex(indexPath).catch((error: unknown) => {
        throw new Error(
          `guidebook index unreadable at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!index || index.chunks.length === 0) {
        return unavailable(
          `no guidebook index at ${indexPath}; run scripts/adminbot-guidebook-sync.ts`,
        );
      }
      if (options.allowIndex && !options.allowIndex(index)) {
        return unavailable("Guidebook content is not approved for this audience.");
      }
      if (index.embeddingModel !== config.embeddingModel) {
        return unavailable(
          `guidebook index was built with ${index.embeddingModel} but this host embeds with ${config.embeddingModel}; re-sync it`,
        );
      }
      const hash = createHash("sha256").update(JSON.stringify(index)).digest("hex");
      const originalHash = await taskStep("guidebook.index-version", { indexPath }, () => hash, {
        replaySafe: true,
      });
      if (originalHash !== hash) {
        throw new Error(
          "Guidebook changed before context selection finished; submit a new question.",
        );
      }
      const [queryVector] = await embedLocally({
        fetchImpl,
        baseUrl: config.embeddingBaseUrl,
        model: config.embeddingModel,
        apiKey: readApiKey(env, config.embeddingApiKeyEnv),
        gate: {
          gate: options.gate,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          caller: "guidebook.embed",
          apiKeyEnv: config.embeddingApiKeyEnv,
        },
        inputs: [question],
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!queryVector) {
        return unavailable("local embedding returned nothing");
      }
      const hits = rankGuidebookChunks({
        chunks: index.chunks,
        queryVector,
        ...(params.maxResults === undefined ? {} : { maxResults: params.maxResults }),
      });
      if (hits.length === 0) {
        return unavailable("the guidebook has nothing close enough to this question");
      }
      // Retain the chosen excerpts, not another full copy of the embedding index for each question.
      return {
        excerpts: hits
          .map((hit, position) => `[${position + 1}] ${hit.chunk.label}\n${hit.chunk.text}`)
          .join("\n\n---\n\n"),
        sources: hits.map((hit) => hit.chunk.label),
      };
    },
    { replaySafe: true },
  );
  if ("failure" in prepared) {
    return prepared.failure;
  }
  const { excerpts, sources } = prepared;
  const answer = await completeLocally({
    fetchImpl,
    baseUrl: config.answerBaseUrl,
    model: config.answerModel,
    apiKey: readApiKey(env, config.answerApiKeyEnv),
    gate: {
      gate: options.gate,
      caller: "guidebook.answer",
      apiKeyEnv: config.answerApiKeyEnv,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Question: ${question}\n\nGuidebook excerpts:\n\n${excerpts}`,
      },
    ],
    ...(options.signal ? { signal: options.signal } : {}),
  });

  return {
    answered: true,
    answer,
    sources,
  };
}
