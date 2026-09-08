import {expect, it} from "vitest";
import {parseLabSharingDiscoveryQuery} from "./lab-sharing-discovery.js";

it("normalizes multi-term searches and preserves fractional time budgets", () => {
  expect(parseLabSharingDiscoveryQuery(new URLSearchParams("q=++Ravi++AGENTS+&max_hours=2.5&sort=hours&limit=20"))).toEqual({query: "ravi agents", terms: ["ravi", "agents"], maxHours: 2.5, sort: "hours", limit: 20});
  expect(parseLabSharingDiscoveryQuery(new URLSearchParams())).toEqual({query: "", terms: [], maxHours: null, sort: "title", limit: 10});
});
it.each(["limit=0", "limit=51", "limit=1.5", "limit=1e1", "max_hours=-1", "max_hours=Infinity", "max_hours=169", "max_hours=0x10", "sort=relevance", "q=a&q=b", "limit=10&limit=20", `q=${"x".repeat(201)}`])("rejects ambiguous or unbounded query %s", (query) => {
  expect(typeof parseLabSharingDiscoveryQuery(new URLSearchParams(query))).toBe("string");
});
