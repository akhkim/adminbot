import type { DatabaseSync } from "node:sqlite";
import type { AdminBotSocialDraftRecord } from "../contracts/paper-cycle.js";

/**
 * Paper social drafts (LinkedIn posts and X threads), cut from sqlite.ts so the store stays under
 * its file-size ratchet. An X draft may carry its stage-specific thread as JSON in `x_thread`.
 */

/** Older databases predate `x_thread`; add it in place. */
export function migrateSocialDraftColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(adminbot_paper_social_drafts)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "x_thread")) {
    db.exec("ALTER TABLE adminbot_paper_social_drafts ADD COLUMN x_thread TEXT");
  }
}

export function saveSqliteSocialDraft(db: DatabaseSync, record: AdminBotSocialDraftRecord): void {
  db.prepare(
    `INSERT INTO adminbot_paper_social_drafts
      (id, paper_id, platform, body, model, generated_at, generated_by_member_id, status, superseded_by, x_thread)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       body = excluded.body,
       model = excluded.model,
       status = excluded.status,
       superseded_by = excluded.superseded_by,
       x_thread = excluded.x_thread`,
  ).run(
    record.id,
    record.paper_id,
    record.platform,
    record.body,
    record.model ?? null,
    record.generated_at,
    record.generated_by_member_id ?? null,
    record.status,
    record.superseded_by ?? null,
    record.x_thread ? JSON.stringify(record.x_thread) : null,
  );
}

/**
 * Newest first, then what the paper read has always fallen back to on a tie: it walks the
 * (paper_id, platform, generated_at) index, so equal times came out by platform, then by insertion.
 * Spelled out so the all-papers read groups into exactly the per-paper order.
 */
const DRAFT_ORDER = "generated_at DESC, platform, rowid";

export function listSqliteSocialDrafts(
  db: DatabaseSync,
  paperId?: string,
  draftId?: string,
): AdminBotSocialDraftRecord[] {
  const rows = (
    draftId
      ? db.prepare("SELECT * FROM adminbot_paper_social_drafts WHERE id = ?").all(draftId)
      : paperId
        ? db
            .prepare(
              `SELECT * FROM adminbot_paper_social_drafts WHERE paper_id = ? ORDER BY ${DRAFT_ORDER}`,
            )
            .all(paperId)
        : db.prepare(`SELECT * FROM adminbot_paper_social_drafts ORDER BY ${DRAFT_ORDER}`).all()
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
    ...(typeof row.x_thread === "string" ? { x_thread: JSON.parse(row.x_thread) } : {}),
  }));
}

function optionalText(row: Record<string, unknown>, key: string): Record<string, string> {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
}
