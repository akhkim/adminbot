import type { DatabaseSync } from "node:sqlite";
import type {
  PaperAiTextCheck,
  PaperIntegrityAlertReason,
} from "../contracts/paper-integrity-checks.js";

// Keyed like adminbot_openreview_citation_checks, so a version's two checks join on the same pair.
const SCHEMA = `CREATE TABLE IF NOT EXISTS adminbot_paper_ai_text_checks (
  submission_id TEXT NOT NULL,
  pdf_path TEXT NOT NULL,
  pdf_sha256 TEXT,
  title TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'unreadable', 'failed')),
  checked_at TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  fraction_ai REAL,
  fraction_ai_assisted REAL,
  fraction_human REAL,
  prediction TEXT,
  words_scored INTEGER,
  error TEXT,
  alerted_for_json TEXT,
  alert_proposal_ids_json TEXT,
  alert_error TEXT,
  scored_from TEXT,
  model_version TEXT,
  PRIMARY KEY (submission_id, pdf_path)
)`;

export function ensurePaperAiTextCheckSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
  // Added as scoring changed (see PaperAiTextCheck.scored_from). Existing rows keep NULL, which
  // marks them as scores from an earlier pipeline, due one re-score.
  const columns = db
    .prepare(`PRAGMA table_info(adminbot_paper_ai_text_checks)`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
  for (const column of ["scored_from", "model_version"]) {
    if (!columns.includes(column)) {
      db.exec(`ALTER TABLE adminbot_paper_ai_text_checks ADD COLUMN ${column} TEXT`);
    }
  }
}

export function savePaperAiTextCheck(db: DatabaseSync, check: PaperAiTextCheck) {
  db.prepare(`INSERT INTO adminbot_paper_ai_text_checks (submission_id, pdf_path, pdf_sha256,
      title, venue_id, status, checked_at, attempts, fraction_ai, fraction_ai_assisted,
      fraction_human, prediction, words_scored, error, alerted_for_json, alert_proposal_ids_json,
      alert_error, scored_from, model_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id, pdf_path) DO UPDATE SET
      pdf_sha256=excluded.pdf_sha256, title=excluded.title, venue_id=excluded.venue_id,
      status=excluded.status, checked_at=excluded.checked_at, attempts=excluded.attempts,
      fraction_ai=excluded.fraction_ai, fraction_ai_assisted=excluded.fraction_ai_assisted,
      fraction_human=excluded.fraction_human, prediction=excluded.prediction,
      words_scored=excluded.words_scored, error=excluded.error,
      alerted_for_json=excluded.alerted_for_json,
      alert_proposal_ids_json=excluded.alert_proposal_ids_json,
      alert_error=excluded.alert_error, scored_from=excluded.scored_from,
      model_version=excluded.model_version`).run(
    check.submission_id,
    check.pdf_path,
    check.pdf_sha256 ?? null,
    check.title,
    check.venue_id,
    check.status,
    check.checked_at,
    check.attempts,
    check.fraction_ai ?? null,
    check.fraction_ai_assisted ?? null,
    check.fraction_human ?? null,
    check.prediction ?? null,
    check.words_scored ?? null,
    check.error ?? null,
    check.alerted_for?.length ? JSON.stringify(check.alerted_for) : null,
    check.alert_proposal_ids?.length ? JSON.stringify(check.alert_proposal_ids) : null,
    check.alert_error ?? null,
    check.scored_from ?? null,
    check.model_version ?? null,
  );
}

export function getPaperAiTextCheck(
  db: DatabaseSync,
  submissionId: string,
  pdfPath: string,
): PaperAiTextCheck | undefined {
  const row = db
    .prepare(`SELECT * FROM adminbot_paper_ai_text_checks WHERE submission_id = ? AND pdf_path = ?`)
    .get(submissionId, pdfPath);
  return row ? fromRow(row) : undefined;
}

export function listPaperAiTextChecks(db: DatabaseSync, submissionId?: string): PaperAiTextCheck[] {
  const rows =
    submissionId === undefined
      ? db.prepare(`SELECT * FROM adminbot_paper_ai_text_checks ORDER BY checked_at DESC`).all()
      : db
          .prepare(
            `SELECT * FROM adminbot_paper_ai_text_checks WHERE submission_id = ?
              ORDER BY checked_at DESC`,
          )
          .all(submissionId);
  return rows.map(fromRow);
}

function fromRow(row: Record<string, unknown>): PaperAiTextCheck {
  const optionalNumber = (value: unknown) =>
    value === null || value === undefined ? undefined : Number(value);
  const fields = {
    fraction_ai: optionalNumber(row.fraction_ai),
    fraction_ai_assisted: optionalNumber(row.fraction_ai_assisted),
    fraction_human: optionalNumber(row.fraction_human),
    words_scored: optionalNumber(row.words_scored),
  };
  return {
    submission_id: String(row.submission_id),
    pdf_path: String(row.pdf_path),
    ...(row.pdf_sha256 === null ? {} : { pdf_sha256: String(row.pdf_sha256) }),
    title: String(row.title),
    venue_id: String(row.venue_id),
    status: row.status as PaperAiTextCheck["status"],
    checked_at: String(row.checked_at),
    attempts: Number(row.attempts),
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    ...(row.prediction === null ? {} : { prediction: String(row.prediction) }),
    ...(row.error === null ? {} : { error: String(row.error) }),
    ...(row.alerted_for_json === null
      ? {}
      : { alerted_for: JSON.parse(String(row.alerted_for_json)) as PaperIntegrityAlertReason[] }),
    ...(row.alert_proposal_ids_json === null
      ? {}
      : { alert_proposal_ids: JSON.parse(String(row.alert_proposal_ids_json)) as string[] }),
    ...(row.alert_error === null ? {} : { alert_error: String(row.alert_error) }),
    ...(row.scored_from === null || row.scored_from === undefined
      ? {}
      : { scored_from: row.scored_from as PaperAiTextCheck["scored_from"] }),
    ...(row.model_version === null || row.model_version === undefined
      ? {}
      : { model_version: String(row.model_version) }),
  };
}
