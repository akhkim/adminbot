import type { DatabaseSync } from "node:sqlite";

/** Tables whose GET responses are tagged by version rather than by hashing the body. */
export type VersionedTable = "papers" | "meetings" | "badges" | "deadlines" | "logistics";

/**
 * A cheap "may have changed" token per table, for the routes that answer 304 before building
 * their body (api/version-etag.ts).
 *
 * Two parts, because neither is enough alone. `PRAGMA data_version` moves when any *other*
 * connection commits (a script, a second process) but never for this connection's own writes;
 * the counter moves on every write through this store. A spurious change only costs one full
 * response, so data_version moving for unrelated tables is fine. A missed change would serve a
 * stale body, so every statement that writes the table must call `bump`.
 */
export class SqliteTableVersions {
  private readonly counters: Record<VersionedTable, number> = {
    papers: 0,
    meetings: 0,
    badges: 0,
    deadlines: 0,
    logistics: 0,
  };

  constructor(private readonly db: DatabaseSync) {}

  bump(table: VersionedTable): void {
    this.counters[table] += 1;
  }

  version(table: VersionedTable): string {
    const { data_version: external } = this.db.prepare("PRAGMA data_version").get() as {
      data_version: number;
    };
    return `${external}.${this.counters[table]}`;
  }
}
