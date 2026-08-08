import Database from "better-sqlite3";

const EXPECTED_SCHEMA: Readonly<Record<string, readonly string[]>> = Object.freeze({
  adminbot_account_registrations: [
    "id", "kind", "member_id", "email", "password_scrypt", "profile_json", "status",
    "created_at", "decided_at", "decided_by",
  ],
  adminbot_audit_events: ["id", "action_id", "event_type", "timestamp", "actor", "event_json"],
  adminbot_email_effects: ["message_id", "effect_key", "status", "result_json", "updated_at"],
  adminbot_email_messages: [
    "message_id", "thread_id", "sender", "category", "status", "reason", "attempts",
    "last_error", "updated_at",
  ],
  adminbot_executions: [
    "action_id", "idempotency_key", "status", "dry_run", "executed_at", "result_json",
  ],
  adminbot_lab_members: ["id", "privilege_level", "updated_at", "payload_json"],
  adminbot_member_credentials: [
    "member_id", "email", "password_scrypt", "claimed_at", "updated_at",
  ],
  adminbot_onboarding_threads: [
    "thread_id", "candidate_email", "decision", "source_message_id", "status", "updated_at",
  ],
  adminbot_openreview_cycles: ["venue_id", "role", "deadline_ms", "updated_at", "payload_json"],
  adminbot_openreview_milestones: [
    "venue_id", "role", "milestone_key", "fired_at", "status", "payload_json",
  ],
  adminbot_papers: ["id", "current_step", "updated_at", "payload_json"],
  adminbot_proposals: [
    "id", "status", "action_type", "risk_tier", "payload_hash", "created_at", "updated_at",
    "payload_json",
  ],
  adminbot_sessions: [
    "token_hash", "member_id", "created_at", "expires_at", "last_seen_at", "revoked_at",
  ],
  adminbot_settings: ["id", "updated_at", "payload_json"],
});

export interface LegacyMemberRow {
  readonly id: string;
  readonly privilege_level: string;
  readonly updated_at: string;
  readonly payload_json: string;
}

export interface LegacyCredentialRow {
  readonly member_id: string;
  readonly email: string;
  readonly password_scrypt: string;
  readonly claimed_at: string;
  readonly updated_at: string;
}

export interface LegacyRegistrationRow {
  readonly id: string;
  readonly kind: string;
  readonly member_id: string | null;
  readonly email: string;
  readonly password_scrypt: string;
  readonly profile_json: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
}

export interface LegacyIdentitySnapshot {
  readonly members: readonly LegacyMemberRow[];
  readonly credentials: readonly LegacyCredentialRow[];
  readonly registrations: readonly LegacyRegistrationRow[];
  readonly legacySessionCount: number;
  readonly sourceTableCount: number;
}

export class LegacySourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LegacySourceError";
  }
}

/** Raw SQL is intentionally quarantined here: this adapter only reads the immutable v1 format. */
export function readLegacyIdentitySnapshot(databasePath: string): LegacyIdentitySnapshot {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    if (database.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new LegacySourceError("source_integrity_failed", "legacy SQLite integrity check failed");
    }
    if (database.pragma("user_version", { simple: true }) !== 0) {
      throw new LegacySourceError("source_version_unknown", "legacy SQLite user_version is not 0");
    }
    if (database.pragma("application_id", { simple: true }) !== 0) {
      throw new LegacySourceError("source_identity_unknown", "legacy SQLite application_id is not 0");
    }
    assertExactSchema(database);
    const members = database
      .prepare("SELECT id, privilege_level, updated_at, payload_json FROM adminbot_lab_members ORDER BY id")
      .all() as LegacyMemberRow[];
    const credentials = database
      .prepare("SELECT member_id, email, password_scrypt, claimed_at, updated_at FROM adminbot_member_credentials ORDER BY member_id")
      .all() as LegacyCredentialRow[];
    const registrations = database
      .prepare("SELECT id, kind, member_id, email, password_scrypt, profile_json, status, created_at, decided_at, decided_by FROM adminbot_account_registrations ORDER BY created_at, id")
      .all() as LegacyRegistrationRow[];
    const sessionCount = database
      .prepare("SELECT COUNT(*) AS count FROM adminbot_sessions")
      .get() as { readonly count: number };
    return {
      members,
      credentials,
      registrations,
      legacySessionCount: sessionCount.count,
      sourceTableCount: Object.keys(EXPECTED_SCHEMA).length,
    };
  } finally {
    database.close();
  }
}

function assertExactSchema(database: Database.Database): void {
  const actualTables = (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ readonly name: string }>
  ).map((row) => row.name);
  const expectedTables = Object.keys(EXPECTED_SCHEMA).sort();
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new LegacySourceError("source_schema_mismatch", "legacy SQLite table fingerprint differs");
  }
  for (const table of expectedTables) {
    const expectedColumns = EXPECTED_SCHEMA[table];
    const actualColumns = (
      database.pragma(`table_info(${table})`) as Array<{ readonly name: string }>
    ).map((column) => column.name);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
      throw new LegacySourceError(
        "source_schema_mismatch",
        `legacy SQLite column fingerprint differs for ${table}`,
      );
    }
  }
}
