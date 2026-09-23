import type { DatabaseSync } from "node:sqlite";
import type {
  CitationCheckFinding,
  OpenReviewCitationCheck,
} from "../contracts/openreview-citation-checks.js";

// Keyed by the upload's content-addressed path, not the PDF hash: a download that fails still
// needs a row (to count attempts), and it has no hash yet.
const SCHEMA = `CREATE TABLE IF NOT EXISTS adminbot_openreview_citation_checks (
  submission_id TEXT NOT NULL,
  pdf_path TEXT NOT NULL,
  pdf_sha256 TEXT,
  title TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'unreadable', 'failed')),
  checked_at TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  findings_json TEXT,
  error TEXT,
  notification_proposal_id TEXT,
  extractor_version INTEGER,
  PRIMARY KEY (submission_id, pdf_path)
)`;

export function ensureOpenReviewCitationCheckSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
  const columns = db.prepare("PRAGMA table_info(adminbot_openreview_citation_checks)").all();
  // Rows from the first release predate the column and read back as version 1.
  if (!columns.some((column) => column.name === "extractor_version")) {
    db.exec("ALTER TABLE adminbot_openreview_citation_checks ADD COLUMN extractor_version INTEGER");
  }
}

export function saveOpenReviewCitationCheck(db: DatabaseSync, check: OpenReviewCitationCheck) {
  db.prepare(`INSERT INTO adminbot_openreview_citation_checks (submission_id, pdf_path,
      pdf_sha256, title, venue_id, status, checked_at, attempts, findings_json, error,
      notification_proposal_id, extractor_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id, pdf_path) DO UPDATE SET
      pdf_sha256=excluded.pdf_sha256, title=excluded.title, venue_id=excluded.venue_id,
      status=excluded.status, checked_at=excluded.checked_at, attempts=excluded.attempts,
      findings_json=excluded.findings_json, error=excluded.error,
      notification_proposal_id=excluded.notification_proposal_id,
      extractor_version=excluded.extractor_version`).run(
    check.submission_id,
    check.pdf_path,
    check.pdf_sha256 ?? null,
    check.title,
    check.venue_id,
    check.status,
    check.checked_at,
    check.attempts,
    check.findings ? JSON.stringify(check.findings) : null,
    check.error ?? null,
    check.notification_proposal_id ?? null,
    check.extractor_version ?? null,
  );
}

export function getOpenReviewCitationCheck(
  db: DatabaseSync,
  submissionId: string,
  pdfPath: string,
): OpenReviewCitationCheck | undefined {
  const row = db
    .prepare(
      `SELECT * FROM adminbot_openreview_citation_checks WHERE submission_id = ? AND pdf_path = ?`,
    )
    .get(submissionId, pdfPath);
  return row ? fromRow(row) : undefined;
}

export function listOpenReviewCitationChecks(
  db: DatabaseSync,
  submissionId?: string,
): OpenReviewCitationCheck[] {
  const rows =
    submissionId === undefined
      ? db
          .prepare(`SELECT * FROM adminbot_openreview_citation_checks ORDER BY checked_at DESC`)
          .all()
      : db
          .prepare(
            `SELECT * FROM adminbot_openreview_citation_checks WHERE submission_id = ?
              ORDER BY checked_at DESC`,
          )
          .all(submissionId);
  return rows.map(fromRow);
}

function fromRow(row: Record<string, unknown>): OpenReviewCitationCheck {
  return {
    submission_id: String(row.submission_id),
    pdf_path: String(row.pdf_path),
    ...(row.pdf_sha256 === null ? {} : { pdf_sha256: String(row.pdf_sha256) }),
    title: String(row.title),
    venue_id: String(row.venue_id),
    status: row.status as OpenReviewCitationCheck["status"],
    checked_at: String(row.checked_at),
    attempts: Number(row.attempts),
    ...(row.findings_json === null
      ? {}
      : { findings: JSON.parse(String(row.findings_json)) as CitationCheckFinding[] }),
    ...(row.error === null ? {} : { error: String(row.error) }),
    ...(row.notification_proposal_id === null
      ? {}
      : { notification_proposal_id: String(row.notification_proposal_id) }),
    ...(row.extractor_version === null || row.extractor_version === undefined
      ? {}
      : { extractor_version: Number(row.extractor_version) }),
  };
}
