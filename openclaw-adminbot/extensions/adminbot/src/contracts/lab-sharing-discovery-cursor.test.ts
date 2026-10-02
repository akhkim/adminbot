import { expect, it } from "vitest";
import {encodeDiscoveryCursor, decodeDiscoveryCursor} from "./lab-sharing-discovery-cursor.js";
import type {LabSharingDiscoveryQuery} from "./lab-sharing-discovery.js";
const query: LabSharingDiscoveryQuery = {query: "agents", terms: ["agents"], maxHours: 4, sort: "title", limit: 10};
const position = {title: "Agents — 合作", hours: 2.5, paperId: "paper-2"};
it("preserves the stable tie-break position and binds every filter", () => {
  const token = encodeDiscoveryCursor(query, position);
  expect(decodeDiscoveryCursor(query, token)).toEqual(position);
  for (const changed of [{query: "other"}, {maxHours: 5}, {sort: "hours" as const}, {limit: 20}]) {
    expect(decodeDiscoveryCursor({...query, ...changed}, token)).toBe("Search filters changed. Restart the search.");
  }
});
it.each(["", "not json", "e30", "W10", "x".repeat(8193)])("rejects malformed cursor %s", token => {
  expect(typeof decodeDiscoveryCursor(query, token)).toBe("string");
});
it("rejects invalid position types and values", () => {
  for (const changed of [{hours: -1}, {hours: 169}, {paperId: ""}, {title: "x".repeat(2001)}]) {
    expect(typeof decodeDiscoveryCursor(query, encodeDiscoveryCursor(query, {...position, ...changed}))).toBe("string");
  }
});
