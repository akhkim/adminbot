import { apiRoutes, type SignupRegistrationInput } from "@adminbot/api-contracts";
import type { RegistrationApplication } from "./registration-routes.js";
import type {
  RegistrationReviewApplication,
  SessionAuthenticator,
} from "./registration-review-routes.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminBotApiServer, type ListeningApiServer } from "./server.js";
import type { SessionApplication } from "./session-routes.js";

const WEB_ORIGIN = "http://127.0.0.1:4173";
const openServers: ListeningApiServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

describe("AdminBotApiServer registration routes", () => {
  it("mounts the generated v0alpha routes and forwards trusted transport context", async () => {
    const application = fakeRegistrationApplication();
    const server = await start(application);
    const body: SignupRegistrationInput = {
      email: "applicant@example.com",
      password: "correct horse battery staple",
      profile: { displayName: "Synthetic Applicant" },
    };

    const response = await fetch(`${server.origin}${apiRoutes.submitSignup.build()}`, {
      method: apiRoutes.submitSignup.method,
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      registrationId: "30000000-0000-4000-8000-000000000001",
      state: "submitted",
    });
    expect(application.submitSignup).toHaveBeenCalledWith(body, {
      remoteAddress: "127.0.0.1",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not serve the legacy unversioned endpoint", async () => {
    const server = await start(fakeRegistrationApplication());
    const response = await fetch(`${server.origin}/auth/registrations/signups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("rejects browser origins outside the explicit allowlist before dispatch", async () => {
    const application = fakeRegistrationApplication();
    const server = await start(application);
    const response = await fetch(`${server.origin}${apiRoutes.submitSignup.build()}`, {
      method: apiRoutes.submitSignup.method,
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(application.submitSignup).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized JSON before application code", async () => {
    const application = fakeRegistrationApplication();
    const server = await start(application);
    const malformed = await fetch(`${server.origin}${apiRoutes.submitClaim.build()}`, {
      method: apiRoutes.submitClaim.method,
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const oversized = await fetch(`${server.origin}${apiRoutes.submitClaim.build()}`, {
      method: apiRoutes.submitClaim.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(70_000) }),
    });

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(application.submitClaim).not.toHaveBeenCalled();
  });

  it("delivers the opaque session credential only in a strict HTTP-only cookie", async () => {
    const sessions = fakeSessionApplication();
    const server = await start(fakeRegistrationApplication(), { sessions });
    const response = await fetch(`${server.origin}${apiRoutes.createSession.build()}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: WEB_ORIGIN,
      },
      body: JSON.stringify({ email: "admin@example.com", password: "correct password" }),
    });

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("adminbot_session_v1=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Domain=");
    expect(JSON.stringify(await response.json())).not.toContain("a".repeat(43));
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("restores and revokes sessions through the cookie without accepting body identity", async () => {
    const sessions = fakeSessionApplication();
    const server = await start(fakeRegistrationApplication(), { sessions });
    const cookie = `adminbot_session_v1=${"a".repeat(43)}`;

    const current = await fetch(`${server.origin}${apiRoutes.getCurrentSession.build()}`, {
      headers: { cookie, origin: WEB_ORIGIN },
    });
    const logout = await fetch(`${server.origin}${apiRoutes.deleteCurrentSession.build()}`, {
      method: "DELETE",
      headers: { cookie, origin: WEB_ORIGIN },
    });

    expect(current.status).toBe(200);
    expect(sessions.current).toHaveBeenCalledWith("a".repeat(43));
    expect(logout.status).toBe(204);
    expect(sessions.logout).toHaveBeenCalledWith("a".repeat(43));
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("authenticates administrator registration review from the cookie", async () => {
    const sessions = fakeSessionApplication();
    const reviews = fakeRegistrationReviewApplication();
    const server = await start(fakeRegistrationApplication(), { sessions, reviews });
    const cookie = `adminbot_session_v1=${"a".repeat(43)}`;

    const list = await fetch(
      `${server.origin}${apiRoutes.listRegistrations.build()}?state=submitted`,
      { headers: { cookie, origin: WEB_ORIGIN } },
    );
    const decisionPath = apiRoutes.decideRegistration.build({
      registrationId: "30000000-0000-4000-8000-000000000001",
    });
    const decision = await fetch(`${server.origin}${decisionPath}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ decision: "reject", reason: "synthetic test" }),
    });

    expect(list.status).toBe(200);
    expect(reviews.list).toHaveBeenCalledWith(expect.objectContaining({ personId: expect.any(String) }), "submitted");
    expect(decision.status).toBe(200);
    expect(reviews.decide).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ["administrator"] }),
      "30000000-0000-4000-8000-000000000001",
      { decision: "reject", reason: "synthetic test" },
    );
  });
});

function fakeRegistrationApplication() {
  const submitClaim = vi.fn<RegistrationApplication["submitClaim"]>(async () => ({
    ok: false as const,
    status: 403 as const,
    body: {
      code: "not_authorized" as const,
      message: "unable to claim this profile",
      retryable: false,
    },
  }));
  const submitSignup = vi.fn<RegistrationApplication["submitSignup"]>(async () => ({
    ok: true as const,
    status: 202 as const,
    body: {
      registrationId: "30000000-0000-4000-8000-000000000001",
      state: "submitted" as const,
    },
  }));
  return {
    listClaimablePeople: vi.fn(async () => []),
    submitClaim,
    submitSignup,
  } satisfies RegistrationApplication;
}

function fakeSessionApplication() {
  const view = {
    sessionId: "22000000-0000-4000-8000-000000000001",
    expiresAt: "2026-08-15T12:00:00.000Z",
    authenticationLevel: "recent_reauthentication" as const,
    person: {
      id: "20000000-0000-4000-8000-000000000001",
      organizationId: "10000000-0000-4000-8000-000000000001",
      displayName: "Synthetic Administrator",
      status: "active" as const,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    },
    roles: ["administrator" as const],
  };
  const actor = {
    sessionId: view.sessionId,
    accountId: "21000000-0000-4000-8000-000000000001",
    organizationId: view.person.organizationId,
    personId: view.person.id,
    roles: view.roles,
    authenticationLevel: view.authenticationLevel,
    expiresAt: new Date(view.expiresAt),
    view,
  };
  return {
    login: vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: view,
      credential: { token: "a".repeat(43), maximumAgeSeconds: 604_800 },
    })),
    current: vi.fn(async () => ({ ok: true as const, status: 200 as const, body: view })),
    logout: vi.fn(async () => undefined),
    authenticate: vi.fn(async (token: string | undefined) =>
      token === "a".repeat(43) ? actor : undefined,
    ),
  } satisfies SessionApplication & SessionAuthenticator;
}

function fakeRegistrationReviewApplication() {
  return {
    list: vi.fn(async () => ({ ok: true as const, status: 200 as const, body: [] })),
    decide: vi.fn(async (_actor, registrationId: string) => ({
      ok: true as const,
      status: 200 as const,
      body: {
        id: registrationId,
        organizationId: "10000000-0000-4000-8000-000000000001",
        kind: "signup" as const,
        requestedLoginHandle: "applicant@example.com",
        requestedDisplayName: "Synthetic Applicant",
        state: "rejected" as const,
        version: 2,
        createdAt: "2026-08-08T11:00:00.000Z",
        updatedAt: "2026-08-08T12:00:00.000Z",
      },
    })),
  } satisfies RegistrationReviewApplication;
}

interface StartOverrides {
  readonly sessions?: ReturnType<typeof fakeSessionApplication>;
  readonly reviews?: ReturnType<typeof fakeRegistrationReviewApplication>;
}

async function start(
  application: RegistrationApplication,
  overrides: StartOverrides = {},
): Promise<ListeningApiServer> {
  const api = new AdminBotApiServer({
    registration: application,
    sessions: overrides.sessions ?? fakeSessionApplication(),
    registrationReview: overrides.reviews ?? fakeRegistrationReviewApplication(),
    allowedOrigins: [WEB_ORIGIN],
  });
  const server = await api.listen({ port: 0 });
  openServers.push(server);
  return server;
}
