import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  AdminBotAccountRegistration,
  AdminBotAuditEvent,
  AdminBotAuthSession,
  AdminBotExecutionResult,
  AdminBotLabMember,
  AdminBotMemberCredential,
  AdminBotPaperRecord,
  AdminBotRegistrationKind,
  AdminBotRegistrationStatus,
  AdminBotSettings,
  AdminBotStoredProposal,
} from "./contracts.js";
import {
  AdminBotService,
  type AdminBotActionExecutor,
  type AdminBotServiceOptions,
  type AdminBotServiceStore,
} from "./service-core.js";

const require = createRequire(import.meta.url);

export type AdminBotSqliteServiceOptions = {
  databasePath: string;
  auditRetentionDays?: number;
  executor?: AdminBotActionExecutor;
};

export function createAdminBotSqliteService(options: AdminBotSqliteServiceOptions) {
  const store = new AdminBotSqliteStore(options.databasePath);
  const service = new AdminBotService(store, serviceOptions(options));
  return {
    service,
    store,
    close: () => store.close(),
  };
}

function serviceOptions(options: AdminBotSqliteServiceOptions): AdminBotServiceOptions {
  return {
    ...(typeof options.auditRetentionDays === "number"
      ? { auditRetentionDays: options.auditRetentionDays }
      : {}),
    ...(options.executor ? { executor: options.executor } : {}),
  };
}

export class AdminBotSqliteStore implements AdminBotServiceStore {
  private readonly db: DatabaseSync;

