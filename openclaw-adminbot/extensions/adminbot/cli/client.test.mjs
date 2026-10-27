import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

await test("every error is one JSON envelope an agent can act on", async (t) => {
  const env = (url) => ({ ADMINBOT_URL: url, ADMINBOT_TOKEN: "test" });
  const failing = (status, body, headers = {}) =>
    service(t, (_req, res) => {
      res.statusCode = status;
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }
      res.end(JSON.stringify(body));
    });
  const errorOf = (result) => {
    assert.equal(result.out, "");
    const { error } = JSON.parse(result.err);
    assert.equal(error.exit_code, result.code);
    assert.equal(typeof error.retryable, "boolean");
    return error;
  };

  const forbidden = errorOf(
    await invoke(["papers", "list"], {
      env: env(await failing(403, { error: { code: "FORBIDDEN", message: "admins only" } })),
    }),
  );
  assert.equal(forbidden.code, "SERVICE_ERROR");
  assert.equal(forbidden.exit_code, 3);
  assert.equal(forbidden.hint, "adminbot whoami");
  assert.equal(forbidden.details.server_code, "FORBIDDEN");
  assert.match(forbidden.details.request, /^GET \//u);

  const limited = errorOf(
    await invoke(["papers", "list"], {
      env: env(await failing(429, { error: { message: "slow down" } }, { "retry-after": "7" })),
    }),
  );
  assert.equal(limited.retryable, true);
  assert.equal(limited.details.retry_after_seconds, 7);
  assert.match(limited.hint, /wait 7s/u);

  // A failed write may still have landed: never advertise it as safe to repeat.
  const crashed = errorOf(
    await invoke(["papers", "progress", "p1", "--step", "overleaf_writing"], {
      env: env(await failing(500, { error: { message: "boom" } })),
    }),
  );
  assert.equal(crashed.retryable, false);
  assert.equal(crashed.details.may_have_applied, true);
  assert.equal(crashed.operation, "patch-papers-by-papers-id-progress");

  const slow = await service(t, () => {});
  const timeout = errorOf(await invoke(["papers", "list", "--timeout", "50"], { env: env(slow) }));
  assert.equal(timeout.code, "CONNECTION_ERROR");
  assert.equal(timeout.details.reason, "TIMEOUT");
  assert.equal(timeout.retryable, true);
  assert.match(timeout.hint, /--timeout 200/u);

  const typo = errorOf(await invoke(["papers", "progress", "p1", "--stepp", "x"]));
  assert.equal(typo.code, "INVALID_ARGUMENTS");
  assert.deepEqual(typo.details.suggestions, ["--step"]);
  assert.ok(typo.details.valid_flags.includes("--step"));

  const unknown = errorOf(await invoke(["call", "get-deadline"]));
  assert.equal(unknown.code, "UNKNOWN_OPERATION");
  assert.equal(unknown.details.suggestions[0], "get-deadlines");
  assert.equal(unknown.hint, "adminbot call get-deadlines --help");

  const invalid = errorOf(
    await invoke(["papers", "progress", "p1", "--step", "invented"], {
      env: env("http://127.0.0.1:9"),
    }),
  );
  assert.equal(invalid.details.problems[0].field, "body.current_step");
  assert.ok(invalid.details.problems[0].allowed.includes("overleaf_writing"));
});

await test("--version prints the version, and a bare flag says where flags go", async () => {
  const version = await invoke(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.out, /^adminbot \d+\.\d+\.\d+\n$/u);
  const stray = await invoke(["--verbose"]);
  assert.equal(stray.code, 2);
  const { error } = JSON.parse(stray.err);
  assert.match(error.message, /--verbose is not a top-level option/u);
  assert.equal(error.hint, "adminbot --help");
});

