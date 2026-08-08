import { apiRoutes, type SignupRegistrationInput } from "@adminbot/api-contracts";
import type { RegistrationApplication } from "./registration-routes.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminBotApiServer, type ListeningApiServer } from "./server.js";

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

async function start(application: RegistrationApplication): Promise<ListeningApiServer> {
  const api = new AdminBotApiServer({
    registration: application,
    allowedOrigins: [WEB_ORIGIN],
  });
  const server = await api.listen({ port: 0 });
  openServers.push(server);
  return server;
}
