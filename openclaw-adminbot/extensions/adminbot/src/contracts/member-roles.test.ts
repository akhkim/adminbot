import { describe, expect, it } from "vitest";
import { formatAdminBotMemberRoles, parseAdminBotMemberRoles } from "./member-roles.js";

describe("parseAdminBotMemberRoles", () => {
  it("splits the stored string into the roles held", () => {
    expect(parseAdminBotMemberRoles("PhD Student, Lab Manager")).toEqual([
      "PhD Student",
      "Lab Manager",
    ]);
  });

  it("reads a single role, which is what most of the roster holds", () => {
    expect(parseAdminBotMemberRoles("Postdoc")).toEqual(["Postdoc"]);
  });

  it("survives the spacing a hand-edited cell arrives with", () => {
    expect(parseAdminBotMemberRoles("  PhD Student ,,Lab Manager,  ")).toEqual([
      "PhD Student",
      "Lab Manager",
    ]);
  });

  it("drops a repeat rather than counting somebody twice", () => {
    expect(parseAdminBotMemberRoles("Postdoc, postdoc")).toEqual(["Postdoc"]);
  });

  it("is empty for a record with no role, and for a non-string", () => {
    expect(parseAdminBotMemberRoles("")).toEqual([]);
    expect(parseAdminBotMemberRoles(null)).toEqual([]);
    expect(parseAdminBotMemberRoles(undefined)).toEqual([]);
  });

  it("keeps an imported answer the vocabulary never had", () => {
    // 158 profiles predate the vocabulary and several carry shapes it does not cover. Splitting
    // must not be the thing that loses them.
    expect(parseAdminBotMemberRoles("PhD Mentee / MSc")).toEqual(["PhD Mentee / MSc"]);
  });
});

describe("formatAdminBotMemberRoles", () => {
  it("stores the vocabulary's own order, not the order the boxes were clicked", () => {
    // Two people who picked the same pair store the same string, so the roster groups them
    // together instead of showing two spellings of one answer.
    expect(formatAdminBotMemberRoles(["Lab Manager", "PhD Student"])).toBe(
      "PhD Student, Lab Manager",
    );
    expect(formatAdminBotMemberRoles(["PhD Student", "Lab Manager"])).toBe(
      "PhD Student, Lab Manager",
    );
  });

  it("round-trips through parse", () => {
    const stored = formatAdminBotMemberRoles(["Research Assistant", "Master's Student"]);
    expect(parseAdminBotMemberRoles(stored)).toEqual(["Master's Student", "Research Assistant"]);
  });

  it("is empty when nothing is picked, which is how a role gets cleared", () => {
    expect(formatAdminBotMemberRoles([])).toBe("");
    expect(formatAdminBotMemberRoles(["", "   "])).toBe("");
  });

  it("keeps an unknown answer, last, rather than quietly rewriting the roster", () => {
    expect(formatAdminBotMemberRoles(["PhD Mentee / MSc", "PhD Student"])).toBe(
      "PhD Student, PhD Mentee / MSc",
    );
  });

  it("does not repeat a role picked twice under different casing", () => {
    expect(formatAdminBotMemberRoles(["Postdoc", "postdoc"])).toBe("Postdoc");
  });
});
