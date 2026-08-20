import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { cvEntryKey } from "../contracts/actions.js";
import type {
  AdminBotAccountRegistration,
  AdminBotCvChangeEvent,
  AdminBotAuditEvent,
  AdminBotAuthSession,
  AdminBotExecutionResult,
  AdminBotLabMember,
  AdminBotLogisticsRequest,
  AdminBotMeetingRecord,
  AdminBotMemberLocationEntry,
  AdminBotMemberCredential,
  AdminBotOpenReviewCycleRecord,
  AdminBotOpenReviewMilestoneRecord,
  AdminBotPaperRecord,
  AdminBotPasswordReset,
  AdminBotRegistrationKind,
  AdminBotRegistrationStatus,
  AdminBotSettings,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import type {
  AdminBotPaperSlot,
  AdminBotPaperSlotRecord,
  AdminBotPaperSlotStatus,
} from "../contracts/paper-slots.js";
import {
  AdminBotService,
  type AdminBotActionExecutor,
  type AdminBotServiceOptions,
  type AdminBotServiceStore,
  type AdminBotSlackChannelNamingRecord,
} from "../kernel/service.js";
import { resolveMemberOnboarding } from "../workflows/onboarding/onboarding.js";

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

      CREATE TABLE IF NOT EXISTS adminbot_openreview_cycles (
        venue_id TEXT NOT NULL,
        role TEXT NOT NULL,
        deadline_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (venue_id, role)
      );

      -- The unique key is the idempotency guarantee for outbound reminders: a fired
      -- milestone has a row, and a row means it is never sent again. Dropping this
      -- constraint would let a restart or a double-triggered timer re-mail a committee.
      CREATE TABLE IF NOT EXISTS adminbot_openreview_milestones (
        venue_id TEXT NOT NULL,
        role TEXT NOT NULL,
        milestone_key TEXT NOT NULL,
        fired_at TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (venue_id, role, milestone_key)
      );

      -- One row per entry a scan saw appear on someone's CV.
      --
      -- Kept because a scan consumes its own diff: the next scan compares against the snapshot the
      -- last one stored, so without this the only record of a change is the draft shown once and
      -- lost on navigation. A digest over "what changed in July" needs the history, not the last
      -- run. The unique key is the change itself, so re-scanning cannot double-report it.
      CREATE TABLE IF NOT EXISTS adminbot_cv_changes (
        member_id TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        recency TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (member_id, entry_key)
      );

      CREATE INDEX IF NOT EXISTS adminbot_cv_changes_detected_at
        ON adminbot_cv_changes (detected_at);

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

      -- One row per evidence slot, per paper. Real columns rather than a JSON blob on the paper:
      -- the global nudge pass reads status, provided_at, last_nudged_at, nudge_count and
      -- snoozed_until across every open paper at once, and that is a query, not a parse.
      CREATE TABLE IF NOT EXISTS adminbot_paper_slots (
        paper_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT,
        value_text TEXT,
        provided_by_member_id TEXT,
        provided_at TEXT,
        validated_at TEXT,
        invalid_reason TEXT,
        waived_by_member_id TEXT,
        waived_reason TEXT,
        last_nudged_at TEXT,
        nudge_count INTEGER NOT NULL DEFAULT 0,
        snoozed_until TEXT,
        PRIMARY KEY (paper_id, slot)
      );

      -- The nudge scan's own access pattern: every open slot in the lab, in one sweep.
      CREATE INDEX IF NOT EXISTS adminbot_paper_slots_status_idx
        ON adminbot_paper_slots(status, last_nudged_at);

      CREATE TABLE IF NOT EXISTS adminbot_member_locations (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      -- Both reads are "recent first": one member's history for their own banner, and every
      -- member's recent entries for the admin list.
      CREATE INDEX IF NOT EXISTS adminbot_member_locations_member_idx
        ON adminbot_member_locations(member_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS adminbot_member_locations_observed_idx
        ON adminbot_member_locations(observed_at DESC);

      CREATE TABLE IF NOT EXISTS adminbot_meetings (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      -- The tab reads newest-first and nothing else queries this table, so one index on the sort
      -- column is the whole access pattern.
      CREATE INDEX IF NOT EXISTS adminbot_meetings_started_idx
        ON adminbot_meetings(started_at DESC);

      CREATE TABLE IF NOT EXISTS adminbot_logistics_requests (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      -- Two reads, both newest-first: the admin queue over everyone, and a member's own requests.
      -- The member index carries the sort column so "my requests" stays one index scan.
      CREATE INDEX IF NOT EXISTS adminbot_logistics_requests_submitted_idx
        ON adminbot_logistics_requests(submitted_at DESC);
      CREATE INDEX IF NOT EXISTS adminbot_logistics_requests_member_idx
        ON adminbot_logistics_requests(member_id, submitted_at DESC);

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

      CREATE TABLE IF NOT EXISTS adminbot_password_resets (
        token_hash TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );

      CREATE INDEX IF NOT EXISTS adminbot_password_resets_member_idx
        ON adminbot_password_resets(member_id, expires_at);

      CREATE TABLE IF NOT EXISTS adminbot_slack_channel_naming (
        channel_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS adminbot_slack_channel_naming_updated_idx
        ON adminbot_slack_channel_naming(updated_at);
    `);
    this.migrateStoredOnboarding();
    this.migrateRetiredPrivilegeLevels();
  }

  // `core_member` was retired and its access grants folded into `member`, so rows seeded before
  // that carry a level the current union no longer contains. Rewrite them once at open — both the
  // indexed column and the payload copy, which must not drift — so runtime only ever reads a
  // canonical level and no read path needs a fallback for the retired name.
  private migrateRetiredPrivilegeLevels(): void {
    const rows = this.db
      .prepare(
        "SELECT id, payload_json FROM adminbot_lab_members WHERE privilege_level = 'core_member'",
      )
      .all() as Array<{ id: string; payload_json: string }>;
    for (const row of rows) {
      const member = parseJson<AdminBotLabMember>(row.payload_json);
      const migrated = JSON.stringify({ ...member, privilege_level: "member" });
      this.db
        .prepare(
          "UPDATE adminbot_lab_members SET privilege_level = 'member', payload_json = ? WHERE id = ?",
        )
        .run(migrated, row.id);
    }
  }

  // Members seeded before the checklist gained structured bullets still carry the step shape from
  // signup day, which the Control UI renders as empty bullets. Rewrite every stored checklist from
  // the current definitions once at open so runtime only ever reads the canonical shape; this is
  // idempotent because `resolveMemberOnboarding` derives content and keeps only acknowledgements.
  private migrateStoredOnboarding(): void {
    const rows = this.db
      .prepare("SELECT id, payload_json FROM adminbot_lab_members")
      .all() as Array<{ id: string; payload_json: string }>;
    for (const row of rows) {
      const member = parseJson<AdminBotLabMember>(row.payload_json);
      if (!member.onboarding) {
        continue;
      }
      const onboarding = resolveMemberOnboarding(member.onboarding);
      if (JSON.stringify(onboarding) === JSON.stringify(member.onboarding)) {
        continue;
      }
      this.db
        .prepare("UPDATE adminbot_lab_members SET payload_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...member, onboarding }), row.id);
    }
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

  recordCvChanges(events: AdminBotCvChangeEvent[]): AdminBotCvChangeEvent[] {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO adminbot_cv_changes (
         member_id, entry_key, detected_at, recency, payload_json
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const inserted: AdminBotCvChangeEvent[] = [];
    for (const event of events) {
      const result = insert.run(
        event.member_id,
        cvEntryKey(event.entry),
        event.detected_at,
        event.recency,
        JSON.stringify(event),
      );
      // INSERT OR IGNORE reports zero changes when the row already existed, which is exactly the
      // "seen this before" signal the caller needs.
      if (result.changes > 0) {
        inserted.push(event);
      }
    }
    return inserted;
  }

  listCvChangesSince(sinceIso: string): AdminBotCvChangeEvent[] {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM adminbot_cv_changes WHERE detected_at >= ? ORDER BY detected_at",
      )
      .all(sinceIso) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotCvChangeEvent>(row.payload_json));
  }

  saveOpenReviewCycle(cycle: AdminBotOpenReviewCycleRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_openreview_cycles (
          venue_id,
          role,
          deadline_ms,
          updated_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(venue_id, role) DO UPDATE SET
          deadline_ms = excluded.deadline_ms,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json`,
      )
      .run(cycle.venue_id, cycle.role, cycle.deadline_ms, cycle.updated_at, JSON.stringify(cycle));
  }

  listOpenReviewCycles(): AdminBotOpenReviewCycleRecord[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM adminbot_openreview_cycles ORDER BY deadline_ms")
      .all() as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotOpenReviewCycleRecord>(row.payload_json));
  }

  // INSERT without an upsert clause: a milestone row is written exactly once, and a
  // second attempt must be rejected rather than silently overwriting the first send.
  recordOpenReviewMilestone(milestone: AdminBotOpenReviewMilestoneRecord): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO adminbot_openreview_milestones (
          venue_id,
          role,
          milestone_key,
          fired_at,
          status,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        milestone.venue_id,
        milestone.role,
        milestone.milestone_key,
        milestone.fired_at,
        milestone.status,
        JSON.stringify(milestone),
      );
    return result.changes > 0;
  }

  listOpenReviewMilestones(venueId?: string): AdminBotOpenReviewMilestoneRecord[] {
    const rows = (
      venueId
        ? this.db
            .prepare(
              "SELECT payload_json FROM adminbot_openreview_milestones WHERE venue_id = ? ORDER BY fired_at",
            )
            .all(venueId)
        : this.db
            .prepare("SELECT payload_json FROM adminbot_openreview_milestones ORDER BY fired_at")
            .all()
    ) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotOpenReviewMilestoneRecord>(row.payload_json));
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
    // The slots go with the paper. Leaving them would let a re-created id inherit the evidence of
    // a paper somebody deleted.
    this.db.prepare("DELETE FROM adminbot_paper_slots WHERE paper_id = ?").run(paperId);
    return this.db.prepare("DELETE FROM adminbot_papers WHERE id = ?").run(paperId).changes > 0;
  }

  savePaperSlot(record: AdminBotPaperSlotRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_paper_slots (
          paper_id,
          slot,
          status,
          url,
          value_text,
          provided_by_member_id,
          provided_at,
          validated_at,
          invalid_reason,
          waived_by_member_id,
          waived_reason,
          last_nudged_at,
          nudge_count,
          snoozed_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(paper_id, slot) DO UPDATE SET
          status = excluded.status,
          url = excluded.url,
          value_text = excluded.value_text,
          provided_by_member_id = excluded.provided_by_member_id,
          provided_at = excluded.provided_at,
          validated_at = excluded.validated_at,
          invalid_reason = excluded.invalid_reason,
          waived_by_member_id = excluded.waived_by_member_id,
          waived_reason = excluded.waived_reason,
          last_nudged_at = excluded.last_nudged_at,
          nudge_count = excluded.nudge_count,
          snoozed_until = excluded.snoozed_until`,
      )
      .run(
        record.paper_id,
        record.slot,
        record.status,
        record.url ?? null,
        record.value_text ?? null,
        record.provided_by_member_id ?? null,
        record.provided_at ?? null,
        record.validated_at ?? null,
        record.invalid_reason ?? null,
        record.waived_by_member_id ?? null,
        record.waived_reason ?? null,
        record.last_nudged_at ?? null,
        record.nudge_count,
        record.snoozed_until ?? null,
      );
  }

  /** One paper's slots, or the whole lab's when no id is given -- the nudge pass wants the latter. */
  listPaperSlots(paperId?: string): AdminBotPaperSlotRecord[] {
    const rows = (
      paperId
        ? this.db
            .prepare("SELECT * FROM adminbot_paper_slots WHERE paper_id = ? ORDER BY slot")
            .all(paperId)
        : this.db.prepare("SELECT * FROM adminbot_paper_slots ORDER BY paper_id, slot").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => paperSlotFromRow(row));
  }

  appendMemberLocation(entry: AdminBotMemberLocationEntry): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_member_locations (id, member_id, observed_at, source, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.member_id, entry.observed_at, entry.source, JSON.stringify(entry));
  }

  listMemberLocations(memberId: string, limit?: number): AdminBotMemberLocationEntry[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM adminbot_member_locations
         WHERE member_id = ? ORDER BY observed_at DESC LIMIT ?`,
      )
      // -1 is SQLite's "no limit", which keeps this one statement rather than two.
      .all(memberId, typeof limit === "number" ? limit : -1) as Array<{
      payload_json: string;
    }>;
    return rows.map((row) => parseJson<AdminBotMemberLocationEntry>(row.payload_json));
  }

  listMemberLocationsSince(since: string): AdminBotMemberLocationEntry[] {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM adminbot_member_locations WHERE observed_at >= ? ORDER BY observed_at DESC",
      )
      .all(since) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotMemberLocationEntry>(row.payload_json));
  }

  saveMeeting(meeting: AdminBotMeetingRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_meetings (
          id,
          started_at,
          updated_at,
          payload_json
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json`,
      )
      .run(meeting.id, meeting.started_at, meeting.updated_at, JSON.stringify(meeting));
  }

  getMeeting(meetingId: string): AdminBotMeetingRecord | undefined {
    const row = this.db
      .prepare("SELECT payload_json FROM adminbot_meetings WHERE id = ?")
      .get(meetingId) as { payload_json?: string } | undefined;
    return row?.payload_json ? parseJson<AdminBotMeetingRecord>(row.payload_json) : undefined;
  }

  listMeetings(): AdminBotMeetingRecord[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM adminbot_meetings ORDER BY started_at DESC")
      .all() as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotMeetingRecord>(row.payload_json));
  }

  deleteMeeting(meetingId: string): boolean {
    return this.db.prepare("DELETE FROM adminbot_meetings WHERE id = ?").run(meetingId).changes > 0;
  }

  saveLogisticsRequest(request: AdminBotLogisticsRequest): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_logistics_requests (
          id,
          member_id,
          submitted_at,
          updated_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          member_id = excluded.member_id,
          submitted_at = excluded.submitted_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json`,
      )
      .run(
        request.id,
        request.member_id,
        request.submitted_at,
        request.updated_at,
        JSON.stringify(request),
      );
  }

  getLogisticsRequest(requestId: string): AdminBotLogisticsRequest | undefined {
    const row = this.db
      .prepare("SELECT payload_json FROM adminbot_logistics_requests WHERE id = ?")
      .get(requestId) as { payload_json?: string } | undefined;
    return row?.payload_json ? parseJson<AdminBotLogisticsRequest>(row.payload_json) : undefined;
  }

  listLogisticsRequests(memberId?: string): AdminBotLogisticsRequest[] {
    const rows = (
      memberId
        ? this.db
            .prepare(
              `SELECT payload_json FROM adminbot_logistics_requests
               WHERE member_id = ? ORDER BY submitted_at DESC`,
            )
            .all(memberId)
        : this.db
            .prepare(
              "SELECT payload_json FROM adminbot_logistics_requests ORDER BY submitted_at DESC",
            )
            .all()
    ) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotLogisticsRequest>(row.payload_json));
  }

  deleteLogisticsRequest(requestId: string): boolean {
    return (
      this.db.prepare("DELETE FROM adminbot_logistics_requests WHERE id = ?").run(requestId)
        .changes > 0
    );
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

  savePasswordReset(reset: AdminBotPasswordReset): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_password_resets (
          token_hash,
          member_id,
          created_at,
          expires_at,
          used_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET
          member_id = excluded.member_id,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          used_at = excluded.used_at`,
      )
      .run(
        reset.token_hash,
        reset.member_id,
        reset.created_at,
        reset.expires_at,
        reset.used_at ?? null,
      );
  }

  getPasswordResetByTokenHash(tokenHash: string): AdminBotPasswordReset | undefined {
    const row = this.db
      .prepare(
        `SELECT token_hash, member_id, created_at, expires_at, used_at
          FROM adminbot_password_resets WHERE token_hash = ?`,
      )
      .get(tokenHash) as AdminBotPasswordReset | undefined;
    return row ?? undefined;
  }

  // Called when a reset succeeds: every other outstanding link for that member dies with it, so a
  // second "forgot password" mail sitting in an inbox cannot be replayed after the password changed.
  markPasswordResetsUsedForMember(memberId: string, usedAt: string): void {
    this.db
      .prepare(
        `UPDATE adminbot_password_resets SET used_at = ?
          WHERE member_id = ? AND used_at IS NULL`,
      )
      .run(usedAt, memberId);
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
      | (Omit<AdminBotAuthSession, "revoked_at"> & {
          revoked_at: string | null;
        })
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

  // Signs the member out everywhere at once. Used by the password reset, where leaving older
  // sessions alive would defeat the point of recovering a possibly-compromised account.
  revokeSessionsForMember(memberId: string, revokedAt: string): void {
    this.db
      .prepare(
        "UPDATE adminbot_sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL",
      )
      .run(revokedAt, memberId);
  }

  pruneSessionsBefore(cutoffIso: string): number {
    const result = this.db
      .prepare("DELETE FROM adminbot_sessions WHERE expires_at < ?")
      .run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  saveSlackChannelNamingRecord(record: AdminBotSlackChannelNamingRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_slack_channel_naming (
          channel_id,
          updated_at,
          payload_json
        ) VALUES (?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json`,
      )
      .run(record.channel_id, record.last_seen_at, JSON.stringify(record));
  }

  getSlackChannelNamingRecord(channelId: string): AdminBotSlackChannelNamingRecord | undefined {
    const row = this.db
      .prepare("SELECT payload_json FROM adminbot_slack_channel_naming WHERE channel_id = ?")
      .get(channelId) as { payload_json?: string } | undefined;
    return row?.payload_json
      ? parseJson<AdminBotSlackChannelNamingRecord>(row.payload_json)
      : undefined;
  }

  listSlackChannelNamingRecords(): AdminBotSlackChannelNamingRecord[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM adminbot_slack_channel_naming ORDER BY updated_at ASC")
      .all() as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotSlackChannelNamingRecord>(row.payload_json));
  }

  deleteSlackChannelNamingRecord(channelId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM adminbot_slack_channel_naming WHERE channel_id = ?")
        .run(channelId).changes > 0
    );
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

/**
 * A slot row as the record.
 *
 * SQLite hands back `null` for an empty column and the record type uses optional keys, so the
 * nullable columns are dropped rather than carried through as `null` -- otherwise every caller
 * would have to treat "no URL" and "URL is null" as two different absences.
 */
function paperSlotFromRow(row: Record<string, unknown>): AdminBotPaperSlotRecord {
  const text = (key: string): string | undefined => {
    const value = row[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const optional = <K extends keyof AdminBotPaperSlotRecord>(key: K & string) => {
    const value = text(key);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    paper_id: String(row.paper_id),
    slot: String(row.slot) as AdminBotPaperSlot,
    status: String(row.status) as AdminBotPaperSlotStatus,
    nudge_count: Number(row.nudge_count ?? 0),
    ...optional("url"),
    ...optional("value_text"),
    ...optional("provided_by_member_id"),
    ...optional("provided_at"),
    ...optional("validated_at"),
    ...optional("invalid_reason"),
    ...optional("waived_by_member_id"),
    ...optional("waived_reason"),
    ...optional("last_nudged_at"),
    ...optional("snoozed_until"),
  };
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
