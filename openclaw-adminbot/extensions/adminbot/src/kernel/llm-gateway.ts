import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLlmLoadRouter, type LlmLoadRouter } from "./llm-router.js";

export type LlmGatewayTarget = { baseUrl: string; apiKey?: string };
export type LlmGatewayOptions = {
  token: string;
  public: LlmGatewayTarget;
  remote?: LlmGatewayTarget;
  local: LlmGatewayTarget;
  router?: LlmLoadRouter;
  fetchImpl?: typeof fetch;
};

/** One loopback process owns both apps' slots and holds them through streamed bodies. */
export function createLlmGateway(options: LlmGatewayOptions) {
  if (!options.token.trim()) throw new Error("LLM gateway token is required");
  const router =
    options.router ??
    createLlmLoadRouter({
      nodes: [{ id: "aurora", baseUrl: options.local.baseUrl, gpu: "RTX6000" }],
    });
  const fetchImpl = options.fetchImpl ?? fetch;
  const controllers = new Set<AbortController>();
  const expected = Buffer.from(`Bearer ${options.token.trim()}`);
  const server = createServer(async (req, res) => {
    const received = Buffer.from(req.headers.authorization ?? "");
    if (
      req.headers.origin ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(router.status()));
      return;
    }
    const route = /^\/(local|public|remote)\/v1\/chat\/completions$/u.exec(req.url ?? "")?.[1];
    if (req.method !== "POST" || !route) {
      res.writeHead(404).end();
      return;
    }
    const target =
      route === "local" ? options.local : route === "public" ? options.public : options.remote;
    if (!target) {
      res.writeHead(503).end();
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    res.once("close", abort);
    let lease: Awaited<ReturnType<LlmLoadRouter["acquire"]>> | undefined;
    try {
      // Bound buffered request size before queueing. No prompts or credentials are logged.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      lease = await router.acquire(route === "local" ? "local" : "public", controller.signal);
      const base = route === "local" && lease.node ? lease.node.baseUrl : target.baseUrl;
      const url = new URL("chat/completions", `${base.replace(/\/$/u, "")}/`);
      // GPU endpoints are reached through local SSH tunnels; private data cannot go to a public host.
      if (
        route === "local" &&
        (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
      ) {
        throw new Error("Local GPU endpoints must use loopback tunnels");
      }
      const upstream = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
        },
        body: Buffer.concat(chunks),
        signal: controller.signal,
      });
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const body = Readable.from(
          (async function* () {
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) return;
                yield chunk.value;
              }
            } finally {
              await reader.cancel();
              reader.releaseLock();
            }
          })(),
        );
        await pipeline(body, res, { signal: controller.signal });
      } else res.end();
    } catch {
      if (!res.destroyed) {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      }
    } finally {
      lease?.release();
      res.off("close", abort);
      controllers.delete(controller);
    }
  });
  // Queue waits are intentional; do not impose an HTTP request-generation deadline.
  server.timeout = 0;
  return {
    server,
    router,
    async listen(port = 8766) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Gateway failed to bind");
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
