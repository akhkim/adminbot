import { afterEach, describe, expect, it } from "vitest";
import { createLlmGateway } from "./llm-gateway.js";
import { createLlmLoadRouter } from "./llm-router.js";

const gateways: ReturnType<typeof createLlmGateway>[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});
const headers = { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" };
function setup(fetchImpl: typeof fetch) {
  const gateway = createLlmGateway({
    token: "synthetic-token",
    local: { baseUrl: "http://127.0.0.1:8000/v1" },
    public: { baseUrl: "https://example.invalid/v1" },
    router: createLlmLoadRouter({ maxLocal: 1, maxPublic: 1 }),
    fetchImpl,
  });
  gateways.push(gateway);
  return gateway;
}

describe("shared LLM gateway", () => {
  it("shares capacity across HTTP clients and holds slots until the body finishes", async () => {
    let complete!: () => void;
    let calls = 0;
    const gateway = setup(async () => {
      calls++;
      if (calls === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
              complete = () => controller.close();
            },
          }),
        );
      return new Response("second");
    });
    const base = await gateway.listen(0);
    const first = await fetch(`${base}/public/v1/chat/completions`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const firstBody = first.text();
    const second = fetch(`${base}/public/v1/chat/completions`, {
      method: "POST",
      headers,
      body: "{}",
    });
    await expect.poll(() => gateway.router.status().queued).toBe(1);
    expect(calls).toBe(1);
    complete();
    expect(await firstBody).toBe("first");
    expect(await (await second).text()).toBe("second");
    await expect.poll(() => gateway.router.status().public_active).toBe(0);
  });

  it("cancels queued clients without forwarding and resumes after local release", async () => {
    let calls = 0;
    const gateway = setup(async () => {
      calls++;
      return new Response("ok");
    });
    const base = await gateway.listen(0);
    const local = await gateway.router.acquire("local");
    const controller = new AbortController();
    const cancelled = fetch(`${base}/public/v1/chat/completions`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal,
    });
    const rejected = expect(cancelled).rejects.toThrow();
    await expect.poll(() => gateway.router.status().queued).toBe(1);
    controller.abort();
    await rejected;
    await expect.poll(() => gateway.router.status().queued).toBe(0);
    expect(calls).toBe(0);
    local.release();
    expect(
      await (
        await fetch(`${base}/public/v1/chat/completions`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).text(),
    ).toBe("ok");
  });

  it("fails closed on auth, browser origins, unknown routes and upstream errors", async () => {
    const gateway = setup(async () => {
      throw new Error("synthetic failure");
    });
    const base = await gateway.listen(0);
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/status`, {
          headers: { ...headers, Origin: "https://example.invalid" },
        })
      ).status,
    ).toBe(401);
    expect((await fetch(`${base}/unknown`, { headers })).status).toBe(404);
    expect(
      (await fetch(`${base}/public/v1/chat/completions`, { method: "POST", headers, body: "{}" }))
        .status,
    ).toBe(502);
    expect(gateway.router.status().public_active).toBe(0);
  });
  it("dispatches across loopback GPU tunnels and rejects nonlocal private targets", async () => {
    const urls: string[] = [];
    const gateway = createLlmGateway({
      token: "synthetic-token",
      local: { baseUrl: "http://127.0.0.1:8000/v1" },
      public: { baseUrl: "https://example.invalid/v1" },
      router: createLlmLoadRouter({
        nodes: [
          { id: "maple", baseUrl: "http://127.0.0.1:8001/v1", gpu: "RTX6000" },
          { id: "conserto3", baseUrl: "http://example.invalid/v1", gpu: "H100" },
        ],
      }),
      fetchImpl: async (input, init) => {
        expect(init?.redirect).toBe("error");
        urls.push(String(input));
        return new Response("ok");
      },
    });
    gateways.push(gateway);
    const base = await gateway.listen(0);
    const call = () =>
      fetch(`${base}/local/v1/chat/completions`, { method: "POST", headers, body: "{}" });
    expect(await (await call()).text()).toBe("ok");
    expect((await call()).status).toBe(502);
    expect(urls).toEqual(["http://127.0.0.1:8001/v1/chat/completions"]);
    expect(gateway.router.status().local_active).toBe(0);
  });
  it("accepts receipt-sized bodies larger than two MiB", async () => {
    const body = JSON.stringify({ image: "a".repeat(3 * 1024 * 1024) });
    const gateway = setup(async (_input, init) => {
      expect(Buffer.byteLength(init?.body as Buffer)).toBe(Buffer.byteLength(body));
      return new Response("ok");
    });
    const base = await gateway.listen(0);
    expect(
      await (
        await fetch(`${base}/local/v1/chat/completions`, {
          method: "POST",
          headers,
          body,
        })
      ).text(),
    ).toBe("ok");
  });
});
