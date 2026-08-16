/**
 * Loopback-only HTTP clients for the guidebook corpus.
 *
 * Both the embedding calls and the answer synthesis must stay on this machine,
 * so every base URL is validated as loopback before a request is made. That check
 * is the guarantee: a misconfigured endpoint fails the call rather than quietly
 * shipping guidebook text to a hosted model.
 */

export type GuidebookFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertLoopbackUrl(value: string, purpose: string): string {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`guidebook ${purpose} must use a loopback URL, got ${url.hostname}`);
  }
  return url.toString();
}

async function postJson(
  fetchImpl: GuidebookFetch,
  baseUrl: string,
  route: string,
  apiKey: string | undefined,
  payload: unknown,
  purpose: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const base = assertLoopbackUrl(baseUrl, purpose);
  const response = await fetchImpl(`${base}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`guidebook ${purpose} failed: ${response.status} ${response.statusText}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`guidebook ${purpose} returned malformed JSON`);
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
    "embedding",
    params.signal,
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
}): Promise<string> {
  const parsed = (await postJson(
    params.fetchImpl,
    params.baseUrl,
    "chat/completions",
    params.apiKey,
    { model: params.model, messages: params.messages, temperature: 0.2 },
    "answer",
    params.signal,
  )) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("guidebook answer model returned no content");
  }
  return content.trim();
}
