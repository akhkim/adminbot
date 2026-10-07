import type { DatabaseSync } from "node:sqlite";

// The store's roster and audit caches only notice another connection's commits (through
// `PRAGMA data_version`); writes on their own connection must tell them. The inference gate and the
// task runner share that connection (`inferenceDatabase()`) and write audit rows -- and roll back
// savepoints that may cover store writes -- without going through the store, so they call
// `invalidateSqliteCaches` after doing so. A connection with no store behind it has nothing to drop.
// Each cache registers itself against its connection when it is constructed.
const invalidators = new WeakMap<DatabaseSync, Set<() => void>>();

export function registerSqliteCacheInvalidator(db: DatabaseSync, invalidate: () => void): void {
  const registered = invalidators.get(db) ?? new Set<() => void>();
  registered.add(invalidate);
  invalidators.set(db, registered);
}

export function invalidateSqliteCaches(db: DatabaseSync): void {
  for (const invalidate of invalidators.get(db) ?? []) {
    invalidate();
  }
}
