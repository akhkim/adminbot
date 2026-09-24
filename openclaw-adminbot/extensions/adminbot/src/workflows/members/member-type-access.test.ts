import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  hasAccessConsequences,
  lostSurfaces,
  memberAccessDelta,
  memberTypeAccessDelta,
  memberTypeAccessProfile,
  privilegeForMemberTypeChange,
} from "./member-type-access.js";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "mei",
    name: "Mei Chen",
    privilege_level: "member",
    member_type: "full",
    ...overrides,
  } as AdminBotLabMember;
}

describe("memberTypeAccessProfile", () => {
  it("grades a full member as one, with no matrix row and both surfaces", () => {
    const profile = memberTypeAccessProfile(member({ member_type: "full" }));

    expect(profile.subgroup_source).toBe("full_member");
    expect(profile.subgroup).toBeUndefined();
    // The matrix describes external collaborators; a full member is entitled to more than any row
    // of it, so an empty grant list here is not "nothing".
    expect(profile.grants).toEqual([]);
    expect(profile.lab_calendar).toBe(true);
    expect(profile.group_meeting).toBe(true);
    expect(profile.portal).toBe(true);
  });

  it("reads the subgroup off the member type when the record does not carry one", () => {
    const profile = memberTypeAccessProfile(
      member({ privilege_level: "external_collaborator", member_type: "coauthor-major" }),
    );

    expect(profile.subgroup).toBe("coauthor_major");
    expect(profile.subgroup_source).toBe("member_type");
    expect(profile.grants.map((grant) => grant.item)).toContain("weekly_meeting");
  });

  // 94 of the roster's 200 rows carry no member type at all, and reading that as "no access" would
  // turn a gap in the spreadsheet into a decision about a person.
  it("leaves portal access unset for a type it has never been told about", () => {
    expect(memberTypeAccessProfile(member({ member_type: "" })).portal).toBeUndefined();
    expect(memberTypeAccessProfile(member({ member_type: "who-knows" })).portal).toBeUndefined();
  });

  it("answers for a hypothetical type without touching the record", () => {
    const stored = member({ member_type: "full" });

    expect(memberTypeAccessProfile(stored, "alumni").lab_calendar).toBe(false);
    // The record it was asked about is unchanged.
    expect(stored.member_type).toBe("full");
    expect(memberTypeAccessProfile(stored).lab_calendar).toBe(true);
  });
});

describe("memberTypeAccessDelta", () => {
  it("reports the surfaces a departing full member loses", () => {
    const delta = memberTypeAccessDelta(member({ member_type: "full" }), "alumni");

    expect(delta.lab_calendar).toBe("lost");
    expect(delta.group_meeting).toBe("lost");
    // An alumnus keeps the portal by design -- they are on adminBotPortalAccessMemberTypes.
    expect(delta.portal).toBe("unchanged");
    expect(hasAccessConsequences(delta)).toBe(true);
    expect(lostSurfaces(delta)).toEqual(["lab_calendar", "group_meeting"]);
  });

  it("says nothing when the column was only respelled", () => {
    const delta = memberTypeAccessDelta(
      member({ member_type: "full, coauthor-major" }),
      "coauthor-major, full",
    );

    expect(hasAccessConsequences(delta)).toBe(false);
    expect(delta.revoked).toEqual([]);
    expect(delta.slack_channels_to_remove).toEqual([]);
  });

  it("names the standing Slack rooms a revoked matrix row covers", () => {
    // coauthor-major holds the active channels; an acquaintance does not.
    const delta = memberTypeAccessDelta(
      member({ privilege_level: "external_collaborator", member_type: "coauthor-major" }),
      "acquaintance",
    );

    expect(delta.revoked.map((grant) => grant.item)).toContain("active_channels");
    expect(delta.slack_channels_to_remove).toContain("jinesis-active");
  });

  // Checked against what they keep rather than against what they lose, which is the direction that
  // fails safe: a room another surviving row still covers must not be taken away.
  it("keeps a room a surviving grant still covers", () => {
    const delta = memberTypeAccessDelta(
      member({ privilege_level: "external_collaborator", member_type: "coauthor-major" }),
      "coauthor-major",
    );

    expect(delta.slack_channels_to_remove).toEqual([]);
  });

  it("reports an unknown portal answer as unknown rather than as a revocation", () => {
    const delta = memberTypeAccessDelta(member({ member_type: "full" }), "");

    expect(delta.portal).toBe("unknown");
  });

  it("does not fold a newly granted room into the removals", () => {
    const delta = memberTypeAccessDelta(
      member({ privilege_level: "external_collaborator", member_type: "acquaintance" }),
      "coauthor-major",
    );

    expect(delta.slack_channels_to_remove).toEqual([]);
    expect(delta.slack_channels_to_add).toContain("jinesis-active");
  });
});

