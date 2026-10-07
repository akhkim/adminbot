import type { Pool } from "pg";
import type { AdminBotMemberNotification } from "../contracts/actions.js";

/** Staging adapter for the member-notification slice of the future PostgreSQL service store. */
export class AdminBotPostgresMemberNotifications {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema) || Buffer.byteLength(schema) > 63) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.table = `"${schema}"."adminbot_member_notifications"`;
  }

  async saveMemberNotification(notification: AdminBotMemberNotification): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (id, member_id, kind, created_at, read_at, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         member_id = EXCLUDED.member_id, kind = EXCLUDED.kind,
         created_at = EXCLUDED.created_at, read_at = EXCLUDED.read_at,
         payload_json = EXCLUDED.payload_json`,
      [
        notification.id,
        notification.member_id,
        notification.kind,
        notification.created_at,
        notification.read_at ?? null,
        JSON.stringify(notification),
      ],
    );
  }

  async listMemberNotifications(memberId: string): Promise<AdminBotMemberNotification[]> {
    const result = await this.pool.query<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.table}
       WHERE member_id = $1 ORDER BY created_at DESC, _sqlite_rowid ASC`,
      [memberId],
    );
    return result.rows.map((row) => JSON.parse(row.payload_json) as AdminBotMemberNotification);
  }

  async listEscalatedMemberNotifications(): Promise<AdminBotMemberNotification[]> {
    const result = await this.pool.query<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.table}
       WHERE coalesce(payload_json::jsonb ->> 'escalated_at', '') <> ''
         AND coalesce(payload_json::jsonb ->> 'read_at', '') = ''
       ORDER BY _sqlite_rowid ASC`,
    );
    return result.rows
      .map((row) => JSON.parse(row.payload_json) as AdminBotMemberNotification)
      .filter((notification) => notification.escalated_at && !notification.read_at)
      .toSorted((left, right) => (left.escalated_at ?? "").localeCompare(right.escalated_at ?? ""));
  }

  async deleteMemberNotification(notificationId: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [
      notificationId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}
