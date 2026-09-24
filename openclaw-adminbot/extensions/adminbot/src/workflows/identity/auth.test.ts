import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import { AdminBotMemoryStore, AdminBotService } from "../../kernel/service.js";
import {
  AdminBotAuthService,
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync,
} from "./auth.js";

function member(
  id: string,
  email: string,
  overrides: Partial<AdminBotLabMember> = {},
): AdminBotLabMember {
  return {
    id,
    name: id,
    email,
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const GATEWAY_URL = "ws://127.0.0.1:18789";

function setup(
  options: {
    now?: () => Date;
    gatewayUrl?: string | null;
    geolocateIp?: (
      ip: string,
    ) => Promise<
      { country?: string; continent?: string; city?: string; timezone?: string } | undefined
    >;
    sendPasswordResetEmail?: (params: {
      email: string;
      name?: string;
      token: string;
      expiresInMinutes: number;
    }) => Promise<void>;
    sendAccountApprovedEmail?: (params: { email: string; name?: string }) => Promise<void>;
  } = {},
) {
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(store);
  const auth = new AdminBotAuthService({
    store,
    prepareMember: (input) => {
      const result = service.prepareLabMember(input);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.payload;
    },
    afterMemberCreated: (member) => service.afterMemberCreated(member),
    ...(options.gatewayUrl === null ? {} : { gatewayUrl: options.gatewayUrl ?? GATEWAY_URL }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.geolocateIp ? { geolocateIp: options.geolocateIp } : {}),
    ...(options.sendPasswordResetEmail
      ? { sendPasswordResetEmail: options.sendPasswordResetEmail }
      : {}),
    ...(options.sendAccountApprovedEmail
      ? { sendAccountApprovedEmail: options.sendAccountApprovedEmail }
      : {}),
  });
  return { store, auth };
}

// Flushes the microtask queue so a fire-and-forget .then()/.catch() chain (login's IP-location
// update, approval's calendar/email/DCS side effects) has settled before assertions run.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function pendingIdForMember(auth: AdminBotAuthService, memberId: string): Promise<string> {
  const registration = (await auth.listRegistrations("pending")).find(
    (entry) => entry.member_id === memberId,
  );
  if (!registration) {
    throw new Error(`no pending registration for ${memberId}`);
  }
  return registration.id;
}

async function claimAndApprove(
  store: AdminBotMemoryStore,
  auth: AdminBotAuthService,
  id: string,
  email: string,
  password = "correcthorse",
): Promise<void> {
  store.saveLabMember(member(id, email));
  await auth.claim({ member_id: id, email, password });
  await auth.approveRegistration(await pendingIdForMember(auth, id), "admin");
}

describe("hashPassword / verifyPassword", () => {
  it("round-trips and rejects wrong passwords", async () => {
    const serialized = hashPassword("correcthorsebattery");
    expect(serialized.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(verifyPassword(serialized, "correcthorsebattery")).toBe(true);
    expect(verifyPassword(serialized, "wrong")).toBe(false);
  });

  it("rejects malformed serialized hashes", async () => {
    expect(verifyPassword("not-a-hash", "x")).toBe(false);
    expect(verifyPassword("scrypt$16384$8$1$abc", "x")).toBe(false);
  });

  it("checks existing sync hashes with the async verifier and writes compatible hashes", async () => {
    const legacy = hashPassword("correcthorsebattery");
    expect(await verifyPasswordAsync(legacy, "correcthorsebattery")).toBe(true);
    expect(await verifyPasswordAsync(legacy, "wrong")).toBe(false);
    const asyncHash = await hashPasswordAsync("correcthorsebattery");
    expect(verifyPassword(asyncHash, "correcthorsebattery")).toBe(true);
    expect(asyncHash.startsWith("scrypt$16384$8$1$")).toBe(true);
  });
});

describe("AdminBotAuthService claim/login flow", () => {
  it("waits for an async session write before returning a login token", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted = false;
    const asyncStore = new Proxy(store, {
      get(target, key) {
        if (key === "saveSessionIfCredentialCurrent") {
          return async (...args: Parameters<typeof target.saveSessionIfCredentialCurrent>) => {
            writeStarted = true;
            await writeGate;
            return target.saveSessionIfCredentialCurrent(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const asyncAuth = new AdminBotAuthService({
      store: asyncStore,
      prepareMember: () => {
        throw new Error("not used by login");
      },
    });
    let loginFinished = false;
    const pendingLogin = asyncAuth
      .login({ email: "ada@example.com", password: "correcthorse" })
      .then((result) => {
        loginFinished = true;
        return result;
      });
    await vi.waitFor(() => expect(writeStarted).toBe(true));
    expect(loginFinished).toBe(false);
    releaseWrite();
    const login = await pendingLogin;
    expect(login.ok).toBe(true);
    if (login.ok) {
      expect(await asyncAuth.resolveSession(login.payload.session_token)).not.toBeNull();
    }
  });

  it("rejects a login verified before a concurrent password change", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    let releaseWrite: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted = false;
    const asyncStore = new Proxy(store, {
      get(target, key) {
        if (key === "saveSessionIfCredentialCurrent") {
          return async (...args: Parameters<typeof target.saveSessionIfCredentialCurrent>) => {
            writeStarted = true;
            await gate;
            return target.saveSessionIfCredentialCurrent(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const asyncAuth = new AdminBotAuthService({
      store: asyncStore,
      prepareMember: () => {
        throw new Error("not used by login");
      },
    });
    const pendingLogin = asyncAuth.login({ email: "ada@example.com", password: "correcthorse" });
    await vi.waitFor(() => expect(writeStarted).toBe(true));
    expect((await auth.changePassword("ada", "correcthorse", "new-password-123")).ok).toBe(true);
    releaseWrite();

    expect(await pendingLogin).toMatchObject({ ok: false, status: 401 });
    expect(
      verifyPassword(
        store.getCredentialByMemberId("ada")?.password_scrypt ?? "",
        "new-password-123",
      ),
    ).toBe(true);
  });

  it("rejects an email change verified before a concurrent password change", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    let releaseUpdate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateStarted = false;
    const asyncStore = new Proxy(store, {
      get(target, key) {
        if (key === "changeMemberLoginEmail") {
          return async (...args: Parameters<typeof target.changeMemberLoginEmail>) => {
            updateStarted = true;
            await gate;
            return target.changeMemberLoginEmail(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const asyncAuth = new AdminBotAuthService({
      store: asyncStore,
      prepareMember: () => {
        throw new Error("not used by email change");
      },
    });
    const pendingChange = asyncAuth.changeEmail("ada", "new@example.com", "correcthorse");
    await vi.waitFor(() => expect(updateStarted).toBe(true));
    expect((await auth.changePassword("ada", "correcthorse", "new-password-123")).ok).toBe(true);
    releaseUpdate();

    expect(await pendingChange).toMatchObject({ ok: false, status: 401 });
    expect(store.getCredentialByMemberId("ada")?.email).toBe("ada@example.com");
    expect(store.getLabMember("ada")?.email).toBe("ada@example.com");
  });

  it("retries transient account-approval email failures", async () => {
    const sendAccountApprovedEmail = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue(undefined);
    const { store, auth } = setup({ sendAccountApprovedEmail });
    store.saveLabMember(member("ada", "ada@example.com"));
    await auth.claim({ member_id: "ada", email: "ada@example.com", password: "correcthorse" });

    await auth.approveRegistration(await pendingIdForMember(auth, "ada"), "admin");

    await vi.waitFor(() => expect(sendAccountApprovedEmail).toHaveBeenCalledTimes(2));
    expect(store.listAuditEvents(20)).toContainEqual(
      expect.objectContaining({
        type: "auth.approval_email_sent",
        details: expect.objectContaining({ attempts: 2 }),
      }),
    );
  });

  it("claim queues a pending registration without a session or credential", async () => {
    const { store, auth } = setup();
    store.saveLabMember(member("ada", "ada@example.com"));

    const result = await auth.claim({
      member_id: "ada",
      email: "Ada@example.com",
      password: "correcthorse",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload).toEqual({ status: "pending" });
    expect(result.sessionToken).toBeUndefined();
    expect(store.getCredentialByMemberId("ada")).toBeUndefined();
  });

  it("blocks login on a pending registration with a distinct pending_approval code", async () => {
    const { store, auth } = setup();
    store.saveLabMember(member("ada", "ada@example.com"));
    await auth.claim({ member_id: "ada", email: "ada@example.com", password: "correcthorse" });

    const pending = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    expect(pending.ok).toBe(false);
    if (!pending.ok) {
      expect(pending.status).toBe(403);
      expect(pending.code).toBe("pending_approval");
    }

    // Wrong password against a pending registration stays a generic 401.
    const wrong = await auth.login({ email: "ada@example.com", password: "totally-wrong" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.status).toBe(401);
      expect(wrong.code).toBeUndefined();
    }
  });

  it("approves a claim, then login succeeds with a session and gateway", async () => {
    const { store, auth } = setup();
    store.saveLabMember(member("ada", "ada@example.com"));
    await auth.claim({ member_id: "ada", email: "ada@example.com", password: "correcthorse" });

    const approved = await auth.approveRegistration(
      await pendingIdForMember(auth, "ada"),
      "admin-1",
    );
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.payload.member_id).toBe("ada");
    }
    expect(store.getCredentialByMemberId("ada")).toBeDefined();

    const login = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    expect(login.ok).toBe(true);
    if (!login.ok) {
      return;
    }
    expect(login.payload.member.id).toBe("ada");
    expect(login.payload.session_token).toBeTruthy();
    expect(login.payload.gateway).toEqual({ url: GATEWAY_URL });
    expect((await auth.resolveSession(login.payload.session_token))?.member.id).toBe("ada");
  });

  // The service cannot know how a given browser reaches the gateway, so with no URL configured it
  // omits gateway configuration and the client keeps the URL it already connects with.
  it("omits the gateway url when none is configured", async () => {
    const { store, auth } = setup({ gatewayUrl: null });
    store.saveLabMember(member("ada", "ada@example.com"));
    await auth.claim({ member_id: "ada", email: "ada@example.com", password: "correcthorse" });
    await auth.approveRegistration(await pendingIdForMember(auth, "ada"), "admin-1");

    const login = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    expect(login.ok).toBe(true);
    if (!login.ok) {
      return;
    }
    expect(login.payload.gateway).toBeUndefined();
    const principal = await auth.resolveSession(login.payload.session_token);
    expect(principal && auth.sessionView(principal).gateway).toBeUndefined();
  });

  it("signup approval mints a plain member and enables login", async () => {
    const { store, auth } = setup();
    const signup = await auth.signup({
      profile: { name: "New Person", research_branch: "ML", research_topics: ["rl"] },
      email: "new@example.com",
      password: "correcthorse",
    });
    expect(signup.ok).toBe(true);

    const registration = (await auth.listRegistrations("pending")).find(
      (entry) => entry.kind === "signup",
    );
    expect(registration?.profile).toMatchObject({ name: "New Person" });
    const approved = await auth.approveRegistration(registration!.id, "admin");
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }
    const created = store.getLabMember(approved.payload.member_id);
    expect(created?.name).toBe("New Person");
    expect(created?.privilege_level).toBe("member");

    expect((await auth.login({ email: "new@example.com", password: "correcthorse" })).ok).toBe(
      true,
    );
  });

  it("does not mint two members when the same signup is approved concurrently", async () => {
    const { store, auth } = setup();
    await auth.signup({
      email: "new@example.com",
      password: "correcthorse",
      profile: { name: "New Person" },
    });
    const registration = (await auth.listRegistrations("pending"))[0];
    expect(registration).toBeDefined();
    let releaseRead: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reads = 0;
    const asyncStore = new Proxy(store, {
      get(target, key) {
        if (key === "getAccountRegistration") {
          return async (...args: Parameters<typeof target.getAccountRegistration>) => {
            reads += 1;
            await gate;
            return target.getAccountRegistration(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new AdminBotService(store);
    const asyncAuth = new AdminBotAuthService({
      store: asyncStore,
      prepareMember: (input) => {
        const result = service.prepareLabMember(input);
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.payload;
      },
      afterMemberCreated: (member) => service.afterMemberCreated(member),
    });
    const first = asyncAuth.approveRegistration(registration!.id, "admin");
    await vi.waitFor(() => expect(reads).toBe(1));
    const second = asyncAuth.approveRegistration(registration!.id, "admin");
    releaseRead();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 409]);
    expect(store.listLabMembers()).toHaveLength(1);
    expect(store.getCredentialByEmail("new@example.com")?.member_id).toBe(
      store.listLabMembers()[0]?.id,
    );
  });

  it("runs signup effects only for the approval that commits across service instances", async () => {
    const { store, auth } = setup();
    await auth.signup({
      email: "new@example.com",
      password: "correcthorse",
      profile: { name: "New Person" },
    });
    const registration = (await auth.listRegistrations("pending"))[0];
    const service = new AdminBotService(store);
    const afterMemberCreated = vi.fn((created: AdminBotLabMember) =>
      service.afterMemberCreated(created),
    );
    const makeAuth = () =>
      new AdminBotAuthService({
        store,
        prepareMember: (input) => {
          const result = service.prepareLabMember(input);
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          return result.payload;
        },
        afterMemberCreated,
      });
    const responses = await Promise.all([
      makeAuth().approveRegistration(registration!.id, "admin-a"),
      makeAuth().approveRegistration(registration!.id, "admin-b"),
    ]);
    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 404]);
    expect(store.listLabMembers()).toHaveLength(1);
    expect(store.getCredentialByEmail("new@example.com")?.member_id).toBe(
      store.listLabMembers()[0]?.id,
    );
    expect(afterMemberCreated).toHaveBeenCalledTimes(1);
  });

  it("rejected registrations behave as unknown on login", async () => {
    const { store, auth } = setup();
    store.saveLabMember(member("rj", "rj@example.com"));
    await auth.claim({ member_id: "rj", email: "rj@example.com", password: "correcthorse" });
    await auth.rejectRegistration(await pendingIdForMember(auth, "rj"), "admin");

    const login = await auth.login({ email: "rj@example.com", password: "correcthorse" });
    expect(login.ok).toBe(false);
    if (!login.ok) {
      expect(login.status).toBe(401);
      expect(login.code).toBeUndefined();
    }
  });

  it("roster excludes claimed and pending-claim members", async () => {
    const { store, auth } = setup();
    store.saveLabMember(member("a", "a@example.com"));
    store.saveLabMember(member("b", "b@example.com"));
    store.saveLabMember(member("c", "c@example.com"));
    // b has a pending claim, a is fully claimed, c is untouched.
    await auth.claim({ member_id: "b", email: "b@example.com", password: "correcthorse" });
    await claimAndApprove(store, auth, "a", "a2@example.com");

    const roster = await auth.listRoster();
    expect(roster).toEqual([{ id: "c", name: "c" }]);
  });

  it("returns at most 20 matching names after excluding pending and claimed members", async () => {
    const { store, auth } = setup();
    for (let index = 0; index < 30; index += 1) {
      store.saveLabMember(
        member(`m-${String(index).padStart(2, "0")}`, `m${index}@example.invalid`, {
          name: `Ada ${String(index).padStart(2, "0")}`,
        }),
      );
    }
    store.saveCredential({
      member_id: "m-00",
      email: "m0@example.invalid",
      password_scrypt: "synthetic",
      claimed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    store.saveAccountRegistration({
      id: "pending-1",
      kind: "claim",
      member_id: "m-01",
      email: "m1@example.invalid",
      password_scrypt: "synthetic",
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(await auth.listRoster()).toHaveLength(20);
    const matches = await auth.listRoster("aDa 2");
    expect(matches.map((entry) => entry.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Ada 2${index}`),
    );
    expect((await auth.listRoster("Ada")).some((entry) => entry.id === "m-00")).toBe(false);
    expect((await auth.listRoster("Ada")).some((entry) => entry.id === "m-01")).toBe(false);
  });

  it("accepts only one pending request when async claims and signups race", async () => {
    for (const collision of ["member", "email"] as const) {
      const { store } = setup();
      store.saveLabMember(member("ada", "ada@example.com"));
      let releaseWrites: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseWrites = resolve;
      });
      let writesWaiting = 0;
      const asyncStore = new Proxy(store, {
        get(target, key) {
          if (key === "trySavePendingRegistration") {
            return async (...args: Parameters<typeof target.trySavePendingRegistration>) => {
              writesWaiting += 1;
              await gate;
              return target.trySavePendingRegistration(...args);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const asyncAuth = new AdminBotAuthService({
        store: asyncStore,
        prepareMember: () => {
          throw new Error("not used before approval");
        },
      });
      const first = asyncAuth.claim({
        member_id: "ada",
        email: "shared@example.com",
        password: "correcthorse",
      });
      const second =
        collision === "member"
          ? asyncAuth.claim({
              member_id: "ada",
              email: "other@example.com",
              password: "correcthorse",
            })
          : asyncAuth.signup({
              email: "shared@example.com",
              password: "correcthorse",
              profile: { name: "New Person" },
            });
      await vi.waitFor(() => expect(writesWaiting).toBe(2));
      releaseWrites();

      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status).toSorted()).toEqual([200, 403]);
      expect(store.listAccountRegistrations("pending")).toHaveLength(1);
    }
  });

  it("rejects a claim if another request creates its credential while hashing", async () => {
    const { store } = setup();
    store.saveLabMember(member("ada", "ada@example.com"));
    let releaseWrite: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeReached = false;
    const asyncStore = new Proxy(store, {
      get(target, key) {
        if (key === "trySavePendingRegistration") {
          return async (...args: Parameters<typeof target.trySavePendingRegistration>) => {
            writeReached = true;
            await gate;
            return target.trySavePendingRegistration(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const auth = new AdminBotAuthService({
      store: asyncStore,
      prepareMember: () => {
        throw new Error("not used before approval");
      },
    });
    const claim = auth.claim({
      member_id: "ada",
      email: "claimed@example.com",
      password: "correcthorse",
    });
    await vi.waitFor(() => expect(writeReached).toBe(true));
    store.saveCredential({
      member_id: "ada",
      email: "claimed@example.com",
      password_scrypt: "another-request-hash",
      claimed_at: "2026-09-24T00:00:00.000Z",
      updated_at: "2026-09-24T00:00:00.000Z",
    });
    releaseWrite();

    expect(await claim).toMatchObject({ ok: false, status: 403 });
    expect(store.listAccountRegistrations("pending")).toEqual([]);
  });

  it("rejects short passwords for claim and signup", async () => {
    const { store, auth } = setup();
    store.saveLabMember(member("ada", "ada@example.com"));
    const claim = await auth.claim({
      member_id: "ada",
      email: "ada@example.com",
      password: "short",
    });
    expect(claim.ok).toBe(false);
    if (!claim.ok) {
      expect(claim.status).toBe(400);
    }
    const signup = await auth.signup({
      profile: { name: "X" },
      email: "x@example.com",
      password: "short",
    });
    expect(signup.ok).toBe(false);
    if (!signup.ok) {
      expect(signup.status).toBe(400);
    }
  });

  it("signup accepts the full self-editable profile field set", async () => {
    const { store, auth } = setup();
    const signup = await auth.signup({
      profile: {
        name: "Full Profile",
        slack_user_id: "U123",
        role: "PhD Student",
        affiliation: "Jinesis Lab",
        research_branch: "NLP",
        research_topics: ["alignment", "rl"],
        projects: ["proj-a", "proj-b"],
        hours_per_week: 20,
        location: "Toronto",
        timezone: "America/Toronto",
        personal_website: "https://example.com",
        notes: "joined via signup",
      },
      email: "full@example.com",
      password: "correcthorse",
    });
    expect(signup.ok).toBe(true);

    const registration = (await auth.listRegistrations("pending")).find(
      (entry) => entry.kind === "signup" && entry.profile?.name === "Full Profile",
    );
    const approved = await auth.approveRegistration(registration!.id, "admin");
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }
    const created = store.getLabMember(approved.payload.member_id);
    expect(created).toMatchObject({
      name: "Full Profile",
      slack_user_id: "U123",
      role: "PhD Student",
      affiliation: "Jinesis Lab",
      research_branch: "NLP",
      research_topics: ["alignment", "rl"],
      projects: ["proj-a", "proj-b"],
      hours_per_week: 20,
      location: "Toronto",
      timezone: "America/Toronto",
      personal_website: "https://example.com",
      notes: "joined via signup",
      privilege_level: "member",
    });
  });

  it("rejects signup profiles with non-numeric hours_per_week", async () => {
    const { auth } = setup();
    const badHours = await auth.signup({
      profile: { name: "Bad Hours", hours_per_week: "twenty" as unknown as number },
      email: "bad-hours@example.com",
      password: "correcthorse",
    });
    expect(badHours.ok).toBe(false);
    if (!badHours.ok) {
      expect(badHours.status).toBe(400);
    }
  });

  it("rejects signup profiles missing a name or with unknown keys", async () => {
    const { auth } = setup();
    const noName = await auth.signup({
      profile: { affiliation: "Lab" },
      email: "a@example.com",
      password: "correcthorse",
    });
    expect(noName.ok).toBe(false);
    const badKey = await auth.signup({
      profile: { name: "Y", privilege_level: "admin" },
      email: "b@example.com",
      password: "correcthorse",
    });
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) {
      expect(badKey.status).toBe(400);
    }
  });

  it("returns a generic 403 for unknown, already-claimed, and colliding emails", async () => {
    const { store, auth } = setup();
    store.saveLabMember(member("x", "x@example.com"));
    store.saveLabMember(member("y", "y@example.com"));

    const unknown = await auth.claim({
      member_id: "ghost",
      email: "ghost@example.com",
      password: "correcthorse",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.status).toBe(403);
      expect(unknown.error.message).toBe("unable to claim this profile");
    }

    // First claim reserves shared@example.com for member x.
    await auth.claim({ member_id: "x", email: "shared@example.com", password: "correcthorse" });
    const collision = await auth.claim({
      member_id: "y",
      email: "shared@example.com",
      password: "correcthorse",
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.status).toBe(403);
    }
    // Re-claiming the same member is also generic.
    const dupeMember = await auth.claim({
      member_id: "x",
      email: "other@example.com",
      password: "correcthorse",
    });
    expect(dupeMember.ok).toBe(false);

    const signupCollision = await auth.signup({
      profile: { name: "Z" },
      email: "shared@example.com",
      password: "correcthorse",
    });
    expect(signupCollision.ok).toBe(false);
    if (!signupCollision.ok) {
      expect(signupCollision.status).toBe(403);
      expect(signupCollision.error.message).toBe("unable to register");
    }
  });

  it("logs in with valid credentials and rejects bad ones generically", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    expect((await auth.login({ email: "ada@example.com", password: "correcthorse" })).ok).toBe(
      true,
    );

    const badPassword = await auth.login({ email: "ada@example.com", password: "nope-nope-nope" });
    expect(badPassword.ok).toBe(false);
    if (!badPassword.ok) {
      expect(badPassword.status).toBe(401);
      expect(badPassword.error.message).toBe("invalid email or password");
    }

    const unknown = await auth.login({ email: "ghost@example.com", password: "whatever123" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.status).toBe(401);
    }
  });

  it("appends a row per sign-in, where last_login_at only remembers the most recent one", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    expect((await auth.login({ email: "ada@example.com", password: "correcthorse" })).ok).toBe(
      true,
    );
    expect((await auth.login({ email: "ada@example.com", password: "correcthorse" })).ok).toBe(
      true,
    );

    // Two sign-ins, two rows -- against one `last_login_at`. This is the whole point of the log:
    // the field cannot say whether somebody came back, and it is erased by the next bulk write.
    expect(store.listLoginEvents("ada")).toHaveLength(2);
    expect(store.listLoginEvents("ada").every((event) => event.member_id === "ada")).toBe(true);
    expect(store.getLabMember("ada")?.last_login_at).toBeTruthy();
  });

  it("does not record a sign-in that failed", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    expect((await auth.login({ email: "ada@example.com", password: "nope-nope-nope" })).ok).toBe(
      false,
    );
    expect(store.listLoginEvents("ada")).toEqual([]);
  });

  it("stamps a last-login location from a configured geolocator, without blocking login itself", async () => {
    const geolocateIp = vi.fn(async () => ({ country: "Switzerland", continent: "Europe" }));
    const { store, auth } = setup({ geolocateIp });
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    const login = await auth.login({
      email: "ada@example.com",
      password: "correcthorse",
      remoteIp: "8.8.8.8",
    });
    expect(login.ok).toBe(true);
    // login() returns before the geolocation lookup resolves — it must never wait on it.
    expect(store.getLabMember("ada")?.last_login_country).toBeUndefined();

    await Promise.resolve();
    await Promise.resolve();

    expect(geolocateIp).toHaveBeenCalledWith("8.8.8.8");
    const updated = store.getLabMember("ada");
    expect(updated?.last_login_country).toBe("Switzerland");
    expect(updated?.last_login_continent).toBe("Europe");
    expect(updated?.last_login_at).toBeTruthy();
  });

  it("stamps the login observation's collection time in the zone the IP resolved to", async () => {
    // The zone IPinfo returns is used only to render the collection instant in local wall-clock --
    // it must never land in the entry's `timezone`, which stays reserved for a stated zone.
    const geolocateIp = vi.fn(async () => ({
      country: "Canada",
      continent: "North America",
      timezone: "America/Toronto",
    }));
    const { store, auth } = setup({
      geolocateIp,
      now: () => new Date("2026-08-12T03:30:00.000Z"),
    });
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    await auth.login({ email: "ada@example.com", password: "correcthorse", remoteIp: "8.8.8.8" });
    await vi.waitFor(() => expect(store.listMemberLocations("ada", 5)).toHaveLength(1));
    const [observation] = store.listMemberLocations("ada", 5);
    expect(observation?.source).toBe("login_ip");
    expect(observation?.observed_at).toBe("2026-08-12T03:30:00.000Z");
    // 03:30 UTC is 23:30 the evening before in Toronto -- the local day a residency count needs.
    expect(observation?.observed_at_local).toBe("2026-08-11T23:30:00-04:00");
    expect(observation?.timezone).toBeUndefined();
  });

  it("samples the account's location on session use, and only when the address changed", async () => {
    const geolocateIp = vi.fn(async (ip: string) => ({
      country: ip === "8.8.8.8" ? "Switzerland" : "Canada",
      continent: ip === "8.8.8.8" ? "Europe" : "North America",
    }));
    const { store, auth } = setup({ geolocateIp });
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const login = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    const token = login.ok ? login.sessionToken : undefined;
    const principal = await auth.resolveSession(token ?? "");
    expect(principal).toBeDefined();

    auth.noteAccountUse(principal!, "8.8.8.8");
    await vi.waitFor(() =>
      expect(store.getLabMember("ada")?.last_login_country).toBe("Switzerland"),
    );
    expect(geolocateIp).toHaveBeenCalledTimes(1);
    expect(store.getLabMember("ada")?.last_login_country).toBe("Switzerland");

    // A session that keeps being used from the same place must not spend a lookup per request.
    auth.noteAccountUse(principal!, "8.8.8.8");
    auth.noteAccountUse(principal!, "8.8.8.8");
    await Promise.resolve();
    expect(geolocateIp).toHaveBeenCalledTimes(1);

    // A new address is the only thing that can mean a new location.
    auth.noteAccountUse(principal!, "1.1.1.1");
    await vi.waitFor(() => expect(store.getLabMember("ada")?.last_login_country).toBe("Canada"));
    expect(geolocateIp).toHaveBeenCalledTimes(2);
    expect(store.getLabMember("ada")?.last_login_country).toBe("Canada");
  });

  it("never samples location from an impersonated session", async () => {
    const geolocateIp = vi.fn(async () => ({ country: "Switzerland", continent: "Europe" }));
    const { store, auth } = setup({ geolocateIp });
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const login = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    const principal = await auth.resolveSession(login.ok ? login.sessionToken : "");
    expect(principal).toBeDefined();

    // An admin viewing the lab as Ada is at their own desk. Recording that address as Ada's
    // whereabouts would put a movement in her timeline that nobody made.
    auth.noteAccountUse({ ...principal!, impersonator: principal!.member }, "8.8.8.8");
    await Promise.resolve();
    await Promise.resolve();

    expect(geolocateIp).not.toHaveBeenCalled();
    expect(store.getLabMember("ada")?.last_login_country).toBeUndefined();
  });

  it("leaves the inferred location alone when no geolocator is configured, or it resolves to nothing", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    await auth.login({ email: "ada@example.com", password: "correcthorse", remoteIp: "8.8.8.8" });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getLabMember("ada")?.last_login_country).toBeUndefined();

    const { store: store2, auth: auth2 } = setup({ geolocateIp: async () => undefined });
    await claimAndApprove(store2, auth2, "bo", "bo@example.com");
    await auth2.login({ email: "bo@example.com", password: "correcthorse", remoteIp: "8.8.8.8" });
    await Promise.resolve();
    await Promise.resolve();
    expect(store2.getLabMember("bo")?.last_login_country).toBeUndefined();
  });

  it("stamps when somebody signed in, whether or not geolocation is configured", async () => {
    // This used to be written only inside the geolocation callback, so with no IPinfo token
    // nobody in the lab ever got one -- and five readers take absent to mean "never signed in".
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    expect(store.getLabMember("ada")?.last_login_at).toBeUndefined();
    const login = await auth.login({ email: "ada@example.com", password: "correcthorse" });

    expect(login.ok).toBe(true);
    // Synchronously, before login returns: it is one local write with nothing to wait on, and it
    // must not depend on a promise the caller never sees.
    expect(store.getLabMember("ada")?.last_login_at).toBeTruthy();
    // ...and it says nothing about where they were.
    expect(store.getLabMember("ada")?.last_login_country).toBeUndefined();
  });

  it("does not stamp a failed sign-in", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    store.saveLabMember({ ...store.getLabMember("ada")!, last_login_at: undefined } as never);

    await auth.login({ email: "ada@example.com", password: "wrong-password" });

    expect(store.getLabMember("ada")?.last_login_at).toBeUndefined();
  });

  it("rate limits after 10 failures in the window", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await auth.login({
        email: "ada@example.com",
        password: "wrong-password",
        remoteIp: "1.2.3.4",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
      }
    }
    const limited = await auth.login({
      email: "ada@example.com",
      password: "wrong-password",
      remoteIp: "1.2.3.4",
    });
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.status).toBe(429);
      expect(limited.retry_after_seconds).toBeGreaterThan(0);
    }
  });

  it("bounds concurrent password checks for the same address and IP", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        auth.login({
          email: "ada@example.com",
          password: "wrong-password",
          remoteIp: "1.2.3.4",
        }),
      ),
    );
    expect(responses.filter((response) => response.status === 401)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(10);
  });

  it("resolves sessions until expiry and revocation", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const { store, auth } = setup({ now: () => current });
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    const login = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    if (!login.ok) {
      throw new Error("login failed");
    }
    const token = login.payload.session_token;
    expect((await auth.resolveSession(token))?.member.id).toBe("ada");

    await auth.logout(token);
    expect(await auth.resolveSession(token)).toBeUndefined();

    const relogin = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    if (!relogin.ok) {
      throw new Error("login failed");
    }
    expect((await auth.resolveSession(relogin.payload.session_token))?.member.id).toBe("ada");
    current = new Date("2026-02-01T00:00:00.000Z");
    expect(await auth.resolveSession(relogin.payload.session_token)).toBeUndefined();
  });

  it("prunes expired sessions on sign-in, not on every authenticated request", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const { store, auth } = setup({ now: () => current });
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const prune = vi.spyOn(store, "pruneSessionsBefore");

    const first = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    if (!first.ok) {
      throw new Error("login failed");
    }
    expect(prune).toHaveBeenCalledTimes(1);
    expect((await auth.resolveSession(first.payload.session_token))?.member.id).toBe("ada");
    expect((await auth.resolveSession(first.payload.session_token))?.member.id).toBe("ada");
    expect(prune).toHaveBeenCalledTimes(1);

    current = new Date("2026-01-09T00:00:00.000Z");
    expect(await auth.resolveSession(first.payload.session_token)).toBeUndefined();
    const second = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    expect(second.ok).toBe(true);
    expect(prune).toHaveBeenCalledTimes(2);
    expect(prune.mock.results[1]?.value).toBe(1);
  });

  it("records session activity at most once every five minutes", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const { store, auth } = setup({ now: () => current });
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const login = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    if (!login.ok) {
      throw new Error("login failed");
    }
    const token = login.payload.session_token;
    const touch = vi.spyOn(store, "touchSession");

    for (let i = 0; i < 20; i++) {
      expect((await auth.resolveSession(token))?.member.id).toBe("ada");
    }
    current = new Date("2026-01-01T00:04:59.999Z");
    await auth.resolveSession(token);
    expect(touch).not.toHaveBeenCalled();

    current = new Date("2026-01-01T00:05:00.000Z");
    await auth.resolveSession(token);
    await auth.resolveSession(token);
    expect(touch).toHaveBeenCalledTimes(1);

    current = new Date("2026-01-01T00:10:00.000Z");
    await auth.resolveSession(token);
    expect(touch).toHaveBeenCalledTimes(2);
    await auth.logout(token);
    expect(await auth.resolveSession(token)).toBeUndefined();
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it("changes a password", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    const existingLogin = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    if (!existingLogin.ok) {
      throw new Error("login failed");
    }
    const oldToken = existingLogin.payload.session_token;
    const badChange = await auth.changePassword("ada", "wrong", "newpassword123");
    expect(badChange.ok).toBe(false);

    const change = await auth.changePassword("ada", "correcthorse", "newpassword123");
    expect(change.ok).toBe(true);
    expect(await auth.resolveSession(oldToken)).toBeUndefined();
    expect((await auth.login({ email: "ada@example.com", password: "newpassword123" })).ok).toBe(
      true,
    );
    expect((await auth.login({ email: "ada@example.com", password: "correcthorse" })).ok).toBe(
      false,
    );
  });

  it("allows only one of two concurrent changes using the old password", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    let releaseUpdates: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpdates = resolve;
    });
    let updatesWaiting = 0;
    const asyncStore = new Proxy(store, {
      get(target, key) {
        if (key === "changePasswordAndRevokeSessions") {
          return async (...args: Parameters<typeof target.changePasswordAndRevokeSessions>) => {
            updatesWaiting += 1;
            await gate;
            return target.changePasswordAndRevokeSessions(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const asyncAuth = new AdminBotAuthService({
      store: asyncStore,
      prepareMember: () => {
        throw new Error("not used by password change");
      },
    });
    const first = asyncAuth.changePassword("ada", "correcthorse", "new-password-one");
    const second = asyncAuth.changePassword("ada", "correcthorse", "new-password-two");
    await vi.waitFor(() => expect(updatesWaiting).toBe(2));
    releaseUpdates();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status).toSorted()).toEqual([200, 401]);
    const hash = store.getCredentialByMemberId("ada")?.password_scrypt ?? "";
    expect(
      verifyPassword(hash, "new-password-one") || verifyPassword(hash, "new-password-two"),
    ).toBe(true);
  });

  it("changes the login email across credential and member, keeping sessions valid", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const login = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    if (!login.ok) {
      throw new Error("login failed");
    }
    const token = login.payload.session_token;

    const changed = await auth.changeEmail("ada", "New.Ada@cs.toronto.edu", "correcthorse");
    expect(changed.ok).toBe(true);
    if (changed.ok) {
      expect(changed.payload.email).toBe("new.ada@cs.toronto.edu");
    }
    // Both the credential row and the member record carry the normalized email.
    expect(store.getCredentialByMemberId("ada")?.email).toBe("new.ada@cs.toronto.edu");
    expect(store.getLabMember("ada")?.email).toBe("new.ada@cs.toronto.edu");
    // Existing session survives the change.
    expect((await auth.resolveSession(token))?.member.id).toBe("ada");

    // New email logs in; the old email no longer resolves.
    expect(
      (await auth.login({ email: "new.ada@cs.toronto.edu", password: "correcthorse" })).ok,
    ).toBe(true);
    const old = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    expect(old.ok).toBe(false);
    if (!old.ok) {
      expect(old.status).toBe(401);
    }
  });

  it("rejects an email change with the wrong password", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const result = await auth.changeEmail("ada", "next@example.com", "wrong-password");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error.message).toBe("invalid password");
    }
    // Email is unchanged after a failed attempt.
    expect(store.getCredentialByMemberId("ada")?.email).toBe("ada@example.com");
  });

  it("rejects a malformed new email", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const result = await auth.changeEmail("ada", "not-an-email", "correcthorse");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  // A cs.toronto.edu address is preferred, not required, on the login identifier as much as on the
  // roster record: members routinely arrive with a CMU or an ETH address and work here for months
  // before a departmental account exists. Format is the whole check; the domain is not.
  it("accepts a non-institutional login email for a full member and a collaborator alike", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    expect(await auth.changeEmail("ada", "ada@gmail.com", "correcthorse")).toMatchObject({
      ok: true,
      payload: { email: "ada@gmail.com" },
    });

    store.saveLabMember(
      member("ada", "ada@gmail.com", {
        privilege_level: "external_collaborator",
        collaborator_subgroup: "visitor",
      }),
    );
    expect(await auth.changeEmail("ada", "ada@ethz.ch", "correcthorse")).toMatchObject({
      ok: true,
      payload: { email: "ada@ethz.ch" },
    });
  });

  it("still rejects an email it cannot parse", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    expect(await auth.changeEmail("ada", "not-an-email", "correcthorse")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("rejects an email colliding with another credential", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    await claimAndApprove(store, auth, "bob", "bob@cs.toronto.edu");
    const result = await auth.changeEmail("ada", "bob@cs.toronto.edu", "correcthorse");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error.message).toBe("email unavailable");
    }
    expect(store.getCredentialByMemberId("ada")?.email).toBe("ada@example.com");
  });

  it("rejects an email colliding with a pending registration", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    store.saveLabMember(member("cid", "cid@example.com"));
    await auth.claim({
      member_id: "cid",
      email: "pending@cs.toronto.edu",
      password: "correcthorse",
    });
    const result = await auth.changeEmail("ada", "pending@cs.toronto.edu", "correcthorse");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error.message).toBe("email unavailable");
    }
  });

  it("rate limits repeated email-change failures", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await auth.changeEmail("ada", "next@example.com", "wrong-password", "1.2.3.4");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
      }
    }
    const limited = await auth.changeEmail("ada", "next@example.com", "wrong-password", "1.2.3.4");
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.status).toBe(429);
      expect(limited.retry_after_seconds).toBeGreaterThan(0);
    }
  });
});

describe("AdminBotAuthService signup role vocabulary", () => {
  it("rejects a role the vocabulary does not contain, at the door", async () => {
    // Checked at signup, not only at approval: accepting it here gave the person a success screen
    // and left an admin holding a registration that could never be approved.
    const { auth } = setup();
    expect(
      await auth.signup({
        profile: { name: "Legacy Role", role: "Research scientist" },
        email: "legacy-role@example.com",
        password: "correcthorse",
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("accepts a role that differs only in case and stores the canonical spelling", async () => {
    const { auth } = setup();
    expect(
      (
        await auth.signup({
          profile: { name: "Case Role", role: "phd student" },
          email: "case-role@example.com",
          password: "correcthorse",
        })
      ).ok,
    ).toBe(true);
    const registration = (await auth.listRegistrations("pending")).find(
      (entry) => entry.profile?.name === "Case Role",
    );
    expect(registration?.profile?.role).toBe("PhD Student");
  });

  it("still approves a registration that predates the vocabulary, keeping the answer in notes", async () => {
    // A person waiting on an account is not refused one because their role was recorded before the
    // list existed; the submitted text moves to notes for an admin to resolve.
    const { store, auth } = setup();
    store.saveAccountRegistration({
      id: "reg_legacy",
      kind: "signup",
      email: "waiting@example.com",
      password_scrypt: hashPassword("correcthorse"),
      profile_json: JSON.stringify({ name: "Waiting Person", role: "Research scientist" }),
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    const approved = await auth.approveRegistration("reg_legacy", "admin");

    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }
    const created = store.getLabMember(approved.payload.member_id);
    expect(created?.role ?? "").toBe("");
    expect(created?.notes).toContain("Role as submitted: Research scientist");
  });
});

describe("login IP location update", () => {
  it("leaves an existing location untouched when the lookup resolves nothing (private IP, provider failure)", async () => {
    const geolocateIp = async () => undefined;
    const { store, auth } = setup({ geolocateIp });
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const before = store.getLabMember("ada");
    store.saveLabMember({ ...before!, location: "Existing City" });

    await auth.login({
      email: "ada@example.com",
      password: "correcthorse",
      remoteIp: "127.0.0.1",
    });
    await flushMicrotasks();

    expect(store.getLabMember("ada")?.location).toBe("Existing City");
  });

  it("never runs the lookup when no geolocateIp dependency is configured", async () => {
    const { store, auth } = setup();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    const login = await auth.login({
      email: "ada@example.com",
      password: "correcthorse",
      remoteIp: "203.0.113.5",
    });
    expect(login.ok).toBe(true);
    await flushMicrotasks();

    expect(store.getLabMember("ada")?.location).toBeUndefined();
  });
});

describe("AdminBotAuthService password reset", () => {
  function setupWithMail() {
    const sent: Array<{ email: string; token: string; expiresInMinutes: number }> = [];
    const { store, auth } = setup({
      sendPasswordResetEmail: async (params) => {
        sent.push({
          email: params.email,
          token: params.token,
          expiresInMinutes: params.expiresInMinutes,
        });
      },
    });
    return { store, auth, sent };
  }

  it("mails a reset link to a member who has an account", async () => {
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    const result = await auth.requestPasswordReset({ email: "ada@example.com" });

    expect(result.ok).toBe(true);
    await flushMicrotasks();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe("ada@example.com");
    expect(sent[0]?.token).toBeTruthy();
  });

  it("mails the reset to the correspondence address when the member has one", async () => {
    // The login address is the departmental identity the account is keyed by; the correspondence
    // address is the one the member actually reads. For anyone without a cs.toronto.edu account
    // yet, sending to the login address is sending to a mailbox that does not exist.
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@cs.toronto.edu");
    const member = store.getLabMember("ada")!;
    store.saveLabMember({ ...member, correspondence_email: "ada@cmu.edu" });

    await auth.requestPasswordReset({ email: "ada@cs.toronto.edu" });

    await flushMicrotasks();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe("ada@cmu.edu");
  });

  it("still identifies the account by the login address, not the correspondence one", async () => {
    // Only the destination moved. Typing the correspondence address at the login screen must not
    // find an account -- credentials are keyed by the login email, and answering otherwise would
    // make this route a membership oracle over a second set of addresses.
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@cs.toronto.edu");
    const member = store.getLabMember("ada")!;
    store.saveLabMember({ ...member, correspondence_email: "ada@cmu.edu" });

    const result = await auth.requestPasswordReset({ email: "ada@cmu.edu" });

    expect(result.ok).toBe(true);
    await flushMicrotasks();
    expect(sent).toHaveLength(0);
  });

  it("falls back to the login address when there is no correspondence one", async () => {
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@cs.toronto.edu");
    const member = store.getLabMember("ada")!;
    store.saveLabMember({ ...member, correspondence_email: "   " });

    await auth.requestPasswordReset({ email: "ada@cs.toronto.edu" });

    await flushMicrotasks();
    expect(sent[0]?.email).toBe("ada@cs.toronto.edu");
  });

  it("answers identically for an unknown address and mails nothing", async () => {
    const { auth, sent } = setupWithMail();

    const result = await auth.requestPasswordReset({ email: "nobody@example.com" });

    // Same shape as the known-address case: this route must not reveal who is on the roster.
    expect(result.ok).toBe(true);
    await flushMicrotasks();
    expect(sent).toHaveLength(0);
  });

  it("stores only the hash of the emailed token", async () => {
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    await auth.requestPasswordReset({ email: "ada@example.com" });
    await flushMicrotasks();

    const rawToken = sent[0]?.token ?? "";
    expect(store.getPasswordResetByTokenHash(rawToken)).toBeUndefined();
  });

  it("resets the password, so the new one logs in and the old one does not", async () => {
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    await auth.requestPasswordReset({ email: "ada@example.com" });
    await flushMicrotasks();

    const result = await auth.resetPassword({
      token: sent[0]?.token ?? "",
      newPassword: "brand-new-passphrase",
    });

    expect(result.ok).toBe(true);
    expect(
      (await auth.login({ email: "ada@example.com", password: "brand-new-passphrase" })).ok,
    ).toBe(true);
    expect((await auth.login({ email: "ada@example.com", password: "correcthorse" })).ok).toBe(
      false,
    );
  });

  it("burns the token so the same link cannot be replayed", async () => {
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    await auth.requestPasswordReset({ email: "ada@example.com" });
    await flushMicrotasks();
    const token = sent[0]?.token ?? "";
    await auth.resetPassword({ token, newPassword: "brand-new-passphrase" });

    const replay = await auth.resetPassword({ token, newPassword: "another-passphrase-x" });

    expect(replay.ok).toBe(false);
    expect(
      (await auth.login({ email: "ada@example.com", password: "another-passphrase-x" })).ok,
    ).toBe(false);
  });

  it("allows only one concurrent redemption of the same reset link", async () => {
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    await auth.requestPasswordReset({ email: "ada@example.com" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    let releaseResets: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseResets = resolve;
    });
    let resetsWaiting = 0;
    const asyncStore = new Proxy(store, {
      get(target, key) {
        if (key === "consumePasswordResetAndRevokeSessions") {
          return async (
            ...args: Parameters<typeof target.consumePasswordResetAndRevokeSessions>
          ) => {
            resetsWaiting += 1;
            await gate;
            return target.consumePasswordResetAndRevokeSessions(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const asyncAuth = new AdminBotAuthService({
      store: asyncStore,
      prepareMember: () => {
        throw new Error("not used by password reset");
      },
    });
    const token = sent[0]?.token ?? "";
    const first = asyncAuth.resetPassword({ token, newPassword: "new-password-one" });
    const second = asyncAuth.resetPassword({ token, newPassword: "new-password-two" });
    await vi.waitFor(() => expect(resetsWaiting).toBe(2));
    releaseResets();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status).toSorted()).toEqual([200, 400]);
    const hash = store.getCredentialByMemberId("ada")?.password_scrypt ?? "";
    expect(
      verifyPassword(hash, "new-password-one") || verifyPassword(hash, "new-password-two"),
    ).toBe(true);
  });

  it("rejects an expired link", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const sent: Array<{ token: string }> = [];
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store);
    const auth = new AdminBotAuthService({
      store,
      prepareMember: (input) => {
        const result = service.prepareLabMember(input);
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.payload;
      },
      afterMemberCreated: (member) => service.afterMemberCreated(member),
      gatewayUrl: GATEWAY_URL,
      now: () => now,
      sendPasswordResetEmail: async (params) => {
        sent.push({ token: params.token });
      },
    });
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    await auth.requestPasswordReset({ email: "ada@example.com" });
    await flushMicrotasks();
    // Tokens live an hour; step just past it.
    now = new Date("2026-01-01T01:00:01.000Z");

    const result = await auth.resetPassword({
      token: sent[0]?.token ?? "",
      newPassword: "brand-new-passphrase",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects an unknown token", async () => {
    const { store, auth } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@example.com");

    const result = await auth.resetPassword({
      token: "not-a-real-token",
      newPassword: "long-enough-pw",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a too-short new password and leaves the old one working", async () => {
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    await auth.requestPasswordReset({ email: "ada@example.com" });
    await flushMicrotasks();

    const result = await auth.resetPassword({ token: sent[0]?.token ?? "", newPassword: "short" });

    expect(result.ok).toBe(false);
    expect((await auth.login({ email: "ada@example.com", password: "correcthorse" })).ok).toBe(
      true,
    );
  });

  it("signs existing sessions out, because a reset means the account may be compromised", async () => {
    const { store, auth, sent } = setupWithMail();
    await claimAndApprove(store, auth, "ada", "ada@example.com");
    const login = await auth.login({ email: "ada@example.com", password: "correcthorse" });
    const sessionToken = login.ok ? login.payload.session_token : "";
    expect(await auth.resolveSession(sessionToken)).toBeTruthy();
    await auth.requestPasswordReset({ email: "ada@example.com" });
    await flushMicrotasks();

    await auth.resetPassword({ token: sent[0]?.token ?? "", newPassword: "brand-new-passphrase" });

    expect(await auth.resolveSession(sessionToken)).toBeFalsy();
  });
});

describe("AdminBotAuthService impersonation", () => {
  // An admin and a plain member, both signed in, which is the state every case below starts from.
  async function twoAccounts(now?: () => Date) {
    const { store, auth } = setup(now ? { now } : {});
    await claimAndApprove(store, auth, "root", "root@cs.toronto.edu");
    // After the claim, not before: claimAndApprove writes the roster row itself, so promoting
    // first would be overwritten by it.
    store.saveLabMember(member("root", "root@cs.toronto.edu", { privilege_level: "admin" }));
    await claimAndApprove(store, auth, "ada", "ada@cs.toronto.edu");
    const login = await auth.login({ email: "root@cs.toronto.edu", password: "correcthorse" });
    if (!login.ok) {
      throw new Error("admin login failed");
    }
    const admin = await auth.resolveSession(login.payload.session_token);
    if (!admin) {
      throw new Error("admin session did not resolve");
    }
    return { store, auth, admin, adminToken: login.payload.session_token };
  }

  async function impersonate(
    auth: AdminBotAuthService,
    admin: Awaited<ReturnType<typeof twoAccounts>>["admin"],
  ) {
    const started = await auth.startImpersonation({ admin, memberId: "ada" });
    if (!started.ok) {
      throw new Error(started.error.message);
    }
    return started.payload.session_token;
  }

  it("resolves as the member being viewed, while naming the admin behind it", async () => {
    const { auth, admin } = await twoAccounts();
    const principal = await auth.resolveSession(await impersonate(auth, admin));
    // The member is the one being viewed -- this is what makes every route serve their view
    // without knowing impersonation exists.
    expect(principal?.member.id).toBe("ada");
    // And the admin is still recoverable, which is what attribution and the banner need.
    expect(principal?.impersonator?.id).toBe("root");
    expect(principal?.session.impersonated_by).toBe("root");
  });

  it("leaves the admin's own session working, so there is a way back", async () => {
    const { auth, admin, adminToken } = await twoAccounts();
    await impersonate(auth, admin);
    const own = await auth.resolveSession(adminToken);
    expect(own?.member.id).toBe("root");
    expect(own?.impersonator).toBeUndefined();
  });

  it("takes the impersonated member's privilege, not the admin's", async () => {
    const { auth, admin } = await twoAccounts();
    const principal = await auth.resolveSession(await impersonate(auth, admin));
    // Viewing as a plain member means losing admin routes for the duration. That is the feature:
    // an admin who kept their own privileges would not be seeing what the member sees.
    expect(principal?.member.privilege_level).toBe("member");
  });

  it("refuses a non-admin, a self-impersonation, an unknown member, and nesting", async () => {
    const { store, auth, admin } = await twoAccounts();
    await claimAndApprove(store, auth, "grace", "grace@cs.toronto.edu");
    const adaLogin = await auth.login({ email: "ada@cs.toronto.edu", password: "correcthorse" });
    if (!adaLogin.ok) {
      throw new Error("member login failed");
    }
    const ada = await auth.resolveSession(adaLogin.payload.session_token);
    if (!ada) {
      throw new Error("member session did not resolve");
    }
    expect(await auth.startImpersonation({ admin: ada, memberId: "grace" })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await auth.startImpersonation({ admin, memberId: "root" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await auth.startImpersonation({ admin, memberId: "nobody" })).toMatchObject({
      ok: false,
      status: 404,
    });
    // No nesting: the chain of who is really acting has to stay one link long.
    const viewing = await auth.resolveSession(await impersonate(auth, admin));
    if (!viewing) {
      throw new Error("impersonated session did not resolve");
    }
    expect(await auth.startImpersonation({ admin: viewing, memberId: "grace" })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("stops dead when the admin behind it loses admin", async () => {
    const { store, auth, admin } = await twoAccounts();
    const token = await impersonate(auth, admin);
    expect((await auth.resolveSession(token))?.member.id).toBe("ada");
    const root = store.getLabMember("root");
    if (!root) {
      throw new Error("admin missing");
    }
    store.saveLabMember({ ...root, privilege_level: "member" });
    // Not merely denied on the next admin route -- the session itself is gone, so a demotion
    // cannot leave a token behind that outlives the access that justified it.
    expect(await auth.resolveSession(token)).toBeUndefined();
  });

  it("expires on its own well before a normal session would", async () => {
    let nowMs = Date.parse("2026-09-03T10:00:00.000Z");
    const { auth, admin } = await twoAccounts(() => new Date(nowMs));
    const token = await impersonate(auth, admin);
    nowMs += 29 * 60 * 1000;
    expect((await auth.resolveSession(token))?.member.id).toBe("ada");
    nowMs += 2 * 60 * 1000;
    expect(await auth.resolveSession(token)).toBeUndefined();
  });

  it("ends on request, and refuses to end a session that is not one", async () => {
    const { auth, admin, adminToken } = await twoAccounts();
    const token = await impersonate(auth, admin);
    expect(await auth.endImpersonation(token)).toMatchObject({ ok: true });
    expect(await auth.resolveSession(token)).toBeUndefined();
    // The admin is still signed in as themselves -- ending a view is not a logout.
    expect((await auth.resolveSession(adminToken))?.member.id).toBe("root");
    // A stray call on a normal session must not sign anybody out by accident.
    expect(await auth.endImpersonation(adminToken)).toMatchObject({ ok: false, status: 400 });
    expect((await auth.resolveSession(adminToken))?.member.id).toBe("root");
  });

  it("records both halves against the admin, naming who was viewed", async () => {
    const { store, auth, admin } = await twoAccounts();
    const token = await impersonate(auth, admin);
    await auth.endImpersonation(token);
    const events = store
      .listAuditEvents()
      .filter((event) => event.type.startsWith("auth.impersonation"));
    expect(events.map((event) => event.type)).toEqual([
      "auth.impersonation_started",
      "auth.impersonation_ended",
    ]);
    for (const event of events) {
      // On the admin, always: "who was looking at my account" is the question this answers.
      expect(event.actor).toBe("root");
      expect(event.details?.member_id).toBe("ada");
    }
  });

  it("tells the browser it is impersonating, so it can offer a way out", async () => {
    const { auth, admin } = await twoAccounts();
    const principal = await auth.resolveSession(await impersonate(auth, admin));
    if (!principal) {
      throw new Error("impersonated session did not resolve");
    }
    expect(auth.sessionView(principal)).toMatchObject({
      member: { id: "ada" },
      impersonated_by: { id: "root", name: "root" },
    });
    // A normal session says nothing, so the banner is driven by presence rather than a flag the
    // client has to remember to check against the member id.
    const own = await auth.resolveSession(
      await (async () => {
        const login = await auth.login({ email: "ada@cs.toronto.edu", password: "correcthorse" });
        if (!login.ok) {
          throw new Error("member login failed");
        }
        return login.payload.session_token;
      })(),
    );
    if (!own) {
      throw new Error("member session did not resolve");
    }
    expect(auth.sessionView(own).impersonated_by).toBeUndefined();
  });
});

describe("lab calendar invite backfill", () => {
  // The repair path's whole reason for existing: these members were approved while
  // ADMINBOT_LAB_EMAIL was unset, so every invite failed and nothing ever tried again.
  function labWith(
    invites: string[],
    fail?: (email: string) => string,
    // Records the options each grant was made with, so a test can assert on the notification flag
    // without every other test having to care about it.
    notified?: Array<boolean | undefined>,
  ) {
    const { store, auth } = setup();
    const inviteToLabCalendar = async (
      email: string,
      options?: { sendNotifications?: boolean },
    ) => {
      const message = fail?.(email);
      if (message) {
        throw new Error(message);
      }
      invites.push(email);
      notified?.push(options?.sendNotifications);
    };
    const withRunner = new AdminBotAuthService({
      store,
      prepareMember: (input) => {
        const result = new AdminBotService(store).prepareLabMember(input);
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.payload;
      },
      afterMemberCreated: (member) => new AdminBotService(store).afterMemberCreated(member),
      inviteToLabCalendar,
    });
    return { store, auth: withRunner, plainAuth: auth };
  }

  function seed(
    store: AdminBotMemoryStore,
    id: string,
    overrides: Partial<AdminBotLabMember> = {},
  ) {
    store.saveLabMember({
      ...member(id, `${id}@cs.toronto.edu`),
      privilege_level: "member",
      ...overrides,
    });
  }

  it("plans without sending anything by default", async () => {
    const invites: string[] = [];
    const { store, auth } = labWith(invites);
    seed(store, "ada");
    seed(store, "grace");
    const result = await auth.backfillLabCalendarInvites({ actorId: "root" });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.payload.dry_run).toBe(true);
    expect(result.payload.granted.map((entry) => entry.id).toSorted()).toEqual(["ada", "grace"]);
    // The point of the default: a run that mails 155 people must be asked for, never stumbled into.
    expect(invites).toEqual([]);
  });

  it("grants and audits when asked for the write", async () => {
    const invites: string[] = [];
    const { store, auth } = labWith(invites);
    seed(store, "ada");
    const result = await auth.backfillLabCalendarInvites({ actorId: "root", dryRun: false });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(invites).toEqual(["ada@cs.toronto.edu"]);
    expect(result.payload.granted).toHaveLength(1);
    const sent = store
      .listAuditEvents()
      .filter((event) => event.type === "auth.calendar_invite_sent");
    expect(sent).toHaveLength(1);
    // Marked as a backfill so the audit trail can tell a repair from an onboarding, and recorded
    // against the admin who ran it rather than the member it was for.
    expect(sent[0]?.details).toMatchObject({ member_id: "ada", backfill: true });
    expect(sent[0]?.actor).toBe("root");
  });

  it("skips anybody already invited, so nobody is mailed twice", async () => {
    const invites: string[] = [];
    const { store, auth } = labWith(invites);
    seed(store, "ada");
    seed(store, "grace");
    store.recordAudit({
      id: "aud_prior",
      timestamp: "2026-08-01T00:00:00.000Z",
      type: "auth.calendar_invite_sent",
      actor: "root",
      details: { member_id: "ada" },
    });
    const result = await auth.backfillLabCalendarInvites({ actorId: "root", dryRun: false });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    // The ACL write is idempotent; the mail Google sends on it is not.
    expect(invites).toEqual(["grace@cs.toronto.edu"]);
    expect(result.payload.already_invited).toBe(1);
  });

  it("leaves out people the lab calendar is not for", async () => {
    const invites: string[] = [];
    const { store, auth } = labWith(invites);
    seed(store, "ada");
    seed(store, "ext", { privilege_level: "external_collaborator" });
    seed(store, "gone", { status: "alumni" });
    const result = await auth.backfillLabCalendarInvites({ actorId: "root", dryRun: false });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    // Same predicate the standing-invite sweep uses, so "who is on the lab calendar" keeps one
    // answer rather than gaining a second one here.
    expect(invites).toEqual(["ada@cs.toronto.edu"]);
  });

  it("prefers the Google address over the departmental one", async () => {
    const invites: string[] = [];
    const { store, auth } = labWith(invites);
    seed(store, "ada", { calendar_email: "ada.personal@gmail.com" });
    await auth.backfillLabCalendarInvites({ actorId: "root", dryRun: false });
    // A calendar ACL is granted to a Google identity; the professional address on file is often a
    // departmental alias that is not one.
    expect(invites).toEqual(["ada.personal@gmail.com"]);
  });

  it("reports members with no address instead of inventing one", async () => {
    const invites: string[] = [];
    const { store, auth } = labWith(invites);
    seed(store, "ada");
    store.saveLabMember({
      ...member("noaddr", ""),
      privilege_level: "member",
      email: undefined as unknown as string,
    });
    const result = await auth.backfillLabCalendarInvites({ actorId: "root", dryRun: false });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.payload.no_address.map((entry) => entry.id)).toEqual(["noaddr"]);
    expect(invites).toEqual(["ada@cs.toronto.edu"]);
  });

  it("stops after the first failure rather than burning the batch on one broken variable", async () => {
    const invites: string[] = [];
    const { store, auth } = labWith(invites, () => "the lab calendar is not configured");
    for (const id of ["ada", "grace", "hopper"]) {
      seed(store, id);
    }
    const result = await auth.backfillLabCalendarInvites({ actorId: "root", dryRun: false });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    // A missing variable fails identically for everybody. Attempting all 155 teaches nothing and
    // writes 155 audit rows saying the same thing.
    expect(result.payload.failed).toHaveLength(1);
    expect(result.payload.granted).toHaveLength(0);
    expect(result.payload.failed[0]?.error).toContain("not configured");
  });

  it("walks the roster in batches and says how many are left", async () => {
    const invites: string[] = [];
    const { store, auth } = labWith(invites);
    for (const id of ["ada", "grace", "hopper"]) {
      seed(store, id);
    }
    const result = await auth.backfillLabCalendarInvites({
      actorId: "root",
      dryRun: false,
      limit: 2,
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(invites).toHaveLength(2);
    expect(result.payload.remaining).toBe(1);
  });

  it("grants silently, unlike the invite onboarding sends", async () => {
    const invites: string[] = [];
    const notified: Array<boolean | undefined> = [];
    const { store, auth } = labWith(invites, undefined, notified);
    seed(store, "ada");
    await auth.backfillLabCalendarInvites({ actorId: "root", dryRun: false });
    // The share notification is how a *new* member finds out the calendar exists. On a backfill it
    // announces a months-old oversight to people who may have left the lab a year ago, and 150 at
    // once reads as a compromise. The access is granted either way.
    expect(notified).toEqual([false]);
  });

  it("leaves the onboarding invite noisy, which is the half that should be", async () => {
    const invites: string[] = [];
    const notified: Array<boolean | undefined> = [];
    const { store, auth } = labWith(invites, undefined, notified);
    store.saveLabMember(member("ada", "ada@cs.toronto.edu"));
    await auth.claim({ member_id: "ada", email: "ada@cs.toronto.edu", password: "correcthorse" });
    await auth.approveRegistration(await pendingIdForMember(auth, "ada"), "root");
    await flushMicrotasks();
    // Undefined, not false: the approval path says nothing and the runner defaults to notifying.
    // Asserted because the two paths differing is the whole point of the option -- a later change
    // that flipped the default would silence onboarding without any test noticing.
    expect(invites).toEqual(["ada@cs.toronto.edu"]);
    expect(notified).toEqual([undefined]);
  });

  it("refuses when the deployment has no calendar runner at all", async () => {
    const { plainAuth } = labWith([]);
    // Distinct from a failed grant: there is nothing to retry, and a 503 says so.
    expect(await plainAuth.backfillLabCalendarInvites({ actorId: "root" })).toMatchObject({
      ok: false,
      status: 503,
    });
  });
});
