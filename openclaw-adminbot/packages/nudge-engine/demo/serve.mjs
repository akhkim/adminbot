/**
 * Demo server. No build step, no dependencies.
 *
 * Node can strip TypeScript types at runtime, so `.ts` files are served straight to the
 * browser as ES modules with the annotations removed. Import specifiers still say `.ts`,
 * which is exactly what the source writes, so nothing needs rewriting.
 *
 *   node demo/serve.mjs   →   http://localhost:5174
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const port = Number(process.env.PORT ?? 5174);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const rel = url.pathname === "/" ? "demo/index.html" : url.pathname.slice(1);
    const file = path.resolve(root, rel);

    // Never serve outside the package.
    if (!file.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const source = await readFile(file, "utf8");

    if (file.endsWith(".ts")) {
      // `strip` keeps line numbers intact, so stack traces in the browser still point at
      // the real source lines.
      const js = stripTypeScriptTypes(source, { mode: "strip" });
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
      return;
    }

    const type = types[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type }).end(source);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(500).end(String(error));
  }
});

server.listen(port, () => {
  process.stdout.write(`nudge-engine demo → http://localhost:${port}\n`);
});
