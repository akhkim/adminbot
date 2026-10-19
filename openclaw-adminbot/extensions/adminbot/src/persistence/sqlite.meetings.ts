// Meeting reads for the SQLite store that are long enough to live on their own (sqlite.ts is at
// its grandfathered size; see config/file-size-grandfather.json).
import type { DatabaseSync } from "node:sqlite";
import type { AdminBotMeetingHead, AdminBotMeetingRecord } from "../contracts/actions.js";
import type { AdminBotMeetingCursor } from "../kernel/service.js";
import { meetingSeriesKey, meetsDurationFloor } from "../workflows/meetings/records.js";

/**
 * One archive page, newest first, skipping meetings under the duration floor and, when
 * `seriesKey` is given, meetings of any other series.
 *
 * Both filters are applied in JS (a meeting's length can come from its transcript, and the series
 * key folds case and spacing the way SQL collation does not), so rows are read in chunks until the
 * page is full rather than with a single LIMIT. The title is read beside the payload so a row of
 * another series is skipped without parsing its roster.
 */
export function listSqliteMeetingsPage(
  db: DatabaseSync,
  options: {
    limit: number;
    before?: AdminBotMeetingCursor;
    minimumMinutes: number;
    seriesKey?: string;
  },
): AdminBotMeetingRecord[] {
  const chunkSize = Math.max(64, options.limit);
  const columns = `id, started_at, json_extract(payload_json, '$.topic') AS topic, payload_json`;
  const first = db.prepare(
    `SELECT ${columns} FROM adminbot_meetings
     ORDER BY COALESCE(julianday(started_at), 0) DESC, id DESC LIMIT ?`,
  );
  const after = db.prepare(
    `SELECT ${columns} FROM adminbot_meetings
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
    ) as Array<{ id: string; started_at: string; topic: unknown; payload_json: string }>;
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      before = { started_at: row.started_at, id: row.id };
      if (
        options.seriesKey !== undefined &&
        meetingSeriesKey(typeof row.topic === "string" ? row.topic : "") !== options.seriesKey
      ) {
        continue;
      }
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

/**
 * Every meeting's head: id, title, start, and the three lengths the duration floor reads.
 *
 * Extracted in SQL so the series index costs one narrow scan however large the stored rosters
 * grow -- the same reason GET /meetings stopped sending them. Every length `meetsDurationFloor`
 * reads has to be here, or a series would count recordings its own list hides.
 */
export function listSqliteMeetingHeads(db: DatabaseSync): AdminBotMeetingHead[] {
  const rows = db
    .prepare(
      `SELECT id, started_at,
         json_extract(payload_json, '$.topic') AS topic,
         json_extract(payload_json, '$.duration_minutes') AS duration_minutes,
         json_extract(payload_json, '$.duration_seconds') AS duration_seconds,
         json_extract(payload_json, '$.transcript.duration_seconds') AS transcript_seconds
       FROM adminbot_meetings`,
    )
    .all() as Array<{
    id: string;
    started_at: string;
    topic: unknown;
    duration_minutes: unknown;
    duration_seconds: unknown;
    transcript_seconds: unknown;
  }>;
  return rows.map((row) => ({
    id: row.id,
    started_at: row.started_at,
    topic: typeof row.topic === "string" ? row.topic : "",
    ...(typeof row.duration_minutes === "number" ? { duration_minutes: row.duration_minutes } : {}),
    ...(typeof row.duration_seconds === "number" ? { duration_seconds: row.duration_seconds } : {}),
    ...(typeof row.transcript_seconds === "number"
      ? { transcript: { duration_seconds: row.transcript_seconds } }
      : {}),
  }));
}
