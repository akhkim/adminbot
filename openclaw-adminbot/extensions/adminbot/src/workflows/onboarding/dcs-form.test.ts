import { describe, expect, it } from "vitest";
import { splitDisplayName } from "./dcs-form.js";

// The roster keeps one free-text name; the DCS form wants First and Last as separate required
// answers. These cases moved here with the splitter itself, which used to live on the approval
// path that filed the request.
describe("splitDisplayName", () => {
  it("splits an ordinary name at the space", () => {
    expect(splitDisplayName("Ada Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  // Both fields are required, so a one-word name fills them both rather than leaving one blank
  // and having the form refuse the submission.
  it("uses a one-word name for both first and last name", () => {
    expect(splitDisplayName("Cher")).toEqual({ firstName: "Cher", lastName: "Cher" });
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
