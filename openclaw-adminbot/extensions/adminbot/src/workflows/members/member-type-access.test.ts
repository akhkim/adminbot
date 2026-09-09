import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  hasAccessConsequences,
  lostSurfaces,
  memberTypeAccessDelta,
  memberTypeAccessProfile,
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