describe("privilegeForMemberTypeChange", () => {
  const external = (overrides: Partial<AdminBotLabMember> = {}) =>
    member({
      privilege_level: "external_collaborator",
      member_type: "coauthor-minor",
      collaborator_subgroup: "coauthor_minor",
      ...overrides,
    });

  it("makes a full member a member, and keeps somebody on trial on trial", () => {
    expect(privilegeForMemberTypeChange(external(), "full")).toEqual({ privilege_level: "member" });
    expect(privilegeForMemberTypeChange(member({ privilege_level: "trial" }), "full")).toEqual({
      privilege_level: "trial",
    });
  });

  it("files a collaboration type under external_collaborator with that type's subgroup", () => {
    expect(privilegeForMemberTypeChange(member(), "alumni")).toEqual({
      privilege_level: "external_collaborator",
      collaborator_subgroup: "alumni",
    });
    // Most-committed token wins, as on the live roster.
    expect(privilegeForMemberTypeChange(member(), "alumni, coauthor-major")).toEqual({
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_major",
    });
  });

  it("grants admin from the admin tag, and takes it away when the tag goes", () => {
    expect(privilegeForMemberTypeChange(member(), "full, adminbot-admin")).toEqual({
      privilege_level: "admin",
    });
    // The legacy spelling on the live roster means the same.
    expect(privilegeForMemberTypeChange(member(), "full, admin")).toEqual({
      privilege_level: "admin",
    });
    const admin = member({ privilege_level: "admin" });
    expect(privilegeForMemberTypeChange(admin, "full")).toEqual({ privilege_level: "member" });
    expect(privilegeForMemberTypeChange(admin, "alumni")).toEqual({
      privilege_level: "external_collaborator",
      collaborator_subgroup: "alumni",
    });
    // No other signal: least privilege, not a kept admin.
    expect(privilegeForMemberTypeChange(admin, "mailing-list")).toEqual({
      privilege_level: "external_collaborator",
    });
  });

  it("leaves types that say nothing about access alone", () => {
    expect(privilegeForMemberTypeChange(external(), "mailing-list")).toBeUndefined();
    expect(privilegeForMemberTypeChange(external(), "")).toBeUndefined();
  });
});

describe("memberAccessDelta", () => {
  it("does not take a newly full member out of the lab's own rooms", () => {
    const before = member({
      privilege_level: "external_collaborator",
      member_type: "coauthor-major",
      collaborator_subgroup: "coauthor_major",
    });
    const after = member({ privilege_level: "member", member_type: "full" });

    const delta = memberAccessDelta(before, after);

    // coauthor_major's matrix rows are gone, but a full member is entitled to more than any row.
    expect(delta.revoked.length).toBeGreaterThan(0);
    expect(delta.slack_channels_to_remove).toEqual([]);
    expect(delta.lab_calendar).toBe("gained");
  });

  it("follows a subgroup that moved with the type, which the type-only diff cannot see", () => {
    const before = member({
      privilege_level: "external_collaborator",
      member_type: "coauthor-major",
      collaborator_subgroup: "coauthor_major",
    });
    const after = { ...before, member_type: "alumni", collaborator_subgroup: "alumni" as const };

    // The type-only diff keeps the pinned subgroup, so it sees no matrix change at all.
    expect(memberTypeAccessDelta(before, "alumni").revoked).toEqual([]);
    const delta = memberAccessDelta(before, after);
    expect(delta.group_meeting).toBe("lost");
    expect(delta.revoked.map((grant) => grant.item)).toContain("active_channels");
    expect(delta.slack_channels_to_remove).toEqual(
      expect.arrayContaining(["jinesis-active", "random-active"]),
    );
  });
});
