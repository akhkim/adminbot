import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import { AdminBotMemoryStore } from "../../kernel/service.js";
import { runWithApiToken } from "./api-token-context.js";
import { ApiTokenRateLimiter, isApiTokenShaped } from "./api-token-format.js";
import { AdminBotApiTokenService } from "./api-tokens.js";
import { hashPassword, type AdminBotMemberPrincipal } from "./auth.js";

// Synthetic people only. One scrypt hash for the whole file: it is deliberately slow.
const PASSWORD = "synthetic-password-1";
const PASSWORD_HASH = hashPassword(PASSWORD);

function member(id: string, overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id,
    name: `Test ${id}`,
    email: `${id}@example.invalid`,
    privilege_level: "admin",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function setup(
  options: {
    levels?: string;
    rateLimiter?: ApiTokenRateLimiter;
    geolocateIp?: (ip: string) => Promise<{ city?: string; country?: string } | undefined>;
    onApiTokenNewIp?: (event: { ip: string; token_id: string }) => void;
  } = {},
) {
  let now = new Date("2026-10-01T12:00:00.000Z");
  const clock = {
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
  const store = new AdminBotMemoryStore();
  for (const m of [
    member("admin-a"),
    member("admin-b"),
    member("plain-c", { privilege_level: "member" }),
  ]) {
    store.saveLabMember(m);
    store.saveCredential({
      member_id: m.id,
      email: m.email!,
      password_scrypt: PASSWORD_HASH,
      claimed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  }
  const tokens = new AdminBotApiTokenService({
    store,
    controlUiUrl: "https://ui.example.invalid/",
    now: () => now,
    warn: () => {},
    ...options,
  });
  const principal = (id: string, extra: Partial<AdminBotMemberPrincipal> = {}) =>
    ({
      kind: "member",
      member: store.getLabMember(id)!,
      session: {
        token_hash: `session-${id}`,
        member_id: id,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
        last_seen_at: now.toISOString(),
      },
      ...extra,
    }) as AdminBotMemberPrincipal;
  return { store, tokens, principal, clock };
}

async function mint(
  tokens: AdminBotApiTokenService,
  owner: AdminBotMemberPrincipal,
  name = "agent-laptop",
): Promise<string> {
  const result = await tokens.create(owner, { name, expires_in_days: 30, password: PASSWORD });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload.token;
}

const flush = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe("AdminBotApiTokenService: creating and resolving", () => {
  it("mints a checksummed token that resolves to its owner and stores only the hash", async () => {
    const { store, tokens, principal } = setup();
    const owner = principal("admin-a");
    const result = await tokens.create(owner, {
      name: "  claude\u0007-laptop ",
      expires_in_days: 500,
      password: PASSWORD,
      remoteIp: "198.51.100.7",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { token, api_token } = result.payload;
    expect(isApiTokenShaped(token)).toBe(true);
    expect(api_token.name).toBe("claude-laptop");
    expect(api_token.hint).toBe(token.slice(-4));
    // Clamped to the 90-day maximum.
    expect(Date.parse(api_token.expires_at) - Date.parse(api_token.created_at)).toBe(
      90 * 86_400_000,
    );
    expect(JSON.stringify(api_token)).not.toContain(token);
    const stored = store.getApiToken(api_token.id)!;
    expect(stored.token_hash).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(token);

    const resolved = await tokens.resolve(token, "198.51.100.7");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.principal.member.id).toBe("admin-a");
    expect(resolved.principal.apiToken).toEqual({ id: api_token.id, name: "claude-laptop" });
    expect(resolved.principal.session.expires_at).toBe(api_token.expires_at);
    expect(store.listAuditEvents().map((e) => e.type)).toContain("auth.api_token.created");
  });

  it("refuses a wrong password, and locks out after repeated failures", async () => {
    const { tokens, principal } = setup();
    const owner = principal("admin-a");
    for (let i = 0; i < 5; i += 1) {
      const wrong = await tokens.create(owner, { name: "x", expires_in_days: 1, password: "nope" });
      expect(wrong).toMatchObject({ ok: false, status: 401 });
    }
    const locked = await tokens.create(owner, {
      name: "x",
      expires_in_days: 1,
      password: PASSWORD,
    });
    expect(locked).toMatchObject({ ok: false, status: 429 });
  });

  it("refuses minting from a token, while impersonating, and for ineligible members", async () => {
    const { tokens, principal } = setup();
    const viaToken = principal("admin-a", { apiToken: { id: "tok_x", name: "x" } });
    expect(
      await tokens.create(viaToken, { name: "y", expires_in_days: 1, password: PASSWORD }),
    ).toMatchObject({ ok: false, status: 403 });
    const viewing = principal("admin-a", { impersonator: member("admin-b") });
    expect(
      await tokens.create(viewing, { name: "y", expires_in_days: 1, password: PASSWORD }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await tokens.create(principal("plain-c"), {
        name: "y",
        expires_in_days: 1,
        password: PASSWORD,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(tokens.allowedFor(principal("plain-c"))).toBe(false);
  });

  it("widens eligibility through ADMINBOT_API_TOKEN_LEVELS", async () => {
    const { tokens, principal } = setup({ levels: "admin,member" });
    expect(tokens.allowedFor(principal("plain-c"))).toBe(true);
    await expect(mint(tokens, principal("plain-c"))).resolves.toMatch(/^abt_/u);
  });

  it("rejects malformed, tampered, expired and revoked tokens", async () => {
    const { tokens, principal, clock } = setup();
    const token = await mint(tokens, principal("admin-a"));
    const tampered = `${token.slice(0, 10)}${token[10] === "A" ? "B" : "A"}${token.slice(11)}`;
    expect(await tokens.resolve(tampered, undefined)).toEqual({ ok: false, status: 401 });
    expect(await tokens.resolve("abt_short", undefined)).toEqual({ ok: false, status: 401 });

    // Used every 20 days so idleness never applies; expiry at 30 days still does.
    clock.advance(20 * 86_400_000);
    expect((await tokens.resolve(token, undefined)).ok).toBe(true);
    clock.advance(10 * 86_400_000 + 1);
    expect(await tokens.resolve(token, undefined)).toEqual({ ok: false, status: 401 });

    const second = await mint(tokens, principal("admin-a"), "second");
    const id = (await tokens.list(principal("admin-a"))).find((t) => t.name === "second")!.id;
    expect(await tokens.revoke(principal("admin-a"), id)).toMatchObject({ ok: true });
    expect(await tokens.resolve(second, undefined)).toEqual({ ok: false, status: 401 });
  });

  it("revokes a token left unused past the idle limit", async () => {
    const { store, tokens, principal, clock } = setup();
    const result = await tokens.create(principal("admin-a"), {
      name: "idle",
      expires_in_days: 90,
      password: PASSWORD,
    });
    if (!result.ok) {
      throw new Error("mint failed");
    }
    clock.advance(31 * 86_400_000);
    expect(await tokens.resolve(result.payload.token, undefined)).toEqual({
      ok: false,
      status: 401,
    });
    expect(store.getApiToken(result.payload.api_token.id)?.revoked_reason).toBe("idle");
    expect(
      store
        .listAuditEvents()
        .some((e) => e.type === "auth.api_token.revoked" && e.details?.reason === "idle"),
    ).toBe(true);
  });

  it("stops a demoted owner's tokens at once and restores them with the level", async () => {
    const { store, tokens, principal } = setup();
    const token = await mint(tokens, principal("admin-a"));
    store.saveLabMember(member("admin-a", { privilege_level: "member" }));
    expect(await tokens.resolve(token, undefined)).toEqual({ ok: false, status: 401 });
    store.saveLabMember(member("admin-a"));
    expect((await tokens.resolve(token, undefined)).ok).toBe(true);
  });

  it("rate-limits per token", async () => {
    const { tokens, principal } = setup({ rateLimiter: new ApiTokenRateLimiter(2) });
    const token = await mint(tokens, principal("admin-a"));
    expect((await tokens.resolve(token, undefined)).ok).toBe(true);
    expect((await tokens.resolve(token, undefined)).ok).toBe(true);
    expect(await tokens.resolve(token, undefined)).toMatchObject({ ok: false, status: 429 });
  });
});

describe("AdminBotApiTokenService: use tracking", () => {
  it("records last use and flags a new address once", async () => {
    const onApiTokenNewIp = vi.fn();
    const { store, tokens, principal, clock } = setup({
      geolocateIp: async (ip) =>
        ip === "203.0.113.9" ? { city: "Zürich", country: "CH" } : undefined,
      onApiTokenNewIp,
    });
    const result = await tokens.create(principal("admin-a"), {
      name: "agent",
      expires_in_days: 30,
      password: PASSWORD,
    });
    if (!result.ok) {
      throw new Error("mint failed");
    }
    const { token, api_token } = result.payload;

    await tokens.resolve(token, "198.51.100.7");
    await flush();
    // The first address is the token's first use: audited, but not an alert.
    expect(onApiTokenNewIp).not.toHaveBeenCalled();
    clock.advance(1000);
    await Promise.all([tokens.resolve(token, "203.0.113.9"), tokens.resolve(token, "203.0.113.9")]);
    await flush();
    expect(onApiTokenNewIp).toHaveBeenCalledTimes(1);
    expect(onApiTokenNewIp.mock.calls[0]![0]).toMatchObject({
      ip: "203.0.113.9",
      place: "Zürich, CH",
    });
    const newIp = store.listAuditEvents().filter((e) => e.type === "auth.api_token.new_ip");
    expect(newIp).toHaveLength(2);

    const stored = store.getApiToken(api_token.id)!;
    expect(stored.last_used_ip).toBe("203.0.113.9");
    expect(stored.last_used_place).toBe("Zürich, CH");
    expect(stored.seen_ips).toEqual(["203.0.113.9", "198.51.100.7"]);
    const [view] = await tokens.list(principal("admin-a"));
    expect(view).toMatchObject({ ip_count: 2, last_used_place: "Zürich, CH" });
    expect(view).not.toHaveProperty("token_hash");
  });

  it("writes last use at most every five minutes from a known address", async () => {
    const { store, tokens, principal, clock } = setup();
    const token = await mint(tokens, principal("admin-a"));
    await tokens.resolve(token, "198.51.100.7");
    await flush();
    const touch = vi.spyOn(store, "touchApiToken");
    clock.advance(60_000);
    await tokens.resolve(token, "198.51.100.7");
    expect(touch).not.toHaveBeenCalled();
    clock.advance(5 * 60_000);
    await tokens.resolve(token, "198.51.100.7");
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("names the token on every audit line written during its request", () => {
    const { store } = setup();
    runWithApiToken({ id: "tok_abc", name: "agent" }, () =>
      store.recordAudit({
        id: "aud_1",
        timestamp: "2026-10-01T12:00:00.000Z",
        type: "auth.login",
        actor: "admin-a",
        details: { note: "kept" },
      }),
    );
    const event = store.listAuditEvents().find((e) => e.id === "aud_1")!;
    expect(event.actor).toBe("admin-a");
    expect(event.details).toEqual({
      note: "kept",
      via_api_token: { id: "tok_abc", name: "agent" },
    });
  });
});

describe("AdminBotApiTokenService: revocation", () => {
  it("does not let one member revoke or see another's tokens", async () => {
    const { tokens, principal } = setup();
    const token = await mint(tokens, principal("admin-a"));
    const id = (await tokens.list(principal("admin-a")))[0]!.id;
    expect(await tokens.list(principal("admin-b"))).toEqual([]);
    expect(await tokens.revoke(principal("admin-b"), id)).toMatchObject({ ok: false, status: 404 });
    expect((await tokens.resolve(token, undefined)).ok).toBe(true);
  });

  it("revoke-all ends every token, and is allowed from a token", async () => {
    const { tokens, principal } = setup();
    const one = await mint(tokens, principal("admin-a"), "one");
    const two = await mint(tokens, principal("admin-a"), "two");
    const resolved = await tokens.resolve(one, undefined);
    if (!resolved.ok) {
      throw new Error("resolve failed");
    }
    expect(await tokens.revokeAll(resolved.principal)).toMatchObject({
      ok: true,
      payload: { revoked: 2 },
    });
    expect((await tokens.resolve(one, undefined)).ok).toBe(false);
    expect((await tokens.resolve(two, undefined)).ok).toBe(false);
  });

  it("revokes tokens with the owner's sessions: password change and sign-out everywhere", async () => {
    const { store, tokens, principal } = setup();
    const one = await mint(tokens, principal("admin-a"), "one");
    expect(
      store.changePasswordAndRevokeSessions(
        "admin-a",
        PASSWORD_HASH,
        PASSWORD_HASH,
        "2026-10-01T12:00:00.000Z",
      ),
    ).toBe(true);
    expect((await tokens.resolve(one, undefined)).ok).toBe(false);
    const two = await mint(tokens, principal("admin-a"), "two");
    store.revokeSessionsForMember("admin-a", "2026-10-01T12:00:00.000Z");
    expect((await tokens.resolve(two, undefined)).ok).toBe(false);
  });
});

describe("AdminBotApiTokenService: adminbot login", () => {
  it("issues the token once, to the CLI that started the request, after a password approval", async () => {
    const { tokens, principal, clock } = setup();
    const started = await tokens.startDeviceLogin({
      name: "claude-laptop",
      expires_in_days: 7,
      remoteIp: "198.51.100.7",
    });
    if (!started.ok) {
      throw new Error("start failed");
    }
    const { device_code, user_code, verification_uri_complete } = started.payload;
    expect(user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/u);
    expect(verification_uri_complete).toBe(
      `https://ui.example.invalid/profile?cliLogin=${user_code}`,
    );

    expect((await tokens.pollDeviceLogin(device_code)).ok && 1).toBe(1);
    expect(await tokens.pollDeviceLogin(device_code)).toMatchObject({
      payload: { status: "slow_down" },
    });

    const admin = principal("admin-a");
    const described = await tokens.describeDeviceLogin(admin, user_code.toLowerCase());
    expect(described).toMatchObject({
      ok: true,
      payload: { name: "claude-laptop", requested_ip: "198.51.100.7", expires_in_days: 7 },
    });
    expect(await tokens.approveDeviceLogin(admin, { user_code, password: "wrong" })).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(
      await tokens.approveDeviceLogin(
        principal("admin-a", { apiToken: { id: "tok_x", name: "x" } }),
        {
          user_code,
          password: PASSWORD,
        },
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(await tokens.approveDeviceLogin(admin, { user_code, password: PASSWORD })).toMatchObject(
      {
        ok: true,
      },
    );

    clock.advance(5000);
    const polled = await tokens.pollDeviceLogin(device_code);
    if (!polled.ok || polled.payload.status !== "approved") {
      throw new Error("not approved");
    }
    expect(polled.payload.member).toEqual({ id: "admin-a", name: "Test admin-a" });
    expect(polled.payload.api_token).toMatchObject({
      name: "claude-laptop",
      created_ip: "198.51.100.7",
    });
    expect((await tokens.resolve(polled.payload.token, undefined)).ok).toBe(true);
    // Collected once; the request is gone.
    expect(await tokens.pollDeviceLogin(device_code)).toMatchObject({
      payload: { status: "expired_token" },
    });
    // A guessed device code gets nothing.
    expect(await tokens.pollDeviceLogin("guess")).toMatchObject({
      payload: { status: "expired_token" },
    });
  });

  it("creates no token for an approval nobody collects, and none for a denied request", async () => {
    const { store, tokens, principal, clock } = setup();
    const a = await tokens.startDeviceLogin({ name: "a", expires_in_days: 1 });
    const b = await tokens.startDeviceLogin({ name: "b", expires_in_days: 1 });
    if (!a.ok || !b.ok) {
      throw new Error("start failed");
    }
    await tokens.approveDeviceLogin(principal("admin-a"), {
      user_code: a.payload.user_code,
      password: PASSWORD,
    });
    expect(await tokens.denyDeviceLogin(principal("admin-a"), b.payload.user_code)).toMatchObject({
      ok: true,
    });
    expect(await tokens.pollDeviceLogin(b.payload.device_code)).toMatchObject({
      payload: { status: "access_denied" },
    });
    clock.advance(11 * 60_000);
    expect(await tokens.pollDeviceLogin(a.payload.device_code)).toMatchObject({
      payload: { status: "expired_token" },
    });
    expect(store.listApiTokensForMember("admin-a")).toEqual([]);
  });

  it("refuses the approval if the approver lost eligibility before the CLI collected it", async () => {
    const { store, tokens, principal } = setup();
    const started = await tokens.startDeviceLogin({ name: "a", expires_in_days: 1 });
    if (!started.ok) {
      throw new Error("start failed");
    }
    await tokens.approveDeviceLogin(principal("admin-a"), {
      user_code: started.payload.user_code,
      password: PASSWORD,
    });
    store.saveLabMember(member("admin-a", { privilege_level: "member" }));
    expect(await tokens.pollDeviceLogin(started.payload.device_code)).toMatchObject({
      payload: { status: "access_denied" },
    });
  });

  it("rate-limits anonymous starts per address", async () => {
    const { tokens } = setup();
    for (let i = 0; i < 10; i += 1) {
      expect(
        (await tokens.startDeviceLogin({ name: "n", expires_in_days: 1, remoteIp: "192.0.2.1" }))
          .ok,
      ).toBe(true);
    }
    expect(
      await tokens.startDeviceLogin({ name: "n", expires_in_days: 1, remoteIp: "192.0.2.1" }),
    ).toMatchObject({ ok: false, status: 429 });
    expect(
      (await tokens.startDeviceLogin({ name: "n", expires_in_days: 1, remoteIp: "192.0.2.2" })).ok,
    ).toBe(true);
  });

  it("counts unknown codes towards the lookout limit", async () => {
    const { tokens, principal } = setup();
    for (let i = 0; i < 5; i += 1) {
      expect(await tokens.describeDeviceLogin(principal("admin-a"), "BCDF-GHJK")).toMatchObject({
        status: 404,
      });
    }
    expect(await tokens.describeDeviceLogin(principal("admin-a"), "BCDF-GHJK")).toMatchObject({
      status: 429,
    });
  });
});
