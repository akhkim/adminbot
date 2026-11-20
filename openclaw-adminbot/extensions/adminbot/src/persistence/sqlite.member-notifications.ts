// The two filter terms of the escalated query, kept in one place because the partial index below
// is only usable when the query repeats its WHERE clause term for term.
const escalatedUnreadWhere = `coalesce(json_extract(payload_json, '$.escalated_at'), '') <> ''
    AND coalesce(json_extract(payload_json, '$.read_at'), '') = ''`;

/**
 * Escalated, unread notifications, in insertion order.
 *
 * The same narrowing the postgres mirror does in SQL: `escalated_at` and `read_at` live inside
 * payload_json, and a full read parsed every notification in the lab to keep the handful one
 * professor works through. For the string timestamps the type allows this is exactly the store's
 * JS check, which still runs after it along with the escalation-time sort.
 *
 * The filter sits in a materialized CTE so the planner reaches for the partial index. Written as a
 * plain `WHERE ... ORDER BY rowid`, SQLite without ANALYZE statistics prefers scanning the table in
 * rowid order to sorting a few index rows, which is the full scan this index exists to avoid -- and
 * on the NFS-backed database that scan is seconds. Without the index the CTE scans as before.
 */
export const escalatedMemberNotificationsSql = `WITH escalated AS MATERIALIZED (
    SELECT rowid AS position, payload_json FROM adminbot_member_notifications
    WHERE ${escalatedUnreadWhere}
  )
  SELECT payload_json FROM escalated ORDER BY position`;

/**
 * The partial index the query above reads. Partial, so it holds only the escalated unread rows and
 * costs nothing on the ordinary notification writes that never match it.
 */
export const escalatedMemberNotificationsIndexSql = `CREATE INDEX IF NOT EXISTS adminbot_member_notifications_escalated_unread_idx
  ON adminbot_member_notifications(coalesce(json_extract(payload_json, '$.escalated_at'), ''))
  WHERE ${escalatedUnreadWhere}`;
