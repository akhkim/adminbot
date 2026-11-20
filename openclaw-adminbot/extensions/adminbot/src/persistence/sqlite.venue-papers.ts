import type { DatabaseSync } from "node:sqlite";
import type { AdminBotVenueIndexStatus, AdminBotVenuePaper } from "../contracts/actions.js";

/**
 * The conference paper index behind venue search.
 *
 * Parsed venues are kept in memory: a large venue is ~70MB of JSON that search and the category
 * list both read in full, and only `replace` changes it, so it is parsed once rather than on every
 * request. The server process is the only writer.
 */
export class SqliteVenuePaperIndex {
  private readonly cache = new Map<string, readonly AdminBotVenuePaper[]>();
  // The grouped count below reads every row of the index (hundreds of MB), which took ~26s on the
  // production disk and is on the Conference Papers page's first read. Only `replace` changes it.
  private statusCache: Omit<AdminBotVenueIndexStatus, "label">[] | undefined;

  constructor(private readonly db: DatabaseSync) {}

  replace(venueId: string, papers: AdminBotVenuePaper[], indexedAt: string, model: string): void {
    const remove = this.db.prepare("DELETE FROM adminbot_venue_papers WHERE venue_id = ?");
    const insert = this.db.prepare(
      `INSERT INTO adminbot_venue_papers (
         venue_id, paper_id, indexed_at, embedding_model, payload_json
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    // Explicit BEGIN/COMMIT so a failed rebuild leaves the previous index intact: without it a
    // crash mid-insert leaves the venue half-indexed and silently ranking against a partial
    // corpus. Written out rather than via a helper because node:sqlite's DatabaseSync has no
    // `transaction()` wrapper -- that is better-sqlite3, which this file does not use.
    this.db.exec("BEGIN");
    try {
      remove.run(venueId);
      for (const paper of papers) {
        insert.run(venueId, paper.paper_id, indexedAt, model, JSON.stringify(paper));
      }
      this.db.exec("COMMIT");
      this.cache.delete(venueId);
      this.statusCache = undefined;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(venueId: string): readonly AdminBotVenuePaper[] {
    const cached = this.cache.get(venueId);
    if (cached) {
      return cached;
    }
    const rows = this.db
      .prepare("SELECT payload_json FROM adminbot_venue_papers WHERE venue_id = ?")
      .all(venueId) as Array<{ payload_json: string }>;
    const papers = rows.map((row) => JSON.parse(row.payload_json) as AdminBotVenuePaper);
    this.cache.set(venueId, papers);
    return papers;
  }

  statuses(): Omit<AdminBotVenueIndexStatus, "label">[] {
    if (this.statusCache) {
      return this.statusCache.map((status) => ({ ...status }));
    }
    const rows = this.db
      .prepare(
        // Counted from the venue index alone, and the stamp read from one row per venue: `replace`
        // writes every row of a venue with the same `indexed_at` and model, so one row is the
        // venue's stamp. Grouping the table itself pulled each row's payload page off disk.
        `SELECT counts.venue_id, counts.paper_count, stamp.indexed_at, stamp.embedding_model
         FROM (
           SELECT venue_id, COUNT(*) AS paper_count
           FROM adminbot_venue_papers INDEXED BY adminbot_venue_papers_venue
           GROUP BY venue_id
         ) AS counts
         JOIN adminbot_venue_papers AS stamp
           ON stamp.rowid = (
             SELECT rowid FROM adminbot_venue_papers
             WHERE venue_id = counts.venue_id LIMIT 1
           )`,
      )
      .all() as Array<{
      venue_id: string;
      paper_count: number;
      indexed_at: string | null;
      embedding_model: string | null;
    }>;
    // Built without a conditional spread: MAX() over a grouped column is null only for an empty
    // group, which cannot happen here, and `undefined` reads the same as an absent key to every
    // caller. Matches how the route serialises the same record.
    this.statusCache = rows.map((row) => ({
      venue_id: row.venue_id,
      paper_count: row.paper_count,
      indexed_at: row.indexed_at ?? undefined,
      embedding_model: row.embedding_model ?? undefined,
    }));
    return this.statusCache.map((status) => ({ ...status }));
  }
}
