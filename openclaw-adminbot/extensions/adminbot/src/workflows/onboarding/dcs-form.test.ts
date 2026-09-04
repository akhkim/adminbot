import { describe, expect, it } from "vitest";
import { splitDisplayName } from "./dcs-form.js";

// The roster keeps one free-text name; the DCS form wants First and Last as separate required
// answers. These cases moved here with the splitter itself, which used to live on the approval
// path that filed the request.
describe("splitDisplayName", () => {
  it("splits an ordinary name at the space", () => {
    expect(splitDisplayName("Ada Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  // The bug this file exists to prevent a second time: a one-word name used to fill *both*
  // required fields with the same word, and a DCS account was really requested for "Eric Eric".
  // A wrong surname on a university system is worse than the blank the duplication was avoiding,
  // so there is no answer to give and the caller has to say so.
  it("refuses a name with no last name in it rather than duplicating the first", () => {
    expect(splitDisplayName("Cher")).toBeUndefined();
    expect(splitDisplayName("Eric")).toBeUndefined();
    expect(splitDisplayName("   ")).toBeUndefined();
    expect(splitDisplayName("")).toBeUndefined();
  });

  // Names arrive pasted out of Slack and Sheets, which carry these instead of a plain space. Held
  // to a literal " ", "Eric\u00a0Zhang" read as a mononym and was duplicated whole.
  it("splits on a non-breaking or full-width space too", () => {
    expect(splitDisplayName("Eric\u00a0Zhang")).toEqual({
      firstName: "Eric",
      lastName: "Zhang",
    });
    expect(splitDisplayName("Eric\u3000Zhang")).toEqual({
      firstName: "Eric",
      lastName: "Zhang",
    });
  });

  // Two spaces between the names is a typo, not a middle name.
  it("does not turn a doubled space into an empty middle name", () => {
    expect(splitDisplayName("Ada  Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  // The split is on the *last* space: a middle name belongs with the first name, and reading it as
  // a surname would file the request under the wrong one.
  it("keeps a middle name with the first name, not the last", () => {
    expect(splitDisplayName("Mary Jane Watson")).toEqual({
      firstName: "Mary Jane",
      lastName: "Watson",
    });
  });

  it("ignores surrounding whitespace", () => {
    expect(splitDisplayName("  Ada Lovelace  ")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });
});
