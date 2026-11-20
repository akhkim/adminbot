/**
 * Read models built from several tables, kept until one of those tables changes.
 *
 * A heavy GET (every lab project, joined to the roster, slots, drafts and weekly updates) was
 * rebuilt from the database on every request: seconds of synchronous SQLite and JSON parsing that
 * blocked every other request while it ran. A read model here is rebuilt only when the version
 * token of its source tables moves, and the token is one indexed read (persistence/
 * sqlite.row-versions.ts). A store with no version (the in-memory test store, Postgres) gets no
 * memo and builds every time, which is correct, only slower.
 *
 * Rules that keep it safe:
 * - The key names the model; the version must cover every stored table the build reads.
 * - Anything the build reads that is not stored (the clock, the caller) stays out of the memo and
 *   is applied by the caller afterwards, on each request.
 * - What is returned is shared between requests. Callers must not edit it in place.
 */
export class ReadModelMemo {
  private readonly entries = new Map<string, { version: string; value: unknown }>();

  get<T>(key: string, version: string | undefined, build: () => T): T {
    if (version === undefined) {
      return build();
    }
    const held = this.entries.get(key);
    if (held && held.version === version) {
      return held.value as T;
    }
    const value = build();
    this.entries.set(key, { version, value });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
