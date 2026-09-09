import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

describe("AdminBotService badges", () => {
  it("seeds the default badge catalog including tiered families", () => {
    const service = new AdminBotService();

    const badges = unwrap(service.listBadgeDefinitions()).badges;

    expect(badges.map((badge) => badge.id)).toContain("team_contributor__infra_builder");
    expect(
      badges.filter((badge) => badge.family_key === "causality").map((badge) => badge.tier),
    ).toEqual(["Level 1", "Level 2", "Level 3"]);
  });

  it("keeps badge tiers exclusive per family when an admin reassigns one", () => {
    const service = new AdminBotService();
    unwrap(service.upsertLabMember({ id: "pat", name: "Pat", privilege_level: "member" }));

    unwrap(service.assignBadge("pat", "causality__level_1", "admin-1"));
    unwrap(service.assignBadge("pat", "causality__level_2", "admin-1"));

    const member = unwrap(service.listLabMembers()).members.find((entry) => entry.id === "pat");
    expect(member?.assigned_badges).toHaveLength(1);
    expect(member?.assigned_badges?.[0]).toMatchObject({
      badge_id: "causality__level_2",
      family_key: "causality",
    });
  });

  it("holds self-nominations pending until an admin decides them", () => {
    const service = new AdminBotService();
    unwrap(service.upsertLabMember({ id: "pat", name: "Pat", privilege_level: "member" }));

    const nomination = unwrap(
      service.submitBadgeNomination("pat", {
        badge_id: "community_building__ambassador",
        evidence: "Organized the NeurIPS booth.",
      }),
    ).nomination;

    const blocked = service.assignBadge("pat", "community_building__ambassador", "admin-1");
    expect(blocked).toMatchObject({
      ok: false,
      status: 409,
    });

    const approved = unwrap(service.decideBadgeNomination(nomination.id, "approved", "admin-1"));
    expect(approved.nomination.status).toBe("approved");
    expect(approved.assignment).toMatchObject({
      badge_id: "community_building__ambassador",
      source: "nomination",
      evidence: "Organized the NeurIPS booth.",
    });
  });

  it("generates a badge id on create instead of requiring one from the caller", () => {
    const service = new AdminBotService();

    const badge = unwrap(
      service.createBadgeDefinition(
        { category: "Team Contributor", name: "Docs Champion", description: "Wrote the docs." },
        "admin-1",
      ),
    ).badge;

    expect(badge.id).toMatch(/^badge_/u);
  });

  it("rejects a self-nomination submitted without evidence", () => {
    const service = new AdminBotService();
    unwrap(service.upsertLabMember({ id: "pat", name: "Pat", privilege_level: "member" }));

    const result = service.submitBadgeNomination("pat", {
      badge_id: "community_building__ambassador",
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  // Most of what these badges recognise is not something the person who did it writes up about
  // themselves, so a colleague has to be able to put it forward.
  describe("nominating somebody else", () => {
    const lab = () => {
      const service = new AdminBotService();
      unwrap(service.upsertLabMember({ id: "pat", name: "Pat", privilege_level: "member" }));
      unwrap(service.upsertLabMember({ id: "mei", name: "Mei", privilege_level: "member" }));
      return service;
    };

    it("records who put it forward and who it is for", () => {
      const service = lab();

      const nomination = unwrap(
        service.submitBadgeNomination("pat", {
          badge_id: "team_contributor__bug_hunter",
          member_id: "mei",
          evidence: "Caught the sign error in the causal effect proof before submission.",
        }),
      ).nomination;

      expect(nomination).toMatchObject({
        member_id: "mei",
        nominated_by: "pat",
        member_name: "Mei",
        nominator_name: "Pat",
        status: "pending",
      });
    });

    it("awards the badge to the nominee, not the nominator, once an admin approves", () => {
      const service = lab();
      const nomination = unwrap(
        service.submitBadgeNomination("pat", {
          badge_id: "team_contributor__bug_hunter",
          member_id: "mei",
          evidence: "Caught the sign error before submission.",
        }),
      ).nomination;

      const approved = unwrap(service.decideBadgeNomination(nomination.id, "approved", "admin-1"));

      expect(approved.assignment).toMatchObject({ member_id: "mei", source: "nomination" });
      const members = unwrap(service.listLabMembers()).members;
      expect(members.find((entry) => entry.id === "pat")?.assigned_badges ?? []).toHaveLength(0);
    });

    it("leaves a self-nomination with no nominator, so the two stay distinguishable", () => {
      const service = lab();

      const nomination = unwrap(
        service.submitBadgeNomination("pat", {
          badge_id: "team_contributor__bug_hunter",
          member_id: "pat",
          evidence: "Found it myself.",
        }),
      ).nomination;

      expect(nomination.nominated_by).toBeUndefined();
    });

    it("checks the family clash against the nominee rather than the nominator", () => {
      const service = lab();
      unwrap(service.assignBadge("mei", "causality__level_1", "admin-1"));

      const forHolder = service.submitBadgeNomination("pat", {
        badge_id: "causality__level_2",
        member_id: "mei",
        evidence: "Three causality papers now.",
      });
      expect(forHolder).toMatchObject({ ok: false, status: 409 });

      // Pat holds nothing in that family, so the same badge is still nominable for Pat.
      expect(
        service.submitBadgeNomination("mei", {
          badge_id: "causality__level_2",
          member_id: "pat",
          evidence: "Main-conference causality paper.",
        }).ok,
      ).toBe(true);
    });

    it("refuses a nomination for somebody who is not on the roster", () => {
      const service = lab();

      const result = service.submitBadgeNomination("pat", {
        badge_id: "team_contributor__bug_hunter",
        member_id: "ghost",
        evidence: "Nobody by that name.",
      });

      expect(result).toMatchObject({ ok: false, status: 404 });
    });

    it("shows a member both what was put forward for them and what they put forward", () => {
      const service = lab();
      unwrap(
        service.submitBadgeNomination("pat", {
          badge_id: "team_contributor__bug_hunter",
          member_id: "mei",
          evidence: "Caught the proof error.",
        }),
      );
      unwrap(
        service.submitBadgeNomination("mei", {
          badge_id: "community_building__ambassador",
          member_id: "pat",
          evidence: "Ran the booth.",
        }),
      );

      const forPat = unwrap(service.listBadgeNominations({ involvingMemberId: "pat" })).nominations;

      expect(forPat.map((entry) => entry.member_id).toSorted()).toEqual(["mei", "pat"]);
    });
  });

  it("lets an admin attach optional evidence when directly assigning a badge", () => {
    const service = new AdminBotService();
    unwrap(service.upsertLabMember({ id: "pat", name: "Pat", privilege_level: "member" }));

    const assignment = unwrap(
      service.assignBadge(
        "pat",
        "community_building__ambassador",
        "admin-1",
        "Ran the outreach booth solo.",
      ),
    ).assignment;

    expect(assignment.evidence).toBe("Ran the outreach booth solo.");
  });
});
