import type { DatabaseSync } from "node:sqlite";
import type { AdminBotLogisticsRequest } from "../contracts/actions.js";

/** `column` with `data_base64` dropped from every element of its `field` array, if it has one. */
function withoutBytes(column: string, field: "documents" | "attachments"): string {
  return `CASE json_type(${column}, '$.${field}') WHEN 'array' THEN json_set(${column}, '$.${field}',
    (SELECT json_group_array(json(json_remove(value, '$.data_base64')))
       FROM json_each(${column}, '$.${field}')))
    ELSE ${column} END`;
}

const SUMMARY_COLUMN = withoutBytes(withoutBytes("payload_json", "documents"), "attachments");

/**
 * Logistics requests newest first, optionally with the file bytes dropped in SQL.
 *
 * A request carries its files as base64 inside the payload, so a full read of the queue parsed
 * megabytes the list never shows. SQLite rewrites only the two file arrays and keeps every other
 * key where it was, so parsing the result gives what stripping the parsed payload would.
 */
export function listSqliteLogisticsRequests(
  db: DatabaseSync,
  memberId: string | undefined,
  { withoutFileBytes }: { withoutFileBytes: boolean },
): AdminBotLogisticsRequest[] {
  const column = withoutFileBytes ? `${SUMMARY_COLUMN} AS payload_json` : "payload_json";
  const where = memberId ? "WHERE member_id = ?" : "";
  const rows = db
    .prepare(
      `SELECT ${column} FROM adminbot_logistics_requests ${where} ORDER BY submitted_at DESC`,
    )
    .all(...(memberId ? [memberId] : [])) as Array<{ payload_json: string }>;
  return rows.map((row) => JSON.parse(row.payload_json) as AdminBotLogisticsRequest);
}
