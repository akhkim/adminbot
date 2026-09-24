import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../contracts/actions.js";
import { AdminBotAuthService } from "../workflows/identity/auth.js";
import { AdminBotPostgresAuthStore } from "./postgres-auth.js";
import { AdminBotSqliteStore } from "./sqlite.js";

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
        prepareMember: async () => {
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

  it("matches SQLite roster ordering, search counts, and summary redaction", async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !/^adminbot_migration_[a-z0-9_]+$/u.test(schema!)
    ) {
      throw new Error("PostgreSQL auth test requires a local migration schema");
    }
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const postgres = new AdminBotPostgresAuthStore(pool, schema!);
    const sqlite = new AdminBotSqliteStore(":memory:");
    const marker = randomUUID().replaceAll("-", "");
    const now = "2026-09-01T00:00:00.000Z";
    const step = {
      id: "setup",
      label: "Set up account",
      status: "current" as const,
      category: "Getting started",
      required: true,
    };
    const members: AdminBotLabMember[] = [
      {
        id: `dev-roster-a-${marker}`,
        name: `apple ${marker}`,
        email: `contact-${marker}@example.test`,
        privilege_level: "member",
        access: [],
        research_topics: [`topic-${marker}`],
        projects: [`project-${marker}`],
        field_provenance: { name: { source: "member", at: now } },
        onboarding: { steps: [step], completed: [], remaining: [step], opened_at: now },
        created_at: now,
        updated_at: now,
      },
      ...(["Zed", "Émile", "émile"] as const).map((name, index) => ({
        id: `dev-roster-${index}-${marker}`,
        name: `${name} ${marker}`,
        privilege_level: "member" as const,
        access: [],
        created_at: now,
        updated_at: now,
      })),
    ];
    const ids = new Set(members.map((member) => member.id));
    try {
      const before = await postgres.countLabMembers();
      for (const member of members) {
        sqlite.saveLabMember(member);
        await postgres.saveLabMember(member);
      }
      expect(await postgres.countLabMembers()).toBe(before + sqlite.countLabMembers());
      for (const q of [
        `ÉMILE ${marker}`,
        `zEd ${marker}`,
        `topic-${marker}`,
        `project-${marker}`,
        `contact-${marker}`,
        `missing-${marker}`,
      ]) {
        expect(await postgres.countLabMembers(q)).toBe(sqlite.countLabMembers(q));
      }
      expect(
        (await postgres.listLabMembers({ limit: 2, offset: 1, q: marker })).map(
          (member) => member.id,
        ),
      ).toEqual(
        sqlite.listLabMembers({ limit: 2, offset: 1, q: marker }).map((member) => member.id),
      );
      const summaries = (await postgres.listLabMemberSummaries()).filter((member) =>
        ids.has(member.id),
      );
      expect(summaries).toEqual(sqlite.listLabMemberSummaries());
      expect(summaries[0]).not.toHaveProperty("access");
      expect(summaries[0]).not.toHaveProperty("field_provenance");
      expect(summaries[0]?.onboarding).toEqual({ steps: [{ id: "setup", status: "current" }] });
    } finally {
      await pool.query(`DELETE FROM "${schema}".adminbot_lab_members WHERE id = ANY($1)`, [
        [...ids],
      ]);
      sqlite.close();
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

  it("approves once across store instances and rolls back a conflicting signup member", async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !/^adminbot_migration_[a-z0-9_]+$/u.test(schema!)
    ) {
      throw new Error("PostgreSQL auth test requires a local migration schema");
    }
    const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000 });
    const first = new AdminBotPostgresAuthStore(pool, schema!);
    const second = new AdminBotPostgresAuthStore(pool, schema!);
    const marker = randomUUID().replaceAll("-", "");
    const registrationIds = [
      `dev-pg-approve-${marker}`,
      `dev-pg-conflict-${marker}`,
      `dev-pg-claim-${marker}`,
    ];
    const memberIds = [
      `dev-pg-approved-a-${marker}`,
      `dev-pg-approved-b-${marker}`,
      `dev-pg-holder-${marker}`,
      `dev-pg-orphan-${marker}`,
    ];
    const email = `approved-${marker}@example.test`;
    const conflictEmail = `conflict-${marker}@example.test`;
    const claimEmail = `claim-${marker}@example.test`;
    const now = new Date().toISOString();
    try {
      const template = await first.getLabMember("dev-alice");
      if (!template) {
        throw new Error("fictional fixture member missing");
      }
      const prepared = (id: string): AdminBotLabMember => ({
        ...template,
        id,
        name: id,
        email,
        created_at: now,
        updated_at: now,
      });
      expect(
        await first.trySavePendingRegistration({
          id: registrationIds[0],
          kind: "signup",
          email,
          password_scrypt: "new-hash",
          status: "pending",
          created_at: now,
        }),
      ).toBe(true);
      const results = await Promise.all([
        first.tryApproveRegistration(registrationIds[0], "admin-a", now, prepared(memberIds[0])),
        second.tryApproveRegistration(registrationIds[0], "admin-b", now, prepared(memberIds[1])),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const winner = results.find((result) => result.ok);
      expect(winner?.member_id).toBeDefined();
      expect((await first.getCredentialByEmail(email))?.member_id).toBe(winner?.member_id);
      expect((await first.getAccountRegistration(registrationIds[0]))?.status).toBe("approved");
      expect(
        await first.updateAccountRegistrationDecision(registrationIds[0], "rejected", "other", now),
      ).toBe(false);
      const roster = await Promise.all(memberIds.slice(0, 2).map((id) => first.getLabMember(id)));
      expect(roster.filter(Boolean)).toHaveLength(1);

      expect(
        await first.trySavePendingRegistration({
          id: registrationIds[1],
          kind: "signup",
          email: conflictEmail,
          password_scrypt: "pending-hash",
          status: "pending",
          created_at: now,
        }),
      ).toBe(true);
      await first.saveLabMember(prepared(memberIds[2]));
      expect(
        await first.trySavePendingRegistration({
          id: registrationIds[2],
          kind: "claim",
          member_id: memberIds[2],
          email: claimEmail,
          password_scrypt: "claim-hash",
          status: "pending",
          created_at: now,
        }),
      ).toBe(true);
      await first.saveCredential({
        member_id: memberIds[2],
        email: conflictEmail,
        password_scrypt: "existing-hash",
        claimed_at: now,
        updated_at: now,
      });
      expect(
        await first.tryApproveRegistration(
          registrationIds[1],
          "admin",
          now,
          prepared(memberIds[3]),
        ),
      ).toEqual({ ok: false, reason: "conflict" });
      expect(await first.getLabMember(memberIds[3])).toBeUndefined();
      expect((await first.getCredentialByEmail(conflictEmail))?.password_scrypt).toBe(
        "existing-hash",
      );
      expect((await first.getAccountRegistration(registrationIds[1]))?.status).toBe("pending");
      expect(await first.tryApproveRegistration(registrationIds[2], "admin", now)).toEqual({
        ok: false,
        reason: "conflict",
      });
      expect((await first.getCredentialByMemberId(memberIds[2]))?.password_scrypt).toBe(
        "existing-hash",
      );
    } finally {
      await pool.query(
        `DELETE FROM "${schema}".adminbot_account_registrations WHERE id = ANY($1)`,
        [registrationIds],
      );
      await pool.query(
        `DELETE FROM "${schema}".adminbot_member_credentials WHERE member_id = ANY($1)`,
        [memberIds],
      );
      await pool.query(`DELETE FROM "${schema}".adminbot_lab_members WHERE id = ANY($1)`, [
        memberIds,
      ]);
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
