import { llmGatewayOrigin } from "../kernel/llm-gateway-client.js";
import type { AdminBotPrivacyBrokerConfig, PrivacyBrokerFetch } from "./broker.js";

/** The broker chooses the privacy route; the gateway only counts and forwards it. */
export function createGatewayFetch(
  fetchImpl: PrivacyBrokerFetch,
  config: AdminBotPrivacyBrokerConfig,
  env: NodeJS.ProcessEnv,
): PrivacyBrokerFetch {
  const base = llmGatewayOrigin(env);
  const token = env.LLM_GATEWAY_TOKEN!.trim();
  const endpoint = (url: string) => new URL("chat/completions", `${url.replace(/\/$/u, "")}/`).href;
  const routes = new Map([
    [endpoint(config.localBaseUrl), "local"],
    [endpoint(config.remoteBaseUrl), "remote"],
    ...(config.publicBaseUrl ? ([[endpoint(config.publicBaseUrl), "public"]] as const) : []),
  ]);
  return (input, init) => {
    const route = routes.get(String(input));
    if (!route) throw new Error("LLM gateway route is not configured");
    return fetchImpl(new URL(`/${route}/v1/chat/completions`, base), {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
  };
}
