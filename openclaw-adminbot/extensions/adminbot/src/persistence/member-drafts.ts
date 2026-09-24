import type { DatabaseSync } from "node:sqlite";

export type MemberDraft = { revision: number; mutationId: string; data: unknown };
export type MemberDraftStore = {
  read(memberId: string, key: string): MemberDraft | null;
  write(
    memberId: string,
    key: string,
    base: number,
    mutationId: string,
    data: unknown,
  ): MemberDraft | null;
};

/** Drafts are private working copies, never proposals or connector commands. */
export function createMemberDraftStore(db?: DatabaseSync): MemberDraftStore {
  const memory = new Map<string, MemberDraft>();
  db?.exec(`CREATE TABLE IF NOT EXISTS adminbot_member_drafts (
    member_id TEXT NOT NULL, draft_key TEXT NOT NULL, revision INTEGER NOT NULL,
    mutation_id TEXT NOT NULL, data_json TEXT NOT NULL,
    PRIMARY KEY (member_id, draft_key)
  )`);
  const read = (memberId: string, key: string): MemberDraft | null => {
    if (!db) {
      return memory.get(JSON.stringify([memberId, key])) ?? null;
    }
    const row = db
      .prepare("SELECT * FROM adminbot_member_drafts WHERE member_id = ? AND draft_key = ?")
      .get(memberId, key) as
      | { revision: number; mutation_id: string; data_json: string }
      | undefined;
    return row
      ? { revision: row.revision, mutationId: row.mutation_id, data: JSON.parse(row.data_json) }
      : null;
  };
  return {
    read,
    write(memberId, key, base, mutationId, data) {
      // The transaction also covers other service processes using the same SQLite file.
      db?.exec("BEGIN IMMEDIATE");
      try {
        const current = read(memberId, key);
        if (
          current?.mutationId === mutationId &&
          JSON.stringify(current.data) === JSON.stringify(data)
        ) {
          db?.exec("COMMIT");
          return current;
        }
        if ((current?.revision ?? 0) !== base) {
          db?.exec("COMMIT");
          return null;
        }
        const next = { revision: base + 1, mutationId, data };
        if (db) {
          db.prepare(`INSERT INTO adminbot_member_drafts VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(member_id, draft_key) DO UPDATE SET revision=excluded.revision,
              mutation_id=excluded.mutation_id, data_json=excluded.data_json`).run(
            memberId,
            key,
            next.revision,
            mutationId,
            JSON.stringify(data),
          );
        } else {
          memory.set(JSON.stringify([memberId, key]), structuredClone(next));
        }
        db?.exec("COMMIT");
        return next;
      } catch (error) {
        db?.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
