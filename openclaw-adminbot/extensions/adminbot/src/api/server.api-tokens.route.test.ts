// Personal API tokens over HTTP: what a bearer `abt_` token may reach, what it may not, and the
// browser handshake behind `adminbot login`. The policy itself is tested in
// workflows/identity/api-tokens.test.ts; this file checks the routes hand it the right caller.
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "../workflows/identity/auth.js";
import { createAdminBotMockService } from "./server.js";

const PASSWORD = "synthetic-password-1";
const PASSWORD_HASH = hashPassword(PASSWORD);
const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  for (const mock of running.splice(0)) {
    await new Promise<void>((resolve) => {
      mock.server.close(() => resolve());
    });
    mock.close();
  }
});

async function start() {
  const mock = createAdminBotMockService({ serviceToken: "test-service-token" });
  running.push(mock);
  await new Promise<void>((resolve) => {
    mock.server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = mock.server.address() as { port: number };
  for (const [id, level] of [
    ["admin-a", "admin"],
    ["plain-c", "member"],
  ] as const) {
    mock.store.saveLabMember({
      id,
      name: `Test ${id}`,
      email: `${id}@example.invalid`,
      privilege_level: level,
      access: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    mock.store.saveCredential({
      member_id: id,
      email: `${id}@example.invalid`,
      password_scrypt: PASSWORD_HASH,
      claimed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  }
  return { mock, baseUrl: `http://127.0.0.1:${port}` };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  options: { bearer?: string; cookie?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (options.bearer) {
    headers.Authorization = `Bearer ${options.bearer}`;
  }
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : {} };
}

async function signIn(baseUrl: string, id: string): Promise<string> {
  const login = await call(baseUrl, "POST", "/auth/login", {
    body: { email: `${id}@example.invalid`, password: PASSWORD },
  });
  expect(login.status).toBe(200);
  return login.body.session_token as string;
}

async function mint(baseUrl: string, session: string, name = "agent"): Promise<string> {
  const created = await call(baseUrl, "POST", "/auth/api-tokens", {
    bearer: session,
    body: { name, expires_in_days: 30, password: PASSWORD },
  });
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toBe("no-store");
  return created.body.token as string;
}

describe("personal API tokens over HTTP", () => {
  it("authenticates as the owner by bearer only", async () => {
    const { baseUrl } = await start();
    const token = await mint(baseUrl, await signIn(baseUrl, "admin-a"));

    const session = await call(baseUrl, "GET", "/auth/session", { bearer: token });
    expect(session.status).toBe(200);
    expect(JSON.stringify(session.body)).toContain("admin-a");

    // In a cookie it is just an unknown session.
    const cookie = await call(baseUrl, "GET", "/auth/session", {
      cookie: `adminbot_session=${token}`,
    });
    expect(JSON.stringify(cookie.body)).not.toContain("admin-a");
    expect(
      (await call(baseUrl, "GET", "/auth/api-tokens", { cookie: `adminbot_session=${token}` }))
        .status,
    ).toBe(401);

    const listed = await call(baseUrl, "GET", "/auth/api-tokens", { bearer: token });
    expect(listed.body.allowed).toBe(true);
    expect(listed.body.tokens).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(token);
  });

  it("refuses a plain member, and refuses minting without the password", async () => {
    const { baseUrl } = await start();
    const plain = await signIn(baseUrl, "plain-c");
    expect((await call(baseUrl, "GET", "/auth/api-tokens", { bearer: plain })).body.allowed).toBe(
      false,
    );
    expect(
      (
        await call(baseUrl, "POST", "/auth/api-tokens", {
          bearer: plain,
          body: { name: "x", expires_in_days: 1, password: PASSWORD },
        })
      ).status,
    ).toBe(403);
    const admin = await signIn(baseUrl, "admin-a");
    expect(
      (
        await call(baseUrl, "POST", "/auth/api-tokens", {
          bearer: admin,
          body: { name: "x", expires_in_days: 1 },
        })
      ).status,
    ).toBe(401);
  });

  it("keeps a token away from credentials, impersonation, pairing and minting", async () => {
    const { baseUrl } = await start();
    const token = await mint(baseUrl, await signIn(baseUrl, "admin-a"));
    for (const [path, body] of [
      ["/auth/api-tokens", { name: "y", expires_in_days: 1, password: PASSWORD }],
      ["/auth/password", { current_password: PASSWORD, new_password: "another-password-2" }],
      ["/auth/email", { email: "new@example.invalid", password: PASSWORD }],
      ["/auth/impersonate", { member_id: "plain-c" }],
      ["/auth/pair-device", {}],
      ["/auth/device-token", {}],
      ["/auth/device/approve", { user_code: "BCDF-GHJK", password: PASSWORD }],
      ["/auth/device/lookup", { user_code: "BCDF-GHJK" }],
    ] as const) {
      const response = await call(baseUrl, "POST", path, { bearer: token, body });
      expect([path, response.status]).toEqual([path, 403]);
    }
  });

  it("logs out by revoking the token, and attributes its actions in the audit", async () => {
    const { baseUrl, mock } = await start();
    const session = await signIn(baseUrl, "admin-a");
    const one = await mint(baseUrl, session, "one");
    const two = await mint(baseUrl, session, "two");
    const tokens = (await call(baseUrl, "GET", "/auth/api-tokens", { bearer: session })).body
      .tokens as Array<{ id: string; name: string }>;
    const idOne = tokens.find((t) => t.name === "one")!.id;
    const idTwo = tokens.find((t) => t.name === "two")!.id;

    expect(
      (await call(baseUrl, "DELETE", `/auth/api-tokens/${idTwo}`, { bearer: one })).status,
    ).toBe(200);
    const revoked = mock.store
      .listAuditEvents()
      .find((e) => e.type === "auth.api_token.revoked" && e.details?.token_id === idTwo);
    expect(revoked?.details?.via_api_token).toEqual({ id: idOne, name: "one" });
    expect((await call(baseUrl, "GET", "/auth/session", { bearer: two })).body).not.toHaveProperty(
      "member",
    );

    expect((await call(baseUrl, "POST", "/auth/logout", { bearer: one })).status).toBe(200);
    expect((await call(baseUrl, "GET", "/auth/api-tokens", { bearer: one })).status).toBe(401);
    // The browser session that minted them is untouched.
    expect((await call(baseUrl, "GET", "/auth/api-tokens", { bearer: session })).status).toBe(200);
  });

  it("answers 429 with Retry-After once a token passes its per-minute budget", async () => {
    const { baseUrl } = await start();
    const token = await mint(baseUrl, await signIn(baseUrl, "admin-a"));
    let limited: Awaited<ReturnType<typeof call>> | undefined;
    for (let batch = 0; batch < 13 && !limited; batch += 1) {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          call(baseUrl, "GET", "/auth/api-tokens", { bearer: token }),
        ),
      );
      limited = results.find((r) => r.status === 429);
    }
    expect(limited).toBeDefined();
    expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("runs the adminbot login handshake end to end", async () => {
    const { baseUrl } = await start();
    const started = await call(baseUrl, "POST", "/auth/device/start", {
      body: { name: "claude-laptop", expires_in_days: 7 },
    });
    expect(started.status).toBe(200);
    const { device_code, user_code } = started.body as { device_code: string; user_code: string };
    expect(
      (await call(baseUrl, "POST", "/auth/device/poll", { body: { device_code } })).body.status,
    ).toBe("authorization_pending");

    const session = await signIn(baseUrl, "admin-a");
    const looked = await call(baseUrl, "POST", "/auth/device/lookup", {
      bearer: session,
      body: { user_code },
    });
    expect(looked.body).toMatchObject({ name: "claude-laptop", expires_in_days: 7 });
    expect(
      (
        await call(baseUrl, "POST", "/auth/device/approve", {
          bearer: session,
          body: { user_code, password: PASSWORD },
        })
      ).status,
    ).toBe(200);

    // The poll interval is five seconds; wait out the slow_down window rather than mock time.
    await new Promise((resolve) => {
      setTimeout(resolve, 2600);
    });
    const polled = await call(baseUrl, "POST", "/auth/device/poll", { body: { device_code } });
    expect(polled.headers.get("cache-control")).toBe("no-store");
    expect(polled.body).toMatchObject({ status: "approved", member: { id: "admin-a" } });
    const session2 = await call(baseUrl, "GET", "/auth/session", { bearer: polled.body.token });
    expect(JSON.stringify(session2.body)).toContain("admin-a");
  });
});
