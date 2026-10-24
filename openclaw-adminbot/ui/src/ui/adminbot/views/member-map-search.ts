// "Where is Ada?" on the member map: the matching behind its search box.
//
// It searches only what the map was handed for this viewer. An admin's `full` map carries names,
// so a name finds that person's city; everyone else gets the `summary` shape, a headcount per city
// and no names, so for them the same box finds cities and nothing else. Nothing here asks the
// service for more, and nothing finer than the city the map already draws is ever involved.
//
// Members who are not on the map reach an admin as a name and a reason only (`notOnMap`): hidden by
// their own choice, IP lookup turned off, a VPN reading set aside, location blocked in the browser,
// text no gazetteer knows, or nothing yet. They are found like anyone else and listed with why, so
// "Ada" answers "location hidden" rather than nothing; there is no city to fly to. An older service
// sends only a count, and the view then says that some people cannot be found.
//
// Pure functions, no DOM, like member-map-layout.ts, so ranking is unit-tested directly.
import type {
  MemberMap,
  MemberMapAbsentMember,
  MemberMapMember,
  MemberMapPlace,
} from "../data/member-map.ts";

export type MemberMapSearchResult =
  | { kind: "person"; member: MemberMapMember; place: MemberMapPlace }
  | { kind: "place"; place: MemberMapPlace }
  /** Not on the map: `index` into `notOnMap` keeps two people of the same name apart. */
  | { kind: "absent"; member: MemberMapAbsentMember; index: number };

/** How many results the box lists before "+N more": a short list to pick from, not a roster. */
export const SEARCH_LIMIT = 8;

/**
 * Lower case with the accents taken off, so "zurich" finds Zürich and "jose" finds José. Typing a
 * diacritic is the hard part on most keyboards; nobody searching expects it to matter.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How well `text` answers `query`, lower is better, or undefined for no match. The whole text
 * starting with the query beats a later word starting with it, which beats the query turning up
 * mid-word: "an" should list Ana before Joanne. Several words must each start a word of the text,
 * in any order, so "lee ada" still finds Ada Lee.
 */
export function matchRank(text: string, query: string): number | undefined {
  const haystack = foldForSearch(text);
  const needle = foldForSearch(query);
  if (!needle || !haystack) {
    return undefined;
  }
  if (haystack.startsWith(needle)) {
    return 0;
  }
  const words = haystack.split(/[\s\-'.,()]+/).filter(Boolean);
  const terms = needle.split(" ");
  if (terms.every((term) => words.some((word) => word.startsWith(term)))) {
    return 1;
  }
  return haystack.includes(needle) ? 2 : undefined;
}

export type MemberMapSearch = {
  /** The first `limit` results, best first. */
  results: MemberMapSearchResult[];
  /** Matches past `limit`, for "+N more". */
  more: number;
};

/**
 * People (when the map carries names) and cities matching `query`, best first.
 *
 * A city matches on its own name or its country, so "germany" lists Tübingen and Berlin. People
 * match on their name only: a city's people are one pick away through the city itself, and listing
 * all twenty-nine Torontonians for "tor" would bury the one person called Tori.
 */
export function searchMemberMap(
  map: MemberMap,
  query: string,
  limit: number = SEARCH_LIMIT,
): MemberMapSearch {
  if (!foldForSearch(query)) {
    return { results: [], more: 0 };
  }
  const scored: Array<{ rank: number; name: string; result: MemberMapSearchResult }> = [];
  for (const place of map.places) {
    const placeRank = Math.min(
      matchRank(place.label, query) ?? Number.POSITIVE_INFINITY,
      // A country match is a weaker answer than the city's own name.
      (matchRank(place.country, query) ?? Number.POSITIVE_INFINITY) + 0.5,
    );
    if (Number.isFinite(placeRank)) {
      scored.push({ rank: placeRank, name: place.label, result: { kind: "place", place } });
    }
    for (const member of place.members ?? []) {
      const rank = matchRank(member.name, query);
      if (rank !== undefined) {
        // People before places at the same rank: a person is what this box is mostly for.
        scored.push({
          rank: rank - 0.25,
          name: member.name,
          result: { kind: "person", member, place },
        });
      }
    }
  }
  for (const [index, member] of (map.notOnMap ?? []).entries()) {
    const rank = matchRank(member.name, query);
    if (rank !== undefined) {
      // Behind the people the map shows at the same rank (they can be flown to), ahead of cities.
      scored.push({
        rank: rank - 0.15,
        name: member.name,
        result: { kind: "absent", member, index },
      });
    }
  }
  const sorted = scored
    .toSorted((left, right) => left.rank - right.rank || left.name.localeCompare(right.name))
    .map((entry) => entry.result);
  return { results: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
}

/** A stable key per result, for `repeat` and for the option ids. */
export function searchResultKey(result: MemberMapSearchResult): string {
  return result.kind === "person"
    ? `person:${result.place.key}:${result.member.member_id || result.member.name}`
    : result.kind === "absent"
      ? `absent:${result.index}`
      : `place:${result.place.key}`;
}