  constructor(readonly databasePath: string) {
    ensureDatabaseDirectory(databasePath);
    const sqlite = requireNodeSqlite();
    this.db = new sqlite.DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS adminbot_proposals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        action_type TEXT NOT NULL,
        risk_tier TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS adminbot_proposals_pending_idx
        ON adminbot_proposals(status, updated_at);

      CREATE TABLE IF NOT EXISTS adminbot_executions (
        action_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        status TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        executed_at TEXT NOT NULL,
        result_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS adminbot_audit_events (
        id TEXT PRIMARY KEY,
        action_id TEXT,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        actor TEXT,
        event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS adminbot_audit_events_timestamp_idx
        ON adminbot_audit_events(timestamp);

      CREATE TABLE IF NOT EXISTS adminbot_lab_members (
        id TEXT PRIMARY KEY,
        privilege_level TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS adminbot_lab_members_privilege_idx
        ON adminbot_lab_members(privilege_level, updated_at);

      CREATE TABLE IF NOT EXISTS adminbot_papers (
        id TEXT PRIMARY KEY,
        current_step TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS adminbot_papers_step_idx
        ON adminbot_papers(current_step, updated_at);

      CREATE TABLE IF NOT EXISTS adminbot_settings (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS adminbot_member_credentials (
        member_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_scrypt TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS adminbot_member_credentials_email_idx
        ON adminbot_member_credentials(email);

      CREATE TABLE IF NOT EXISTS adminbot_account_registrations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        member_id TEXT,
        email TEXT NOT NULL,
        password_scrypt TEXT NOT NULL,
        profile_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
      );

      CREATE INDEX IF NOT EXISTS adminbot_account_registrations_status_idx
        ON adminbot_account_registrations(status, email, member_id);

      CREATE TABLE IF NOT EXISTS adminbot_sessions (
        token_hash TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE INDEX IF NOT EXISTS adminbot_sessions_member_expiry_idx
        ON adminbot_sessions(member_id, expires_at);
    `);
  }

  saveProposal(proposal: AdminBotStoredProposal): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_proposals (
          id,
          status,
          action_type,
          risk_tier,
          payload_hash,
          created_at,
          updated_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.status,
        proposal.type,
        proposal.risk_tier,
        proposal.payload_hash,
        proposal.created_at,
        proposal.updated_at,
        JSON.stringify(proposal),
      );
  }

  getProposal(actionId: string): AdminBotStoredProposal | undefined {
    const row = this.db
      .prepare("SELECT payload_json FROM adminbot_proposals WHERE id = ?")
      .get(actionId) as { payload_json?: string } | undefined;
    return row?.payload_json ? parseJson<AdminBotStoredProposal>(row.payload_json) : undefined;
  }

  updateProposal(proposal: AdminBotStoredProposal): void {
    this.db
      .prepare(
        `UPDATE adminbot_proposals
          SET status = ?,
            risk_tier = ?,
            payload_hash = ?,
            updated_at = ?,
            payload_json = ?
          WHERE id = ?`,
      )
      .run(
        proposal.status,
        proposal.risk_tier,
        proposal.payload_hash,
        proposal.updated_at,
        JSON.stringify(proposal),
        proposal.id,
      );
  }

  listPending(limit?: number): AdminBotStoredProposal[] {
    const max = Number.isFinite(limit) && typeof limit === "number" ? Math.max(0, limit) : 100;
    const rows = this.db
      .prepare(
        `SELECT payload_json
          FROM adminbot_proposals
          WHERE status = 'pending'
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .all(max) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotStoredProposal>(row.payload_json));
  }

  saveExecutionResult(result: AdminBotExecutionResult): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_executions (
          action_id,
          idempotency_key,
          status,
          dry_run,
          executed_at,
          result_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.action_id,
        result.idempotency_key ?? null,
        result.status,
        result.dry_run ? 1 : 0,
        result.executed_at,
        JSON.stringify(result),
      );
  }

  getExecutionResult(actionId: string): AdminBotExecutionResult | undefined {
    const row = this.db
      .prepare("SELECT result_json FROM adminbot_executions WHERE action_id = ?")
      .get(actionId) as { result_json?: string } | undefined;
    return row?.result_json ? parseJson<AdminBotExecutionResult>(row.result_json) : undefined;
  }

  getExecutionResultByIdempotencyKey(idempotencyKey: string): AdminBotExecutionResult | undefined {
    const row = this.db
      .prepare("SELECT result_json FROM adminbot_executions WHERE idempotency_key = ?")
      .get(idempotencyKey) as { result_json?: string } | undefined;
    return row?.result_json ? parseJson<AdminBotExecutionResult>(row.result_json) : undefined;
  }

  saveLabMember(member: AdminBotLabMember): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_lab_members (
          id,
          privilege_level,
          updated_at,
          payload_json
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          privilege_level = excluded.privilege_level,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json`,
      )
      .run(member.id, member.privilege_level, member.updated_at, JSON.stringify(member));
  }

  getLabMember(memberId: string): AdminBotLabMember | undefined {
    const row = this.db
      .prepare("SELECT payload_json FROM adminbot_lab_members WHERE id = ?")
      .get(memberId) as { payload_json?: string } | undefined;
    return row?.payload_json ? parseJson<AdminBotLabMember>(row.payload_json) : undefined;
  }

  listLabMembers(): AdminBotLabMember[] {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM adminbot_lab_members ORDER BY json_extract(payload_json, '$.name')",
      )
      .all() as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotLabMember>(row.payload_json));
  }

  savePaper(paper: AdminBotPaperRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_papers (
          id,
          current_step,
          updated_at,
          payload_json
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          current_step = excluded.current_step,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json`,
      )
      .run(paper.id, paper.current_step, paper.updated_at, JSON.stringify(paper));
  }

  getPaper(paperId: string): AdminBotPaperRecord | undefined {
    const row = this.db
      .prepare("SELECT payload_json FROM adminbot_papers WHERE id = ?")
      .get(paperId) as { payload_json?: string } | undefined;
    return row?.payload_json ? parseJson<AdminBotPaperRecord>(row.payload_json) : undefined;
  }

  listPapers(): AdminBotPaperRecord[] {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM adminbot_papers ORDER BY json_extract(payload_json, '$.title')",
      )
      .all() as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotPaperRecord>(row.payload_json));
  }

  deletePaper(paperId: string): boolean {
    return this.db.prepare("DELETE FROM adminbot_papers WHERE id = ?").run(paperId).changes > 0;
  }

  getSettings(): AdminBotSettings | undefined {
    const row = this.db
      .prepare("SELECT payload_json FROM adminbot_settings WHERE id = 'default'")
      .get() as { payload_json?: string } | undefined;
    return row?.payload_json ? parseJson<AdminBotSettings>(row.payload_json) : undefined;
  }

  saveSettings(settings: AdminBotSettings): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_settings (
          id,
          updated_at,
          payload_json
        ) VALUES ('default', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json`,
      )
      .run(settings.updated_at, JSON.stringify(settings));
  }

  recordAudit(event: AdminBotAuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_audit_events (
          id,
          action_id,
          event_type,
          timestamp,
          actor,
          event_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.action_id ?? null,
        event.type,
        event.timestamp,
        event.actor ?? null,
        JSON.stringify(event),
      );
  }

  listAuditEvents(): AdminBotAuditEvent[] {
    const rows = this.db
      .prepare("SELECT event_json FROM adminbot_audit_events ORDER BY timestamp ASC")
      .all() as Array<{ event_json: string }>;
    return rows.map((row) => parseJson<AdminBotAuditEvent>(row.event_json));
  }

  pruneAuditEventsBefore(cutoffIso: string): number {
    const result = this.db
      .prepare("DELETE FROM adminbot_audit_events WHERE timestamp < ?")
      .run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  getCredentialByEmail(email: string): AdminBotMemberCredential | undefined {
    const row = this.db
      .prepare(
        `SELECT member_id, email, password_scrypt, claimed_at, updated_at
          FROM adminbot_member_credentials WHERE email = ?`,
      )
      .get(email.toLowerCase()) as AdminBotMemberCredential | undefined;
    return row ?? undefined;
  }

  getCredentialByMemberId(memberId: string): AdminBotMemberCredential | undefined {
    const row = this.db
      .prepare(
        `SELECT member_id, email, password_scrypt, claimed_at, updated_at
          FROM adminbot_member_credentials WHERE member_id = ?`,
      )
      .get(memberId) as AdminBotMemberCredential | undefined;
    return row ?? undefined;
  }

  saveCredential(credential: AdminBotMemberCredential): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_member_credentials (
          member_id,
          email,
          password_scrypt,
          claimed_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET
          email = excluded.email,
          password_scrypt = excluded.password_scrypt,
          updated_at = excluded.updated_at`,
      )
      .run(
        credential.member_id,
        credential.email.toLowerCase(),
        credential.password_scrypt,
        credential.claimed_at,
        credential.updated_at,
      );
  }

