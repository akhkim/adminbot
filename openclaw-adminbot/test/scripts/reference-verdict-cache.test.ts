import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReferenceVerdictCache,
  verifyEntriesWithCache,
} from "../../scripts/lib/reference-verdict-cache.mjs";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-reference-cache-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "adminbot.sqlite");
}

function entry(title: string, doi = "", key = "ref1") {
  return {
    key,
    fields: {
      title,
      author: "Example, Alice",
      year: "2025",
      doi,
      booktitle: "Example Conference",
    },
  };
}

function paper(title: string, doi = "") {
  return {
    title,
    authors: [{ name: "Alice Example" }],
    year: 2025,
    venue: "Example Conference",
    externalIds: doi ? { DOI: doi } : {},
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ReferenceVerdictCache", () => {
  it("persists verdicts and skips every provider call on an unchanged second pass", async () => {
    const dbPath = databasePath();
    const entries = [entry("DOI-backed paper", "10.1000/example"), entry("Title-only paper")];
    const firstLookup = {
      provider: "semantic-scholar",
      trustedAbsence: true,
      lookupByDOIs: vi.fn(
        async () => new Map([["10.1000/example", paper("DOI-backed paper", "10.1000/example")]]),
      ),
      searchByTitle: vi.fn(async (title: string) => [paper(title)]),
    };
    const firstCache = new ReferenceVerdictCache(dbPath);

    const first = await verifyEntriesWithCache(entries, firstLookup, firstCache);

    expect(first.verdicts.map((verdict) => verdict.kind)).toEqual(["verified", "verified"]);
    expect(first.cache).toEqual({ hits: 0, misses: 2, writes: 2 });
    expect(firstLookup.lookupByDOIs).toHaveBeenCalledOnce();
    expect(firstLookup.searchByTitle).toHaveBeenCalledOnce();
    firstCache.close();

    const secondLookup = {
      provider: "semantic-scholar",
      trustedAbsence: true,
      lookupByDOIs: vi.fn(),
      searchByTitle: vi.fn(),
    };
    const secondCache = new ReferenceVerdictCache(dbPath);
    const reorderedKeys = [
      entry("DOI-backed paper", "10.1000/EXAMPLE", "ref9"),
      entry("Title-only paper", "", "ref10"),
    ];

    const second = await verifyEntriesWithCache(reorderedKeys, secondLookup, secondCache);

    expect(second.verdicts).toEqual(first.verdicts);
    expect(second.cache).toEqual({ hits: 2, misses: 0, writes: 0 });
    expect(secondLookup.lookupByDOIs).not.toHaveBeenCalled();
    expect(secondLookup.searchByTitle).not.toHaveBeenCalled();
    secondCache.close();
  });

  it("invalidates entries when citation content, provider, or trust mode changes", () => {
    const cache = new ReferenceVerdictCache(":memory:");
    const original = entry("Original title");
    const context = { provider: "semantic-scholar", trustedAbsence: true };
    cache.put(original, context, { kind: "verified", paper: paper("Original title") });

    expect(cache.get({ ...original, key: "ref99" }, context)?.kind).toBe("verified");
    expect(cache.get(entry("Changed title"), context)).toBeNull();
    expect(cache.get(original, { ...context, provider: "arxiv+crossref+openalex" })).toBeNull();
    expect(cache.get(original, { ...context, trustedAbsence: false })).toBeNull();
    cache.close();
  });

  it("expires negative verdicts quickly and never stores provider outages", () => {
    let now = Date.UTC(2026, 0, 1);
    const cache = new ReferenceVerdictCache(":memory:", { now: () => now });
    const citation = entry("Unmatched title");
    const context = { provider: "semantic-scholar", trustedAbsence: true };

    cache.put(citation, context, { kind: "fabricated", bestSim: 0, bestCandidate: null });
    now += 12 * 60 * 60 * 1000;
    expect(cache.get(citation, context)?.kind).toBe("fabricated");
    now += 24 * 60 * 60 * 1000;
    expect(cache.get(citation, context)).toBeNull();

    const outage = entry("Provider outage");
    expect(cache.put(outage, context, { kind: "unverified", reason: "api_unavailable" })).toBe(
      false,
    );
    expect(cache.get(outage, context)).toBeNull();
    cache.close();
  });

  it("force-refreshes a cached verdict and replaces it", async () => {
    const cache = new ReferenceVerdictCache(":memory:");
    const citation = entry("A corrected record");
    const lookup = {
      provider: "semantic-scholar",
      trustedAbsence: true,
      lookupByDOIs: vi.fn(),
      searchByTitle: vi.fn(async () => [paper("A corrected record")]),
    };
    cache.put(citation, lookup, { kind: "fabricated", bestSim: 0, bestCandidate: null });

    const refreshed = await verifyEntriesWithCache([citation], lookup, cache, {
      refreshCache: true,
    });

    expect(refreshed.verdicts[0].kind).toBe("verified");
    expect(refreshed.cache).toEqual({ hits: 0, misses: 1, writes: 1 });
    expect(lookup.searchByTitle).toHaveBeenCalledOnce();
    expect(cache.get(citation, lookup)?.kind).toBe("verified");
    cache.close();
  });
});
