import type { DatabaseSync } from "node:sqlite";
import type {
  AdminBotPosterPrintBatchRecord,
  AdminBotPosterPrintRequestRecord,
} from "../contracts/poster-printing.js";

/**
 * Poster print batch settings and first authors' answers, on SQLite when given a database and in
 * memory otherwise -- one implementation for both stores, like the collaborator-chat requests, so
 * sqlite.ts and memory.ts each gain one line rather than six methods.
 *
 * Both tables are small (a row per conference site, a row per accepted paper) and always read
 * whole by the batch builder, so they keep the record as JSON and index nothing beyond the key.
 */
export function createPosterPrintStore(db?: DatabaseSync) {
  db?.exec(`
    CREATE TABLE IF NOT EXISTS adminbot_poster_print_batches (
      conference_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adminbot_poster_print_requests (
      conference_key TEXT NOT NULL,
      paper_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (conference_key, paper_id)
    );
  `);
  const batches = new Map<string, AdminBotPosterPrintBatchRecord>();
  const requests = new Map<string, AdminBotPosterPrintRequestRecord>();
  const requestKey = (conferenceKey: string, paperId: string) =>
    JSON.stringify([conferenceKey, paperId]);
  const parse = <T>(rows: unknown[]): T[] =>
    (rows as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as T);

  return {
    saveBatch(record: AdminBotPosterPrintBatchRecord): void {
      if (!db) {
        batches.set(record.conference_key, record);
        return;
      }
      db.prepare(
        `INSERT INTO adminbot_poster_print_batches (conference_key, payload_json) VALUES (?, ?)
         ON CONFLICT(conference_key) DO UPDATE SET payload_json = excluded.payload_json`,
      ).run(record.conference_key, JSON.stringify(record));
    },
    listBatches(): AdminBotPosterPrintBatchRecord[] {
      if (!db) {
        return [...batches.values()];
      }
      return parse(
        db
          .prepare("SELECT payload_json FROM adminbot_poster_print_batches ORDER BY conference_key")
          .all(),
      );
    },
    saveRequest(record: AdminBotPosterPrintRequestRecord): void {
      if (!db) {
        requests.set(requestKey(record.conference_key, record.paper_id), record);
        return;
      }
      db.prepare(
        `INSERT INTO adminbot_poster_print_requests (conference_key, paper_id, payload_json)
         VALUES (?, ?, ?)
         ON CONFLICT(conference_key, paper_id) DO UPDATE SET payload_json = excluded.payload_json`,
      ).run(record.conference_key, record.paper_id, JSON.stringify(record));
    },
    listRequests(): AdminBotPosterPrintRequestRecord[] {
      if (!db) {
        return [...requests.values()];
      }
      return parse(
        db
          .prepare(
            "SELECT payload_json FROM adminbot_poster_print_requests ORDER BY conference_key, paper_id",
          )
          .all(),
      );
    },
  };
}

export type AdminBotPosterPrintStore = ReturnType<typeof createPosterPrintStore>;
