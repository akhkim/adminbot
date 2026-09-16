import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ADMINBOT_BROADCAST_HISTORY_LIMIT,
  type LabDirectorStatus,
} from "../contracts/lab-sharing-status.js";

/**
 * The broadcast archive, and the one-row table it grew out of.
 *
 * `adminbot_director_status` held exactly one row by construction (`CHECK (id = 1)`), so every
 * publish overwrote the last. The history table replaces it. The old table is still created here
 * and then drained on first open: an installation that has been running carries a current status in
 * it, and losing that on upgrade would blank the banner for whatever it was saying.
 *
 * Ordering is by `posted_at` and then `rowid`, never by id: ids are random, and two broadcasts
 * published inside the same millisecond would otherwise come back in an order that changes between
 * reads -- which for a list whose first element *is* the current broadcast is not cosmetic.
 */
export function ensureDirectorStatusSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS adminbot_director_status (
    id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS adminbot_director_broadcasts (
    id TEXT PRIMARY KEY, posted_at TEXT NOT NULL, payload_json TEXT NOT NULL
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS adminbot_director_broadcasts_posted_at ON adminbot_director_broadcasts (posted_at DESC)",
  );
  migrateLegacyStatus(db);
}

/**
 * Move the pre-history row into the archive, once.
 *
 * Copy first, verify, then delete -- and only then, so a failure between the two leaves the old row
 * where it was rather than losing the lab's current broadcast. Deleting at all is what keeps one
 * answer to "what is being broadcast": leaving a populated legacy table behind is how a later
 * reader picks the wrong source and shows a status somebody retracted months ago.
 */
function migrateLegacyStatus(db: DatabaseSync): void {
  const row = db.prepare("SELECT payload_json FROM adminbot_director_status WHERE id = 1").get() as
    | { payload_json: string }
    | undefined;
  if (!row) {
    return;
  }
  let legacy: LabDirectorStatus;
  try {
    legacy = JSON.parse(row.payload_json) as LabDirectorStatus;
  } catch {
    // Unreadable JSON is not something to carry forward, and not something to keep failing on
    // either: drop it and let the next publish start the archive.
    db.prepare("DELETE FROM adminbot_director_status WHERE id = 1").run();
    return;
  }
  const migrated: LabDirectorStatus = { ...legacy, id: legacy.id || `bcast_${randomUUID()}` };
  appendBroadcast(db, migrated);
  const copied = db
    .prepare("SELECT id FROM adminbot_director_broadcasts WHERE id = ?")
    .get(migrated.id);
  if (copied) {
    db.prepare("DELETE FROM adminbot_director_status WHERE id = 1").run();
  }
}

function appendBroadcast(db: DatabaseSync, status: LabDirectorStatus): void {
  db.prepare(
    "INSERT INTO adminbot_director_broadcasts (id, posted_at, payload_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET posted_at=excluded.posted_at, payload_json=excluded.payload_json",
  ).run(status.id, status.updated_at, JSON.stringify(status));
}

/**
 * Publish a broadcast, or retract the current one.
 *
 * `null` means retract, not delete: it stamps `retracted_at` on the newest live entry and leaves it
 * in the archive. Nothing is ever removed here, which is the whole point of the table.
 */
export function saveDirectorStatus(db: DatabaseSync, status: LabDirectorStatus | null): void {
  if (status) {
    appendBroadcast(db, status);
    return;
  }
  const latest = readDirectorStatus(db);
  if (!latest || latest.retracted_at) {
    return;
  }
  appendBroadcast(db, { ...latest, retracted_at: new Date().toISOString() });
}

/** The newest broadcast, live or not. Callers apply expiry and retraction before showing it. */
export function readDirectorStatus(db: DatabaseSync): LabDirectorStatus | null {
  return listDirectorStatusHistory(db, 1)[0] ?? null;
}

/** The archive, newest first. Visible to every signed-in member: a broadcast went to all of them. */
export function listDirectorStatusHistory(
  db: DatabaseSync,
  limit = ADMINBOT_BROADCAST_HISTORY_LIMIT,
): LabDirectorStatus[] {
  const rows = db
    .prepare(
      "SELECT payload_json FROM adminbot_director_broadcasts ORDER BY posted_at DESC, rowid DESC LIMIT ?",
    )
    .all(Math.max(1, limit)) as Array<{ payload_json: string }>;
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.payload_json) as LabDirectorStatus];
    } catch {
      return [];
    }
  });
}
