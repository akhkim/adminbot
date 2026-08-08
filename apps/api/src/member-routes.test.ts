import { apiRoutes } from "@adminbot/api-contracts";
import type { AuthenticatedHumanSession } from "@adminbot/identity";
import type { MemberApplication } from "./member-routes.js";
import { createMemberRoutes } from "./member-routes.js";
import { describe, expect, it, vi } from "vitest";

describe("member routes", () => {
  it("derives the self-edit identity from the authenticated cookie session", async () => {
    const application = fakeApplication();
    const sessions = { authenticate: vi.fn(async () => session()) };
    const route = createMemberRoutes(sessions, application)[1];
    const body = { expectedVersion: 1, biography: "Synthetic biography" };
    await route?.handle({ body, pathname: apiRoutes.updateOwnMemberProfile.build(), query: new URLSearchParams(), sessionToken: "opaque" });
    expect(application.updateOwnProfile).toHaveBeenCalledWith(expect.objectContaining({ personId: session().personId, roles: ["member"] }), body);
  });

  it("decodes the centralized governance target without trusting a body person id", async () => {
    const application = fakeApplication();
    const target = "20000000-0000-4000-8000-000000000002";
    const route = createMemberRoutes({ authenticate: vi.fn(async () => session()) }, application)[2];
    await route?.handle({ body: { personId: "forged" }, pathname: apiRoutes.updateMemberGovernance.build({ personId: target }), query: new URLSearchParams() });
    expect(application.updateGovernance).toHaveBeenCalledWith(expect.anything(), target, { personId: "forged" });
  });

  it("routes role and visibility changes to the path target", async () => {
    const application = fakeApplication();
    const target = "20000000-0000-4000-8000-000000000002";
    const routes = createMemberRoutes({ authenticate: vi.fn(async () => session()) }, application);
    await routes[3]?.handle({ body: { roles: ["member"] }, pathname: apiRoutes.replaceMemberRoles.build({ personId: target }), query: new URLSearchParams() });
    await routes[4]?.handle({ body: { fieldVisibility: {} }, pathname: apiRoutes.replaceMemberVisibility.build({ personId: target }), query: new URLSearchParams() });
    expect(application.replaceRoles).toHaveBeenCalledWith(expect.anything(), target, { roles: ["member"] });
    expect(application.replaceVisibility).toHaveBeenCalledWith(expect.anything(), target, { fieldVisibility: {} });
  });
});

function fakeApplication(): MemberApplication {
  const result = { ok: false as const, status: 403 as const, body: { code: "not_authorized" as const, message: "denied", retryable: false as const } };
  return {
    list: vi.fn(async () => result), updateOwnProfile: vi.fn(async () => result),
    updateGovernance: vi.fn(async () => result), replaceRoles: vi.fn(async () => result),
    replaceVisibility: vi.fn(async () => result),
  };
}

function session(): AuthenticatedHumanSession {
  return {
    sessionId: "session", accountId: "50000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000001",
    personId: "20000000-0000-4000-8000-000000000001", roles: ["member"],
    authenticationLevel: "recent_reauthentication", expiresAt: new Date("2026-08-15T00:00:00Z"),
    view: {} as AuthenticatedHumanSession["view"],
  };
}
