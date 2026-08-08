// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { AdminBotMemberWorkspace } from "./member-workspace.js";

if (!customElements.get("adminbot-member-workspace")) customElements.define("adminbot-member-workspace", AdminBotMemberWorkspace);

describe("AdminBotMemberWorkspace", () => {
  it("shows the authenticated roster and exposes only authorized editors", async () => {
    const element = document.createElement("adminbot-member-workspace") as AdminBotMemberWorkspace;
    element.client = { list: vi.fn(async () => workspace()), updateOwn: vi.fn(async () => workspace()), updateGovernance: vi.fn(async () => workspace()) };
    document.body.append(element);
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Synthetic Member"));
    expect(element.shadowRoot?.textContent).toContain("Edit my profile");
    expect(element.shadowRoot?.textContent).not.toContain("Edit member");
    element.remove();
  });
});

function workspace() {
  const timestamp = "2026-08-08T12:00:00.000Z";
  const profile = { id: "20000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000001", personId: "20000000-0000-4000-8000-000000000001", displayName: "Synthetic Member", researchTopics: ["Systems"], fieldVisibility: { preferredName: "members" as const, institutionalEmail: "members" as const, biography: "members" as const, researchTopics: "members" as const, profileImageArtifactId: "members" as const }, version: 1, createdAt: timestamp, updatedAt: timestamp };
  return { viewerPersonId: profile.personId, viewerRoles: ["member" as const], members: [{ profile, membership: { id: profile.id, organizationId: profile.organizationId, personId: profile.personId, tier: "member" as const, lifecycle: "active" as const, version: 1, createdAt: timestamp, updatedAt: timestamp }, roles: ["member" as const], canEditOwnProfile: true, canEditGovernance: false }, { profile: { ...profile, id: "20000000-0000-4000-8000-000000000002", personId: "20000000-0000-4000-8000-000000000002", displayName: "Other Member" }, membership: { id: "20000000-0000-4000-8000-000000000002", organizationId: profile.organizationId, personId: "20000000-0000-4000-8000-000000000002", tier: "member" as const, lifecycle: "active" as const, version: 1, createdAt: timestamp, updatedAt: timestamp }, roles: [], canEditOwnProfile: false, canEditGovernance: false }], asOf: timestamp };
}
