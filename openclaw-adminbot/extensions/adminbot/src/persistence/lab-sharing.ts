import type { DatabaseSync } from "node:sqlite";
import type { LabHelpRequest } from "../contracts/lab-sharing.js";

// One request per project makes retries an upsert, including across service processes.
export function ensureLabSharingSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS adminbot_help_requests (
    paper_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL
  )`);
}
export function saveHelpRequest(db: DatabaseSync, request: LabHelpRequest): void {
  db.prepare(
    "INSERT INTO adminbot_help_requests (paper_id, payload_json) VALUES (?, ?) ON CONFLICT(paper_id) DO UPDATE SET payload_json=excluded.payload_json",
  ).run(request.paper_id, JSON.stringify(request));
}
export function listHelpRequests(db: DatabaseSync): LabHelpRequest[] {
  return (
    db.prepare("SELECT payload_json FROM adminbot_help_requests ORDER BY paper_id").all() as {
      payload_json: string;
    }[]
  ).map((row) => JSON.parse(row.payload_json) as LabHelpRequest);
}
