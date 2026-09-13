/**
 * Loopback-only HTTP clients for the guidebook corpus.
 *
 * Both the embedding calls and the answer synthesis must stay on this machine,
 * so every base URL is validated as loopback before a request is made. That check
 * is the guarantee: a misconfigured endpoint fails the call rather than quietly
 * shipping guidebook text to a hosted model.
 *
 * Every call also passes through the shared inference gate (inference/gate.ts), which is the one
 * count of requests in flight to the GPU. The gate is a parameter with a process-wide default rather
 * than a hidden global so a test can hand a call its own, but there is deliberately no way to opt a
 * call *out*: a caller that bypassed the counter would be the third pool of two that reproduced the
 * recorded incident.
 */
import {
  assertLoopbackUrl,
  runGated,
  sharedInferenceGate,
  type InferenceFetch,
  type InferenceGate,
} from "../inference/gate.js";

export { assertLoopbackUrl };

export type GuidebookFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: "error";
  },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

/**
 * How a call presents itself to the gate.
 *
 * `owner` and `caller` are what the audit row and the member-facing status carry; `wait` is the
 * caller's answer to "no slot right now" (unattended jobs say yes, interactive ones let the member
 * choose); `timeoutMs` is the model's budget once admitted, and is the one thing a caller must send
 * as a number rather than as an AbortSignal, or the clock starts before the slot is taken.
 */
export type LocalCallGateOptions = {
  gate?: InferenceGate;
  owner?: string;
  caller?: string;
  wait?: boolean;
  timeoutMs?: number;
  submissionKey?: string;
  /**
   * The environment variable the bearer token came from. Stored on the row (the name, never the
   * value) so a request re-dispatched after a shed-then-wait or a restart -- when the in-memory key
   * is gone -- still authenticates. Without it, those re-dispatches went out with no Authorization
   * header at all.
   */
  apiKeyEnv?: string;
};

async function postJson(
  fetchImpl: GuidebookFetch,
  baseUrl: string,
  route: "chat/completions" | "embeddings",
  apiKey: string | undefined,
  payload: unknown,
  purpose: string,
  signal?: AbortSignal,
  gateOptions: LocalCallGateOptions = {},
): Promise<unknown> {
  const base = assertLoopbackUrl(baseUrl, purpose);
  const endpoint = `${base}${route}`;
  // The gate has already read the body -- it has to, to release the slot only once the response is
  // fully consumed -- so what comes back is a record, not a stream.
  let response: { ok: boolean; status: number; statusText: string; text: string };
  try {
    // The bearer token travels beside the request, not inside it: the gate stores the request body
    // durably and rebuilds the Authorization header at dispatch, so a queue row on disk carries no
    // credential and a row re-admitted after a restart authenticates with what the process has then.
    response = await runGated(gateOptions.gate ?? sharedInferenceGate(), {
      owner: gateOptions.owner ?? "system:local-client",
      caller: gateOptions.caller ?? purpose,
      request: {
        route,
        baseUrl: base,
        body: payload as Record<string, unknown>,
        purpose,
        ...(gateOptions.apiKeyEnv ? { apiKeyEnv: gateOptions.apiKeyEnv } : {}),
      },
      ...(apiKey ? { apiKey } : {}),
      ...(gateOptions.wait !== undefined ? { wait: gateOptions.wait } : {}),
      ...(gateOptions.timeoutMs !== undefined ? { timeoutMs: gateOptions.timeoutMs } : {}),
      ...(gateOptions.submissionKey ? { submissionKey: gateOptions.submissionKey } : {}),
      ...(signal ? { signal } : {}),
      fetchImpl: fetchImpl as unknown as InferenceFetch,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "InferenceDeferredError") {
      // A queue decision, not an outage. The wording below would send the operator to check the
      // model server for a request that was deliberately not sent to it.
      throw error;
    }
    // Node reports a refused connection as a bare "fetch failed", which says
    // nothing about which of the two local services is down.
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${purpose} could not reach ${endpoint} (${detail}). Is the local model serving there?`,
    );
  }
  const raw = response.text;
  if (!response.ok) {
    throw new Error(`${purpose} failed: ${response.status} ${response.statusText}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${purpose} returned malformed JSON`);
  }
}

function toUnitVector(values: number[]): number[] {
  let sum = 0;
  for (const value of values) {
    sum += value * value;
  }
  const magnitude = Math.sqrt(sum);
  // Storing unit vectors turns retrieval into a dot product and keeps scores
  // comparable across re-syncs.
  return magnitude > 0 ? values.map((value) => value / magnitude) : values;
}

/** Embeds one or more strings with the local embedding server. */
export async function embedLocally(params: {
  fetchImpl: GuidebookFetch;
  baseUrl: string;
  model: string;
  apiKey?: string;
  inputs: string[];
  signal?: AbortSignal;
  /** Which member and code path this is for, and how it should meet a busy GPU. See the gate. */
  gate?: LocalCallGateOptions;
}): Promise<number[][]> {
  if (params.inputs.length === 0) {
    return [];
  }
  const parsed = (await postJson(
    params.fetchImpl,
    params.baseUrl,
    "embeddings",
    params.apiKey,
    { model: params.model, input: params.inputs },
    "guidebook embedding",
    params.signal,
    params.gate,
  )) as { data?: Array<{ embedding?: unknown }> };
  const rows = parsed.data ?? [];
  if (rows.length !== params.inputs.length) {
    throw new Error(
      `guidebook embedding returned ${rows.length} vectors for ${params.inputs.length} inputs`,
    );
  }
  return rows.map((row) => {
    if (!Array.isArray(row.embedding) || row.embedding.some((v) => typeof v !== "number")) {
      throw new Error("guidebook embedding returned a non-numeric vector");
    }
    return toUnitVector(row.embedding as number[]);
  });
}

/** Runs one chat completion against the local model and returns its text. */
export async function completeLocally(params: {
  fetchImpl: GuidebookFetch;
  baseUrl: string;
  model: string;
  apiKey?: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  signal?: AbortSignal;
  /** Opens every error this call can raise. Defaults to the guidebook, which was the first caller. */
  purposeLabel?: string;
  /** Sampling temperature. Left at the guidebook's 0.2 unless a caller needs otherwise. */
  temperature?: number;
  /** Output ceiling. Unset leaves it to the server, which for a reasoning model means "a lot". */
  maxTokens?: number;
  /**
   * Further request fields, spread over the payload last.
   *
   * vLLM takes `chat_template_kwargs: { enable_thinking: false }` and a `response_format` JSON
   * schema, and every caller that wants a short, parseable answer out of Qwen sends both. They are
   * passed through rather than modelled here because they are vLLM's vocabulary, not OpenAI's,
   * and the next server may spell them differently.
   */
  extra?: Record<string, unknown>;
  /** Which member and code path this is for, and how it should meet a busy GPU. See the gate. */
  gate?: LocalCallGateOptions;
}): Promise<string> {
  const parsed = (await postJson(
    params.fetchImpl,
    params.baseUrl,
    "chat/completions",
    params.apiKey,
    {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.2,
      ...(params.maxTokens === undefined ? {} : { max_tokens: params.maxTokens }),
      ...params.extra,
    },
    params.purposeLabel ?? "guidebook answer",
    params.signal,
    { caller: params.purposeLabel ?? "guidebook answer", ...params.gate },
  )) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`${params.purposeLabel ?? "guidebook answer"} model returned no content`);
  }
  return content.trim();
}