  updateCredentialEmail(memberId: string, newEmail: string, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE adminbot_member_credentials
          SET email = ?, updated_at = ?
          WHERE member_id = ?`,
      )
      .run(newEmail.toLowerCase(), updatedAt, memberId);
  }

  saveAccountRegistration(registration: AdminBotAccountRegistration): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_account_registrations (
          id,
          kind,
          member_id,
          email,
          password_scrypt,
          profile_json,
          status,
          created_at,
          decided_at,
          decided_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          decided_at = excluded.decided_at,
          decided_by = excluded.decided_by`,
      )
      .run(
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
      );
  }

  getAccountRegistration(id: string): AdminBotAccountRegistration | undefined {
    const row = this.db.prepare(`${REGISTRATION_COLUMNS} WHERE id = ?`).get(id) as
      | AccountRegistrationRow
      | undefined;
    return row ? rowToRegistration(row) : undefined;
  }

  listAccountRegistrations(status?: AdminBotRegistrationStatus): AdminBotAccountRegistration[] {
    const rows = status
      ? (this.db
          .prepare(`${REGISTRATION_COLUMNS} WHERE status = ? ORDER BY created_at ASC`)
          .all(status) as AccountRegistrationRow[])
      : (this.db
          .prepare(`${REGISTRATION_COLUMNS} ORDER BY created_at ASC`)
          .all() as AccountRegistrationRow[]);
    return rows.map(rowToRegistration);
  }

  updateAccountRegistrationDecision(
    id: string,
    status: AdminBotRegistrationStatus,
    decidedBy: string,
    decidedAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE adminbot_account_registrations
          SET status = ?, decided_by = ?, decided_at = ?
          WHERE id = ?`,
      )
      .run(status, decidedBy, decidedAt, id);
  }

  getPendingRegistrationByEmail(email: string): AdminBotAccountRegistration | undefined {
    const row = this.db
      .prepare(`${REGISTRATION_COLUMNS} WHERE status = 'pending' AND email = ? LIMIT 1`)
      .get(email.toLowerCase()) as AccountRegistrationRow | undefined;
    return row ? rowToRegistration(row) : undefined;
  }

  getPendingRegistrationByMemberId(memberId: string): AdminBotAccountRegistration | undefined {
    const row = this.db
      .prepare(`${REGISTRATION_COLUMNS} WHERE status = 'pending' AND member_id = ? LIMIT 1`)
      .get(memberId) as AccountRegistrationRow | undefined;
    return row ? rowToRegistration(row) : undefined;
  }

  saveSession(session: AdminBotAuthSession): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_sessions (
          token_hash,
          member_id,
          created_at,
          expires_at,
          last_seen_at,
          revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET
          member_id = excluded.member_id,
          expires_at = excluded.expires_at,
          last_seen_at = excluded.last_seen_at,
          revoked_at = excluded.revoked_at`,
      )
      .run(
        session.token_hash,
        session.member_id,
        session.created_at,
        session.expires_at,
        session.last_seen_at,
        session.revoked_at ?? null,
      );
  }

  getSession(tokenHash: string): AdminBotAuthSession | undefined {
    const row = this.db
      .prepare(
        `SELECT token_hash, member_id, created_at, expires_at, last_seen_at, revoked_at
          FROM adminbot_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash) as
      | (Omit<AdminBotAuthSession, "revoked_at"> & { revoked_at: string | null })
      | undefined;
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
    };
  }

  touchSession(tokenHash: string, lastSeenAt: string): void {
    this.db
      .prepare("UPDATE adminbot_sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(lastSeenAt, tokenHash);
  }

  revokeSession(tokenHash: string, revokedAt: string): void {
    this.db
      .prepare("UPDATE adminbot_sessions SET revoked_at = ? WHERE token_hash = ?")
      .run(revokedAt, tokenHash);
  }

  pruneSessionsBefore(cutoffIso: string): number {
    const result = this.db
      .prepare("DELETE FROM adminbot_sessions WHERE expires_at < ?")
      .run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

function requireNodeSqlite(): typeof import("node:sqlite") {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    throw new Error("SQLite support is unavailable in this Node runtime (missing node:sqlite).", {
      cause: err,
    });
  }
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

const REGISTRATION_COLUMNS = `SELECT id, kind, member_id, email, password_scrypt, profile_json, status, created_at, decided_at, decided_by
  FROM adminbot_account_registrations`;

type AccountRegistrationRow = {
  id: string;
  kind: AdminBotRegistrationKind;
  member_id: string | null;
  email: string;
  password_scrypt: string;
  profile_json: string | null;
  status: AdminBotRegistrationStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

function rowToRegistration(row: AccountRegistrationRow): AdminBotAccountRegistration {
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
