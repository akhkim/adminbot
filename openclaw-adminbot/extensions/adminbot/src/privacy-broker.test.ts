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
    message: { content: typeof content === "string" ? content : JSON.stringify(content) },
  });
}

const config = { ...defaultAdminBotPrivacyBrokerConfig };

describe("AdminBot privacy broker", () => {
  it("classifies locally before sending a generic task to MiniMax", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      calls.push({ url: String(input), body });
      return calls.length === 1
        ? local({
            classification: "generic",
            sanitized_task: "Explain merge sort",
            replacements: {},
          })
        : response({ choices: [{ message: { content: "Remote answer" } }] });
    }) as PrivacyBrokerFetch;
    const broker = createAdminBotPrivacyBroker(config, {
      fetchImpl,
      env: { NVIDIA_API_KEY: "test-key" },
    });

    await expect(broker.handle({ task: "Explain merge sort" })).resolves.toEqual({
      route: "remote",
      output: "Remote answer",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:11434/api/chat",
      "https://integrate.api.nvidia.com/v1/chat/completions",
    ]);
    expect(calls[0]?.body.model).toBe("gemma4:e4b-it-qat");
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
          replacements: { "<<PRIVATE_1>>": "pat@example.com" },
        });
      }
      return local("Email pat@example.com");
    }) as PrivacyBrokerFetch;
    const broker = createAdminBotPrivacyBroker(config, {
      fetchImpl,
      env: { NVIDIA_API_KEY: "test-key" },
    });

    await expect(
      broker.handle({ task: "Draft an email to pat@example.com", privacy: "private" }),
    ).resolves.toEqual({ route: "hybrid", output: "Email pat@example.com" });
    expect(remoteBodies).toHaveLength(1);
    expect(remoteBodies[0]).toContain("<<PRIVATE_1>>");
    expect(remoteBodies[0]).not.toContain("pat@example.com");
  });

  it("falls back locally when sanitization still contains a sensitive value", async () => {
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
    const broker = createAdminBotPrivacyBroker(config, {
      fetchImpl,
      env: { NVIDIA_API_KEY: "test-key" },
    });

    await expect(broker.handle({ task: "Email pat@example.com" })).resolves.toEqual({
      route: "local",
      output: "Local answer",
    });
    expect(urls).toEqual(["http://127.0.0.1:11434/api/chat", "http://127.0.0.1:11434/api/chat"]);
  });

  it("pulls the missing local model and retries once", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let chatCall = 0;
    const fetchImpl = vi.fn(async (input, init) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      const url = String(input);
      calls.push({ url, body });
      if (url.endsWith("/api/chat")) {
        chatCall += 1;
        if (chatCall === 1) {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            async text() {
              return JSON.stringify({ error: "model 'gemma4:e4b-it-qat' not found" });
            },
          };
        }
        if (chatCall === 2) {
          return local({
            classification: "generic",
            sanitized_task: "Explain merge sort",
            replacements: {},
          });
        }
        return local("Explain merge sort");
      }
      if (url.endsWith("/api/pull")) {
        return response({ status: "success" });
      }
      throw new Error(`unexpected url ${url}`);
    }) as PrivacyBrokerFetch;
    const broker = createAdminBotPrivacyBroker(config, { fetchImpl });

    await expect(broker.handle({ task: "Explain merge sort" })).resolves.toEqual({
      route: "local",
      output: "Explain merge sort",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:11434/api/chat",
      "http://127.0.0.1:11434/api/pull",
      "http://127.0.0.1:11434/api/chat",
      "http://127.0.0.1:11434/api/chat",
    ]);
    expect(calls[1]?.body).toEqual({ model: "gemma4:e4b-it-qat", stream: false });
  });
});


