import { describe, expect, it, vi } from "vitest";
import {
  createAdminBotPrivacyBroker,
  defaultAdminBotPrivacyBrokerConfig,
  type PrivacyBrokerFetch,
} from "./privacy-broker.js";

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async text() {
      return JSON.stringify(body);
    },
  };
}

function local(content: unknown) {
  return response({
    choices: [
      { message: { content: typeof content === "string" ? content : JSON.stringify(content) } },
    ],
  });
}

const config = { ...defaultAdminBotPrivacyBrokerConfig };
const env = { NVIDIA_API_KEY: "remote-key", VLLM_API_KEY: "local-key" };

describe("AdminBot privacy broker", () => {
  it("classifies with local Qwen before sending a generic task to MiniMax", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      calls.push({ url: String(input), body, auth: init?.headers?.Authorization });
      return calls.length === 1
        ? local({
            classification: "generic",
            sanitized_task: "Explain merge sort",
            replacements: [],
          })
        : response({ choices: [{ message: { content: "Remote answer" } }] });
    }) as PrivacyBrokerFetch;
    const broker = createAdminBotPrivacyBroker(config, { fetchImpl, env });

    await expect(broker.handle({ task: "Explain merge sort" })).resolves.toEqual({
      route: "remote",
      output: "Remote answer",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8000/v1/chat/completions",
      "https://integrate.api.nvidia.com/v1/chat/completions",
    ]);
    expect(calls[0]).toMatchObject({
      auth: "Bearer local-key",
      body: {
        model: "RedHatAI/Qwen3-Next-80B-A3B-Instruct-NVFP4",
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_schema" },
      },
    });
  });

  it("sends placeholders only to MiniMax and finalizes private output locally", async () => {
    const remoteBodies: string[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (input, init) => {
      call += 1;
      if (String(input).includes("integrate.api.nvidia.com")) {
        remoteBodies.push(init?.body ?? "");
        return response({ choices: [{ message: { content: "Email <<PRIVATE_1>>" } }] });
      }
      if (call === 1) {
        return local({
          classification: "private",
          sanitized_task: "Draft an email to <<PRIVATE_1>>",
          replacements: [{ placeholder: "<<PRIVATE_1>>", value: "pat@example.com" }],
        });
      }
      return local("Email pat@example.com");
    }) as PrivacyBrokerFetch;
    const broker = createAdminBotPrivacyBroker(config, { fetchImpl, env });

    await expect(
      broker.handle({ task: "Draft an email to pat@example.com", privacy: "private" }),
    ).resolves.toEqual({ route: "hybrid", output: "Email pat@example.com" });
    expect(remoteBodies).toHaveLength(1);
    expect(remoteBodies[0]).toContain("<<PRIVATE_1>>");
    expect(remoteBodies[0]).not.toContain("pat@example.com");
  });

  it("stays local when sanitization still contains a sensitive value", async () => {
    const urls: string[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (input) => {
      call += 1;
      urls.push(String(input));
      return call === 1
        ? local({
            classification: "private",
            sanitized_task: "Email pat@example.com at <<PRIVATE_1>>",
            replacements: [{ placeholder: "<<PRIVATE_1>>", value: "pat@example.com" }],
          })
        : local("Local answer");
    }) as PrivacyBrokerFetch;
    const broker = createAdminBotPrivacyBroker(config, { fetchImpl, env });

    await expect(broker.handle({ task: "Email pat@example.com" })).resolves.toEqual({
      route: "local",
      output: "Local answer",
    });
    expect(urls).toEqual([
      "http://127.0.0.1:8000/v1/chat/completions",
      "http://127.0.0.1:8000/v1/chat/completions",
    ]);
  });

  it("rejects a non-loopback privacy model endpoint", async () => {
    const fetchImpl = vi.fn() as PrivacyBrokerFetch;
    const broker = createAdminBotPrivacyBroker(
      { ...config, localBaseUrl: "https://example.com/v1" },
      { fetchImpl, env },
    );

    await expect(broker.handle({ task: "private", privacy: "private" })).rejects.toThrow(
      "local privacy model must use a loopback URL",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
