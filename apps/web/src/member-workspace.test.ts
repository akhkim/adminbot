// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { MemberRosterProjection } from "@adminbot/api-contracts";
import { AdminBotMemberWorkspace } from "./member-workspace.js";

if (!customElements.get("adminbot-member-workspace")) customElements.define("adminbot-member-workspace", AdminBotMemberWorkspace);

describe("AdminBotMemberWorkspace", () => {
  it("shows the authenticated roster and exposes only authorized editors", async () => {
    const element = document.createElement("adminbot-member-workspace") as AdminBotMemberWorkspace;
    element.client = {
      list: vi.fn(async () => workspace()), updateOwn: vi.fn(async () => workspace()),
      updateGovernance: vi.fn(async () => workspace()), replaceRoles: vi.fn(async () => workspace()),
      replaceVisibility: vi.fn(async () => workspace()),
    };
    document.body.append(element);
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Synthetic Member"));
    expect(element.shadowRoot?.textContent).toContain("Edit my profile");
    expect(element.shadowRoot?.textContent).not.toContain("Edit member");
    element.remove();
  });

  it("shows account state, role replacement, and visibility controls only to administrators", async () => {
    const base = workspace();
    const administrator: MemberRosterProjection = {
      ...base,
      viewerRoles: ["administrator"],
      members: base.members.map((member, index) => ({
        ...member,
        roles: index === 0 ? ["administrator"] : ["member"],
        canEditGovernance: true,
        canManageRoles: index !== 0,
        canManageVisibility: true,
      })),
    };
    const element = document.createElement("adminbot-member-workspace") as AdminBotMemberWorkspace;
    element.client = {
      list: vi.fn(async () => administrator), updateOwn: vi.fn(async () => administrator),
      updateGovernance: vi.fn(async () => administrator), replaceRoles: vi.fn(async () => administrator),
      replaceVisibility: vi.fn(async () => administrator),
    };
    document.body.append(element);
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Identity: Active · Account: No account"));
    const otherButton = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("Edit member"));
    otherButton?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("Authorization roles");
    expect(element.shadowRoot?.textContent).toContain("Profile visibility");
    element.remove();
  });
});

function workspace(): MemberRosterProjection {
  const timestamp = "2026-08-08T12:00:00.000Z";
  const profile = { id: "20000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000001", personId: "20000000-0000-4000-8000-000000000001", displayName: "Synthetic Member", researchTopics: ["Systems"], fieldVisibility: { preferredName: "members" as const, institutionalEmail: "members" as const, biography: "members" as const, researchTopics: "members" as const, profileImageArtifactId: "members" as const }, version: 1, createdAt: timestamp, updatedAt: timestamp };
  return { viewerPersonId: profile.personId, viewerRoles: ["member" as const], members: [{ profile, membership: { id: profile.id, organizationId: profile.organizationId, personId: profile.personId, tier: "member" as const, lifecycle: "active" as const, version: 1, createdAt: timestamp, updatedAt: timestamp }, personStatus: "active" as const, accountState: "active" as const, roles: ["member" as const], canEditOwnProfile: true, canEditGovernance: false, canManageRoles: false, canManageVisibility: false }, { profile: { ...profile, id: "20000000-0000-4000-8000-000000000002", personId: "20000000-0000-4000-8000-000000000002", displayName: "Other Member" }, membership: { id: "20000000-0000-4000-8000-000000000002", organizationId: profile.organizationId, personId: "20000000-0000-4000-8000-000000000002", tier: "member" as const, lifecycle: "active" as const, version: 1, createdAt: timestamp, updatedAt: timestamp }, personStatus: "active" as const, roles: [], canEditOwnProfile: false, canEditGovernance: false, canManageRoles: false, canManageVisibility: false }], asOf: timestamp };
}
