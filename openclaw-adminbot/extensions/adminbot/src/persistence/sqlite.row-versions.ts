import type { DatabaseSync } from "node:sqlite";

/**
 * Tables whose change counter is kept by the database itself, for read models built from several
 * tables (kernel/read-model-memo.ts) and the version ETags routes answer 304 with.
 *
 * SqliteTableVersions counts writes made through this store and relies on every write method
 * remembering to bump. These counters are maintained by AFTER INSERT/UPDATE/DELETE triggers, so a
 * write cannot miss them: not a new store method, not a migration, not a script or a second
 * process on the same file. They persist with the data, so a tag survives a restart only while
 * the rows are unchanged.
 *
 * Only tables of ordinary size belong here. A trigger runs once per row written, so a bulk table
 * rewritten thousands of rows at a time (the venue paper index) is versioned another way.
 */
export const ROW_VERSIONED_TABLES = [
  "adminbot_papers",
  "adminbot_paper_slots",
  "adminbot_paper_social_drafts",
  "adminbot_paper_weekly_updates",
  "adminbot_help_requests",
  "adminbot_lab_members",
  "adminbot_published_deadlines",
] as const;

export type RowVersionedTable = (typeof ROW_VERSIONED_TABLES)[number];

const COUNTER_TABLE = "adminbot_row_versions";

/** Creates the counter table and one trigger per write kind per table. Idempotent. */
export function installRowVersionTriggers(
  db: DatabaseSync,
  tables: readonly RowVersionedTable[] = ROW_VERSIONED_TABLES,
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${COUNTER_TABLE} (
    table_name TEXT PRIMARY KEY,
    n INTEGER NOT NULL
  )`);
  const seed = db.prepare(`INSERT OR IGNORE INTO ${COUNTER_TABLE} (table_name, n) VALUES (?, 0)`);
  for (const table of tables) {
    seed.run(table);
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}__rv_${event.toLowerCase()}
        AFTER ${event} ON ${table}
        BEGIN
          UPDATE ${COUNTER_TABLE} SET n = n + 1 WHERE table_name = '${table}';
        END`);
    }
  }
}

/** One primary-key read: the counters of the given tables, as a single token. */
export function readRowVersion(db: DatabaseSync, tables: readonly RowVersionedTable[]): string {
  const placeholders = tables.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT table_name, n FROM ${COUNTER_TABLE} WHERE table_name IN (${placeholders})`)
    .all(...tables) as Array<{ table_name: string; n: number }>;
  const counters = new Map(rows.map((row) => [row.table_name, row.n]));
  return tables.map((table) => counters.get(table) ?? "x").join(".");
}
