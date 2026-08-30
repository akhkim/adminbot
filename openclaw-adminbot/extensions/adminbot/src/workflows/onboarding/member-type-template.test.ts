import { describe, expect, it } from "vitest";
import { findOnboardingTemplate } from "./emails.js";
import { memberTypeTokens, templateForMemberType } from "./member-type-template.js";

describe("choosing a template from the Member Type column", () => {
  it("maps each single role to its own mail", () => {
    expect(templateForMemberType("alumni")).toEqual({
      ok: true,
      templateId: "alumni",
      token: "alumni",
    });
    expect(templateForMemberType("coauthor-minor").ok && templateForMemberType("coauthor-minor"))
      .toMatchObject({ templateId: "coauthor_minor" });
    expect(templateForMemberType("interviewee")).toMatchObject({ templateId: "interviewee" });
  });

  // A row can carry several roles. The most-committed one wins because its onboarding already
  // covers what the others would have said.
  it("takes the most-committed role when a row carries several", () => {
    expect(templateForMemberType("full, coauthor-major")).toMatchObject({ templateId: "member" });
    expect(templateForMemberType("coauthor-major, coauthor-minor")).toMatchObject({
      templateId: "coauthor_major",
    });
  });

  // David Jenny's row. The discussant half sends nothing; the alumni half still does.
  it("still mails a row whose other role is a no-mail one", () => {
    expect(templateForMemberType("alumni, coauthor-discussant-or-designer")).toMatchObject({
      templateId: "alumni",
    });
  });

  it("refuses a row carrying only no-mail roles, and says why", () => {
    for (const type of ["acquaintance", "coauthor-discussant-or-designer", "external-prof"]) {
      const result = templateForMemberType(type);
      expect(result.ok, type).toBe(false);
      expect(result.ok ? "" : result.reason).toContain("sends no onboarding mail");
    }
  });

  it("refuses an empty or unknown Member Type rather than guessing", () => {
    expect(templateForMemberType("")).toMatchObject({ ok: false });
    expect(templateForMemberType(undefined)).toMatchObject({ ok: false });
    const unknown = templateForMemberType("visiting-wizard");
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? "" : unknown.reason).toContain("visiting-wizard");
  });

  it("is case- and space-insensitive, since the column is typed by hand", () => {
    expect(templateForMemberType("  Alumni , Coauthor-Minor ")).toMatchObject({
      templateId: "alumni",
    });
    expect(memberTypeTokens("full,  alumni ,")).toEqual(["full", "alumni"]);
  });

  // The map is worthless if it names a template that no longer exists -- exactly what would have
  // happened when `acquaintance` and `external_prof` were removed.
  it("names only templates that exist", () => {
    for (const type of [
      "full",
      "alumni",
      "own-pace-advisee",
      "coauthor-major",
      "coauthor-minor",
      "disappearing-coauthor",
      "slightly-better-than-emails",
      "interviewee",
    ]) {
      const result = templateForMemberType(type);
      expect(result.ok, type).toBe(true);
      if (result.ok) {
        expect(findOnboardingTemplate(result.templateId), result.templateId).toBeDefined();
      }
    }
  });
});
