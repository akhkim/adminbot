import type { DatabaseSync } from "node:sqlite";
import type { AdminBotLocationShareRecord } from "../contracts/lab-travel.js";

/**
 * The Travel tab's location opt-in: one row per member who has switched it on.
 *
 * Kept out of `adminbot_member_locations` on purpose. That table is the append-only history the
 * admin travel view and the "have you moved?" prompt are built from; a fix a member shared so
 * colleagues could find them for dinner must not quietly become part of that record, and it must
 * be gone -- not superseded -- when they switch sharing off. So this is a single overwritten row,
 * and opting out is a DELETE.
 */
export function ensureLocationShareSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS adminbot_location_shares (
    member_id TEXT PRIMARY KEY,
    enabled_at TEXT NOT NULL,
    lat REAL,
    lon REAL,
    accuracy_m REAL,
    place_key TEXT,
    place_label TEXT,
    place_country TEXT,
    place_distance_km REAL,
    reported_at TEXT
  )`);
}

export function saveLocationShare(db: DatabaseSync, record: AdminBotLocationShareRecord): void {
  db.prepare(
    `INSERT INTO adminbot_location_shares
      (member_id, enabled_at, lat, lon, accuracy_m, place_key, place_label, place_country,
       place_distance_km, reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       enabled_at = excluded.enabled_at,
       lat = excluded.lat,
       lon = excluded.lon,
       accuracy_m = excluded.accuracy_m,
       place_key = excluded.place_key,
       place_label = excluded.place_label,
       place_country = excluded.place_country,
       place_distance_km = excluded.place_distance_km,
       reported_at = excluded.reported_at`,
  ).run(
    record.member_id,
    record.enabled_at,
    record.lat ?? null,
    record.lon ?? null,
    record.accuracy_m ?? null,
    record.place_key ?? null,
    record.place_label ?? null,
    record.place_country ?? null,
    record.place_distance_km ?? null,
    record.reported_at ?? null,
  );
}

export function deleteLocationShare(db: DatabaseSync, memberId: string): boolean {
  return (
    db.prepare("DELETE FROM adminbot_location_shares WHERE member_id = ?").run(memberId).changes > 0
  );
}

function fromRow(row: Record<string, unknown>): AdminBotLocationShareRecord {
  const number = (key: string) =>
    typeof row[key] === "number" && Number.isFinite(row[key]) ? { [key]: row[key] } : {};
  const string = (key: string) =>
    typeof row[key] === "string" && row[key] ? { [key]: row[key] } : {};
  return {
    member_id: String(row.member_id),
    enabled_at: String(row.enabled_at),
    ...number("lat"),
    ...number("lon"),
    ...number("accuracy_m"),
    ...string("place_key"),
    ...string("place_label"),
    ...string("place_country"),
    ...number("place_distance_km"),
    ...string("reported_at"),
  } as AdminBotLocationShareRecord;
}

export function getLocationShare(
  db: DatabaseSync,
  memberId: string,
): AdminBotLocationShareRecord | undefined {
  const row = db
    .prepare("SELECT * FROM adminbot_location_shares WHERE member_id = ?")
    .get(memberId) as Record<string, unknown> | undefined;
  return row ? fromRow(row) : undefined;
}

export function listLocationShares(db: DatabaseSync): AdminBotLocationShareRecord[] {
  return (
    db.prepare("SELECT * FROM adminbot_location_shares ORDER BY member_id").all() as Array<
      Record<string, unknown>
    >
  ).map(fromRow);
}
