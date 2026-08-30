import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderAdminBotBadges } from "./badges.ts";

describe("renderAdminBotBadges", () => {
  it("renders the badge catalog, assignments, and nomination queue", () => {
    const container = document.createElement("div");
    render(
      renderAdminBotBadges({
        definitions: [
          {
            id: "causality__level_1",
            family_key: "causality",
            category: "Causality",
            name: "Causality",
            tier: "Level 1",
            description: "Passed the CausalTutor curriculum.",
            sort_order: 10,
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-01T00:00:00.000Z",
          },
        ],
        definitionsLoading: false,
        definitionsError: null,
        nominations: [
          {
            id: "nom-1",
            badge_id: "causality__level_1",
            family_key: "causality",
            member_id: "pat",
            member_name: "Pat Doe",
            status: "pending",
            created_at: "2026-08-03T00:00:00.000Z",
            badge_category: "Causality",
            badge_name: "Causality",
            badge_tier: "Level 1",
            badge_description: "Passed the CausalTutor curriculum.",
          },
        ],
        nominationsLoading: false,
        nominationsError: null,
        busyKey: null,
        notice: null,
        assignRowId: "",
        onToggleAssignRow: vi.fn(),
        memberQuery: "",
        onMemberQueryChange: vi.fn(),
        members: [
          {
            id: "pat",
            name: "Pat Doe",
            assigned_badges: [
              {
                member_id: "pat",
                badge_id: "causality__level_1",
                family_key: "causality",
                awarded_at: "2026-08-02T00:00:00.000Z",
                awarded_by: "admin",
                source: "admin",
                category: "Causality",
                name: "Causality",
                tier: "Level 1",
                description: "Passed the CausalTutor curriculum.",
                sort_order: 10,
              },
            ],
          },
        ],
        onRefresh: vi.fn(),
        onSaveDefinition: vi.fn(),
        onAssign: vi.fn(),
        onRemove: vi.fn(),
        onDecide: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("Badges");
    expect(container.textContent).toContain("Causality · Level 1");
    expect(container.textContent).toContain("Pat Doe");
    expect(container.textContent).toContain("Pending self-nominations");
  });

  it("shows the selected member's badges, including evidence, in the per-member view", () => {
    const container = document.createElement("div");
    render(
      renderAdminBotBadges({
        definitions: [],
        definitionsLoading: false,
        definitionsError: null,
        nominations: [],
        nominationsLoading: false,
        nominationsError: null,
        busyKey: null,
        notice: null,
        assignRowId: "",
        onToggleAssignRow: vi.fn(),
        memberQuery: "",
        onMemberQueryChange: vi.fn(),
        members: [
          {
            id: "pat",
            name: "Pat Doe",
            assigned_badges: [
              {
                member_id: "pat",
                badge_id: "causality__level_1",
                family_key: "causality",
                awarded_at: "2026-08-02T00:00:00.000Z",
                awarded_by: "admin",
                source: "admin",
                evidence: "Ran the outreach booth solo.",
                category: "Causality",
                name: "Causality",
                tier: "Level 1",
                description: "Passed the CausalTutor curriculum.",
                sort_order: 10,
              },
            ],
          },
        ],
        onRefresh: vi.fn(),
        onSaveDefinition: vi.fn(),
        onAssign: vi.fn(),
        onRemove: vi.fn(),
        onDecide: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("Ran the outreach booth solo.");
  });

  // The Control UI ships from Vercel ahead of the service on Aurora, so an admin opening this tab
  // against an older service gets a 404. That has to read as "the service needs a deploy", not as
  // the sign-in problem the generic copy used to claim.
  it("names the missing deploy when the service has no badge routes", () => {
    const container = document.createElement("div");
    const onRefresh = vi.fn();
    render(renderAdminBotBadges(errorProps("not-deployed", onRefresh)), container);

    expect(container.textContent).toContain("doesn't have badges yet");
    expect(container.textContent).not.toContain("session has expired");
    const retry = container.querySelector("button");
    expect(retry).not.toBeNull();
    retry?.click();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the sign-in prompt for a genuinely expired session, with no retry button", () => {
    const container = document.createElement("div");
    render(renderAdminBotBadges(errorProps("expired", vi.fn())), container);

    expect(container.textContent).toContain("session has expired");
    expect(container.querySelector("button")).toBeNull();
  });

  it("says the catalog is empty rather than showing nothing at all", () => {
    const container = document.createElement("div");
    render(renderAdminBotBadges(baseProps()), container);

    expect(container.textContent).toContain("No badges defined yet.");
  });
});

function baseProps(): Parameters<typeof renderAdminBotBadges>[0] {
  return {
    definitions: [],
    definitionsLoading: false,
    definitionsError: null,
    nominations: [],
    nominationsLoading: false,
    nominationsError: null,
    busyKey: null,
    notice: null,
    members: [],
    assignRowId: "",
    onToggleAssignRow: vi.fn(),
    memberQuery: "",
    onMemberQueryChange: vi.fn(),
    editBadgeId: "",
    onToggleEditBadge: vi.fn(),
    onRefresh: vi.fn(),
    onSaveDefinition: vi.fn(),
    onAssign: vi.fn(),
    onRemove: vi.fn(),
    onDecide: vi.fn(),
  };
}

function errorProps(
  definitionsError: NonNullable<Parameters<typeof renderAdminBotBadges>[0]["definitionsError"]>,
  onRefresh: () => void,
): Parameters<typeof renderAdminBotBadges>[0] {
  return { ...baseProps(), definitionsError, onRefresh };
}
