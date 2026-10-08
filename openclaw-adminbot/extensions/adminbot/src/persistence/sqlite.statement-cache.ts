import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * Distinct statements kept per connection. The store's fixed SQL is well under this; the cap is
 * for SQL built per call (an IN list per length), which would otherwise grow the map forever.
 */
const MAX_STATEMENTS = 512;

/**
 * Compile each SQL string once per connection instead of on every call.
 *
 * Every read and write here goes through `db.prepare(sql).all(...)`, and compiling costs ~20x
 * running a small indexed statement. Reusing the compiled statement is safe for how the store
 * uses them: node:sqlite resets the statement and rebinds every parameter on each call (one left
 * out binds NULL, never the last call's value), and a nested use from inside a SQL function runs
 * to completion first. The one thing reuse breaks is an open `iterate()` cursor, which fails
 * loudly ("iterator was invalidated") rather than misreading; nothing in the store iterates.
 *
 * A compiled `SELECT *` keeps the column list it was compiled with, so a column added later (the
 * schema helpers ALTER lazily, and another process may migrate) would be silently missing. The
 * schema version is read on every call -- about as cheap as a cached statement gets -- and any
 * change drops every compiled statement. A change made by another connection is only noticed by
 * this one when a statement next steps, so the drop also steps a no-op read of the schema first;
 * otherwise the recompile would be against the old column list. A call with options is passed
 * straight through.
 */
export function cacheStatements(db: DatabaseSync): void {
  const compile = db.prepare.bind(db);
  const statements = new Map<string, StatementSync>();
  const schemaVersion = compile("PRAGMA schema_version");
  let compiledAt: unknown;
  db.prepare = (sql: string, options?: Parameters<DatabaseSync["prepare"]>[1]) => {
    if (options !== undefined) {
      return compile(sql, options);
    }
    const version = (schemaVersion.get() as { schema_version: unknown }).schema_version;
    if (version !== compiledAt) {
      db.exec("SELECT 1 FROM sqlite_schema LIMIT 0");
      statements.clear();
      compiledAt = version;
    } else if (statements.size >= MAX_STATEMENTS) {
      statements.clear();
    }
    let statement = statements.get(sql);
    if (!statement) {
      statement = compile(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
}
