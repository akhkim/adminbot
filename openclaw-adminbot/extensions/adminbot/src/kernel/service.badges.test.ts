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