await test("input errors come before sign-in, and logout without a login succeeds", async () => {
  const offline = { ADMINBOT_URL: "http://127.0.0.1:9", ADMINBOT_TOKEN: "" };
  const bad = await invoke(["papers", "progress", "p1", "--step", "invented"], { env: offline });
  assert.equal(bad.code, 2);
  assert.equal(JSON.parse(bad.err).error.code, "INVALID_INPUT");
  const out = await invoke(["logout"], { env: offline });
  assert.equal(out.code, 0);
  assert.equal(JSON.parse(out.out).authenticated, false);
  assert.match((await invoke(["help"])).out, /^AdminBot CLI/u);
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

const FAKE_TOKEN = `abt_${"A".repeat(43)}_0badc0de`;
async function deviceService(t, polls) {
  const seen = [];
  const baseUrl = await service(t, (req, res, body) => {
    seen.push({ path: req.url, authorization: req.headers.authorization, body });
    if (req.url === "/auth/device/start") {
      res.end(
        JSON.stringify({
          device_code: "d".repeat(43),
          user_code: "BCDF-GHJK",
          verification_uri: "http://127.0.0.1/profile",
          verification_uri_complete: "http://127.0.0.1/profile?cliLogin=BCDF-GHJK",
          expires_in: 600,
          interval: 1,
        }),
      );
    } else if (req.url === "/auth/device/poll") {
      res.end(JSON.stringify(polls.shift()));
    } else if (req.url === "/auth/session") {
      res.end('{"member":{"id":"admin-a"}}');
    } else if (req.url === "/auth/logout") {
      res.end("{}");
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  return { baseUrl, seen };
}
const approved = {
  status: "approved",
  token: FAKE_TOKEN,
  member: { id: "admin-a" },
  api_token: {
    id: `tok_${"0".repeat(20)}`,
    name: "laptop",
    expires_at: "2099-01-01T00:00:00.000Z",
  },
};

await test("auth login through the browser saves the token privately and never prints it", async (t) => {
  const { baseUrl, seen } = await deviceService(t, [{ status: "authorization_pending" }, approved]);
  const dir = await mkdtemp(join(tmpdir(), "adminbot-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentials = join(dir, "credentials.json");
  const env = { ADMINBOT_CREDENTIALS_FILE: credentials, ADMINBOT_KEYCHAIN: "0" };

  const login = await invoke(
    ["auth", "login", "--url", baseUrl, "--no-browser", "--name", "laptop", "--days", "7"],
    { env },
  );
  assert.equal(login.code, 0, login.err);
  assert.ok(login.err.includes("BCDF-GHJK"));
  assert.ok(!login.out.includes(FAKE_TOKEN) && !login.err.includes(FAKE_TOKEN));
  assert.equal(JSON.parse(login.out).api_token.id, approved.api_token.id);
  assert.deepEqual(seen[0].body, { name: "laptop", expires_in_days: 7 });
  assert.equal(seen[0].authorization, undefined);
  assert.equal((await stat(credentials)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(credentials, "utf8"));
  assert.equal(saved.kind, "api_token");
  assert.equal(saved.url, baseUrl);

  const whoami = await invoke(["auth", "whoami", "--url", baseUrl], { env });
  assert.equal(whoami.code, 0, whoami.err);
  assert.equal(seen.at(-1).authorization, `Bearer ${FAKE_TOKEN}`);

  const logout = await invoke(["auth", "logout", "--url", baseUrl], { env });
  assert.equal(logout.code, 0, logout.err);
  await assert.rejects(stat(credentials), { code: "ENOENT" });
});

await test("gh-style shortcuts: login falls back to a private file, auth token prints it, logout", async (t) => {
  const { baseUrl, seen } = await deviceService(t, [approved]);
  const dir = await mkdtemp(join(tmpdir(), "adminbot-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentials = join(dir, "credentials.json");
  // A keychain file that does not exist makes `security` fail, as it does inside an agent sandbox.
  const env = {
    ADMINBOT_CREDENTIALS_FILE: credentials,
    ADMINBOT_KEYCHAIN_FILE: join(dir, "missing.keychain-db"),
  };

  const login = await invoke(["login", "--url", baseUrl, "--no-browser"], { env });
  assert.equal(login.code, 0, login.err);
  assert.equal(JSON.parse(login.out).storage, "file");
  assert.deepEqual(Object.keys(seen[0].body), ["name"]);
  assert.equal((await stat(credentials)).mode & 0o777, 0o600);

  const token = await invoke(["auth", "token", "--url", baseUrl], { env });
  assert.equal(token.code, 0, token.err);
  assert.equal(token.out, `${FAKE_TOKEN}\n`);

  assert.equal((await invoke(["whoami", "--url", baseUrl], { env })).code, 0);
  assert.equal(seen.at(-1).authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal((await invoke(["logout", "--url", baseUrl], { env })).code, 0);
  const after = await invoke(["auth", "token", "--url", baseUrl], { env });
  assert.equal(after.code, 3);
  assert.equal(JSON.parse(after.err).error.hint, "adminbot login");
});

await test("browser login slows down when asked and stops on denial", async (t) => {
  const { deviceLogin } = await import("./login.mjs");
  const { baseUrl } = await deviceService(t, [
    { status: "slow_down" },
    { status: "authorization_pending" },
    { status: "access_denied" },
  ]);
  const dir = await mkdtemp(join(tmpdir(), "adminbot-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const waits = [];
  await assert.rejects(
    deviceLogin({
      baseUrl,
      credentials: join(dir, "credentials.json"),
      browser: false,
      timeout: 5000,
      env: { ADMINBOT_KEYCHAIN: "0" },
      stderr: { write: () => {} },
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
    { code: "ACCESS_DENIED", status: 403 },
  );
  // RFC 8628: slow_down raises the interval for every later poll, not just the next.
  assert.deepEqual(waits, [1000, 6000, 6000]);
  await assert.rejects(stat(join(dir, "credentials.json")), { code: "ENOENT" });
});

await test("browser login refuses unknown flags and redacts tokens from errors", async () => {
  const bad = await invoke(["auth", "login", "--password", FAKE_TOKEN]);
  assert.equal(bad.code, 2);
  assert.ok(!bad.err.includes(FAKE_TOKEN));
  const days = await invoke(["auth", "login", "--days", "366"]);
  assert.equal(days.code, 2);
  assert.match(days.err, /--days/u);
});

test("skill install copies the agent skill and replaces only an earlier copy", async () => {
  const home = await mkdtemp(join(tmpdir(), "adminbot-skill-"));
  try {
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".codex", "skills"), { recursive: true });
    await symlink(join(home, "elsewhere"), join(home, ".codex", "skills", "adminbot-cli"));
    const first = await invoke(["skill", "install"], { env: { HOME: home } });
    assert.equal(first.code, 0, first.err);
    for (const agent of [".claude", ".codex"]) {
      const skill = await readFile(join(home, agent, "skills", "adminbot-cli", "SKILL.md"), "utf8");
      assert.match(skill, /^name: adminbot-cli$/mu);
      assert.match(
        await readFile(join(home, agent, "skills", "adminbot-cli", "pages.md"), "utf8"),
        /post-guidebook-ask/u,
      );
    }
    assert.equal((await invoke(["skill", "install"], { env: { HOME: home } })).code, 0);
    await writeFile(
      join(home, ".claude", "skills", "adminbot-cli", "SKILL.md"),
      "---\nname: mine\n---\n",
    );
    const clash = await invoke(["skill", "install"], { env: { HOME: home } });
    assert.equal(clash.code, 2);
    assert.match(clash.err, /SKILL_CONFLICT/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the skill's page index lists every operation", async () => {
  const pages = await readFile(new URL("./skill/pages.md", import.meta.url), "utf8");
  for (const operationId of Object.keys(operations)) {
    assert.ok(pages.includes(`\`${operationId}\``), operationId);
  }
});
