// Meeting reads for the SQLite store that are long enough to live on their own (sqlite.ts is at
// its grandfathered size; see config/file-size-grandfather.json).
import type { DatabaseSync } from "node:sqlite";
import type { AdminBotMeetingRecord } from "../contracts/actions.js";
import type { AdminBotMeetingCursor } from "../kernel/service.js";
import { meetsDurationFloor } from "../workflows/meetings/records.js";

/**
 * One archive page, newest first, skipping meetings under the duration floor.
 *
 * The floor is applied in JS (a meeting's length can come from its transcript), so rows are read
 * in chunks until the page is full rather than with a single LIMIT.
 */
export function listSqliteMeetingsPage(
  db: DatabaseSync,
  options: { limit: number; before?: AdminBotMeetingCursor; minimumMinutes: number },
): AdminBotMeetingRecord[] {
  const chunkSize = Math.max(64, options.limit);
  const first = db.prepare(
    `SELECT id, started_at, payload_json FROM adminbot_meetings
     ORDER BY COALESCE(julianday(started_at), 0) DESC, id DESC LIMIT ?`,
  );
  const after = db.prepare(
    `SELECT id, started_at, payload_json FROM adminbot_meetings
     WHERE COALESCE(julianday(started_at), 0) <= COALESCE(julianday(?), 0)
       AND (COALESCE(julianday(started_at), 0) < COALESCE(julianday(?), 0) OR id < ?)
     ORDER BY COALESCE(julianday(started_at), 0) DESC, id DESC LIMIT ?`,
  );
  const meetings: AdminBotMeetingRecord[] = [];
  let before = options.before;
  while (meetings.length < options.limit) {
    const rows = (
      before
        ? after.all(before.started_at, before.started_at, before.id, chunkSize)
        : first.all(chunkSize)
    ) as Array<{ id: string; started_at: string; payload_json: string }>;
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      before = { started_at: row.started_at, id: row.id };
      const meeting = JSON.parse(row.payload_json) as AdminBotMeetingRecord;
      if (meetsDurationFloor(meeting, options.minimumMinutes)) {
        meetings.push(meeting);
        if (meetings.length === options.limit) {
          break;
        }
      }
    }
    if (rows.length < chunkSize) {
      break;
    }
  }
  return meetings;
}
