import {
  assertLoopbackUrl,
  completeLocally,
  type GuidebookFetch,
} from "../guidebook/local-client.js";
import { defaultAdminBotPrivacyBrokerConfig } from "./broker.js";

export type LocalChatMessage = { role: "user" | "assistant"; content: string };

export function localChatMessages(body: unknown): LocalChatMessage[] | undefined {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > 23 ||
    messages.length % 2 !== 1
  )
    return;
  let size = 0;
  for (const [index, message] of messages.entries()) {
    if (
      !message ||
      message.role !== (index % 2 ? "assistant" : "user") ||
      typeof message.content !== "string" ||
      !message.content.trim() ||
      message.content.length > 8000
    )
      return;
    size += message.content.length;
  }
  if (size > 32000) return;
  return messages.map(({ role, content }) => ({ role, content }));
}

export function createLocalChat(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: GuidebookFetch } = {},
) {
  const env = options.env ?? process.env;
  const model = env.ADMINBOT_LOCAL_MODEL?.trim() || defaultAdminBotPrivacyBrokerConfig.localModel;
  const baseUrl =
    env.ADMINBOT_LOCAL_BASE_URL?.trim() || defaultAdminBotPrivacyBrokerConfig.localBaseUrl;
  let active = false;
  return {
    model,
    async complete(messages: LocalChatMessage[], signal?: AbortSignal) {
      // ponytail: one active turn for this single-user route; per-user limits if access expands.
      if (active) throw new Error("local chat busy");
      const url = new URL(assertLoopbackUrl(baseUrl, "local chat"));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("invalid local chat endpoint");
      active = true;
      try {
        return await completeLocally({
          fetchImpl: options.fetchImpl ?? globalThis.fetch,
          baseUrl,
          model,
          apiKey: env.VLLM_API_KEY?.trim() || "vllm-local",
          messages: [
            {
              role: "system",
              content:
                "You are a local chat assistant. Answer using only this conversation. You have no tools, browsing, credentials, or access to lab records.",
            },
            ...messages,
          ],
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
            : AbortSignal.timeout(60000),
          maxTokens: 2048,
          verifyModel: true,
          purposeLabel: "local chat",
          extra: { chat_template_kwargs: { enable_thinking: false } },
        });
      } finally {
        active = false;
      }
    },
  };
}
