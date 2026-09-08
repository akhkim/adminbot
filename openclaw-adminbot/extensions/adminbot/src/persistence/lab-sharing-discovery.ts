import type { DatabaseSync } from "node:sqlite";
import type { LabSharingDiscoveryQuery } from "../contracts/lab-sharing-discovery.js";
import type { DiscoveryPosition } from "../contracts/lab-sharing-discovery-cursor.js";
import type { LabHelpRequest } from "../contracts/lab-sharing.js";

export type DiscoveredHelpRequest = LabHelpRequest & { title: string; owner_name: string };

/** Reads only open requests; member authentication belongs to the service entry point. */
export function discoverHelpRequests(db: DatabaseSync, query: LabSharingDiscoveryQuery, after?: DiscoveryPosition): DiscoveredHelpRequest[] {
  // SQLite's built-in lower() only folds ASCII; match the browser's Unicode normalization.
  db.function("adminbot_discovery_lower", {deterministic: true}, (value) => String(value ?? "").toLowerCase());
  const filters = ["status = 'open'"];
  const values: (string | number)[] = [];
  if (query.maxHours !== null) { filters.push("hours <= ?"); values.push(query.maxHours); }
  for (const term of query.terms) { filters.push("instr(search_text, ?) > 0"); values.push(term); }
  if (after) {
    if (query.sort === "hours") {
      filters.push("(hours, title, paper_id) > (?, ?, ?)");
      values.push(after.hours, after.title, after.paperId);
    } else { filters.push("(title, paper_id) > (?, ?)"); values.push(after.title, after.paperId); }
  }
  values.push(query.limit + 1);
  const rows = db.prepare(`WITH entries AS (
    SELECT r.payload_json, r.paper_id,
      json_extract(p.payload_json, '$.title') AS title,
      COALESCE(json_extract(m.payload_json, '$.name'), 'Lab member') AS owner_name,
      json_extract(r.payload_json, '$.status') AS status,
      json_extract(r.payload_json, '$.hours_per_week') AS hours,
      adminbot_discovery_lower(COALESCE(json_extract(p.payload_json, '$.title'), '') || ' ' ||
        COALESCE(json_extract(m.payload_json, '$.name'), '') || ' ' ||
        COALESCE(json_extract(r.payload_json, '$.description'), '') || ' ' ||
        COALESCE((SELECT group_concat(value, ' ') FROM json_each(r.payload_json, '$.tags')), '') || ' ' ||
        COALESCE(json_extract(r.payload_json, '$.timeline'), '')) AS search_text
    FROM adminbot_help_requests r JOIN adminbot_papers p ON p.id = r.paper_id
    LEFT JOIN adminbot_lab_members m ON m.id = json_extract(r.payload_json, '$.owner_id')
  ) SELECT payload_json, title, owner_name FROM entries
  WHERE ${filters.join(" AND ")} ORDER BY ${query.sort === "hours" ? "hours, " : ""}title, paper_id LIMIT ?`).all(...values) as {payload_json: string; title: string; owner_name: string}[];
  return rows.map(row => ({...JSON.parse(row.payload_json) as LabHelpRequest, title: row.title, owner_name: row.owner_name}));
}
