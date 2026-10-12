import { describe, expect, it } from "vitest";
import { createLlmLoadRouter } from "../kernel/llm-router.js";
import { createGatewayFetch } from "./broker.gateway.js";
import { createAdminBotPrivacyBroker, defaultAdminBotPrivacyBrokerConfig } from "./broker.js";

const answer = (content: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () =>
    JSON.stringify({
      choices: [
        { message: { content: typeof content === "string" ? content : JSON.stringify(content) } },
      ],
    }),
});
const env = {
  LLM_GATEWAY_URL: "http://127.0.0.1:8766",
  LLM_GATEWAY_TOKEN: "synthetic",
  OPENROUTER_API_KEY: "synthetic-provider",
};

describe("broker gateway integration", () => {
  it("classifies locally then routes public work through the shared gateway", async () => {
    const calls: string[] = [];
    const broker = createAdminBotPrivacyBroker(defaultAdminBotPrivacyBrokerConfig, {
      env,
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        expect(init?.headers?.Authorization).toBe("Bearer synthetic");
        return calls.length === 1
          ? answer({
              classification: "generic",
              sanitized_task: "Explain sorting",
              replacements: [],
            })
          : answer("Sorted");
      },
    });
    expect(await broker.handle({ task: "Explain sorting" })).toMatchObject({ output: "Sorted" });
    expect(calls).toEqual([
      "http://127.0.0.1:8766/local/v1/chat/completions",
      "http://127.0.0.1:8766/public/v1/chat/completions",
    ]);
  });

  it("fails closed for unsafe gateway configuration and unknown destinations", async () => {
    const mock = async () => answer("unused");
    expect(() =>
      createGatewayFetch(mock, defaultAdminBotPrivacyBrokerConfig, {
        ...env,
        LLM_GATEWAY_URL: "https://example.invalid",
      }),
    ).toThrow("loopback");
    expect(() =>
      createGatewayFetch(mock, defaultAdminBotPrivacyBrokerConfig, {
        ...env,
        LLM_GATEWAY_TOKEN: "",
      }),
    ).toThrow("required");
    expect(() =>
      createGatewayFetch(mock, defaultAdminBotPrivacyBrokerConfig, env)("https://unknown.invalid"),
    ).toThrow("not configured");
  });

  it("holds a direct broker slot while the body is still generating", async () => {
    const router = createLlmLoadRouter({ maxLocal: 1 });
    let complete!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const broker = createAdminBotPrivacyBroker(defaultAdminBotPrivacyBrokerConfig, {
      env: {},
      llmRouter: router,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => {
          if (calls++ === 0) {
            entered();
            await new Promise<void>((resolve) => {
              complete = resolve;
            });
          }
          return JSON.stringify({ choices: [{ message: { content: "answer" } }] });
        },
      }),
    });
    const pending = broker.handle({ task: "Hello" });
    await started;
    expect(router.status().local_active).toBe(1);
    complete();
    // An invalid classifier response fails closed; the capacity must still be released.
    await pending.catch(() => undefined);
    expect(router.status().local_active).toBe(0);
  });
});
