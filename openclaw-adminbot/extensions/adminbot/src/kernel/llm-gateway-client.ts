type LlmRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export function llmGatewayOrigin(env: NodeJS.ProcessEnv): URL {
  const base = new URL(env.LLM_GATEWAY_URL!);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  ) {
    throw new Error("LLM_GATEWAY_URL must be a loopback HTTP origin");
  }
  if (!env.LLM_GATEWAY_TOKEN?.trim()) throw new Error("LLM_GATEWAY_TOKEN is required");
  return base;
}

/** An unavailable configured gateway never falls back to an uncounted provider call. */
export function routeLlmFetch<T>(
  fetchImpl: (input: string, init?: LlmRequestInit) => Promise<T>,
  route: "local" | "public" | "remote",
  env: NodeJS.ProcessEnv = process.env,
): (input: string | URL, init?: LlmRequestInit) => Promise<T> {
  if (!env.LLM_GATEWAY_URL) return (input, init) => fetchImpl(String(input), init);
  const endpoint = new URL(`/${route}/v1/chat/completions`, llmGatewayOrigin(env)).href;
  return (_input, init) =>
    fetchImpl(endpoint, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LLM_GATEWAY_TOKEN!.trim()}`,
      },
    });
}

export async function readLlmGatewayStatus(env: NodeJS.ProcessEnv = process.env) {
  const response = await fetch(new URL("/status", llmGatewayOrigin(env)), {
    headers: { Authorization: `Bearer ${env.LLM_GATEWAY_TOKEN!.trim()}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Shared LLM gateway status unavailable");
  return response.json() as Promise<import("../contracts/resilience.js").AdminBotLlmLoadStatus>;
}
