import { expect, it } from "vitest";
import type {
  AdminBotAccountRegistration,
  AdminBotAuthSession,
  AdminBotLabMember,
} from "../contracts/actions.js";
import { AdminBotMemoryStore } from "./memory.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const then = "2026-09-24T00:00:00.000Z";
const now = "2026-09-24T01:00:00.000Z";

function registration(id: string, memberId: string, email: string): AdminBotAccountRegistration {
  return {
    id,
    kind: "claim",
    member_id: memberId,
    email,
    password_scrypt: "hash",
    status: "pending",
    created_at: then,
  };
}

function session(tokenHash: string): AdminBotAuthSession {
  return {
    token_hash: tokenHash,
    member_id: "ada",
    created_at: then,
    expires_at: "2026-09-25T00:00:00.000Z",
    last_seen_at: then,
  };
}

function member(id: string): AdminBotLabMember {
  return {
    id,
    name: id,
    privilege_level: "member",
    access: [],
    created_at: then,
    updated_at: now,
  };
}

it("commits signup member, credential and approval once, without overwriting another account", () => {
  for (const store of [new AdminBotMemoryStore(), new AdminBotSqliteStore(":memory:")]) {
    try {
      const signup: AdminBotAccountRegistration = {
        id: "signup",
        kind: "signup",
        email: "new@example.test",
        password_scrypt: "new-hash",
        status: "pending",
        created_at: then,
      };
      expect(store.trySavePendingRegistration(signup)).toBe(true);
      store.saveLabMember(member("existing"));
      expect(store.tryApproveRegistration("signup", "admin", now, member("existing"))).toEqual({
        ok: false,
        reason: "conflict",
      });
      expect(store.getAccountRegistration("signup")?.status).toBe("pending");
      expect(store.getCredentialByEmail(signup.email)).toBeUndefined();

      expect(store.tryApproveRegistration("signup", "admin", now, member("new"))).toEqual({
        ok: true,
        member_id: "new",
      });
      expect(store.getLabMember("new")).toEqual(member("new"));
      expect(store.getCredentialByEmail(signup.email)).toMatchObject({
        member_id: "new",
        password_scrypt: "new-hash",
      });
      expect(store.getAccountRegistration("signup")?.status).toBe("approved");
      expect(store.tryApproveRegistration("signup", "other", now, member("other"))).toEqual({
        ok: false,
        reason: "not_pending",
      });
      expect(store.getLabMember("other")).toBeUndefined();
    } finally {
      if (store instanceof AdminBotSqliteStore) store.close();
    }
  }
});

it("a rejected claim cannot later create or replace credentials", () => {
  for (const store of [new AdminBotMemoryStore(), new AdminBotSqliteStore(":memory:")]) {
    try {
      store.saveLabMember(member("ada"));
      expect(
        store.trySavePendingRegistration(registration("claim", "ada", "ada@example.test")),
      ).toBe(true);
      expect(store.updateAccountRegistrationDecision("claim", "rejected", "admin", now)).toBe(true);
      expect(store.tryApproveRegistration("claim", "other", now)).toEqual({
        ok: false,
        reason: "not_pending",
      });
      expect(store.updateAccountRegistrationDecision("claim", "approved", "other", now)).toBe(
        false,
      );
      expect(store.getCredentialByMemberId("ada")).toBeUndefined();
    } finally {
      if (store instanceof AdminBotSqliteStore) store.close();
    }
  }
});

it("an approval never overwrites a credential added after a claim was submitted", () => {
  for (const store of [new AdminBotMemoryStore(), new AdminBotSqliteStore(":memory:")]) {
    try {
      store.saveLabMember(member("ada"));
      expect(
        store.trySavePendingRegistration(registration("claim", "ada", "ada@example.test")),
      ).toBe(true);
      store.saveCredential({
        member_id: "ada",
        email: "ada@example.test",
        password_scrypt: "existing-hash",
        claimed_at: then,
        updated_at: then,
      });
      expect(store.tryApproveRegistration("claim", "admin", now)).toEqual({
        ok: false,
        reason: "conflict",
      });
      expect(store.getCredentialByMemberId("ada")?.password_scrypt).toBe("existing-hash");
      expect(store.getAccountRegistration("claim")?.status).toBe("pending");
    } finally {
      if (store instanceof AdminBotSqliteStore) store.close();
    }
  }
});

it("enforces pending email and member uniqueness at the SQLite write boundary", () => {
  const store = new AdminBotSqliteStore(":memory:");
  try {
    expect(store.trySavePendingRegistration(registration("a", "ada", "shared@example.com"))).toBe(
      true,
    );
    expect(store.trySavePendingRegistration(registration("b", "bea", "shared@example.com"))).toBe(
      false,
    );
    expect(store.trySavePendingRegistration(registration("c", "ada", "other@example.com"))).toBe(
      false,
    );
    store.updateAccountRegistrationDecision("a", "rejected", "admin", now);
    expect(store.trySavePendingRegistration(registration("b", "bea", "shared@example.com"))).toBe(
      true,
    );
  } finally {
    store.close();
  }
});

