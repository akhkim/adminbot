import type { Pool } from "pg";

/** Staging replacement for the email job's monotonic SQLite scan watermark. */
export class AdminBotPostgresEmailScan {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema) || Buffer.byteLength(schema) > 63) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.table = `"${schema}"."adminbot_email_scan"`;
  }

  async scannedThrough(): Promise<Date | undefined> {
    const result = await this.pool.query<{ scanned_through: string }>(
      `SELECT scanned_through FROM ${this.table} WHERE id = 1`,
    );
    const at = Date.parse(result.rows[0]?.scanned_through ?? "");
    return Number.isNaN(at) ? undefined : new Date(at);
  }

  async markScannedThrough(at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} AS scan (id, scanned_through) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET scanned_through = EXCLUDED.scanned_through
       WHERE EXCLUDED.scanned_through > scan.scanned_through`,
      [at.toISOString()],
    );
  }
}
