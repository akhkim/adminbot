import { describe, expect, it } from "vitest";
import { isDoNotContact, isDoNotContactName } from "./do-not-contact.js";

describe("isDoNotContact", () => {
  it.each([
    // The exact string a real member set on their own record.
    "Null,do not contact",
    "Do Not Contact",
    "do-not-contact",
    "Do_Not_Contact",
    "donotcontact",
    "Jane (do not contact)",
    "DNC - old account",
    "old account [dnc]",
    "Null",
    " NULL ",
  ])("reads %j as an opt-out", (name) => {
    expect(isDoNotContactName(name)).toBe(true);
  });

  it.each([
    "Ada Lovelace",
    "Dncan Smith",
    "Contact Me",
    "Donna Notley",
    "Nullah",
    "",
    undefined,
    null,
  ])("leaves %j alone", (name) => {
    expect(isDoNotContactName(name)).toBe(false);
  });

  it("honours the request in preferred_name as well as name", () => {
    expect(isDoNotContact({ name: "Ada", preferred_name: "do not contact" })).toBe(true);
    expect(isDoNotContact({ name: "Ada", preferred_name: "Ada L." })).toBe(false);
  });
});
