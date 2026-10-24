import { describe, expect, it } from "vitest";
import { parseMemberMap, type MemberMap } from "../data/member-map.ts";
import {
  foldForSearch,
  matchRank,
  searchMemberMap,
  searchResultKey,
  type MemberMapSearchResult,
} from "./member-map-search.ts";

const full = parseMemberMap({
  mode: "full",
  places: [
    {
      key: "toronto",
      label: "Toronto",
      country: "Canada",
      lat: 43.65,
      lon: -79.38,
      members: [
        { member_id: "a", name: "Ada Lee" },
        { member_id: "t", name: "Tori Banks" },
        { member_id: "j", name: "Joanne Park" },
      ],
    },
    {
      key: "zurich",
      label: "Zürich",
      country: "Switzerland",
      lat: 47.37,
      lon: 8.54,
      members: [
        { member_id: "b", name: "José Núñez" },
        { member_id: "n", name: "Ana Roth" },
      ],
    },
    {
      key: "tubingen",
      label: "Tübingen",
      country: "Germany",
      lat: 48.52,
      lon: 9.06,
      members: [{ member_id: "d", name: "Di Weber" }],
    },
    {
      key: "country:FR",
      label: "France",
      country: "France",
      lat: 46.6,
      lon: 2.2,
      members: [{ member_id: "f", name: "Fleur Martin" }],
    },
  ],
  unplaced_count: 2,
  counts: { placed: 7, unplaced: 2, unknown: 0 },
})!;

const summary = parseMemberMap({
  mode: "summary",
  places: [
    { key: "toronto", label: "Toronto", country: "Canada", lat: 43.65, lon: -79.38, count: 9 },
    { key: "zurich", label: "Zürich", country: "Switzerland", lat: 47.37, lon: 8.54, count: 4 },
  ],
  counts: { placed: 13, unplaced: 0, unknown: 0 },
})!;

function labels(results: MemberMapSearchResult[]): string[] {
  return results.map((result) =>
    result.kind === "person" ? `${result.member.name} @ ${result.place.key}` : result.place.key,
  );
}

describe("foldForSearch", () => {
  it("ignores case, accents and runs of spaces", () => {
    expect(foldForSearch("  José   NÚÑEZ ")).toBe("jose nunez");
    expect(foldForSearch("Zürich")).toBe("zurich");
  });
});

describe("matchRank", () => {
  it("ranks a match at the start over a later word over mid-word", () => {
    expect(matchRank("Ana Roth", "an")).toBe(0);
    expect(matchRank("Joanne Park", "pa")).toBe(1);
    expect(matchRank("Joanne Park", "an")).toBe(2);
    expect(matchRank("Joanne Park", "xyz")).toBeUndefined();
  });

  it("takes several words in any order, each starting a word", () => {
    expect(matchRank("Ada Lee", "lee ada")).toBe(1);
    expect(matchRank("Ada Lee", "le ad")).toBe(1);
    expect(matchRank("Ada Lee", "lee bob")).toBeUndefined();
  });

  it("matches nothing for an empty or blank query", () => {
    expect(matchRank("Ada Lee", "")).toBeUndefined();
    expect(matchRank("Ada Lee", "   ")).toBeUndefined();
  });
});

describe("searchMemberMap", () => {
  it("finds a person by any part of their name and says which city they are in", () => {
    expect(labels(searchMemberMap(full, "lee").results)).toEqual(["Ada Lee @ toronto"]);
    expect(labels(searchMemberMap(full, "weber").results)).toEqual(["Di Weber @ tubingen"]);
  });

  it("finds names and cities without their accents", () => {
    expect(labels(searchMemberMap(full, "jose nunez").results)).toEqual(["José Núñez @ zurich"]);
    expect(labels(searchMemberMap(full, "zurich").results)).toEqual(["zurich"]);
  });

  it("lists the names that start with the query before those that only contain it", () => {
    const found = labels(searchMemberMap(full, "an").results);
    expect(found[0]).toBe("Ana Roth @ zurich");
    // Mid-word: Joanne, Tori Banks, France, then the cities whose country has it (Canada,
    // Germany, Switzerland).
    expect(found.slice(1, 3)).toEqual(["Joanne Park @ toronto", "Tori Banks @ toronto"]);
    expect(found.slice(3)).toEqual(["country:FR", "toronto", "tubingen", "zurich"]);
  });

  it("puts a person ahead of a city that matches as well", () => {
    // "tor" starts both Tori and Toronto.
    expect(labels(searchMemberMap(full, "tor").results)).toEqual([
      "Tori Banks @ toronto",
      "toronto",
    ]);
  });

  it("finds a city by its country, after any city named that", () => {
    expect(labels(searchMemberMap(full, "germany").results)).toEqual(["tubingen"]);
    // The country-only place is named for its country, so its own name wins.
    expect(labels(searchMemberMap(full, "fran").results)).toEqual(["country:FR"]);
  });

  it("does not list a city's people for a search that only matched the city", () => {
    const results = searchMemberMap(full, "toronto").results;
    expect(results.every((result) => result.kind === "place")).toBe(true);
  });

  it("finds only cities on a map that carries no names", () => {
    expect(labels(searchMemberMap(summary, "tor").results)).toEqual(["toronto"]);
    // "lee" would find Ada Lee on the full map; this one has no names to find.
    expect(searchMemberMap(summary, "lee").results).toEqual([]);
  });

  it("keeps the list short and counts the rest", () => {
    const search = searchMemberMap(full, "a", 2);
    expect(search.results).toHaveLength(2);
    expect(search.more).toBeGreaterThan(0);
    expect(search.results.length + search.more).toBe(
      searchMemberMap(full, "a", 100).results.length,
    );
  });

  it("returns nothing for an empty query rather than everyone", () => {
    expect(searchMemberMap(full, "  ")).toEqual({ results: [], more: 0 });
  });

  it("searches only what the map was given", () => {
    const empty: MemberMap = { ...full, places: [] };
    expect(searchMemberMap(empty, "ada").results).toEqual([]);
  });

  it("gives every result a distinct key", () => {
    const keys = searchMemberMap(full, "a", 100).results.map(searchResultKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
