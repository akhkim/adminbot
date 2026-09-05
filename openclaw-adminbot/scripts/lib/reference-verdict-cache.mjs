import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyEntry } from "./reference-verifier.mjs";

// Increment this whenever verifier thresholds, provider record mapping, or verdict semantics change.
// It deliberately invalidates every old row instead of silently applying an outdated decision.
const CACHE_SCHEMA_VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TTL_BY_KIND = {
  verified: 90 * DAY_MS,
  no_title: 90 * DAY_MS,
  mismatch: 7 * DAY_MS,
  doi_mismatch: 7 * DAY_MS,
  doi_not_found: DAY_MS,
  fabricated: DAY_MS,
  unverified: 6 * HOUR_MS,
};

function canonicalize(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((childKey) => [childKey, canonicalize(value[childKey], childKey)]),
    );
  }
  if (typeof value === "string") {
    const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
    return key.toLowerCase() === "doi" ? normalized.toLowerCase() : normalized;
  }
  return value;
}

function cacheIdentity(entry, { provider, trustedAbsence }) {
  return {
    version: CACHE_SCHEMA_VERSION,
    provider,
    trustedAbsence: Boolean(trustedAbsence),
    // Reference keys are positional (ref1, ref2, ...), so they must not invalidate a verdict when
    // a paper merely reorders its bibliography. The cited fields are the verification input.
    fields: canonicalize(entry.fields ?? {}),
  };
}

function cacheKey(identity) {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function isVerdict(value) {
  return Boolean(value && typeof value === "object" && typeof value.kind === "string");
}

function verdictTtlMs(verdict) {
  return TTL_BY_KIND[verdict.kind] ?? DAY_MS;
}

export function defaultReferenceCachePath() {
  return (
    process.env.ADMINBOT_DB_PATH || path.join(os.homedir(), ".openclaw", "state", "adminbot.sqlite")
  );
}

export class ReferenceVerdictCache {
  constructor(databasePath = defaultReferenceCachePath(), { now = Date.now } = {}) {
    this.now = now;
    this.stats = { hits: 0, misses: 0, writes: 0 };
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS adminbot_reference_verdict_cache (
        cache_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        input_json TEXT NOT NULL,
        verdict_json TEXT NOT NULL,
        checked_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS adminbot_reference_verdict_cache_expires_idx
        ON adminbot_reference_verdict_cache(expires_at_ms);
    `);
    this.readStatement = this.db.prepare(`
      SELECT verdict_json
      FROM adminbot_reference_verdict_cache
      WHERE cache_key = ? AND expires_at_ms > ?
    `);
    this.writeStatement = this.db.prepare(`
      INSERT INTO adminbot_reference_verdict_cache (
        cache_key, provider, input_json, verdict_json, checked_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        provider = excluded.provider,
        input_json = excluded.input_json,
        verdict_json = excluded.verdict_json,
        checked_at_ms = excluded.checked_at_ms,
        expires_at_ms = excluded.expires_at_ms
    `);
  }

  get(entry, context, { refresh = false } = {}) {
    if (refresh) {
      this.stats.misses += 1;
      return null;
    }
    const identity = cacheIdentity(entry, context);
    const row = this.readStatement.get(cacheKey(identity), this.now());
    if (!row) {
      this.stats.misses += 1;
      return null;
    }
    try {
      const verdict = JSON.parse(row.verdict_json);
      if (isVerdict(verdict)) {
        this.stats.hits += 1;
        return verdict;
      }
    } catch {
      // A corrupt row is a cache miss. The fresh verdict below replaces it.
    }
    this.stats.misses += 1;
    return null;
  }

  put(entry, context, verdict) {
    // A provider outage must be retried on the next run, not preserved as a verdict.
    if (verdict.kind === "unverified" && verdict.reason === "api_unavailable") {
      return false;
    }
    const identity = cacheIdentity(entry, context);
    const checkedAt = this.now();
    this.writeStatement.run(
      cacheKey(identity),
      context.provider,
      JSON.stringify(identity),
      JSON.stringify(verdict),
      checkedAt,
      checkedAt + verdictTtlMs(verdict),
    );
    this.stats.writes += 1;
    return true;
  }

  snapshotStats() {
    return { ...this.stats };
  }

  close() {
    this.db.close();
  }
}

function subtractStats(after, before) {
  return {
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
    writes: after.writes - before.writes,
  };
}

/** Verify an ordered set of entries while issuing provider calls only for cache misses. */
export async function verifyEntriesWithCache(
  entries,
  lookup,
  cache,
  { refreshCache = false } = {},
) {
  const before = cache.snapshotStats();
  const verdicts = Array.from({ length: entries.length });
  const misses = [];
  const context = { provider: lookup.provider, trustedAbsence: lookup.trustedAbsence };

  entries.forEach((entry, index) => {
    const cached = cache.get(entry, context, { refresh: refreshCache });
    if (cached) {
      verdicts[index] = cached;
    } else {
      misses.push({ entry, index });
    }
  });

  const dois = [
    ...new Set(
      misses.map(({ entry }) => (entry.fields.doi || "").toLowerCase().trim()).filter(Boolean),
    ),
  ];
  const doiLookup = dois.length > 0 ? await lookup.lookupByDOIs(dois) : new Map();

  for (const { entry, index } of misses) {
    const verdict = await verifyEntry(entry, doiLookup, lookup.searchByTitle, {
      trustedAbsence: lookup.trustedAbsence,
    });
    verdicts[index] = verdict;
    cache.put(entry, context, verdict);
  }

  return { verdicts, cache: subtractStats(cache.snapshotStats(), before) };
}
