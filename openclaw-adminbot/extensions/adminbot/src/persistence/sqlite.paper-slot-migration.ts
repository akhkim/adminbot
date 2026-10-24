import type { DatabaseSync } from "node:sqlite";

// Moved out of sqlite.ts unchanged, which is at its size ratchet; it runs once per open from the
// store's constructor, after the schema block has created the ledger it copies into.

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
export function migratePaperSlotColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(adminbot_paper_slots)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  if (!columns.has("value_note")) {
    db.exec("ALTER TABLE adminbot_paper_slots ADD COLUMN value_note TEXT");
  }
  // Nullable with no default, like every other column added here: every row that already exists
  // reads back as unconfirmed, which is exactly what it is. Nothing is re-checked on upgrade --
  // the verification pass finds them in its own time.
  for (const column of [
    "verified_by",
    "verified_at",
    "verified_title",
    "previous_submission_id",
    "identity_review",
  ]) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE adminbot_paper_slots ADD COLUMN ${column} TEXT`);
    }
  }
  if (!columns.has("nudge_count")) {
    return;
  }
  // One row per (slot, member) is not knowable from the old table -- it recorded the nudge, not
  // who received it -- so the paper's first author is the best available answer, and it is who
  // the old pass would have been messaging in all but a handful of cases.
  db.exec(`
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
