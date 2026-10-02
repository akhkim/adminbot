import type { DatabaseSync } from "node:sqlite";
import type { LabHelpInterest } from "../contracts/lab-sharing-interest.js";

export function ensureLabInterestSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS adminbot_help_interests (
    paper_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (paper_id, member_id)
  )`);
}

// Composite uniqueness keeps retries isolated to this respondent and project.
export function saveHelpInterest(db: DatabaseSync, interest: LabHelpInterest): void {
  db.prepare(
    `INSERT INTO adminbot_help_interests (paper_id, member_id, payload_json) VALUES (?, ?, ?)
     ON CONFLICT(paper_id, member_id) DO UPDATE SET payload_json=excluded.payload_json`,
  ).run(interest.paper_id, interest.member_id, JSON.stringify(interest));
}

// Service authorization must project these private records before any API response.
export function listHelpInterests(db: DatabaseSync): LabHelpInterest[] {
  const rows = db
    .prepare("SELECT payload_json FROM adminbot_help_interests ORDER BY paper_id, member_id")
    .all() as { payload_json: string }[];
  return rows.map((row) => JSON.parse(row.payload_json) as LabHelpInterest);
}
