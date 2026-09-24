import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { AdminBotAuthService } from "../workflows/identity/auth.js";
import { AdminBotPostgresAuthStore } from "./postgres-auth.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;
const schema = process.env.ADMINBOT_TEST_POSTGRES_SCHEMA;
const password = process.env.ADMINBOT_TEST_POSTGRES_PASSWORD;

// Opt in with a local database imported from scripts/seed-adminbot-dev.ts. The gate prevents a
// copied production URL from turning an auth integration check into a live login/session write.
describe.skipIf(!url || !schema || !password)("PostgreSQL auth store", () => {
  it("logs in with a migrated credential and resolves then revokes the session", async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !/^adminbot_migration_[a-z0-9_]+$/u.test(schema!)
    ) {
      throw new Error("PostgreSQL auth test requires a local migration schema");
    }
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    try {
      const store = new AdminBotPostgresAuthStore(pool, schema!);
      const auth = new AdminBotAuthService({
        store,
        createMember: async () => {
          throw new Error("member creation is outside this check");
        },
      });
      const login = await auth.login({ email: "alice@example.test", password: password! });
      expect(login.ok).toBe(true);
      if (!login.ok) {
        return;
      }
      const token = login.payload.session_token;
      expect((await auth.resolveSession(token))?.member.id).toBe("dev-alice");
      expect((await auth.logout(token)).ok).toBe(true);
      expect(await auth.resolveSession(token)).toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it("finds a Unicode name with the same lowercase query as SQLite", async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !/^adminbot_migration_[a-z0-9_]+$/u.test(schema!)
    ) {
      throw new Error("PostgreSQL auth test requires a local migration schema");
    }
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const store = new AdminBotPostgresAuthStore(pool, schema!);
    const id = "dev-unicode-search-check";
    try {
      const template = await store.getLabMember("dev-alice");
      if (!template) {
        throw new Error("fictional fixture member missing");
      }
      await store.saveLabMember({
        ...template,
        id,
        name: "İpek Example",
        email: "ipek@example.test",
      });
      const results = await store.listLabMembers({ limit: 50, offset: 0, q: "İpek" });
      expect(results.map((member) => member.id)).toContain(id);
    } finally {
      await pool.query(`DELETE FROM "${schema}".adminbot_lab_members WHERE id = $1`, [id]);
      await pool.end();
    }
  });

  it("serializes pending registrations and keeps login email and roster email together", async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !/^adminbot_migration_[a-z0-9_]+$/u.test(schema!)
    ) {
      throw new Error("PostgreSQL auth test requires a local migration schema");
    }
    const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000 });
    const store = new AdminBotPostgresAuthStore(pool, schema!);
    const marker = randomUUID().replaceAll("-", "");
    const memberId = `dev-pg-email-${marker}`;
    const pendingEmail = `pending-${marker}@example.test`;
    const newEmail = `changed-${marker}@example.test`;
    const now = new Date().toISOString();
    const registrationIds = [
      `dev-pg-registration-${marker}-1`,
      `dev-pg-registration-${marker}-2`,
      `dev-pg-registration-${marker}-3`,
    ];
    try {
      const template = await store.getLabMember("dev-alice");
      if (!template) {
        throw new Error("fictional fixture member missing");
      }
      await store.saveLabMember({
        ...template,
        id: memberId,
        email: `original-${marker}@example.test`,
      });
      await store.saveCredential({
        member_id: memberId,
        email: `original-${marker}@example.test`,
        password_scrypt: "old-hash",
        claimed_at: now,
        updated_at: now,
      });
      const [first, second] = await Promise.all(
        registrationIds.map((id) =>
          store.trySavePendingRegistration({
            id,
            kind: "signup",
            email: pendingEmail,
            password_scrypt: "unused-hash",
            status: "pending",
            created_at: now,
          }),
        ),
      );
      expect([first, second].sort()).toEqual([false, true]);
      expect(
        (await store.listAccountRegistrations("pending")).filter(
          (row) => row.email === pendingEmail,
        ),
      ).toHaveLength(1);
      expect(await store.changeMemberLoginEmail(memberId, pendingEmail, "old-hash", now)).toBe(
        "taken",
      );
      expect(
        await store.changeMemberLoginEmail(memberId, "alice@example.test", "old-hash", now),
      ).toBe("taken");
      expect(await store.changeMemberLoginEmail(memberId, newEmail, "wrong-hash", now)).toBe(
        "stale",
      );
      expect(await store.changeMemberLoginEmail(memberId, newEmail, "old-hash", now)).toBe(
        "changed",
      );
      expect((await store.getCredentialByMemberId(memberId))?.email).toBe(newEmail);
      expect((await store.getLabMember(memberId))?.email).toBe(newEmail);
      const racingEmail = `race-${marker}@example.test`;
      const [changed, pendingSaved] = await Promise.all([
        store.changeMemberLoginEmail(memberId, racingEmail, "old-hash", now),
        store.trySavePendingRegistration({
          id: registrationIds[2],
          kind: "signup",
          email: racingEmail,
          password_scrypt: "unused-hash",
          status: "pending",
          created_at: now,
        }),
      ]);
      expect([changed, pendingSaved]).toEqual(
        changed === "changed" ? ["changed", false] : ["taken", true],
      );
      expect((await store.getCredentialByMemberId(memberId))?.email === racingEmail).toBe(
        changed === "changed",
      );
      const currentEmail = (await store.getCredentialByMemberId(memberId))?.email;
      await pool.query(`DELETE FROM "${schema}".adminbot_lab_members WHERE id = $1`, [memberId]);
      expect(
        await store.changeMemberLoginEmail(
          memberId,
          `rollback-${marker}@example.test`,
          "old-hash",
          now,
        ),
      ).toBe("stale");
      expect((await store.getCredentialByMemberId(memberId))?.email).toBe(currentEmail);
    } finally {
      await pool.query(
        `DELETE FROM "${schema}".adminbot_account_registrations WHERE id = ANY($1)`,
        [registrationIds],
      );
      await pool.query(`DELETE FROM "${schema}".adminbot_member_credentials WHERE member_id = $1`, [
        memberId,
      ]);
      await pool.query(`DELETE FROM "${schema}".adminbot_lab_members WHERE id = $1`, [memberId]);
      await pool.end();
    }
  });

  it("rejects a session minted from a stale verified password", async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !/^adminbot_migration_[a-z0-9_]+$/u.test(schema!)
    ) {
      throw new Error("PostgreSQL auth test requires a local migration schema");
    }
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const store = new AdminBotPostgresAuthStore(pool, schema!);
    const marker = randomUUID().replaceAll("-", "");
    const memberId = `dev-pg-session-${marker}`;
    const now = new Date().toISOString();
    try {
      const template = await store.getLabMember("dev-alice");
      if (!template) {
        throw new Error("fictional fixture member missing");
      }
      await store.saveLabMember({
        ...template,
        id: memberId,
        email: `session-${marker}@example.test`,
      });
      const credential = {
        member_id: memberId,
        email: `session-${marker}@example.test`,
        password_scrypt: "old-hash",
        claimed_at: now,
        updated_at: now,
      };
      await store.saveCredential(credential);
      const session = {
        token_hash: `dev-pg-token-${marker}`,
        member_id: memberId,
        created_at: now,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        last_seen_at: now,
      };
      expect(await store.saveSessionIfCredentialCurrent(session, "old-hash")).toBe(true);
      await store.saveCredential({ ...credential, password_scrypt: "new-hash" });
      expect(
        await store.saveSessionIfCredentialCurrent(
          { ...session, token_hash: `${session.token_hash}-stale` },
          "old-hash",
        ),
      ).toBe(false);
      expect(
        await store.saveSessionIfCredentialCurrent(
          { ...session, token_hash: `${session.token_hash}-current` },
          "new-hash",
        ),
      ).toBe(true);
    } finally {
      await pool.query(`DELETE FROM "${schema}".adminbot_sessions WHERE member_id = $1`, [
        memberId,
      ]);
      await pool.query(`DELETE FROM "${schema}".adminbot_member_credentials WHERE member_id = $1`, [
        memberId,
      ]);
      await pool.query(`DELETE FROM "${schema}".adminbot_lab_members WHERE id = $1`, [memberId]);
      await pool.end();
    }
  });

  it("atomically rotates passwords and consumes only one concurrent reset", async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !/^adminbot_migration_[a-z0-9_]+$/u.test(schema!)
    ) {
      throw new Error("PostgreSQL auth test requires a local migration schema");
    }
    const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000 });
    const store = new AdminBotPostgresAuthStore(pool, schema!);
    const marker = randomUUID().replaceAll("-", "");
    const memberId = `dev-pg-reset-${marker}`;
    const now = new Date().toISOString();
    const resetHashes = [`dev-pg-reset-a-${marker}`, `dev-pg-reset-b-${marker}`];
    try {
      const template = await store.getLabMember("dev-alice");
      if (!template) {
        throw new Error("fictional fixture member missing");
      }
      await store.saveLabMember({
        ...template,
        id: memberId,
        email: `reset-${marker}@example.test`,
      });
      await store.saveCredential({
        member_id: memberId,
        email: `reset-${marker}@example.test`,
        password_scrypt: "old-hash",
        claimed_at: now,
        updated_at: now,
      });
      await store.saveSession({
        token_hash: `dev-pg-active-${marker}`,
        member_id: memberId,
        created_at: now,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        last_seen_at: now,
      });
      expect(await store.changePasswordAndRevokeSessions(memberId, "wrong", "rotated", now)).toBe(
        false,
      );
      expect((await store.getSession(`dev-pg-active-${marker}`))?.revoked_at).toBeUndefined();
      expect(
        await store.changePasswordAndRevokeSessions(memberId, "old-hash", "rotated", now),
      ).toBe(true);
      expect((await store.getCredentialByMemberId(memberId))?.password_scrypt).toBe("rotated");
      expect((await store.getSession(`dev-pg-active-${marker}`))?.revoked_at).toBe(now);

      for (const token_hash of resetHashes) {
        await store.savePasswordReset({
          token_hash,
          member_id: memberId,
          created_at: now,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      const results = await Promise.all(
        resetHashes.map((tokenHash, index) =>
          store.consumePasswordResetAndRevokeSessions(tokenHash, `reset-hash-${index}`, now),
        ),
      );
      expect([...results].sort()).toEqual([false, true]);
      expect((await store.getCredentialByMemberId(memberId))?.password_scrypt).toBe(
        `reset-hash-${results.findIndex(Boolean)}`,
      );
      for (const tokenHash of resetHashes) {
        expect((await store.getPasswordResetByTokenHash(tokenHash))?.used_at).toBe(now);
      }
    } finally {
      await pool.query(`DELETE FROM "${schema}".adminbot_password_resets WHERE member_id = $1`, [
        memberId,
      ]);
      await pool.query(`DELETE FROM "${schema}".adminbot_sessions WHERE member_id = $1`, [
        memberId,
      ]);
      await pool.query(`DELETE FROM "${schema}".adminbot_member_credentials WHERE member_id = $1`, [
        memberId,
      ]);
      await pool.query(`DELETE FROM "${schema}".adminbot_lab_members WHERE id = $1`, [memberId]);
      await pool.end();
    }
  });
});
