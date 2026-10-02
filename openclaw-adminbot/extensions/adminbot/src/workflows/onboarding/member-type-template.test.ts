import { describe, expect, it } from "vitest";
import { findOnboardingTemplate } from "./emails.js";
import { adminBotMemberTypes } from "../../contracts/actions.js";
import {
  NO_MAIL_MEMBER_TYPES,
  memberTypeTokens,
  templateForMemberType,
} from "./member-type-template.js";

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

// The routing table above and the vocabulary the Onboarding grid offers are two lists of the same
// tokens, and the failure of letting them drift is silent both ways: a token this file routes on
// but the dropdown cannot offer is a template nobody can select, and a token the dropdown offers
// but nothing routes gets picked and then quietly sends no mail.
describe("the routing table and the Member Type vocabulary", () => {
  // Operational tags rather than collaboration shapes: they say what somebody does for AdminBot or
  // that they only receive the mailing list, and carry no onboarding of their own. A row holding
  // only one of these is refused by name, which is the same treatment a typo used to get -- the
  // difference is that this is now a deliberate answer about a token somebody deliberately picked.
  const OPERATIONAL = ["adminbot-admin", "adminbot-developer", "mailing-list"];

  it("gives every token in the vocabulary a decided outcome", () => {
    const buckets = { mail: [] as string[], noMail: [] as string[], none: [] as string[] };
    for (const type of adminBotMemberTypes) {
      const routed = templateForMemberType(type);
      if (routed.ok) {
        buckets.mail.push(type);
      } else if (routed.reason.includes("sends no onboarding mail")) {
        buckets.noMail.push(type);
      } else {
        buckets.none.push(type);
      }
    }
    // Adding a token to the vocabulary without deciding its onboarding lands it here and fails.
    expect(buckets.none.toSorted()).toEqual(OPERATIONAL.toSorted());
    expect(buckets.noMail.toSorted()).toEqual([...NO_MAIL_MEMBER_TYPES].toSorted());
    expect(buckets.mail.length).toBeGreaterThan(0);
  });

  it("gives every mail-sending role a template that exists", () => {
    for (const type of adminBotMemberTypes) {
      const routed = templateForMemberType(type);
      if (routed.ok) {
        expect(findOnboardingTemplate(routed.templateId)).toBeDefined();
      }
    }
  });

  it("keeps the no-mail roles inside the vocabulary", () => {
    for (const type of NO_MAIL_MEMBER_TYPES) {
      expect(adminBotMemberTypes as readonly string[]).toContain(type);
    }
  });
});
