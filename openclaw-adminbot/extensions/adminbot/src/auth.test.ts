import { describe, expect, it } from "vitest";
import { AdminBotAuthService, hashPassword, verifyPassword } from "./auth.js";
import type { AdminBotLabMember } from "./contracts.js";
import { AdminBotMemoryStore, AdminBotService } from "./service-core.js";

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
  options: { now?: () => Date; gatewayToken?: string; gatewayUrl?: string | null } = {},
) {
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(store);
  const auth = new AdminBotAuthService({
    store,
    createMember: (input) => {
      const result = service.upsertLabMember(input);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.payload;
    },
    ...(options.gatewayUrl === null ? {} : { gatewayUrl: options.gatewayUrl ?? GATEWAY_URL }),
    ...(options.gatewayToken ? { gatewayToken: options.gatewayToken } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { store, auth };
}

function pendingIdForMember(auth: AdminBotAuthService, memberId: string): string {
  const registration = auth
    .listRegistrations("pending")
    .find((entry) => entry.member_id === memberId);
  if (!registration) {
    throw new Error(`no pending registration for ${memberId}`);
  }
  return registration.id;
}

function claimAndApprove(
  store: AdminBotMemoryStore,
  auth: AdminBotAuthService,
  id: string,
  email: string,
  password = "correcthorse",
): void {
  store.saveLabMember(member(id, email));
  auth.claim({ member_id: id, email, password });
  auth.approveRegistration(pendingIdForMember(auth, id), "admin");
}

describe("hashPassword / verifyPassword", () => {
  it("round-trips and rejects wrong passwords", () => {
    const serialized = hashPassword("correcthorsebattery");
    expect(serialized.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(verifyPassword(serialized, "correcthorsebattery")).toBe(true);
    expect(verifyPassword(serialized, "wrong")).toBe(false);
  });

  it("rejects malformed serialized hashes", () => {
    expect(verifyPassword("not-a-hash", "x")).toBe(false);
    expect(verifyPassword("scrypt$16384$8$1$abc", "x")).toBe(false);
  });
});

describe("AdminBotAuthService claim/login flow", () => {
  it("claim queues a pending registration without a session or credential", () => {
    const { store, auth } = setup();
    store.saveLabMember(member("ada", "ada@example.com"));

    const result = auth.claim({
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

  it("blocks login on a pending registration with a distinct pending_approval code", () => {
    const { store, auth } = setup();
    store.saveLabMember(member("ada", "ada@example.com"));
    auth.claim({ member_id: "ada", email: "ada@example.com", password: "correcthorse" });

    const pending = auth.login({ email: "ada@example.com", password: "correcthorse" });
    expect(pending.ok).toBe(false);
    if (!pending.ok) {
      expect(pending.status).toBe(403);
      expect(pending.code).toBe("pending_approval");
    }

    // Wrong password against a pending registration stays a generic 401.
    const wrong = auth.login({ email: "ada@example.com", password: "totally-wrong" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.status).toBe(401);
      expect(wrong.code).toBeUndefined();
    }
  });

  it("approves a claim, then login succeeds with a session and gateway", () => {
    const { store, auth } = setup({ gatewayToken: "gw-token" });
    store.saveLabMember(member("ada", "ada@example.com"));
    auth.claim({ member_id: "ada", email: "ada@example.com", password: "correcthorse" });

    const approved = auth.approveRegistration(pendingIdForMember(auth, "ada"), "admin-1");
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.payload.member_id).toBe("ada");
    }
    expect(store.getCredentialByMemberId("ada")).toBeDefined();

    const login = auth.login({ email: "ada@example.com", password: "correcthorse" });
    expect(login.ok).toBe(true);
    if (!login.ok) {
      return;
    }
    expect(login.payload.member.id).toBe("ada");
    expect(login.payload.session_token).toBeTruthy();
    expect(login.payload.gateway).toEqual({ url: GATEWAY_URL, token: "gw-token" });
    expect(auth.resolveSession(login.payload.session_token)?.member.id).toBe("ada");
  });

  // The service cannot know how a given browser reaches the gateway, so with no URL configured it
  // advertises only the token and the client keeps the URL it already connects with. Advertising a
  // loopback guess instead pointed every remote member at their own machine on sign-in.
  it("omits the gateway url when none is configured", () => {
    const { store, auth } = setup({ gatewayToken: "gw-token", gatewayUrl: null });
    store.saveLabMember(member("ada", "ada@example.com"));
    auth.claim({ member_id: "ada", email: "ada@example.com", password: "correcthorse" });
    auth.approveRegistration(pendingIdForMember(auth, "ada"), "admin-1");

    const login = auth.login({ email: "ada@example.com", password: "correcthorse" });
    expect(login.ok).toBe(true);
    if (!login.ok) {
      return;
    }
    expect(login.payload.gateway).toEqual({ token: "gw-token" });
    const principal = auth.resolveSession(login.payload.session_token);
    expect(principal && auth.sessionView(principal).gateway).toEqual({ token: "gw-token" });
  });

  it("signup approval mints a plain member and enables login", () => {
    const { store, auth } = setup();
    const signup = auth.signup({
      profile: { name: "New Person", research_branch: "ML", research_topics: ["rl"] },
      email: "new@example.com",
      password: "correcthorse",
    });
    expect(signup.ok).toBe(true);

    const registration = auth.listRegistrations("pending").find((entry) => entry.kind === "signup");
    expect(registration?.profile).toMatchObject({ name: "New Person" });
    const approved = auth.approveRegistration(registration!.id, "admin");
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }
    const created = store.getLabMember(approved.payload.member_id);
    expect(created?.name).toBe("New Person");
    expect(created?.privilege_level).toBe("member");

    expect(auth.login({ email: "new@example.com", password: "correcthorse" }).ok).toBe(true);
  });

  it("rejected registrations behave as unknown on login", () => {
    const { store, auth } = setup();
    store.saveLabMember(member("rj", "rj@example.com"));
    auth.claim({ member_id: "rj", email: "rj@example.com", password: "correcthorse" });
    auth.rejectRegistration(pendingIdForMember(auth, "rj"), "admin");

    const login = auth.login({ email: "rj@example.com", password: "correcthorse" });
    expect(login.ok).toBe(false);
    if (!login.ok) {
      expect(login.status).toBe(401);
      expect(login.code).toBeUndefined();
    }
  });

  it("roster excludes claimed and pending-claim members", () => {
    const { store, auth } = setup();
    store.saveLabMember(member("a", "a@example.com"));
    store.saveLabMember(member("b", "b@example.com"));
    store.saveLabMember(member("c", "c@example.com"));
    // b has a pending claim, a is fully claimed, c is untouched.
    auth.claim({ member_id: "b", email: "b@example.com", password: "correcthorse" });
    claimAndApprove(store, auth, "a", "a2@example.com");

    const roster = auth.listRoster();
    expect(roster).toEqual([{ id: "c", name: "c" }]);
  });

  it("rejects short passwords for claim and signup", () => {
    const { store, auth } = setup();
    store.saveLabMember(member("ada", "ada@example.com"));
    const claim = auth.claim({ member_id: "ada", email: "ada@example.com", password: "short" });
    expect(claim.ok).toBe(false);
    if (!claim.ok) {
      expect(claim.status).toBe(400);
    }
    const signup = auth.signup({
      profile: { name: "X" },
      email: "x@example.com",
      password: "short",
    });
    expect(signup.ok).toBe(false);
    if (!signup.ok) {
      expect(signup.status).toBe(400);
    }
  });

  it("signup accepts the full self-editable profile field set", () => {
    const { store, auth } = setup();
    const signup = auth.signup({
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

    const registration = auth
      .listRegistrations("pending")
      .find((entry) => entry.kind === "signup" && entry.profile?.name === "Full Profile");
    const approved = auth.approveRegistration(registration!.id, "admin");
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

  it("rejects signup profiles with non-numeric hours_per_week", () => {
    const { auth } = setup();
    const badHours = auth.signup({
      profile: { name: "Bad Hours", hours_per_week: "twenty" as unknown as number },
      email: "bad-hours@example.com",
      password: "correcthorse",
    });
    expect(badHours.ok).toBe(false);
    if (!badHours.ok) {
      expect(badHours.status).toBe(400);
    }
  });

  it("rejects signup profiles missing a name or with unknown keys", () => {
    const { auth } = setup();
    const noName = auth.signup({
      profile: { affiliation: "Lab" },
      email: "a@example.com",
      password: "correcthorse",
    });
    expect(noName.ok).toBe(false);
    const badKey = auth.signup({
      profile: { name: "Y", privilege_level: "admin" },
      email: "b@example.com",
      password: "correcthorse",
    });
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) {
      expect(badKey.status).toBe(400);
    }
  });

  it("returns a generic 403 for unknown, already-claimed, and colliding emails", () => {
    const { store, auth } = setup();
    store.saveLabMember(member("x", "x@example.com"));
    store.saveLabMember(member("y", "y@example.com"));

    const unknown = auth.claim({
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
    auth.claim({ member_id: "x", email: "shared@example.com", password: "correcthorse" });
    const collision = auth.claim({
      member_id: "y",
      email: "shared@example.com",
      password: "correcthorse",
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.status).toBe(403);
    }
    // Re-claiming the same member is also generic.
    const dupeMember = auth.claim({
      member_id: "x",
      email: "other@example.com",
      password: "correcthorse",
    });
    expect(dupeMember.ok).toBe(false);

    const signupCollision = auth.signup({
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

  it("logs in with valid credentials and rejects bad ones generically", () => {
    const { store, auth } = setup();
    claimAndApprove(store, auth, "ada", "ada@example.com");

    expect(auth.login({ email: "ada@example.com", password: "correcthorse" }).ok).toBe(true);

    const badPassword = auth.login({ email: "ada@example.com", password: "nope-nope-nope" });
    expect(badPassword.ok).toBe(false);
    if (!badPassword.ok) {
      expect(badPassword.status).toBe(401);
      expect(badPassword.error.message).toBe("invalid email or password");
    }

    const unknown = auth.login({ email: "ghost@example.com", password: "whatever123" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.status).toBe(401);
    }
  });

  it("rate limits after 10 failures in the window", () => {
    const { store, auth } = setup();
    claimAndApprove(store, auth, "ada", "ada@example.com");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = auth.login({
        email: "ada@example.com",
        password: "wrong-password",
        remoteIp: "1.2.3.4",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
      }
    }
    const limited = auth.login({
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

  it("resolves sessions until expiry and revocation", () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const { store, auth } = setup({ now: () => current });
    claimAndApprove(store, auth, "ada", "ada@example.com");

    const login = auth.login({ email: "ada@example.com", password: "correcthorse" });
    if (!login.ok) {
      throw new Error("login failed");
    }
    const token = login.payload.session_token;
    expect(auth.resolveSession(token)?.member.id).toBe("ada");

    auth.logout(token);
    expect(auth.resolveSession(token)).toBeUndefined();

    const relogin = auth.login({ email: "ada@example.com", password: "correcthorse" });
    if (!relogin.ok) {
      throw new Error("login failed");
    }
    expect(auth.resolveSession(relogin.payload.session_token)?.member.id).toBe("ada");
    current = new Date("2026-02-01T00:00:00.000Z");
    expect(auth.resolveSession(relogin.payload.session_token)).toBeUndefined();
  });

  it("changes a password", () => {
    const { store, auth } = setup();
    claimAndApprove(store, auth, "ada", "ada@example.com");

    const badChange = auth.changePassword("ada", "wrong", "newpassword123");
    expect(badChange.ok).toBe(false);

    const change = auth.changePassword("ada", "correcthorse", "newpassword123");
    expect(change.ok).toBe(true);
    expect(auth.login({ email: "ada@example.com", password: "newpassword123" }).ok).toBe(true);
    expect(auth.login({ email: "ada@example.com", password: "correcthorse" }).ok).toBe(false);
  });

  it("changes the login email across credential and member, keeping sessions valid", () => {
    const { store, auth } = setup();
    claimAndApprove(store, auth, "ada", "ada@example.com");
    const login = auth.login({ email: "ada@example.com", password: "correcthorse" });
    if (!login.ok) {
      throw new Error("login failed");
    }
    const token = login.payload.session_token;

    const changed = auth.changeEmail("ada", "New.Ada@Example.com", "correcthorse");
    expect(changed.ok).toBe(true);
    if (changed.ok) {
      expect(changed.payload.email).toBe("new.ada@example.com");
    }
    // Both the credential row and the member record carry the normalized email.
    expect(store.getCredentialByMemberId("ada")?.email).toBe("new.ada@example.com");
    expect(store.getLabMember("ada")?.email).toBe("new.ada@example.com");
    // Existing session survives the change.
    expect(auth.resolveSession(token)?.member.id).toBe("ada");

    // New email logs in; the old email no longer resolves.
    expect(auth.login({ email: "new.ada@example.com", password: "correcthorse" }).ok).toBe(true);
    const old = auth.login({ email: "ada@example.com", password: "correcthorse" });
    expect(old.ok).toBe(false);
    if (!old.ok) {
      expect(old.status).toBe(401);
    }
  });

  it("rejects an email change with the wrong password", () => {
    const { store, auth } = setup();
    claimAndApprove(store, auth, "ada", "ada@example.com");
    const result = auth.changeEmail("ada", "next@example.com", "wrong-password");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error.message).toBe("invalid password");
    }
    // Email is unchanged after a failed attempt.
    expect(store.getCredentialByMemberId("ada")?.email).toBe("ada@example.com");
  });

  it("rejects a malformed new email", () => {
    const { store, auth } = setup();
    claimAndApprove(store, auth, "ada", "ada@example.com");
    const result = auth.changeEmail("ada", "not-an-email", "correcthorse");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("rejects an email colliding with another credential", () => {
    const { store, auth } = setup();
    claimAndApprove(store, auth, "ada", "ada@example.com");
    claimAndApprove(store, auth, "bob", "bob@example.com");
    const result = auth.changeEmail("ada", "bob@example.com", "correcthorse");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error.message).toBe("email unavailable");
    }
    expect(store.getCredentialByMemberId("ada")?.email).toBe("ada@example.com");
  });

  it("rejects an email colliding with a pending registration", () => {
    const { store, auth } = setup();
    claimAndApprove(store, auth, "ada", "ada@example.com");
    store.saveLabMember(member("cid", "cid@example.com"));
    auth.claim({ member_id: "cid", email: "pending@example.com", password: "correcthorse" });
    const result = auth.changeEmail("ada", "pending@example.com", "correcthorse");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error.message).toBe("email unavailable");
    }
  });

  it("rate limits repeated email-change failures", () => {
    const { store, auth } = setup();
    claimAndApprove(store, auth, "ada", "ada@example.com");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = auth.changeEmail("ada", "next@example.com", "wrong-password", "1.2.3.4");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
      }
    }
    const limited = auth.changeEmail("ada", "next@example.com", "wrong-password", "1.2.3.4");
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.status).toBe(429);
      expect(limited.retry_after_seconds).toBeGreaterThan(0);
    }
  });
});
