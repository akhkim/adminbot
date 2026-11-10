import { describe, expect, it } from "vitest";
import {
  letterRequestSearchFields,
  matchesSearch,
  paperReviewSearchFields,
  searchTokens,
} from "./desk-search.js";

describe("searchTokens", () => {
  it("splits on whitespace, folds case and accents, and drops empties", () => {
    expect(searchTokens("  José   MIT ")).toEqual(["jose", "mit"]);
    expect(searchTokens("")).toEqual([]);
    expect(searchTokens(undefined)).toEqual([]);
  });
});

describe("matchesSearch", () => {
  const fields = ["Jane Example", "Example State University", "PhD Computer Science"];

  it("matches everything when the query is blank", () => {
    expect(matchesSearch(fields, "   ")).toBe(true);
  });

  it("needs every word, but each word may sit in a different field", () => {
    expect(matchesSearch(fields, "jane state")).toBe(true);
    expect(matchesSearch(fields, "jane harbor")).toBe(false);
  });

  it("ignores case and accents on both sides", () => {
    expect(matchesSearch(["Zoë Sample"], "zoe")).toBe(true);
    expect(matchesSearch(["Zoe Sample"], "ZOË")).toBe(true);
  });

  it("skips missing fields", () => {
    expect(matchesSearch([undefined, null, "", "Ada"], "ada")).toBe(true);
  });
});

describe("search fields", () => {
  it("finds a letter request by member, school or program", () => {
    const fields = letterRequestSearchFields({
      member_name: "Jane Example",
      schools: [{ school: "Example Tech", program: "MSc Robotics" }],
    });
    expect(matchesSearch(fields, "jane")).toBe(true);
    expect(matchesSearch(fields, "robotics")).toBe(true);
    expect(matchesSearch(fields, "harbor")).toBe(false);
  });

  it("finds a paper by title, author or venue, from either row shape", () => {
    const fields = paperReviewSearchFields({
      title: "Sparse Widgets at Scale",
      authors: ["Ada Sample", "Bo Example"],
      venue: "NeurIPS 2026",
    });
    expect(matchesSearch(fields, "widgets")).toBe(true);
    expect(matchesSearch(fields, "bo example")).toBe(true);
    expect(matchesSearch(fields, "neurips")).toBe(true);
    expect(
      matchesSearch(paperReviewSearchFields({ proofreading: { venue: "ICML" } }), "icml"),
    ).toBe(true);
  });
});
