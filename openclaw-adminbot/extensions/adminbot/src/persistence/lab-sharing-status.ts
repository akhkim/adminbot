import type { DatabaseSync } from "node:sqlite";
import type { LabDirectorStatus } from "../contracts/lab-sharing-status.js";

export function ensureDirectorStatusSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS adminbot_director_status (
    id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL
  )`);
}

export function saveDirectorStatus(db: DatabaseSync, status: LabDirectorStatus | null): void {
  if (!status) {
    db.prepare("DELETE FROM adminbot_director_status WHERE id = 1").run();
    return;
  }
  db.prepare(
    "INSERT INTO adminbot_director_status (id, payload_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json",
  ).run(JSON.stringify(status));
}

// Raw persistence: callers must apply expiry and audience checks before projection.
export function readDirectorStatus(db: DatabaseSync): LabDirectorStatus | null {
  const row = db.prepare("SELECT payload_json FROM adminbot_director_status WHERE id = 1").get() as
    | { payload_json: string }
    | undefined;
  return row ? (JSON.parse(row.payload_json) as LabDirectorStatus) : null;
}
