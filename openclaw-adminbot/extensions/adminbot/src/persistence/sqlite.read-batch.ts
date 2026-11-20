// Reads made in one turn of the event loop share one SQLite read transaction.
//
// The live database sits on NFS. Outside a transaction every statement is its own read
// transaction, and on NFS each one costs about 2 ms of locking and drops SQLite's page cache: a
// one-row query took 2.4 ms against 0.06 ms inside a transaction, and reading the members table
// 36 ms against 3.8 ms. A page read runs dozens of statements, and the connection is synchronous,
// so that cost stalled every other request too.
//
// Here the first read of a turn opens a deferred transaction and a setImmediate commits it once
// the turn ends. Anything that is not a plain read (exec, a write, an explicit BEGIN) commits the
// batch first and then runs exactly as before, so writes and explicit transactions are unchanged.
// Reads in one turn see one consistent snapshot, and a write from another process shows from the
// next turn on.
import type { DatabaseSync, StatementSync } from "node:sqlite";

// PRAGMAs that only read and are safe inside a transaction.
const READ_PRAGMAS = new Set([
  "schema_version",
  "user_version",
  "data_version",
  "table_info",
  "table_xinfo",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
]);

const WRITE_WORD = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/iu;

/** True when the statement only reads, so it may join the turn's read transaction. */
export function isReadOnlySql(sql: string): boolean {
  const text = sql.replace(/^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/u, "");
  const head = /^([A-Za-z]+)/u.exec(text)?.[1]?.toUpperCase();
  if (head === "SELECT" || head === "VALUES") {
    return true;
  }
  if (head === "WITH") {
    return !WRITE_WORD.test(text);
  }
  if (head === "PRAGMA") {
    const pragma = /^PRAGMA\s+(?:\w+\.)?(\w+)\s*(\(|;|$)/iu.exec(text);
    return pragma !== null && READ_PRAGMAS.has(pragma[1]!.toLowerCase());
  }
  return false;
}

export type ReadBatch = {
  /** Commit the open read transaction now, if there is one. */
  flush(): void;
};

export function batchReadsPerTick(
  db: DatabaseSync,
  options: { schedule?: (run: () => void) => void } = {},
): ReadBatch {
  const schedule = options.schedule ?? ((run) => void setImmediate(run));
  const exec = db.exec.bind(db);
  const prepare = db.prepare.bind(db);
  const close = db.close.bind(db);
  let open = false;

  const flush = () => {
    if (!open) {
      return;
    }
    open = false;
    if (db.isOpen && db.isTransaction) {
      exec("COMMIT");
    }
  };
  const join = () => {
    // An explicit transaction is already open: its reads belong to it.
    if (open || db.isTransaction) {
      return;
    }
    exec("BEGIN");
    open = true;
    schedule(flush);
  };

  db.exec = (sql: string) => {
    flush();
    exec(sql);
  };
  db.close = () => {
    flush();
    close();
  };
  db.prepare = ((sql: string, ...rest: unknown[]) => {
    const statement = (prepare as (sql: string, ...rest: unknown[]) => StatementSync)(sql, ...rest);
    const before = isReadOnlySql(sql) ? join : flush;
    for (const method of ["get", "all", "iterate", "run"] as const) {
      const call = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      const guard = method === "run" ? flush : before;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        guard();
        return call(...args);
      };
    }
    return statement;
  }) as DatabaseSync["prepare"];

  return { flush };
}