it("rejects a pending request when an approval claimed its email or member before insertion", () => {
  const store = new AdminBotSqliteStore(":memory:");
  try {
    store.saveCredential({
      member_id: "ada",
      email: "claimed@example.com",
      password_scrypt: "hash",
      claimed_at: then,
      updated_at: then,
    });
    expect(store.trySavePendingRegistration(registration("a", "bea", "claimed@example.com"))).toBe(
      false,
    );
    expect(store.trySavePendingRegistration(registration("b", "ada", "other@example.com"))).toBe(
      false,
    );
    expect(store.listAccountRegistrations("pending")).toEqual([]);
  } finally {
    store.close();
  }
});

it("keeps credential email unchanged when its member profile disappeared", () => {
  for (const store of [new AdminBotMemoryStore(), new AdminBotSqliteStore(":memory:")]) {
    try {
      store.saveCredential({
        member_id: "ada",
        email: "ada@example.com",
        password_scrypt: "hash",
        claimed_at: then,
        updated_at: then,
      });
      expect(store.changeMemberLoginEmail("ada", "new@example.com", "hash", now)).toBe("stale");
      expect(store.getCredentialByMemberId("ada")?.email).toBe("ada@example.com");
    } finally {
      if (store instanceof AdminBotSqliteStore) store.close();
    }
  }
});

it("refuses stale session and password writes after an atomic password change", () => {
  const store = new AdminBotSqliteStore(":memory:");
  try {
    store.saveCredential({
      member_id: "ada",
      email: "ada@example.com",
      password_scrypt: "old-hash",
      claimed_at: then,
      updated_at: then,
    });
    expect(store.saveSessionIfCredentialCurrent(session("before"), "old-hash")).toBe(true);
    expect(store.changePasswordAndRevokeSessions("ada", "old-hash", "new-hash", now)).toBe(true);
    expect(store.getSession("before")?.revoked_at).toBe(now);
    expect(store.saveSessionIfCredentialCurrent(session("after"), "old-hash")).toBe(false);
    expect(store.changePasswordAndRevokeSessions("ada", "old-hash", "third-hash", now)).toBe(false);
    expect(store.getCredentialByMemberId("ada")?.password_scrypt).toBe("new-hash");
  } finally {
    store.close();
  }
});

it("patches auth fields without replacing a member profile and changes email atomically", () => {
  const store = new AdminBotSqliteStore(":memory:");
  try {
    store.saveLabMember({
      id: "ada",
      name: "Ada",
      email: "ada@example.com",
      role: "Researcher",
      privilege_level: "member",
      access: [],
      created_at: then,
      updated_at: then,
    });
    store.saveCredential({
      member_id: "ada",
      email: "ada@example.com",
      password_scrypt: "old-hash",
      claimed_at: then,
      updated_at: then,
    });
    expect(
      store.patchLabMemberAuthFields("ada", { last_login_country: "Canada", updated_at: now }),
    ).toBe(true);
    expect(store.getLabMember("ada")?.role).toBe("Researcher");
    expect(store.changeMemberLoginEmail("ada", "new@example.com", "old-hash", now)).toBe("changed");
    expect(store.getLabMember("ada")).toMatchObject({
      email: "new@example.com",
      role: "Researcher",
      last_login_country: "Canada",
    });
    expect(store.getCredentialByMemberId("ada")?.email).toBe("new@example.com");
    expect(store.changeMemberLoginEmail("ada", "stale@example.com", "wrong-hash", now)).toBe(
      "stale",
    );
    expect(
      store.trySavePendingRegistration(registration("pending", "bea", "reserved@example.com")),
    ).toBe(true);
    expect(store.changeMemberLoginEmail("ada", "reserved@example.com", "old-hash", now)).toBe(
      "taken",
    );
    expect(store.getCredentialByMemberId("ada")?.email).toBe("new@example.com");
    expect(store.getLabMember("ada")?.email).toBe("new@example.com");
  } finally {
    store.close();
  }
});

it("consumes a reset token with the credential and session changes in one SQLite transaction", () => {
  const store = new AdminBotSqliteStore(":memory:");
  try {
    store.saveCredential({
      member_id: "ada",
      email: "ada@example.com",
      password_scrypt: "old-hash",
      claimed_at: then,
      updated_at: then,
    });
    store.savePasswordReset({
      token_hash: "reset",
      member_id: "ada",
      created_at: then,
      expires_at: "2026-09-25T00:00:00.000Z",
      used_at: null,
    });
    store.saveSession(session("active"));
    expect(store.consumePasswordResetAndRevokeSessions("reset", "new-hash", now)).toBe(true);
    expect(store.getPasswordResetByTokenHash("reset")?.used_at).toBe(now);
    expect(store.getSession("active")?.revoked_at).toBe(now);
    expect(store.getCredentialByMemberId("ada")?.password_scrypt).toBe("new-hash");
    expect(store.consumePasswordResetAndRevokeSessions("reset", "third-hash", now)).toBe(false);
    expect(store.getCredentialByMemberId("ada")?.password_scrypt).toBe("new-hash");
  } finally {
    store.close();
  }
});
