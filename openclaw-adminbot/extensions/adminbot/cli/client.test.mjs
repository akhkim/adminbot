import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { run } from "./adminbot.mjs";
import { aliases } from "./aliases.mjs";
import { callOperation, document, operations } from "./client.mjs";

async function invoke(args, options = {}) {
  let out = "",
    err = "";
  const code = await run(args, {
    env: {},
    stdin: Readable.from([]),
    stdout: {
      write: (value) => {
        out += String(value);
      },
    },
    stderr: {
      write: (value) => {
        err += String(value);
      },
    },
    ...options,
  });
  return { code, out, err };
}
async function service(t, handler) {
  const server = createServer((req, res) => {
    void (async () => {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
      }
      res.setHeader("content-type", "application/json");
      handler(req, res, raw ? JSON.parse(raw) : undefined);
    })().catch(() => {
      res.destroy(new Error("HTTP fixture failed"));
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
const input = (body) => Readable.from([JSON.stringify(body)]);

await test("every OpenAPI operation is discoverable and every alias resolves to the contract", async () => {
  const result = await invoke(["operations"]);
  assert.equal(result.code, 0);
  assert.equal(
    JSON.parse(result.out).length,
    Object.values(document.paths).reduce(
      (count, methods) => count + Object.keys(methods).length,
      0,
    ),
  );
  assert.ok(Object.keys(operations).length > 200);
  for (const alias of Object.values(aliases)) {
    assert.ok(operations[alias.operation]);
  }
  assert.equal(JSON.parse((await invoke(["schema"])).out).openapi, "3.1.1");
});

await test("a formerly unmapped operation works through the same generic engine", async (t) => {
  const received = [];
  const baseUrl = await service(t, (req, res, body) => {
    received.push({ path: req.url, method: req.method, body });
    res.end('{"items":[]}');
  });
  const result = await invoke(["call", "get-badges"], {
    env: { ADMINBOT_URL: baseUrl, ADMINBOT_TOKEN: "test" },
  });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(received, [{ path: "/badges", method: "GET", body: undefined }]);
});

await test("task/work/progress flags serialize without handwritten endpoint implementations", async (t) => {
  const received = [];
  const url = await service(t, (req, res, body) => {
    received.push({ path: req.url, method: req.method, body });
    res.end("{}");
  });
  const env = { ADMINBOT_URL: url, ADMINBOT_TOKEN: "member" };
  for (const args of [
    ["tasks", "update", "paper/1", "fixes_merged", "--done"],
    ["tasks", "update", "paper/1", "fixes_merged", "--pending"],
    ["work", "update", "paper-1", "--note", "Finished experiments"],
    ["papers", "progress", "paper-1", "--step", "overleaf_writing"],
  ]) {
    assert.equal((await invoke(args, { env })).code, 0, args.join(" "));
  }
  assert.deepEqual(received, [
    { path: "/papers/paper%2F1/slots/fixes_merged", method: "PUT", body: { done: true } },
    { path: "/papers/paper%2F1/slots/fixes_merged", method: "PUT", body: { done: false } },
    {
      path: "/papers/paper-1/weekly-updates",
      method: "POST",
      body: { body: "Finished experiments" },
    },
    {
      path: "/papers/paper-1/progress",
      method: "PATCH",
      body: { current_step: "overleaf_writing" },
    },
  ]);
});

await test("OpenAPI enums/required fields reject invalid inputs before transport", async () => {
  for (const args of [
    ["papers", "progress", "p1", "--step", "invented"],
    ["proposals", "approve", "a1"],
    ["tasks", "update", "..", "fixes_merged", "--done"],
    ["tasks", "update", "p1", "fixes_merged", "--done", "--no-done"],
    ["work", "update", "p1", "--file", "-", "--note", "mixed"],
    ["papers", "list", "--url", "http://remote.example.test"],
    ["work", "update", "p1", "--set", "__proto__.polluted=true"],
  ]) {
    const result = await invoke(args, {
      env: { ADMINBOT_TOKEN: "test" },
      stdin: input({ body: "x" }),
      fetchImpl: () => assert.fail("must not request"),
    });
    assert.equal(result.code, 2, result.err);
    assert.equal(result.out, "");
  }
});

await test("generic SDK validates the same schemas and public endpoints omit auth", async (t) => {
  await assert.rejects(
    callOperation("patch-papers-by-papers-id-progress", {
      token: "test",
      path: { papers_id: "p1" },
      body: { current_step: "invented" },
      fetchImpl: () => assert.fail("must not request"),
    }),
    { code: "INVALID_INPUT" },
  );
  const baseUrl = await service(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.end('{"items":[]}');
  });
  await callOperation("get-deadlines", { baseUrl, token: "secret" });
});

await test("a refusal carries the service's own reason, and a 400 exits as an input error", async (t) => {
  const url = await service(t, (_req, res) => {
    res.statusCode = 400;
    res.end('{"error":{"message":"current_step must be one of the paper steps"}}');
  });
  const result = await invoke(["papers", "progress", "p1", "--step", "overleaf_writing"], {
    env: { ADMINBOT_URL: url, ADMINBOT_TOKEN: "test" },
  });
  assert.equal(result.code, 2, result.err);
  const { error } = JSON.parse(result.err);
  assert.equal(error.status, 400);
  assert.match(error.message, /current_step must be one of the paper steps/u);
});

await test("a refusal without a reason still says something, bounded", async () => {
  await assert.rejects(
    callOperation("get-deadlines", {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async () =>
        new Response("x".repeat(10), { status: 500, headers: { "content-type": "text/plain" } }),
    }),
    { code: "SERVICE_ERROR", status: 500, message: /check permissions, policy, and input/u },
  );
});

await test("header parameters are read from the headers, not the query", async (t) => {
  const seen = [];
  const baseUrl = await service(t, (req, res) => {
    seen.push({ url: req.url, key: req.headers["idempotency-key"] });
    res.end("{}");
  });
  await callOperation("post-deadline-proposals", {
    baseUrl,
    token: "test",
    header: { "idempotency-key": "once" },
    body: {},
  }).catch(() => {});
  assert.equal(seen.at(-1)?.key, "once");
  assert.ok(!seen.at(-1)?.url.includes("idempotency"));
});

await test("a nested --set may share a top-level field's name without being a duplicate", async (t) => {
  const received = [];
  const url = await service(t, (_req, res, body) => {
    received.push(body);
    res.end("{}");
  });
  const env = { ADMINBOT_URL: url, ADMINBOT_TOKEN: "test" };
  const result = await invoke(
    [
      "proposals",
      "create",
      "--type",
      "email.send",
      "--summary",
      "Synthetic draft",
      "--set",
      "proposed_payload.summary=nested",
    ],
    { env },
  );
  assert.equal(result.code, 0, result.err);
  assert.equal(received.at(-1).summary, "Synthetic draft");
  assert.equal(received.at(-1).proposed_payload.summary, "nested");
  const twice = await invoke(
    ["proposals", "create", "--set", "proposed_payload.to=a", "--set", "proposed_payload.to=b"],
    { env },
  );
  assert.equal(twice.code, 2);
  assert.match(twice.err, /Duplicate body field/u);
});

await test("input files, nested --set, query parameters and dry-run overrides use OpenAPI", async (t) => {
  const received = [];
  const url = await service(t, (req, res, body) => {
    received.push({ path: req.url, body });
    res.end("{}");
  });
  const env = { ADMINBOT_URL: url, ADMINBOT_TOKEN: "test" };
  const proposal = {
    type: "email.send",
    summary: "Synthetic draft",
    proposed_payload: { to: "member@example.test", body: "Test" },
    dry_run: false,
  };
  assert.equal(
    (await invoke(["proposals", "create", "--file", "-"], { env, stdin: input(proposal) })).code,
    0,
  );
  assert.equal(received.at(-1).body.dry_run, true);
  assert.equal(
    (
      await invoke(
        [
          "proposals",
          "create",
          "--type",
          "email.send",
          "--summary",
          "Synthetic draft",
          "--set",
          "proposed_payload.to=member@example.test",
        ],
        { env },
      )
    ).code,
    0,
  );
  assert.equal(received.at(-1).body.proposed_payload.to, "member@example.test");
  assert.equal(
    (await invoke(["proposals", "execute", "a1", "--live", "--idempotency-key", "once"], { env }))
      .code,
    0,
  );
  assert.deepEqual(received.at(-1).body, { idempotency_key: "once", dry_run: false });
  assert.equal((await invoke(["call", "get-proposals-pending", "--limit", "5"], { env })).code, 0);
  assert.equal(received.at(-1).path, "/proposals/pending?limit=5");
});

await test("login stores an origin-bound private session, token overrides work, logout revokes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "adminbot-api-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentials = join(dir, "config/credentials.json");
  const requests = [];
  const url = await service(t, (req, res, body) => {
    requests.push({ path: req.url, auth: req.headers.authorization, body });
    res.end(
      JSON.stringify(
        req.url === "/auth/login"
          ? { session_token: "synthetic-session", expires_at: "2099-01-01T00:00:00Z" }
          : {},
      ),
    );
  });
  const env = { ADMINBOT_URL: url, ADMINBOT_CREDENTIALS_FILE: credentials };
  const login = await invoke(
    ["auth", "login", "--email", "member@example.test", "--password-stdin"],
    { env, stdin: Readable.from(["synthetic-password\n"]) },
  );
  assert.equal(login.code, 0, login.err);
  assert.ok(!login.out.includes("synthetic-session") && !login.out.includes("synthetic-password"));
  assert.equal((await stat(credentials)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(credentials, "utf8")).url, url);
  assert.equal((await invoke(["auth", "whoami"], { env })).code, 0);
  assert.equal(requests.at(-1).auth, "Bearer synthetic-session");
  assert.equal((await invoke(["auth", "whoami", "--url", "http://127.0.0.1:1"], { env })).code, 3);
  assert.equal(
    (await invoke(["auth", "whoami"], { env: { ...env, ADMINBOT_TOKEN: "override" } })).code,
    0,
  );
  assert.equal(requests.at(-1).auth, "Bearer override");
  assert.equal((await invoke(["auth", "logout"], { env })).code, 0);
  assert.equal(requests.at(-1).path, "/auth/logout");
  await assert.rejects(readFile(credentials), { code: "ENOENT" });
});

await test("HTTP failures remain nonzero and redirects never receive credentials", async (t) => {
  for (const status of [401, 403, 409, 503]) {
    const url = await service(t, (_req, res) => {
      res.statusCode = status;
      res.end(`{"error":{"message":"refused: ${"r".repeat(800)}"}}`);
    });
    const result = await invoke(["papers", "list"], {
      env: { ADMINBOT_URL: url, ADMINBOT_TOKEN: "test" },
    });
    assert.equal(result.code, status === 409 ? 4 : status === 503 ? 1 : 3);
    // The service's reason is the caller's to read -- on stderr, as JSON, and bounded -- and
    // never on stdout, where a script would take it for a result.
    assert.equal(result.out, "");
    const { error } = JSON.parse(result.err);
    assert.match(error.message, /^AdminBot rejected the request: refused: r+$/u);
    assert.ok(error.message.length < 600);
  }
  let forwarded = 0;
  const target = await service(t, (_req, res) => {
    forwarded++;
    res.end("{}");
  });
  const url = await service(t, (_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", target);
    res.end("{}");
  });
  assert.equal(
    (await invoke(["papers", "list"], { env: { ADMINBOT_URL: url, ADMINBOT_TOKEN: "test" } })).code,
    1,
  );
  assert.equal(forwarded, 0);
});
