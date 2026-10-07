// The SQLite halves of a member merge and a member-id change: the writes that move every row
// naming one member to another id. Raw SQL on the store's connection, so the store methods that
// call these own cache invalidation (see AdminBotSqliteStore.renameMemberId).
import type { DatabaseSync } from "node:sqlite";

export function reassignMemberReferencesIn(
  db: DatabaseSync,
  columns: ReadonlyArray<[string, string]>,
  fromMemberId: string,
  toMemberId: string,
): Record<string, number> {
  const moved: Record<string, number> = {};
  // One transaction: a half-repointed member is worse than an unmerged one, because the rows
  // that did move no longer name a record anybody can find their way back from. Written as an
  // explicit BEGIN/COMMIT for the same reason replaceVenueIndex is -- node:sqlite's DatabaseSync
  // has no `transaction()` wrapper.
  db.exec("BEGIN");
  try {
    for (const [table, column] of columns) {
      // The tall tables key on (subject, member), so a row that would collide with one the
      // survivor already has is dropped rather than updated -- two attendee rows for one person
      // on one paper is not a merge, it is a duplicate with a new name. INSERT OR REPLACE
      // semantics are wrong here for the same reason: the survivor's own answer wins.
      const result = db
        .prepare(`UPDATE OR IGNORE "${table}" SET ${column} = ? WHERE ${column} = ?`)
        .run(toMemberId, fromMemberId) as { changes?: number };
      const changes = result.changes ?? 0;
      if (changes > 0) {
        moved[`${table}.${column}`] = (moved[`${table}.${column}`] ?? 0) + changes;
      }
      // Whatever the UPDATE could not move is a collision with a row the survivor already owns.
      db.prepare(`DELETE FROM "${table}" WHERE ${column} = ?`).run(fromMemberId);
    }
    // Badge suggestions are repointed here rather than from MEMBER_REFERENCE_COLUMNS because
    // that loop moves the column and leaves `payload_json` alone -- and payload_json is what is
    // read back, so a merge done through the loop would move the row and change nothing anybody
    // can see. Nothing keys on the suggester, so there is no collision case to drop.
    {
      const result = db
        .prepare(
          `UPDATE adminbot_badge_suggestions
            SET suggested_by = ?,
                payload_json = json_set(payload_json, '$.suggested_by', ?)
            WHERE suggested_by = ?`,
        )
        .run(toMemberId, toMemberId, fromMemberId) as { changes?: number };
      if ((result.changes ?? 0) > 0) {
        moved["adminbot_badge_suggestions.suggested_by"] = result.changes ?? 0;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return moved;
}

export function renameMemberIdIn(
  db: DatabaseSync,
  fromMemberId: string,
  toMemberId: string,
): Record<string, number> {
  const changed: Record<string, number> = {};
  // Every table, discovered rather than listed: a member id lives in dedicated columns and inside
  // payload_json (paper author links, the head-professor setting, attendee maps keyed by id), and
  // a hand-kept list is how the merge ended up moving the column a page reads from but not the
  // payload it renders. The audit log is the one exception -- it is history, and the rename's own
  // audit line is what ties the old id in it to the new one.
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'adminbot_audit_events'`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  // Matched as a whole JSON string, quotes included, so renaming "pat" leaves "pat-lee" and a
  // sentence mentioning pat alone. Covers both values and object keys.
  const fromJson = JSON.stringify(fromMemberId);
  const toJson = JSON.stringify(toMemberId);
  // One transaction, and plain UPDATE rather than UPDATE OR IGNORE: a row already keyed on the
  // new id is a collision the admin has to look at, and a rename that silently dropped the old
  // row instead would lose that person's data. The throw rolls every table back.
  db.exec("BEGIN");
  try {
    for (const table of tables) {
      const columns = (
        db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
          name: string;
          type: string;
        }>
      )
        // Untyped columns too: SQLite stores whatever was bound, and an old schema may not say.
        .filter((column) => column.type === "" || /TEXT|CHAR|CLOB/iu.test(column.type))
        .map((column) => column.name);
      for (const column of columns) {
        const exact = db
          .prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`)
          .run(toMemberId, fromMemberId) as { changes?: number };
        const embedded = db
          .prepare(
            `UPDATE "${table}" SET "${column}" = replace("${column}", ?, ?)
              WHERE instr("${column}", ?) > 0`,
          )
          .run(fromJson, toJson, fromJson) as { changes?: number };
        const changes = (exact.changes ?? 0) + (embedded.changes ?? 0);
        if (changes > 0) {
          changed[`${table}.${column}`] = changes;
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return changed;
}
