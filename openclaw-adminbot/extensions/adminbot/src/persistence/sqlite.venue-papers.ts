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
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Drop every parsed venue; for writes that bypass `replace` (the member-id rename sweep). */
  invalidate(): void {
    this.cache.clear();
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
    const rows = this.db
      .prepare(
        `SELECT venue_id, COUNT(*) AS paper_count,
                MAX(indexed_at) AS indexed_at,
                MAX(embedding_model) AS embedding_model
         FROM adminbot_venue_papers GROUP BY venue_id`,
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
    return rows.map((row) => ({
      venue_id: row.venue_id,
      paper_count: row.paper_count,
      indexed_at: row.indexed_at ?? undefined,
      embedding_model: row.embedding_model ?? undefined,
    }));
  }
}
