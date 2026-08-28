import { describe, expect, it } from "vitest";
import { adminBotExternalCollaboratorSubgroups } from "../../extensions/adminbot/src/contracts/actions.js";
import { AdminBotService } from "../../extensions/adminbot/src/kernel/service.js";
import {
  classify,
  memberTypeTokens,
  SUBGROUP_BY_TOKEN,
} from "../../scripts/adminbot-import-member-types.js";

describe("memberTypeTokens", () => {
  it("splits the column's comma-separated list and lowercases it", () => {
    expect(memberTypeTokens("full, adminbot-admin, adminbot-developer")).toEqual([
      "full",
      "adminbot-admin",
      "adminbot-developer",
    ]);
  });

  it("drops empty entries left by trailing commas", () => {
    expect(memberTypeTokens("alumni, ,")).toEqual(["alumni"]);
  });
});

describe("classify", () => {
  it.each([
    ["acquaintance", "acquaintance"],
    ["alumni", "alumni"],
    ["coauthor-minor", "coauthor_minor"],
    ["coauthor-major", "coauthor_major"],
    ["external-prof", "external_prof"],
    ["own-pace-advisee", "own_pace_advisee"],
    ["coauthor-discussant-or-designer", "coauthor_discussant_designer"],
    ["disappearing-coauthor", "disappearing_coauthor"],
    ["interviewee", "interviewee"],
    ["slightly-better-than-emails", "slightly_better_than_emails"],
  ] as const)("maps the sheet's %s to the %s subgroup", (token, subgroup) => {
    const verdict = classify(token);
    expect(verdict).toMatchObject({
      kind: "collaborator",
      privilege_level: "external_collaborator",
      collaborator_subgroup: subgroup,
    });
  });

  it("can reach every subgroup the contract defines", () => {
    // A subgroup no sheet token maps onto is one nobody could ever be imported as -- which is the
    // shape of the bug that left own_pace_advisee unassignable in the first place.
    const reachable = new Set(Object.values(SUBGROUP_BY_TOKEN));
    expect([...adminBotExternalCollaboratorSubgroups].filter((s) => !reachable.has(s))).toEqual([]);
  });

  it("makes a full member a member, and never gives them a subgroup", () => {
    expect(classify("full")).toEqual({ kind: "full", privilege_level: "member" });
  });

  it("reads adminbot-admin as the admin privilege level", () => {
    expect(classify("full, adminbot-admin, adminbot-developer")).toEqual({
      kind: "full",
      privilege_level: "admin",
    });
  });

  it("lets full win over a subgroup named beside it", () => {
    // "full, coauthor-minor" is a full member who also coauthors, not an external collaborator.
    // The whole string still reaches member_type; only the privilege is decided here.
    expect(classify("full, coauthor-minor")).toEqual({ kind: "full", privilege_level: "member" });
    expect(classify("full, coauthor-major")).toEqual({ kind: "full", privilege_level: "member" });
  });

  it("takes the least-granting subgroup when a row names several, and says what it passed over", () => {
    expect(classify("alumni, coauthor-major")).toEqual({
      kind: "collaborator",
      privilege_level: "external_collaborator",
      collaborator_subgroup: "alumni",
      alsoNamed: ["coauthor_major"],
    });
    expect(classify("alumni, coauthor-minor, interviewee")).toMatchObject({
      collaborator_subgroup: "alumni",
      alsoNamed: ["coauthor_minor", "interviewee"],
    });
  });

  it("reports nothing to import rather than guessing", () => {
    expect(classify("")).toMatchObject({ kind: "unmappable" });
    // "mailing-list" is a real value in the sheet and is not part of the access design.
    expect(classify("mailing-list")).toMatchObject({ kind: "unmappable" });
  });

  it("ignores a stray note sitting beside a real subgroup", () => {
    // One row carries an email-template variant name in this column.
    expect(classify("coauthor-major, top2-only-invite-to-theme-meeting-and-slack")).toMatchObject({
      collaborator_subgroup: "coauthor_major",
      alsoNamed: [],
    });
  });

  it("is case- and space-insensitive, the way the sheet is typed", () => {
    expect(classify("  Coauthor-Major ")).toMatchObject({
      collaborator_subgroup: "coauthor_major",
    });
  });
});

// The script derives a patch and PUTs it. These run the two patch shapes it actually sends through
// the real service, because both of them turn on validation rules that live there rather than here.
describe("the patch the import sends", () => {
  function patchFor(memberType: string): Record<string, unknown> {
    const verdict = classify(memberType);
    if (verdict.kind === "unmappable") {
      throw new Error(`unmappable: ${verdict.reason}`);
    }
    const patch: Record<string, unknown> = {
      member_type: memberType,
      privilege_level: verdict.privilege_level,
    };
    if (verdict.kind === "collaborator") {
      patch.collaborator_subgroup = verdict.collaborator_subgroup;
    }
    return patch;
  }

  function serviceWith(seed: Record<string, unknown>) {
    const service = new AdminBotService();
    const created = service.upsertLabMember({ id: "m1", name: "Ada Lovelace", ...seed } as never);
    expect(created.ok).toBe(true);
    return service;
  }

  it("sets the subgroup on someone the sheet calls a collaborator", () => {
    const service = serviceWith({ privilege_level: "external_collaborator" });
    const saved = service.upsertLabMember({ id: "m1", ...patchFor("own-pace-advisee") } as never);
    expect(saved.ok).toBe(true);
    const member = service.upsertLabMember({ id: "m1" } as never);
    expect(member.ok && member.payload.privilege_level).toBe("external_collaborator");
    expect(member.ok && member.payload.collaborator_subgroup).toBe("own_pace_advisee");
    expect(member.ok && member.payload.member_type).toBe("own-pace-advisee");
  });

  it("clears a stale subgroup when the sheet promotes someone to full, without sending one", () => {
    // The regression this guards: sending `collaborator_subgroup: ""` to clear it is refused by
    // validation ("must be one of: ..."), because the field is checked whenever it is present.
    // Omitting it is what actually clears it, via the privilege level.
    const service = serviceWith({
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_minor",
    });
    const patch = patchFor("full, coauthor-minor");
    expect(patch).not.toHaveProperty("collaborator_subgroup");

    const saved = service.upsertLabMember({ id: "m1", ...patch } as never);
    expect(saved.ok).toBe(true);
    expect(saved.ok && saved.payload.privilege_level).toBe("member");
    expect(saved.ok && saved.payload.collaborator_subgroup).toBeUndefined();
    // The whole cell still lands on the record, which is where "they also coauthor" survives.
    expect(saved.ok && saved.payload.member_type).toBe("full, coauthor-minor");
  });

  it("is refused if a subgroup is ever sent alongside a full-member privilege level", () => {
    const service = serviceWith({ privilege_level: "external_collaborator" });
    const refused = service.upsertLabMember({
      id: "m1",
      privilege_level: "member",
      collaborator_subgroup: "coauthor_major",
    } as never);
    expect(refused.ok).toBe(false);
  });
});
