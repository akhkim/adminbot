import type { DatabaseSync } from "node:sqlite";
import type { ReferenceScan, ReferenceScanResult } from "../contracts/reference-scans.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS adminbot_reference_scans (
  submission_id TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  result_json TEXT,
  PRIMARY KEY (submission_id, pdf_sha256)
)`;

export function ensureReferenceScanSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(adminbot_reference_scans)").all();
  if (!columns.some((column) => column.name === "payload_json")) {
    db.exec(SCHEMA);
    return;
  }
  // Preserve scans if an operator already ran the initial MVP schema.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE adminbot_reference_scans RENAME TO adminbot_reference_scans_legacy");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO adminbot_reference_scans (submission_id, pdf_sha256, status, result_json)
      SELECT submission_id, pdf_sha256, json_extract(payload_json, '$.status'),
        json_extract(payload_json, '$.result') FROM adminbot_reference_scans_legacy`);
    db.exec("DROP TABLE adminbot_reference_scans_legacy");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveReferenceScan(db: DatabaseSync, scan: ReferenceScan): void {
  db.prepare(`INSERT INTO adminbot_reference_scans (submission_id, pdf_sha256, status, result_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(submission_id, pdf_sha256) DO UPDATE SET
      status=excluded.status, result_json=excluded.result_json`).run(
    scan.submission_id,
    scan.pdf_sha256,
    scan.status,
    scan.result ? JSON.stringify(scan.result) : null,
  );
}

export function getReferenceScan(
  db: DatabaseSync,
  submissionId: string,
  pdfHash: string,
): ReferenceScan | undefined {
  const row = db
    .prepare(`SELECT submission_id, pdf_sha256, status, result_json
    FROM adminbot_reference_scans WHERE submission_id = ? AND pdf_sha256 = ?`)
    .get(submissionId, pdfHash);
  if (!row) {
    return undefined;
  }
  return {
    submission_id: String(row.submission_id),
    pdf_sha256: String(row.pdf_sha256),
    status: row.status as ReferenceScan["status"],
    ...(row.result_json === null
      ? {}
      : { result: JSON.parse(String(row.result_json)) as ReferenceScanResult }),
  };
}
