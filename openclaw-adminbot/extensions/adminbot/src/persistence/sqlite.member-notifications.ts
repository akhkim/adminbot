/**
 * Escalated, unread notifications, in insertion order.
 *
 * The same narrowing the postgres mirror does in SQL: `escalated_at` and `read_at` live inside
 * payload_json, and a full read parsed every notification in the lab to keep the handful one
 * professor works through. For the string timestamps the type allows this is exactly the store's
 * JS check, which still runs after it along with the escalation-time sort.
 */
export const escalatedMemberNotificationsSql = `SELECT payload_json FROM adminbot_member_notifications
  WHERE coalesce(json_extract(payload_json, '$.escalated_at'), '') <> ''
    AND coalesce(json_extract(payload_json, '$.read_at'), '') = ''
  ORDER BY rowid`;
