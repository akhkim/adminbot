import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  AdminBotAccountRegistration,
  AdminBotAuditEvent,
  AdminBotAuthSession,
  AdminBotLabMember,
  AdminBotMemberCredential,
  AdminBotMemberLocationEntry,
  AdminBotPasswordReset,
  AdminBotRegistrationStatus,
  AdminBotSettings,
} from "../contracts/actions.js";
import type { AdminBotLoginEvent, AdminBotLoginLocation } from "../contracts/activity-log.js";
import type { AdminBotListPage } from "../kernel/service.js";
import type { AdminBotAuthStore } from "../workflows/identity/auth.js";

type RegistrationRow = AdminBotAccountRegistration & {
  member_id: string | null;
  profile_json: string | null;
  decided_at: string | null;
  decided_by: string | null;
};

/** The auth slice can run against a copied PostgreSQL schema while the rest of the store migrates. */
export class AdminBotPostgresAuthStore implements AdminBotAuthStore {
  private readonly schema: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema)) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.schema = `"${schema}"`;
  }

  private table(name: string): string {
    return `${this.schema}."${name}"`;
  }

  private async first<T extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T | undefined> {
    return (await this.pool.query<T>(sql, values)).rows[0];
  }

  private async rows<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, values)).rows;
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let started = false;
    let broken = false;
    try {
      await client.query("BEGIN");
      started = true;
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (started) {
        try {
          await client.query("ROLLBACK");
        } catch {
          broken = true;
        }
      } else {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken ? new Error("PostgreSQL transaction connection failed") : undefined);
    }
  }

  async saveLabMember(member: AdminBotLabMember): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("adminbot_lab_members")}
       (id, privilege_level, updated_at, payload_json) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET privilege_level = EXCLUDED.privilege_level,
         updated_at = EXCLUDED.updated_at, payload_json = EXCLUDED.payload_json`,
      [member.id, member.privilege_level, member.updated_at, JSON.stringify(member)],
    );
  }

  async patchLabMemberAuthFields(
    memberId: string,
    patch: Parameters<AdminBotAuthStore["patchLabMemberAuthFields"]>[1],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.table("adminbot_lab_members")}
       SET updated_at = $1, payload_json = (payload_json::jsonb || $2::jsonb)::text
       WHERE id = $3`,
      [patch.updated_at, JSON.stringify(patch), memberId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getLabMember(memberId: string): Promise<AdminBotLabMember | undefined> {
    const row = await this.first<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.table("adminbot_lab_members")} WHERE id = $1`,
      [memberId],
    );
    return row ? (JSON.parse(row.payload_json) as AdminBotLabMember) : undefined;
  }

  async listLabMembers(page?: AdminBotListPage): Promise<AdminBotLabMember[]> {
    const q = page?.q?.toLowerCase();
    if (q && /[^\x00-\x7f]/u.test(q)) {
      // ponytail: Unicode search scans the roster to preserve JS lowercasing; add a persisted
      // search key when non-ASCII searches or roster size make this fallback measurable.
      const rows = await this.rows<{ payload_json: string }>(
        `SELECT payload_json FROM ${this.table("adminbot_lab_members")} m
         ORDER BY translate(m.payload_json::jsonb ->> 'name',
           'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE "C" NULLS FIRST, m.id`,
      );
      const matches = rows
        .map((row) => JSON.parse(row.payload_json) as AdminBotLabMember)
        .filter((member) =>
          [
            member.name,
            member.email,
            ...(Array.isArray(member.research_topics) ? member.research_topics : []),
            ...(Array.isArray(member.projects) ? member.projects : []),
          ].some((value) => typeof value === "string" && value.toLowerCase().includes(q)),
        );
      return page ? matches.slice(page.offset, page.offset + page.limit) : matches;
    }
    const search = q
      ? `WHERE strpos(lower(coalesce(m.payload_json::jsonb ->> 'name', '')), $1) > 0
         OR strpos(lower(coalesce(m.payload_json::jsonb ->> 'email', '')), $1) > 0
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE
                      WHEN jsonb_typeof(m.payload_json::jsonb -> 'research_topics') = 'array'
                      THEN m.payload_json::jsonb -> 'research_topics' ELSE '[]'::jsonb END) AS topic(value)
                    WHERE strpos(lower(topic.value), $1) > 0)
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE
                      WHEN jsonb_typeof(m.payload_json::jsonb -> 'projects') = 'array'
                      THEN m.payload_json::jsonb -> 'projects' ELSE '[]'::jsonb END) AS project(value)
                    WHERE strpos(lower(project.value), $1) > 0)`
      : "";
    const values: unknown[] = q ? [q] : [];
    if (page) {
      values.push(page.limit, page.offset);
    }
    const order = page
      ? `translate(m.payload_json::jsonb ->> 'name', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
           'abcdefghijklmnopqrstuvwxyz') COLLATE "C" NULLS FIRST, m.id`
      : `(m.payload_json::jsonb ->> 'name') COLLATE "C" NULLS FIRST`;
    const limit = page ? `LIMIT $${values.length - 1} OFFSET $${values.length}` : "";
    const rows = await this.rows<{ payload_json: string }>(
      `SELECT m.payload_json FROM ${this.table("adminbot_lab_members")} m ${search} ORDER BY ${order} ${limit}`,
      values,
    );
    return rows.map((row) => JSON.parse(row.payload_json) as AdminBotLabMember);
  }

  async appendMemberLocation(entry: AdminBotMemberLocationEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("adminbot_member_locations")}
       (id, member_id, observed_at, source, payload_json) VALUES ($1, $2, $3, $4, $5)`,
      [entry.id, entry.member_id, entry.observed_at, entry.source, JSON.stringify(entry)],
    );
  }

  async listMemberLocations(
    memberId: string,
    limit?: number,
  ): Promise<AdminBotMemberLocationEntry[]> {
    const rows = await this.rows<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.table("adminbot_member_locations")}
       WHERE member_id = $1 ORDER BY observed_at DESC, _sqlite_rowid DESC
       ${typeof limit === "number" ? "LIMIT $2" : ""}`,
      typeof limit === "number" ? [memberId, limit] : [memberId],
    );
    return rows.map((row) => JSON.parse(row.payload_json) as AdminBotMemberLocationEntry);
  }

  async appendLoginEvent(event: AdminBotLoginEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("adminbot_login_events")}
       (id, member_id, at, country, continent, city, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.id,
        event.member_id,
        event.at,
        event.country ?? null,
        event.continent ?? null,
        event.city ?? null,
        event.timezone ?? null,
      ],
    );
  }

  async attachLoginEventLocation(id: string, location: AdminBotLoginLocation): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table("adminbot_login_events")} SET
       country = coalesce(nullif($1, ''), country),
       continent = coalesce(nullif($2, ''), continent),
       city = coalesce(nullif($3, ''), city),
       timezone = coalesce(nullif($4, ''), timezone) WHERE id = $5`,
      [
        location.country ?? null,
        location.continent ?? null,
        location.city ?? null,
        location.timezone ?? null,
        id,
      ],
    );
  }

  async getSettings(): Promise<AdminBotSettings | undefined> {
    const row = await this.first<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.table("adminbot_settings")} WHERE id = 'default'`,
    );
    return row ? (JSON.parse(row.payload_json) as AdminBotSettings) : undefined;
  }

  async recordAudit(event: AdminBotAuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("adminbot_audit_events")}
       (id, action_id, event_type, timestamp, actor, event_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.id,
        event.action_id ?? null,
        event.type,
        event.timestamp,
        event.actor ?? null,
        JSON.stringify(event),
      ],
    );
  }

  async listAuditEvents(): Promise<AdminBotAuditEvent[]> {
    const rows = await this.rows<{ event_json: string }>(
      `SELECT event_json FROM ${this.table("adminbot_audit_events")}
       ORDER BY timestamp ASC, _sqlite_rowid ASC`,
    );
    return rows.map((row) => JSON.parse(row.event_json) as AdminBotAuditEvent);
  }

  async getCredentialByEmail(email: string): Promise<AdminBotMemberCredential | undefined> {
    return this.first<AdminBotMemberCredential>(
      `SELECT member_id, email, password_scrypt, claimed_at, updated_at
       FROM ${this.table("adminbot_member_credentials")} WHERE email = $1`,
      [email.toLowerCase()],
    );
  }

  async getCredentialByMemberId(memberId: string): Promise<AdminBotMemberCredential | undefined> {
    return this.first<AdminBotMemberCredential>(
      `SELECT member_id, email, password_scrypt, claimed_at, updated_at
       FROM ${this.table("adminbot_member_credentials")} WHERE member_id = $1`,
      [memberId],
    );
  }

  async listCredentialMemberIds(): Promise<string[]> {
    const rows = await this.rows<{ member_id: string }>(
      `SELECT member_id FROM ${this.table("adminbot_member_credentials")}`,
    );
    return rows.map((row) => row.member_id);
  }

  async saveCredential(credential: AdminBotMemberCredential): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("adminbot_member_credentials")}
       (member_id, email, password_scrypt, claimed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (member_id) DO UPDATE SET email = EXCLUDED.email,
         password_scrypt = EXCLUDED.password_scrypt, updated_at = EXCLUDED.updated_at`,
      [
        credential.member_id,
        credential.email.toLowerCase(),
        credential.password_scrypt,
        credential.claimed_at,
        credential.updated_at,
      ],
    );
  }

  async changePasswordAndRevokeSessions(
    memberId: string,
    expectedPasswordHash: string,
    newPasswordHash: string,
    updatedAt: string,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const changed = await client.query(
        `UPDATE ${this.table("adminbot_member_credentials")}
         SET password_scrypt = $1, updated_at = $2
         WHERE member_id = $3 AND password_scrypt = $4`,
        [newPasswordHash, updatedAt, memberId, expectedPasswordHash],
      );
      if (changed.rowCount !== 1) {
        return false;
      }
      await client.query(
        `UPDATE ${this.table("adminbot_sessions")}
         SET revoked_at = $1 WHERE member_id = $2 AND revoked_at IS NULL`,
        [updatedAt, memberId],
      );
      return true;
    });
  }

  async updateCredentialEmail(
    memberId: string,
    newEmail: string,
    updatedAt: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table("adminbot_member_credentials")}
       SET email = $1, updated_at = $2 WHERE member_id = $3`,
      [newEmail.toLowerCase(), updatedAt, memberId],
    );
  }

  async changeMemberLoginEmail(
    memberId: string,
    newEmail: string,
    expectedPasswordHash: string,
    updatedAt: string,
  ): Promise<"changed" | "stale" | "taken"> {
    const email = newEmail.toLowerCase();
    const missingMember = new Error("credential member is missing from the roster");
    try {
      return await this.transaction(async (client) => {
        const credential = await client.query<{ password_scrypt: string }>(
          `SELECT password_scrypt FROM ${this.table("adminbot_member_credentials")}
           WHERE member_id = $1 FOR UPDATE`,
          [memberId],
        );
        if (credential.rows[0]?.password_scrypt !== expectedPasswordHash) {
          return "stale";
        }
        // A pending registration lives in another table, so its writer takes the same email lock.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [email]);
        const pending = await client.query(
          `SELECT 1 FROM ${this.table("adminbot_account_registrations")}
           WHERE status = 'pending' AND lower(email) = $1 LIMIT 1`,
          [email],
        );
        if (pending.rowCount) {
          return "taken";
        }
        await client.query(
          `UPDATE ${this.table("adminbot_member_credentials")}
           SET email = $1, updated_at = $2 WHERE member_id = $3`,
          [email, updatedAt, memberId],
        );
        const member = await client.query(
          `UPDATE ${this.table("adminbot_lab_members")}
           SET updated_at = $1,
               payload_json = (payload_json::jsonb || jsonb_build_object('email', $2::text,
                 'updated_at', $1::text))::text
           WHERE id = $3`,
          [updatedAt, email, memberId],
        );
        if (member.rowCount !== 1) {
          throw missingMember;
        }
        return "changed";
      });
    } catch (error) {
      if (error === missingMember) {
        return "stale";
      }
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "sqlite_autoindex_adminbot_member_credentials_2"
      ) {
        return "taken";
      }
      throw error;
    }
  }

  async savePasswordReset(reset: AdminBotPasswordReset): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("adminbot_password_resets")}
       (token_hash, member_id, created_at, expires_at, used_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_hash) DO UPDATE SET member_id = EXCLUDED.member_id,
         created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at,
         used_at = EXCLUDED.used_at`,
      [
        reset.token_hash,
        reset.member_id,
        reset.created_at,
        reset.expires_at,
        reset.used_at ?? null,
      ],
    );
  }

  async getPasswordResetByTokenHash(tokenHash: string): Promise<AdminBotPasswordReset | undefined> {
    const row = await this.first<AdminBotPasswordReset>(
      `SELECT token_hash, member_id, created_at, expires_at, used_at
       FROM ${this.table("adminbot_password_resets")} WHERE token_hash = $1`,
      [tokenHash],
    );
    return row ?? undefined;
  }

  async markPasswordResetsUsedForMember(memberId: string, usedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table("adminbot_password_resets")}
       SET used_at = $1 WHERE member_id = $2 AND used_at IS NULL`,
      [usedAt, memberId],
    );
  }

  async consumePasswordResetAndRevokeSessions(
    tokenHash: string,
    newPasswordHash: string,
    usedAt: string,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const reset = await client.query<{ member_id: string }>(
        `SELECT member_id FROM ${this.table("adminbot_password_resets")}
         WHERE token_hash = $1`,
        [tokenHash],
      );
      const memberId = reset.rows[0]?.member_id;
      if (!memberId) {
        return false;
      }
      // All resets for one account must lock the same credential before any token row.
      const credential = await client.query(
        `SELECT 1 FROM ${this.table("adminbot_member_credentials")}
         WHERE member_id = $1 FOR UPDATE`,
        [memberId],
      );
      if (!credential.rowCount) {
        return false;
      }
      const consumed = await client.query(
        `UPDATE ${this.table("adminbot_password_resets")}
         SET used_at = $1 WHERE token_hash = $2 AND member_id = $3
           AND used_at IS NULL AND expires_at > $1`,
        [usedAt, tokenHash, memberId],
      );
      if (consumed.rowCount !== 1) {
        return false;
      }
      await client.query(
        `UPDATE ${this.table("adminbot_member_credentials")}
         SET password_scrypt = $1, updated_at = $2 WHERE member_id = $3`,
        [newPasswordHash, usedAt, memberId],
      );
      await client.query(
        `UPDATE ${this.table("adminbot_password_resets")}
         SET used_at = $1 WHERE member_id = $2 AND used_at IS NULL`,
        [usedAt, memberId],
      );
      await client.query(
        `UPDATE ${this.table("adminbot_sessions")}
         SET revoked_at = $1 WHERE member_id = $2 AND revoked_at IS NULL`,
        [usedAt, memberId],
      );
      return true;
    });
  }

  async saveAccountRegistration(registration: AdminBotAccountRegistration): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("adminbot_account_registrations")}
       (id, kind, member_id, email, password_scrypt, profile_json, status,
        created_at, decided_at, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,
         decided_at = EXCLUDED.decided_at, decided_by = EXCLUDED.decided_by`,
      [
        registration.id,
        registration.kind,
        registration.member_id ?? null,
        registration.email.toLowerCase(),
        registration.password_scrypt,
        registration.profile_json ?? null,
        registration.status,
        registration.created_at,
        registration.decided_at ?? null,
        registration.decided_by ?? null,
      ],
    );
  }

  async trySavePendingRegistration(registration: AdminBotAccountRegistration): Promise<boolean> {
    if (registration.status !== "pending") {
      throw new Error("only pending registrations can be inserted here");
    }
    const email = registration.email.toLowerCase();
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [email]);
      const credential = await client.query(
        `SELECT 1 FROM ${this.table("adminbot_member_credentials")}
         WHERE email = $1 OR member_id = $2 LIMIT 1`,
        [email, registration.member_id ?? ""],
      );
      if (credential.rowCount) {
        return false;
      }
      const inserted = await client.query(
        `INSERT INTO ${this.table("adminbot_account_registrations")}
         (id, kind, member_id, email, password_scrypt, profile_json, status,
          created_at, decided_at, decided_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NULL, NULL)
         ON CONFLICT DO NOTHING`,
        [
          registration.id,
          registration.kind,
          registration.member_id ?? null,
          email,
          registration.password_scrypt,
          registration.profile_json ?? null,
          registration.created_at,
        ],
      );
      return inserted.rowCount === 1;
    });
  }

  private registration(row: RegistrationRow | undefined): AdminBotAccountRegistration | undefined {
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      kind: row.kind,
      email: row.email,
      password_scrypt: row.password_scrypt,
      status: row.status,
      created_at: row.created_at,
      ...(row.member_id ? { member_id: row.member_id } : {}),
      ...(row.profile_json ? { profile_json: row.profile_json } : {}),
      ...(row.decided_at ? { decided_at: row.decided_at } : {}),
      ...(row.decided_by ? { decided_by: row.decided_by } : {}),
    };
  }

  private registrationColumns(): string {
    return `SELECT id, kind, member_id, email, password_scrypt, profile_json,
                   status, created_at, decided_at, decided_by
            FROM ${this.table("adminbot_account_registrations")}`;
  }

  async getAccountRegistration(id: string): Promise<AdminBotAccountRegistration | undefined> {
    return this.registration(
      await this.first<RegistrationRow>(`${this.registrationColumns()} WHERE id = $1`, [id]),
    );
  }

  async listAccountRegistrations(
    status?: AdminBotRegistrationStatus,
  ): Promise<AdminBotAccountRegistration[]> {
    const rows = await this.rows<RegistrationRow>(
      `${this.registrationColumns()} ${status ? "WHERE status = $1" : ""}
       ORDER BY created_at ASC, _sqlite_rowid ASC`,
      status ? [status] : [],
    );
    return rows.map((row) => this.registration(row)!);
  }

  async updateAccountRegistrationDecision(
    id: string,
    status: AdminBotRegistrationStatus,
    decidedBy: string,
    decidedAt: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table("adminbot_account_registrations")}
       SET status = $1, decided_by = $2, decided_at = $3 WHERE id = $4`,
      [status, decidedBy, decidedAt, id],
    );
  }

  async getPendingRegistrationByEmail(
    email: string,
  ): Promise<AdminBotAccountRegistration | undefined> {
    return this.registration(
      await this.first<RegistrationRow>(
        `${this.registrationColumns()} WHERE status = 'pending' AND lower(email) = $1 LIMIT 1`,
        [email.toLowerCase()],
      ),
    );
  }

  async getPendingRegistrationByMemberId(
    memberId: string,
  ): Promise<AdminBotAccountRegistration | undefined> {
    return this.registration(
      await this.first<RegistrationRow>(
        `${this.registrationColumns()} WHERE status = 'pending' AND member_id = $1 LIMIT 1`,
        [memberId],
      ),
    );
  }

  async saveSession(session: AdminBotAuthSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("adminbot_sessions")}
       (token_hash, member_id, created_at, expires_at, last_seen_at, revoked_at, impersonated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (token_hash) DO UPDATE SET member_id = EXCLUDED.member_id,
         expires_at = EXCLUDED.expires_at, last_seen_at = EXCLUDED.last_seen_at,
         revoked_at = EXCLUDED.revoked_at, impersonated_by = EXCLUDED.impersonated_by`,
      [
        session.token_hash,
        session.member_id,
        session.created_at,
        session.expires_at,
        session.last_seen_at,
        session.revoked_at ?? null,
        session.impersonated_by ?? null,
      ],
    );
  }

  async saveSessionIfCredentialCurrent(
    session: AdminBotAuthSession,
    expectedPasswordHash: string,
  ): Promise<boolean> {
    // The credential row lock makes a verified password either precede the reset's
    // revoke-all step or observe its new hash and fail; an ordinary read cannot do that.
    const inserted = await this.pool.query(
      `INSERT INTO ${this.table("adminbot_sessions")}
       (token_hash, member_id, created_at, expires_at, last_seen_at, revoked_at, impersonated_by)
       SELECT $1, credential.member_id, $2, $3, $4, $5, $6
       FROM ${this.table("adminbot_member_credentials")} AS credential
       WHERE credential.member_id = $7 AND credential.password_scrypt = $8
       FOR UPDATE OF credential
       ON CONFLICT DO NOTHING`,
      [
        session.token_hash,
        session.created_at,
        session.expires_at,
        session.last_seen_at,
        session.revoked_at ?? null,
        session.impersonated_by ?? null,
        session.member_id,
        expectedPasswordHash,
      ],
    );
    return inserted.rowCount === 1;
  }

  async getSession(tokenHash: string): Promise<AdminBotAuthSession | undefined> {
    const row = await this.first<
      AdminBotAuthSession & {
        revoked_at: string | null;
        impersonated_by: string | null;
      }
    >(
      `SELECT token_hash, member_id, created_at, expires_at, last_seen_at,
              revoked_at, impersonated_by
       FROM ${this.table("adminbot_sessions")} WHERE token_hash = $1`,
      [tokenHash],
    );
    if (!row) {
      return undefined;
    }
    return {
      token_hash: row.token_hash,
      member_id: row.member_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at,
      ...(row.revoked_at ? { revoked_at: row.revoked_at } : {}),
      ...(row.impersonated_by ? { impersonated_by: row.impersonated_by } : {}),
    };
  }

  async touchSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table("adminbot_sessions")} SET last_seen_at = $1 WHERE token_hash = $2`,
      [lastSeenAt, tokenHash],
    );
  }

  async revokeSession(tokenHash: string, revokedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table("adminbot_sessions")} SET revoked_at = $1 WHERE token_hash = $2`,
      [revokedAt, tokenHash],
    );
  }

  async revokeSessionsForMember(memberId: string, revokedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table("adminbot_sessions")}
       SET revoked_at = $1 WHERE member_id = $2 AND revoked_at IS NULL`,
      [revokedAt, memberId],
    );
  }

  async pruneSessionsBefore(cutoffIso: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table("adminbot_sessions")} WHERE expires_at < $1`,
      [cutoffIso],
    );
    return result.rowCount ?? 0;
  }
}
