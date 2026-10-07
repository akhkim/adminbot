import { describe, expect, it, vi } from "vitest";
import { routeLlmFetch } from "./llm-gateway-client.js";

const env = { LLM_GATEWAY_URL: "http://127.0.0.1:8766", LLM_GATEWAY_TOKEN: "synthetic" };
describe("gateway completion clients", () => {
  it.each(["local", "public", "remote"] as const)(
    "routes %s without leaking provider credentials",
    async (route) => {
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const signal = new AbortController().signal;
      await routeLlmFetch(
        fetchImpl,
        route,
        env,
      )("https://example.invalid/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-provider-key" },
        body: "{}",
        signal,
      });
      expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:8766/${route}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json" },
        body: "{}",
        signal,
      });
    },
  );
  it("does not fall back when the gateway fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      routeLlmFetch(fetchImpl, "public", env)("https://example.invalid"),
    ).rejects.toThrow("offline");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
