import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { cvEntryKey } from "../contracts/actions.js";
import type {
  AdminBotAccountRegistration,
  AdminBotCvChangeEvent,
  AdminBotVenueIndexStatus,
  AdminBotVenuePaper,
  AdminBotAuditEvent,
  AdminBotAuthSession,
  AdminBotExecutionResult,
  AdminBotLabMember,
  AdminBotLogisticsRequest,
  AdminBotMeetingRecord,
  AdminBotMemberNotification,
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
import type { AdminBotLoginEvent, AdminBotUpdateEvent } from "../contracts/activity-log.js";
import type { PublishedDeadlineRecord } from "../contracts/deadline-proposals.js";
import type { AdminBotFeedbackEntry } from "../contracts/feedback.js";
import type {
  AdminBotConferenceAttendeeRecord,
  AdminBotNudgeLedgerRecord,
  AdminBotPaperReimbursementRecord,
  AdminBotSocialConsentRecord,
  AdminBotSocialDraftRecord,
} from "../contracts/paper-cycle.js";
import type {
  AdminBotPaperSlot,
  AdminBotPaperSlotRecord,
  AdminBotPaperSlotStatus,
} from "../contracts/paper-slots.js";
import type { AdminBotPaperWeeklyUpdate } from "../contracts/paper-weekly-updates.js";
import type { AdminBotPaperflowEvidenceRecord } from "../contracts/paperflow-stages.js";
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
    // Read here rather than in the kernel so the service stays free of process globals: both
    // callers (the API server and the hourly email script) build the service through this factory
    // and both already load ~/.openclaw/.env before they do.
    ...(process.env.ADMINBOT_BOT_EMAIL?.trim()
      ? { paperflowBotEmail: process.env.ADMINBOT_BOT_EMAIL.trim() }
      : {}),
    ...(process.env.ADMINBOT_PAPERFLOW_PRIORITY_MEMBER_ID?.trim()
      ? { paperflowPriorityMemberId: process.env.ADMINBOT_PAPERFLOW_PRIORITY_MEMBER_ID.trim() }
      : {}),
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

      CREATE TABLE IF NOT EXISTS adminbot_deadline_submission_keys (
        submitter_member_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        action_id TEXT NOT NULL REFERENCES adminbot_proposals(id),
        PRIMARY KEY (submitter_member_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS adminbot_published_deadlines (
        action_id TEXT PRIMARY KEY REFERENCES adminbot_proposals(id),
        proposal_id TEXT NOT NULL,
        deadline_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        published_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS adminbot_published_deadlines_id_idx
        ON adminbot_published_deadlines(deadline_id, revision);

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

      -- One row per accepted paper in a searchable venue, with the vector it is ranked by.
      --
      -- The vector is a JSON array rather than a blob: it is written once per rebuild and read as
      -- a whole row, so the parse cost is paid on the read path either way, and JSON keeps the
      -- table inspectable when a ranking looks wrong. indexed_at and embedding_model are
      -- repeated on every row rather than kept in a venues table, which keeps a rebuild a single
      -- delete-and-insert with nothing to keep in step.
      CREATE TABLE IF NOT EXISTS adminbot_venue_papers (
        venue_id TEXT NOT NULL,
        paper_id TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (venue_id, paper_id)
      );

      CREATE INDEX IF NOT EXISTS adminbot_venue_papers_venue
        ON adminbot_venue_papers (venue_id);

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
      -- the nudge sweep reads status across every open paper at once, and that is a query, not a
      -- parse. value_note is the free-text half of an enum slot (where the poster physically is);
      -- value_text holds the state itself.
      --
      -- No nudge columns here: how often somebody has been chased about this belongs to the
      -- person, not to the artifact, and lives in adminbot_nudge_ledger.
      CREATE TABLE IF NOT EXISTS adminbot_paper_slots (
        paper_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT,
        value_text TEXT,
        value_note TEXT,
        provided_by_member_id TEXT,
        provided_at TEXT,
        validated_at TEXT,
        invalid_reason TEXT,
        waived_by_member_id TEXT,
        waived_reason TEXT,
        PRIMARY KEY (paper_id, slot)
      );

      -- The nudge scan's own access pattern: every open slot in the lab, in one sweep.
      CREATE INDEX IF NOT EXISTS adminbot_paper_slots_status_idx
        ON adminbot_paper_slots(status);

      -- One clock for every nudge in the lab, keyed by what it is about and who was asked. This
      -- is what lets one sweep say everything a person owes in a single message rather than
      -- letting four subsystems each keep their own cadence and all fire on the same morning.
      CREATE TABLE IF NOT EXISTS adminbot_nudge_ledger (
        domain TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        last_nudged_at TEXT,
        nudge_count INTEGER NOT NULL DEFAULT 0,
        snoozed_until TEXT,
        PRIMARY KEY (domain, subject_id, member_id)
      );

      -- "What has this person been chased about lately" is the sweep's question, so that is the
      -- index.
      CREATE INDEX IF NOT EXISTS adminbot_nudge_ledger_member_idx
        ON adminbot_nudge_ledger(member_id, last_nudged_at);

      -- One row per venue-cycle stage AdminBot has seen the closing mail for. Keyed by
      -- (paper, stage) rather than by message: a stage closes once, and a second bcc on the same
      -- decision is a duplicate rather than a second fact.
      --
      -- Separate from adminbot_paper_slots because it answers a different question. A slot is an
      -- artifact somebody in the lab produces; this is an event the venue caused, and the only
      -- thing anybody here can do about it is report that it happened.
      CREATE TABLE IF NOT EXISTS adminbot_paperflow_evidence (
        paper_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        message_id TEXT,
        subject TEXT,
        sender TEXT,
        recorded_at TEXT NOT NULL,
        recorded_by TEXT NOT NULL,
        confidence REAL,
        PRIMARY KEY (paper_id, stage)
      );

      -- The social draft itself, kept because consent is asked against a specific wording.
      CREATE TABLE IF NOT EXISTS adminbot_paper_social_drafts (
        id TEXT PRIMARY KEY,
        paper_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        body TEXT NOT NULL,
        model TEXT,
        generated_at TEXT NOT NULL,
        generated_by_member_id TEXT,
        status TEXT NOT NULL,
        superseded_by TEXT
      );

      CREATE INDEX IF NOT EXISTS adminbot_paper_social_drafts_paper_idx
        ON adminbot_paper_social_drafts(paper_id, platform, generated_at DESC);

      CREATE TABLE IF NOT EXISTS adminbot_paper_social_draft_consents (
        draft_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        comment TEXT,
        asked_at TEXT NOT NULL,
        decided_at TEXT,
        PRIMARY KEY (draft_id, member_id)
      );

      -- attendee_key is a stored column, not the coalesce() expression the spec named: SQLite
      -- cannot key on an expression, and the service has to agree with the memory store about
      -- what counts as the same person twice anyway.
      CREATE TABLE IF NOT EXISTS adminbot_paper_conference_attendees (
        paper_id TEXT NOT NULL,
        attendee_key TEXT NOT NULL,
        member_id TEXT,
        name TEXT NOT NULL,
        attending TEXT NOT NULL,
        confirmed_at TEXT,
        PRIMARY KEY (paper_id, attendee_key)
      );

      CREATE TABLE IF NOT EXISTS adminbot_paper_reimbursements (
        paper_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        status TEXT NOT NULL,
        submitted_at TEXT,
        completed_at TEXT,
        PRIMARY KEY (paper_id, member_id)
      );

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

      CREATE TABLE IF NOT EXISTS adminbot_member_notifications (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        payload_json TEXT NOT NULL
      );

      -- One read only: this member's notifications, newest first. The kind rides along because a
      -- resend replaces its own row rather than adding a second copy of the same sentence.
      CREATE INDEX IF NOT EXISTS adminbot_member_notifications_member_idx
        ON adminbot_member_notifications(member_id, created_at DESC);

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

      -- One row per member per surface: a re-rating is a change of mind, not a second vote.
      -- Anonymous rows share one slot per feature (see adminBotFeedbackId).
      CREATE TABLE IF NOT EXISTS adminbot_feedback (
        id TEXT PRIMARY KEY,
        feature_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        member_id TEXT,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS adminbot_feedback_feature_idx
        ON adminbot_feedback(feature_id, updated_at);

      -- One entry per author per paper per week. Keyed by the week's Monday (UTC) so two people
      -- in different timezones writing the same evening land in the same bucket.
      CREATE TABLE IF NOT EXISTS adminbot_paper_weekly_updates (
        paper_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        week_start TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (paper_id, member_id, week_start)
      );

      CREATE INDEX IF NOT EXISTS adminbot_paper_weekly_updates_week_idx
        ON adminbot_paper_weekly_updates(week_start);

      -- Every sign-in, not just the most recent one. Real columns rather than a payload blob:
      -- these two logs exist to be counted and grouped, and a JSON parse per row is the wrong
      -- shape for "how many distinct members signed in last month".
      CREATE TABLE IF NOT EXISTS adminbot_login_events (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        at TEXT NOT NULL
      );

      -- Both reads are recent-first: one member's own history, and the lab-wide sweep behind the
      -- adoption line.
      CREATE INDEX IF NOT EXISTS adminbot_login_events_member_idx
        ON adminbot_login_events(member_id, at DESC);
      CREATE INDEX IF NOT EXISTS adminbot_login_events_at_idx
        ON adminbot_login_events(at DESC);

      -- Who changed which field of what, when. slot_id is namespaced by subject (see
      -- contracts/activity-log.ts) so profile fields and paper slots share one table without
      -- colliding.
      CREATE TABLE IF NOT EXISTS adminbot_update_events (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        at TEXT NOT NULL,
        source TEXT NOT NULL,
        subject_member_id TEXT
      );

      -- "What has this person touched" and "who has touched this slot" are the two questions asked
      -- of this table; the third index serves the adoption sweep, which filters on source first.
      CREATE INDEX IF NOT EXISTS adminbot_update_events_member_idx
        ON adminbot_update_events(member_id, at DESC);
      CREATE INDEX IF NOT EXISTS adminbot_update_events_slot_idx
        ON adminbot_update_events(slot_id, at DESC);
      CREATE INDEX IF NOT EXISTS adminbot_update_events_source_idx
        ON adminbot_update_events(source, at DESC);
    `);
    this.migrateStoredOnboarding();
    this.migrateRetiredPrivilegeLevels();
    this.migratePaperSlotColumns();
  }

  /**
   * Bring an `adminbot_paper_slots` written by the first revision up to this one.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so a database
   * created by the previous release keeps its old shape forever unless something says otherwise.
   * Two changes: `value_note` is new, and the three nudge columns moved to the ledger.
   *
   * The nudge columns are read across into the ledger rather than dropped, because they are the
   * only record of who has already been chased -- dropping them would re-nudge everybody once.
   * They are then left in place: SQLite can drop a column, but a stale column nothing reads costs
   * nothing, and rewriting a live table to remove one is the riskier half of this migration for
   * no benefit.
   */
  private migratePaperSlotColumns(): void {
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(adminbot_paper_slots)").all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    if (!columns.has("value_note")) {
      this.db.exec("ALTER TABLE adminbot_paper_slots ADD COLUMN value_note TEXT");
    }
    if (!columns.has("nudge_count")) {
      return;
    }
    // One row per (slot, member) is not knowable from the old table -- it recorded the nudge, not
    // who received it -- so the paper's first author is the best available answer, and it is who
    // the old pass would have been messaging in all but a handful of cases.
    this.db.exec(`
      INSERT OR IGNORE INTO adminbot_nudge_ledger
        (domain, subject_id, member_id, last_nudged_at, nudge_count, snoozed_until)
      SELECT
        'paper_slot',
        s.paper_id || ':' || s.slot,
        COALESCE(
          json_extract(p.payload_json, '$.first_author_member_id'),
          json_extract(p.payload_json, '$.submitted_by_member_id')
        ),
        s.last_nudged_at,
        s.nudge_count,
        s.snoozed_until
      FROM adminbot_paper_slots s
      JOIN adminbot_papers p ON p.id = s.paper_id
      WHERE s.nudge_count > 0
        AND COALESCE(
          json_extract(p.payload_json, '$.first_author_member_id'),
          json_extract(p.payload_json, '$.submitted_by_member_id')
        ) IS NOT NULL
    `);
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

  listProposalsByType(type: AdminBotStoredProposal["type"]): AdminBotStoredProposal[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json
          FROM adminbot_proposals
          WHERE action_type = ?
          ORDER BY created_at ASC`,
      )
      .all(type) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotStoredProposal>(row.payload_json));
  }

  saveDeadlineProposalSubmission(
    proposal: AdminBotStoredProposal,
    submitterMemberId: string,
    idempotencyKey: string,
  ): { proposal: AdminBotStoredProposal; created: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          `SELECT p.payload_json
            FROM adminbot_deadline_submission_keys k
            JOIN adminbot_proposals p ON p.id = k.action_id
            WHERE k.submitter_member_id = ? AND k.idempotency_key = ?`,
        )
        .get(submitterMemberId, idempotencyKey) as { payload_json?: string } | undefined;
      if (existing?.payload_json) {
        this.db.exec("COMMIT");
        return {
          proposal: parseJson<AdminBotStoredProposal>(existing.payload_json),
          created: false,
        };
      }
      this.saveProposal(proposal);
      this.db
        .prepare(
          `INSERT INTO adminbot_deadline_submission_keys
            (submitter_member_id, idempotency_key, action_id)
            VALUES (?, ?, ?)`,
        )
        .run(submitterMemberId, idempotencyKey, proposal.id);
      this.db.exec("COMMIT");
      return { proposal, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceDeadlineProposalRevision(
    previous: AdminBotStoredProposal,
    next: AdminBotStoredProposal,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.updateProposal(previous);
      this.saveProposal(next);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  savePublishedDeadline(record: PublishedDeadlineRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO adminbot_published_deadlines (
          action_id,
          proposal_id,
          deadline_id,
          revision,
          published_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.action_id,
        record.proposal_id,
        record.deadline_id,
        record.revision,
        record.published_at,
        JSON.stringify(record),
      );
  }

  listPublishedDeadlines(): PublishedDeadlineRecord[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json
          FROM adminbot_published_deadlines
          ORDER BY published_at ASC, revision ASC`,
      )
      .all() as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<PublishedDeadlineRecord>(row.payload_json));
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

  deleteLabMember(memberId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM adminbot_lab_members WHERE id = ?")
      .run(memberId) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  /**
   * Every table that names a member, and the column it names them in.
   *
   * Written out rather than discovered from the schema at runtime: a column called `member_id` is
   * not automatically a roster reference, and a merge that repointed the wrong one would be a
   * silent data corruption rather than a failure. Adding a table with a member column means adding
   * it here, which the merge test asserts by counting what moved.
   */
  private static readonly MEMBER_REFERENCE_COLUMNS: ReadonlyArray<[string, string]> = [
    ["adminbot_account_registrations", "member_id"],
    ["adminbot_cv_changes", "member_id"],
    ["adminbot_logistics_requests", "member_id"],
    ["adminbot_login_events", "member_id"],
    ["adminbot_member_locations", "member_id"],
    ["adminbot_nudge_ledger", "member_id"],
    ["adminbot_paper_conference_attendees", "member_id"],
    ["adminbot_paper_reimbursements", "member_id"],
    ["adminbot_paper_social_draft_consents", "member_id"],
    ["adminbot_paper_social_drafts", "generated_by_member_id"],
    ["adminbot_paper_slots", "provided_by_member_id"],
    ["adminbot_paper_slots", "waived_by_member_id"],
    ["adminbot_password_resets", "member_id"],
    // Both member columns on an update event move. `member_id` is who typed, and repointing it is
    // what keeps the merged member's authorship -- and so their adoption rate -- intact.
    // `subject_member_id` is whose record was touched, and a merge that moved one without the
    // other would turn a self-edit into an admin edit, or the reverse.
    ["adminbot_update_events", "member_id"],
    ["adminbot_update_events", "subject_member_id"],
    // The login itself. Moving it is the point of a merge -- one person with two accounts ends up
    // with one account they can still sign in to -- and the collision rule decides which address
    // that is: if the survivor already has a credential, theirs stands and the duplicate's row is
    // dropped, so the retired address stops working. Both outcomes are in the merge's audit line.
    //
    // Live sessions are deliberately NOT in this sweep. They are repointable in principle, but a
    // session is a bearer of someone's identity and a merge is a human judgement that two records
    // are one person; if that judgement is ever wrong, a repointed session hands one person's
    // signed-in browser the other's record. The service revokes the retired member's sessions
    // instead, which costs a sign-in and cannot be wrong.
    ["adminbot_member_credentials", "member_id"],
  ];

  reassignMemberReferences(fromMemberId: string, toMemberId: string): Record<string, number> {
    const moved: Record<string, number> = {};
    // One transaction: a half-repointed member is worse than an unmerged one, because the rows
    // that did move no longer name a record anybody can find their way back from. Written as an
    // explicit BEGIN/COMMIT for the same reason replaceVenueIndex is -- node:sqlite's DatabaseSync
    // has no `transaction()` wrapper.
    this.db.exec("BEGIN");
    try {
      for (const [table, column] of AdminBotSqliteStore.MEMBER_REFERENCE_COLUMNS) {
        // The tall tables key on (subject, member), so a row that would collide with one the
        // survivor already has is dropped rather than updated -- two attendee rows for one person
        // on one paper is not a merge, it is a duplicate with a new name. INSERT OR REPLACE
        // semantics are wrong here for the same reason: the survivor's own answer wins.
        const result = this.db
          .prepare(`UPDATE OR IGNORE "${table}" SET ${column} = ? WHERE ${column} = ?`)
          .run(toMemberId, fromMemberId) as { changes?: number };
        const changes = result.changes ?? 0;
        if (changes > 0) {
          moved[`${table}.${column}`] = (moved[`${table}.${column}`] ?? 0) + changes;
        }
        // Whatever the UPDATE could not move is a collision with a row the survivor already owns.
        this.db.prepare(`DELETE FROM "${table}" WHERE ${column} = ?`).run(fromMemberId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return moved;
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

  replaceVenueIndex(
    venueId: string,
    papers: AdminBotVenuePaper[],
    indexedAt: string,
    model: string,
  ): void {
    const remove = this.db.prepare("DELETE FROM adminbot_venue_papers WHERE venue_id = ?");
    const insert = this.db.prepare(
      `INSERT INTO adminbot_venue_papers (
         venue_id, paper_id, indexed_at, embedding_model, payload_json
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    // Explicit BEGIN/COMMIT so a failed rebuild leaves the previous index intact: without it a
    // crash mid-insert leaves the venue half-indexed and silently ranking against a partial
    // corpus. Written out rather than via a helper because node:sqlite's DatabaseSync has no
    // `transaction()` wrapper -- that is better-sqlite3, which this file does not use.
    this.db.exec("BEGIN");
    try {
      remove.run(venueId);
      for (const paper of papers) {
        insert.run(venueId, paper.paper_id, indexedAt, model, JSON.stringify(paper));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listVenuePapers(venueId: string): AdminBotVenuePaper[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM adminbot_venue_papers WHERE venue_id = ?")
      .all(venueId) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotVenuePaper>(row.payload_json));
  }

  listVenueIndexStatuses(): Omit<AdminBotVenueIndexStatus, "label">[] {
    const rows = this.db
      .prepare(
        `SELECT venue_id, COUNT(*) AS paper_count,
                MAX(indexed_at) AS indexed_at,
                MAX(embedding_model) AS embedding_model
         FROM adminbot_venue_papers GROUP BY venue_id`,
      )
      .all() as Array<{
      venue_id: string;
      paper_count: number;
      indexed_at: string | null;
      embedding_model: string | null;
    }>;
    // Built without a conditional spread: MAX() over a grouped column is null only for an empty
    // group, which cannot happen here, and `undefined` reads the same as an absent key to every
    // caller. Matches how the route serialises the same record.
    return rows.map((row) => ({
      venue_id: row.venue_id,
      paper_count: row.paper_count,
      indexed_at: row.indexed_at ?? undefined,
      embedding_model: row.embedding_model ?? undefined,
    }));
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
    // Everything hanging off the paper goes with it. Leaving any of it would let a re-created id
    // inherit the evidence, the drafts and the consents of a paper somebody deleted.
    const drafts = this.db
      .prepare("SELECT id FROM adminbot_paper_social_drafts WHERE paper_id = ?")
      .all(paperId) as Array<{ id: string }>;
    for (const draft of drafts) {
      this.db
        .prepare("DELETE FROM adminbot_paper_social_draft_consents WHERE draft_id = ?")
        .run(draft.id);
    }
    for (const table of [
      "adminbot_paper_slots",
      "adminbot_paper_social_drafts",
      "adminbot_paper_conference_attendees",
      "adminbot_paper_reimbursements",
      "adminbot_paperflow_evidence",
      // Left behind until now, against the comment above. A weekly update is the one row on a
      // paper that only its author can write, so an orphan of it is somebody's work attributed to
      // a paper that no longer exists -- and it is counted by the adoption rate.
      "adminbot_paper_weekly_updates",
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE paper_id = ?`).run(paperId);
    }
    for (const domain of ["paper_slot", "paperflow_stage"]) {
      this.db
        .prepare("DELETE FROM adminbot_nudge_ledger WHERE domain = ? AND subject_id LIKE ?")
        .run(domain, `${paperId}:%`);
    }
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
          value_note,
          provided_by_member_id,
          provided_at,
          validated_at,
          invalid_reason,
          waived_by_member_id,
          waived_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(paper_id, slot) DO UPDATE SET
          status = excluded.status,
          url = excluded.url,
          value_text = excluded.value_text,
          value_note = excluded.value_note,
          provided_by_member_id = excluded.provided_by_member_id,
          provided_at = excluded.provided_at,
          validated_at = excluded.validated_at,
          invalid_reason = excluded.invalid_reason,
          waived_by_member_id = excluded.waived_by_member_id,
          waived_reason = excluded.waived_reason`,
      )
      .run(
        record.paper_id,
        record.slot,
        record.status,
        record.url ?? null,
        record.value_text ?? null,
        record.value_note ?? null,
        record.provided_by_member_id ?? null,
        record.provided_at ?? null,
        record.validated_at ?? null,
        record.invalid_reason ?? null,
        record.waived_by_member_id ?? null,
        record.waived_reason ?? null,
      );
  }

  saveNudgeLedgerEntry(record: AdminBotNudgeLedgerRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_nudge_ledger
          (domain, subject_id, member_id, last_nudged_at, nudge_count, snoozed_until)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain, subject_id, member_id) DO UPDATE SET
           last_nudged_at = excluded.last_nudged_at,
           nudge_count = excluded.nudge_count,
           snoozed_until = excluded.snoozed_until`,
      )
      .run(
        record.domain,
        record.subject_id,
        record.member_id,
        record.last_nudged_at ?? null,
        record.nudge_count,
        record.snoozed_until ?? null,
      );
  }

  /** The whole ledger, or one domain's slice. The sweep wants all of it in one read. */
  listNudgeLedger(domain?: string): AdminBotNudgeLedgerRecord[] {
    const rows = (
      domain
        ? this.db.prepare("SELECT * FROM adminbot_nudge_ledger WHERE domain = ?").all(domain)
        : this.db.prepare("SELECT * FROM adminbot_nudge_ledger").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      domain: String(row.domain) as AdminBotNudgeLedgerRecord["domain"],
      subject_id: String(row.subject_id),
      member_id: String(row.member_id),
      nudge_count: Number(row.nudge_count ?? 0),
      ...optionalText(row, "last_nudged_at"),
      ...optionalText(row, "snoozed_until"),
    }));
  }

  saveSocialDraft(record: AdminBotSocialDraftRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_paper_social_drafts
          (id, paper_id, platform, body, model, generated_at, generated_by_member_id, status, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           body = excluded.body,
           model = excluded.model,
           status = excluded.status,
           superseded_by = excluded.superseded_by`,
      )
      .run(
        record.id,
        record.paper_id,
        record.platform,
        record.body,
        record.model ?? null,
        record.generated_at,
        record.generated_by_member_id ?? null,
        record.status,
        record.superseded_by ?? null,
      );
  }

  listSocialDrafts(paperId?: string): AdminBotSocialDraftRecord[] {
    const rows = (
      paperId
        ? this.db
            .prepare(
              "SELECT * FROM adminbot_paper_social_drafts WHERE paper_id = ? ORDER BY generated_at DESC",
            )
            .all(paperId)
        : this.db
            .prepare("SELECT * FROM adminbot_paper_social_drafts ORDER BY generated_at DESC")
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      paper_id: String(row.paper_id),
      platform: String(row.platform) as AdminBotSocialDraftRecord["platform"],
      body: String(row.body),
      generated_at: String(row.generated_at),
      status: String(row.status) as AdminBotSocialDraftRecord["status"],
      ...optionalText(row, "model"),
      ...optionalText(row, "generated_by_member_id"),
      ...optionalText(row, "superseded_by"),
    }));
  }

  saveSocialConsent(record: AdminBotSocialConsentRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_paper_social_draft_consents
          (draft_id, member_id, decision, comment, asked_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(draft_id, member_id) DO UPDATE SET
           decision = excluded.decision,
           comment = excluded.comment,
           decided_at = excluded.decided_at`,
      )
      .run(
        record.draft_id,
        record.member_id,
        record.decision,
        record.comment ?? null,
        record.asked_at,
        record.decided_at ?? null,
      );
  }

  listSocialConsents(draftId?: string): AdminBotSocialConsentRecord[] {
    const rows = (
      draftId
        ? this.db
            .prepare("SELECT * FROM adminbot_paper_social_draft_consents WHERE draft_id = ?")
            .all(draftId)
        : this.db.prepare("SELECT * FROM adminbot_paper_social_draft_consents").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      draft_id: String(row.draft_id),
      member_id: String(row.member_id),
      decision: String(row.decision) as AdminBotSocialConsentRecord["decision"],
      asked_at: String(row.asked_at),
      ...optionalText(row, "comment"),
      ...optionalText(row, "decided_at"),
    }));
  }

  saveConferenceAttendee(record: AdminBotConferenceAttendeeRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_paper_conference_attendees
          (paper_id, attendee_key, member_id, name, attending, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(paper_id, attendee_key) DO UPDATE SET
           member_id = excluded.member_id,
           name = excluded.name,
           attending = excluded.attending,
           confirmed_at = excluded.confirmed_at`,
      )
      .run(
        record.paper_id,
        record.attendee_key,
        record.member_id ?? null,
        record.name,
        record.attending,
        record.confirmed_at ?? null,
      );
  }

  listConferenceAttendees(paperId?: string): AdminBotConferenceAttendeeRecord[] {
    const rows = (
      paperId
        ? this.db
            .prepare(
              "SELECT * FROM adminbot_paper_conference_attendees WHERE paper_id = ? ORDER BY name",
            )
            .all(paperId)
        : this.db
            .prepare("SELECT * FROM adminbot_paper_conference_attendees ORDER BY paper_id, name")
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      paper_id: String(row.paper_id),
      attendee_key: String(row.attendee_key),
      name: String(row.name),
      attending: String(row.attending) as AdminBotConferenceAttendeeRecord["attending"],
      ...optionalText(row, "member_id"),
      ...optionalText(row, "confirmed_at"),
    }));
  }

  savePaperReimbursement(record: AdminBotPaperReimbursementRecord): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_paper_reimbursements
          (paper_id, member_id, status, submitted_at, completed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(paper_id, member_id) DO UPDATE SET
           status = excluded.status,
           submitted_at = excluded.submitted_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        record.paper_id,
        record.member_id,
        record.status,
        record.submitted_at ?? null,
        record.completed_at ?? null,
      );
  }

  listPaperReimbursements(paperId?: string): AdminBotPaperReimbursementRecord[] {
    const rows = (
      paperId
        ? this.db
            .prepare("SELECT * FROM adminbot_paper_reimbursements WHERE paper_id = ?")
            .all(paperId)
        : this.db.prepare("SELECT * FROM adminbot_paper_reimbursements").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      paper_id: String(row.paper_id),
      member_id: String(row.member_id),
      status: String(row.status) as AdminBotPaperReimbursementRecord["status"],
      ...optionalText(row, "submitted_at"),
      ...optionalText(row, "completed_at"),
    }));
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

  savePaperflowEvidence(record: AdminBotPaperflowEvidenceRecord): void {
    // First sighting wins. A stage that already closed stays closed with the mail that closed it:
    // a later bcc on the same decision is the author forwarding the thread again, and letting it
    // overwrite would rewrite when the lab actually found out.
    this.db
      .prepare(
        `INSERT INTO adminbot_paperflow_evidence
          (paper_id, stage, message_id, subject, sender, recorded_at, recorded_by, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(paper_id, stage) DO NOTHING`,
      )
      .run(
        record.paper_id,
        record.stage,
        record.message_id ?? null,
        record.subject ?? null,
        record.sender ?? null,
        record.recorded_at,
        record.recorded_by,
        record.confidence ?? null,
      );
  }

  listPaperflowEvidence(paperId?: string): AdminBotPaperflowEvidenceRecord[] {
    const rows = (
      paperId
        ? this.db
            .prepare("SELECT * FROM adminbot_paperflow_evidence WHERE paper_id = ? ORDER BY stage")
            .all(paperId)
        : this.db
            .prepare("SELECT * FROM adminbot_paperflow_evidence ORDER BY paper_id, stage")
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const record: AdminBotPaperflowEvidenceRecord = {
        paper_id: String(row.paper_id),
        stage: String(row.stage) as AdminBotPaperflowEvidenceRecord["stage"],
        recorded_at: String(row.recorded_at),
        recorded_by: String(row.recorded_by) as AdminBotPaperflowEvidenceRecord["recorded_by"],
      };
      Object.assign(
        record,
        optionalText(row, "message_id"),
        optionalText(row, "subject"),
        optionalText(row, "sender"),
      );
      if (row.confidence !== null && row.confidence !== undefined) {
        record.confidence = Number(row.confidence);
      }
      return record;
    });
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

  appendLoginEvent(event: AdminBotLoginEvent): void {
    this.db
      .prepare("INSERT INTO adminbot_login_events (id, member_id, at) VALUES (?, ?, ?)")
      .run(event.id, event.member_id, event.at);
  }

  listLoginEvents(memberId: string, limit?: number): AdminBotLoginEvent[] {
    return (
      this.db
        .prepare(
          `SELECT id, member_id, at FROM adminbot_login_events
         WHERE member_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
        )
        // -1 is SQLite's "no limit", which keeps this one statement rather than two.
        .all(memberId, typeof limit === "number" ? limit : -1) as AdminBotLoginEvent[]
    );
  }

  listLoginEventsSince(since: string): AdminBotLoginEvent[] {
    return this.db
      .prepare(
        "SELECT id, member_id, at FROM adminbot_login_events WHERE at >= ? ORDER BY at DESC, rowid DESC",
      )
      .all(since) as AdminBotLoginEvent[];
  }

  appendUpdateEvent(event: AdminBotUpdateEvent): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_update_events
           (id, subject, slot_id, member_id, at, source, subject_member_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.subject,
        event.slot_id,
        event.member_id,
        event.at,
        event.source,
        event.subject_member_id ?? null,
      );
  }

  listUpdateEventsByMember(memberId: string, limit?: number): AdminBotUpdateEvent[] {
    return this.readUpdateEvents(
      "WHERE member_id = ? ORDER BY at DESC, rowid DESC LIMIT ?",
      memberId,
      typeof limit === "number" ? limit : -1,
    );
  }

  listUpdateEventsBySlot(slotId: string, limit?: number): AdminBotUpdateEvent[] {
    return this.readUpdateEvents(
      "WHERE slot_id = ? ORDER BY at DESC, rowid DESC LIMIT ?",
      slotId,
      typeof limit === "number" ? limit : -1,
    );
  }

  listUpdateEventsSince(since: string): AdminBotUpdateEvent[] {
    return this.readUpdateEvents("WHERE at >= ? ORDER BY at DESC, rowid DESC", since);
  }

  // SQLite gives back `null` for an absent TEXT column, but the contract says the field is absent.
  // Normalizing here keeps every reader's "did somebody else edit this" check a null check.
  private readUpdateEvents(
    clause: string,
    ...params: Array<string | number>
  ): AdminBotUpdateEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, subject, slot_id, member_id, at, source, subject_member_id
         FROM adminbot_update_events ${clause}`,
      )
      .all(...params) as Array<AdminBotUpdateEvent & { subject_member_id: string | null }>;
    return rows.map(({ subject_member_id, ...rest }) => ({
      ...rest,
      ...(subject_member_id ? { subject_member_id } : {}),
    }));
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

  saveMemberNotification(notification: AdminBotMemberNotification): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_member_notifications (
          id,
          member_id,
          kind,
          created_at,
          read_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          member_id = excluded.member_id,
          kind = excluded.kind,
          created_at = excluded.created_at,
          read_at = excluded.read_at,
          payload_json = excluded.payload_json`,
      )
      .run(
        notification.id,
        notification.member_id,
        notification.kind,
        notification.created_at,
        notification.read_at ?? null,
        JSON.stringify(notification),
      );
  }

  listMemberNotifications(memberId: string): AdminBotMemberNotification[] {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM adminbot_member_notifications WHERE member_id = ? ORDER BY created_at DESC",
      )
      .all(memberId) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotMemberNotification>(row.payload_json));
  }

  deleteMemberNotification(notificationId: string): boolean {
    return (
      this.db.prepare("DELETE FROM adminbot_member_notifications WHERE id = ?").run(notificationId)
        .changes > 0
    );
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

  savePaperWeeklyUpdate(update: AdminBotPaperWeeklyUpdate): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_paper_weekly_updates (
          paper_id, member_id, week_start, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(paper_id, member_id, week_start) DO UPDATE SET
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json`,
      )
      .run(
        update.paper_id,
        update.member_id,
        update.week_start,
        update.updated_at,
        JSON.stringify(update),
      );
  }

  listPaperWeeklyUpdates(params?: {
    paperId?: string;
    weekStart?: string;
  }): AdminBotPaperWeeklyUpdate[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (params?.paperId) {
      clauses.push("paper_id = ?");
      values.push(params.paperId);
    }
    if (params?.weekStart) {
      clauses.push("week_start = ?");
      values.push(params.weekStart);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM adminbot_paper_weekly_updates ${where} ORDER BY week_start DESC, member_id`,
      )
      .all(...values) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotPaperWeeklyUpdate>(row.payload_json));
  }

  saveFeedback(entry: AdminBotFeedbackEntry): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_feedback (
          id, feature_id, rating, member_id, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          feature_id = excluded.feature_id,
          rating = excluded.rating,
          member_id = excluded.member_id,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json`,
      )
      .run(
        entry.id,
        entry.feature_id,
        entry.rating,
        entry.member_id ?? null,
        entry.updated_at,
        JSON.stringify(entry),
      );
  }

  listFeedback(featureId?: string): AdminBotFeedbackEntry[] {
    const rows = (
      featureId
        ? this.db
            .prepare(
              "SELECT payload_json FROM adminbot_feedback WHERE feature_id = ? ORDER BY updated_at DESC",
            )
            .all(featureId)
        : this.db
            .prepare("SELECT payload_json FROM adminbot_feedback ORDER BY updated_at DESC")
            .all()
    ) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<AdminBotFeedbackEntry>(row.payload_json));
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
    ...optional("url"),
    ...optional("value_text"),
    ...optional("value_note"),
    ...optional("provided_by_member_id"),
    ...optional("provided_at"),
    ...optional("validated_at"),
    ...optional("invalid_reason"),
    ...optional("waived_by_member_id"),
    ...optional("waived_reason"),
  };
}

/** The same drop-the-null rule as paperSlotFromRow, for the cycle tables. */
function optionalText(row: Record<string, unknown>, key: string): Record<string, string> {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
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
