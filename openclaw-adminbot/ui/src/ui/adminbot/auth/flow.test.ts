// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import {
  type MemberAuthHost,
  acknowledgeOnboardingChecklist,
  loadMemberPrivilege,
  recoverFromRejectedDeviceToken,
  resumeMemberSession,
  toggleOnboardingStep,
  signOutMember,
  submitMemberAuth,
} from "./flow.ts";
import { clearStoredMemberSession, saveStoredMemberSession } from "./session.ts";

const BASE_URL = "http://127.0.0.1:8765";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("location", { hostname: "127.0.0.1" } as Location);
});

afterEach(() => {
  clearStoredMemberSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockLoginAndDevice(body: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      String(input).includes("/auth/device-token")
        ? jsonResponse(200, { token: "device-tok", scopes: ["operator.read"] })
        : jsonResponse(200, body),
    );
}

function makeHost(overrides: Partial<MemberAuthHost> = {}): MemberAuthHost {
  return {
    settings: { adminBotUrl: BASE_URL } as unknown as UiSettings,
    memberEmail: "",
    memberPassword: "",
    memberPasswordConfirm: "",
    loginMode: "signin",
    memberAuthBusy: false,
    memberAuthFailure: null,
    memberFormError: null,
    loginPendingNotice: false,
    rosterMembers: [],
    rosterLoading: false,
    rosterError: null,
    rosterFilter: "",
    selectedMemberId: null,
    memberName: "",
    memberSlackUserId: "",
    memberRole: "",
    memberAffiliation: "",
    memberResearchBranch: "",
    memberResearchTopics: "",
    memberProjects: "",
    memberHoursPerWeek: "",
    memberLocation: "",
    memberTimezone: "",
    memberPersonalWebsite: "",
    memberNotes: "",
    memberPrivilegeLevel: null,
    memberId: null,
    adminBotOnboarding: null,
    adminBotOnboardingAcknowledged: true,
    adminBotOnboardingBusyStepId: null,
    adminBotOnboardingError: null,
    applySettings: vi.fn(),
    connect: vi.fn(),
    ...overrides,
  };
}

// Signing in must not downgrade the gateway URL the page is already configured with. AdminBot
// advertised its own loopback address, so adopting it pointed a hosted browser at port 18789 on the
// member's own machine and every sign-in ended at "disconnected (1006): no reason".
describe("gateway URL on sign-in", () => {
  const REMOTE = "wss://adminbot.tailnet.example.ts.net";

  function signedInHost() {
    return makeHost({
      memberEmail: "a@b.co",
      memberPassword: "pw",
      settings: { adminBotUrl: BASE_URL, gatewayUrl: REMOTE, token: "" } as unknown as UiSettings,
    });
  }

  it("keeps the configured URL when the service advertises loopback", async () => {
    const host = signedInHost();
    mockLoginAndDevice({
      session_token: "sess",
      expires_at: "2026-08-01T00:00:00Z",
      member: { id: "pat" },
      gateway: { url: "ws://127.0.0.1:18789" },
    });

    await submitMemberAuth(host);

    expect(host.applySettings).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayUrl: REMOTE }),
    );
  });

  it("keeps the configured URL when the service omits one", async () => {
    const host = signedInHost();
    mockLoginAndDevice({
      session_token: "sess",
      expires_at: "2026-08-01T00:00:00Z",
      member: { id: "pat" },
    });

    await submitMemberAuth(host);

    expect(host.applySettings).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayUrl: REMOTE }),
    );
  });

  it("adopts a routable URL the service does advertise", async () => {
    const host = signedInHost();
    mockLoginAndDevice({
      session_token: "sess",
      expires_at: "2026-08-01T00:00:00Z",
      member: { id: "pat" },
      gateway: { url: "wss://moved.example.ts.net" },
    });

    await submitMemberAuth(host);

    expect(host.applySettings).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayUrl: "wss://moved.example.ts.net" }),
    );
  });
});

describe("memberPrivilegeLevel wiring", () => {
  it("applyMemberSession persists privilege on signin success", async () => {
    const host = makeHost({ memberEmail: "a@b.co", memberPassword: "pw" });
    mockLoginAndDevice({
      session_token: "sess",
      expires_at: "2026-08-01T00:00:00Z",
      member: { id: "pat", privilege_level: "admin" },
      gateway: { url: "ws://127.0.0.1:18789" },
    });
    await submitMemberAuth(host);
    expect(host.memberPrivilegeLevel).toBe("admin");
    expect(host.connect).toHaveBeenCalled();
  });

  it("defaults privilege to null when the session omits it", async () => {
    const host = makeHost({ memberEmail: "a@b.co", memberPassword: "pw" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        session_token: "sess",
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat" },
        gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
      }),
    );
    await submitMemberAuth(host);
    expect(host.memberPrivilegeLevel).toBeNull();
  });

  it("resumeMemberSession restores privilege from the stored session", async () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "2026-08-01T00:00:00Z" });
    const host = makeHost();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", privilege_level: "admin" },
        gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
      }),
    );
    const outcome = await resumeMemberSession(host);
    expect(outcome).toBe("resumed");
    expect(host.memberPrivilegeLevel).toBe("admin");
  });

  it("loadMemberPrivilege populates privilege without touching the gateway", async () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "2026-08-01T00:00:00Z" });
    const host = makeHost();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", privilege_level: "admin" },
        gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
      }),
    );
    await loadMemberPrivilege(host);
    expect(host.memberPrivilegeLevel).toBe("admin");
    // Privilege load must not open the gateway connection.
    expect(host.connect).not.toHaveBeenCalled();
  });

  it("loadMemberPrivilege clears privilege when no session is stored", async () => {
    const host = makeHost({ memberPrivilegeLevel: "admin" });
    await loadMemberPrivilege(host);
    expect(host.memberPrivilegeLevel).toBeNull();
  });

  it("signOutMember resets privilege to null", async () => {
    const host = makeHost({ memberPrivilegeLevel: "admin", client: { stop: vi.fn() } });
    await signOutMember(host);
    expect(host.memberPrivilegeLevel).toBeNull();
  });
});

describe("onboarding checklist acknowledgement", () => {
  const onboarding = {
    completed: [],
    remaining: [],
    steps: [
      {
        id: "profile_photo",
        label: "Photo",
        status: "current" as const,
        category: "Getting started",
        required: true,
      },
    ],
  };

  it("submitMemberAuth login leaves the dashboard warning unacknowledged the first time for a member", async () => {
    const host = makeHost({ memberEmail: "a@b.co", memberPassword: "pw" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        session_token: "sess",
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", onboarding },
        gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
      }),
    );
    await submitMemberAuth(host);
    expect(host.adminBotOnboarding).toEqual(onboarding);
    expect(host.adminBotOnboardingAcknowledged).toBe(false);
  });

  it("does not re-warn once the member has acknowledged the checklist, even on a fresh login", async () => {
    const first = makeHost({ memberEmail: "a@b.co", memberPassword: "pw" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        session_token: "sess",
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", onboarding },
        gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
      }),
    );
    await submitMemberAuth(first);
    acknowledgeOnboardingChecklist(first);
    expect(first.adminBotOnboardingAcknowledged).toBe(true);

    const second = makeHost({ memberEmail: "a@b.co", memberPassword: "pw" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        session_token: "sess2",
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", onboarding },
        gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
      }),
    );
    await submitMemberAuth(second);
    expect(second.adminBotOnboardingAcknowledged).toBe(true);
  });

  it("resumeMemberSession keeps warning across reloads until the member acknowledges it", async () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "2026-08-01T00:00:00Z" });
    const host = makeHost();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", onboarding },
        gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
      }),
    );
    await resumeMemberSession(host);
    expect(host.adminBotOnboarding).toEqual(onboarding);
    // Unlike the old popup (which stayed hidden on reload once seen once), the dashboard warning
    // reflects real acknowledgement state on every resume, not just the first sign-in.
    expect(host.adminBotOnboardingAcknowledged).toBe(false);
  });

  it("resumeMemberSession does not re-warn once acknowledged in this browser", async () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "2026-08-01T00:00:00Z" });
    const setup = makeHost({ memberId: "pat" });
    acknowledgeOnboardingChecklist(setup);

    const host = makeHost();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", onboarding },
        gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
      }),
    );
    await resumeMemberSession(host);
    expect(host.adminBotOnboardingAcknowledged).toBe(true);
  });

  it("acknowledgeOnboardingChecklist is a no-op without a signed-in member id", () => {
    const host = makeHost({ memberId: null, adminBotOnboardingAcknowledged: false });
    acknowledgeOnboardingChecklist(host);
    // Still flips the in-memory flag (nothing left to warn about locally) even though there is
    // no member id to persist the acknowledgement against.
    expect(host.adminBotOnboardingAcknowledged).toBe(true);
  });

  it("signOutMember clears onboarding state", async () => {
    const host = makeHost({
      adminBotOnboarding: onboarding,
      adminBotOnboardingAcknowledged: false,
      client: { stop: vi.fn() },
    });
    await signOutMember(host);
    expect(host.adminBotOnboarding).toBeNull();
    expect(host.adminBotOnboardingAcknowledged).toBe(true);
  });
});

describe("submitMemberAuth signup", () => {
  it("sends the full Lab Members profile field set, dropping blank/invalid optional fields", async () => {
    const host = makeHost({
      loginMode: "signup",
      memberEmail: "full@example.com",
      memberPassword: "correcthorse",
      memberPasswordConfirm: "correcthorse",
      memberName: "Full Profile",
      memberSlackUserId: "U123",
      memberRole: "PhD student",
      memberAffiliation: "Jinesis Lab",
      memberResearchBranch: "NLP",
      memberResearchTopics: "alignment, rl",
      memberProjects: "proj-a, proj-b",
      memberHoursPerWeek: "20",
      memberLocation: "Toronto",
      memberTimezone: "America/Toronto",
      memberPersonalWebsite: "https://example.com",
      memberNotes: "  ",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { status: "pending" }));

    await submitMemberAuth(host);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.profile).toEqual({
      name: "Full Profile",
      slack_user_id: "U123",
      role: "PhD student",
      affiliation: "Jinesis Lab",
      research_branch: "NLP",
      research_topics: ["alignment", "rl"],
      projects: ["proj-a", "proj-b"],
      hours_per_week: 20,
      location: "Toronto",
      timezone: "America/Toronto",
      personal_website: "https://example.com",
    });
    expect(host.loginPendingNotice).toBe(true);
  });
});

// The browser minting its own device-bound gateway token is what lets a member connect with only
// their login: settings.token stays empty, so the shared gateway secret never reaches the browser.
describe("device-bound gateway token", () => {
  function routedFetch(routes: Record<string, () => Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const match = Object.keys(routes).find((path) => url.includes(path));
      if (!match) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return routes[match]!();
    });
  }

  const loginBody = {
    session_token: "sess",
    expires_at: "2026-08-01T00:00:00Z",
    member: { id: "pat", privilege_level: "member" },
    gateway: { url: "ws://127.0.0.1:18789" },
  };

  it("stores the minted token and keeps the shared gateway token out of settings", async () => {
    const host = makeHost({ memberEmail: "a@b.co", memberPassword: "pw" });
    const fetchSpy = routedFetch({
      "/auth/login": () => jsonResponse(200, loginBody),
      "/auth/device-token": () =>
        jsonResponse(200, { token: "device-tok", scopes: ["operator.read"] }),
    });

    await submitMemberAuth(host);

    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/auth/device-token"))).toBe(
      true,
    );
    expect(host.applySettings).toHaveBeenCalledWith(expect.objectContaining({ token: "" }));
    expect(host.connect).toHaveBeenCalled();
    const stored = JSON.parse(localStorage.getItem("openclaw.device.auth.v1") ?? "{}");
    expect(Object.values(stored.tokens ?? {})).toContainEqual(
      expect.objectContaining({ token: "device-tok", scopes: ["operator.read"] }),
    );
  });

  it("fails closed when the service cannot mint a device token", async () => {
    const host = makeHost({ memberEmail: "a@b.co", memberPassword: "pw" });
    routedFetch({
      "/auth/login": () => jsonResponse(200, loginBody),
      "/auth/device-token": () => jsonResponse(501, { error: { message: "no shared secret" } }),
    });

    await submitMemberAuth(host);

    expect(host.applySettings).not.toHaveBeenCalled();
    expect(host.connect).not.toHaveBeenCalled();
    expect(host.memberFormError).toContain("device credential");
  });

  it("signing out clears the device's gateway token", async () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "2026-08-01T00:00:00Z" });
    const host = makeHost();
    routedFetch({
      "/auth/session": () =>
        jsonResponse(200, {
          expires_at: "2026-08-01T00:00:00Z",
          member: { id: "pat", privilege_level: "member" },
          gateway: { url: "ws://127.0.0.1:18789" },
        }),
      "/auth/device-token": () =>
        jsonResponse(200, { token: "device-tok", scopes: ["operator.read"] }),
      "/auth/logout": () => jsonResponse(200, {}),
    });

    await resumeMemberSession(host);
    const afterResume = JSON.parse(localStorage.getItem("openclaw.device.auth.v1") ?? "{}");
    expect(JSON.stringify(afterResume)).toContain("device-tok");

    await signOutMember(host);
    const afterSignOut = JSON.parse(localStorage.getItem("openclaw.device.auth.v1") ?? "{}");
    expect(JSON.stringify(afterSignOut)).not.toContain("device-tok");
  });
});

// A connect the gateway refuses for want of an acceptable credential — the device token was
// rejected (rotated shared secret, device no longer paired, revoked token) or none was ever minted
// — must not strand a signed-in member. Recovery re-mints the device credential and fails closed
// when minting is unavailable, so a browser is never handed the shared gateway secret.
describe("recoverFromRejectedDeviceToken", () => {
  it("re-mints the device token rather than handing the member the shared secret", async () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "2026-08-01T00:00:00Z" });
    const host = makeHost();
    let mintedTokens = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/auth/session")) {
        return jsonResponse(200, {
          expires_at: "2026-08-01T00:00:00Z",
          member: { id: "pat", privilege_level: "member" },
          gateway: { url: "ws://127.0.0.1:18789" },
        });
      }
      if (url.includes("/auth/device-token")) {
        mintedTokens += 1;
        return jsonResponse(200, {
          token: `device-tok-${mintedTokens}`,
          scopes: ["operator.read"],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await resumeMemberSession(host);
    expect(localStorage.getItem("openclaw.device.auth.v1")).toContain("device-tok-1");

    const recovered = await recoverFromRejectedDeviceToken(host);

    expect(recovered).toBe(true);
    // The rejected token is gone and a fresh one took its place, so the reconnect authenticates as
    // the device with settings.token left empty.
    expect(localStorage.getItem("openclaw.device.auth.v1")).toContain("device-tok-2");
    expect(host.applySettings).toHaveBeenLastCalledWith(expect.objectContaining({ token: "" }));
  });

  it("fails closed when the service cannot mint a replacement", async () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "2026-08-01T00:00:00Z" });
    const host = makeHost();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/auth/device-token")) {
        return jsonResponse(503, { error: { message: "device token issuance is not configured" } });
      }
      return jsonResponse(200, {
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", privilege_level: "member" },
        gateway: { url: "ws://127.0.0.1:18789" },
      });
    });

    expect(await recoverFromRejectedDeviceToken(host)).toBe(false);
    expect(host.applySettings).not.toHaveBeenCalled();
  });

  it("declines when no member is signed in", async () => {
    const host = makeHost();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await recoverFromRejectedDeviceToken(host)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("declines when neither a mint nor a shared gateway token is available", async () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "2026-08-01T00:00:00Z" });
    const host = makeHost();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/auth/device-token")) {
        return jsonResponse(503, { error: { message: "device token issuance is not configured" } });
      }
      return jsonResponse(200, {
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", privilege_level: "member" },
      });
    });
    expect(await recoverFromRejectedDeviceToken(host)).toBe(false);
  });
});

describe("toggleOnboardingStep", () => {
  it("saves the step over the member session and refreshes the checklist from the response", async () => {
    saveStoredMemberSession({ sessionToken: "sess-tok", expiresAt: "later" });
    const refreshed = {
      steps: [{ id: "linkedin", status: "complete", label: "Connect on LinkedIn" }],
      completed: [],
      remaining: [],
    };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { id: "pat", onboarding: refreshed }));
    const host = makeHost({ memberId: "pat" });

    await toggleOnboardingStep(host, "linkedin", true);

    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/lab/members/pat/onboarding/linkedin`);
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({ complete: true });
    expect(host.adminBotOnboarding).toEqual(refreshed);
    expect(host.adminBotOnboardingBusyStepId).toBeNull();
    expect(host.adminBotOnboardingError).toBeNull();
  });

  it("does nothing without a stored session", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const host = makeHost({ memberId: "pat" });

    await toggleOnboardingStep(host, "linkedin", true);

    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the old checklist and surfaces an error when the save fails", async () => {
    saveStoredMemberSession({ sessionToken: "sess-tok", expiresAt: "later" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(403, { error: { message: "insufficient privileges" } }),
    );
    const before = { steps: [], completed: [], remaining: [] };
    const host = makeHost({ memberId: "pat", adminBotOnboarding: before });

    await toggleOnboardingStep(host, "linkedin", true);

    expect(host.adminBotOnboarding).toBe(before);
    expect(host.adminBotOnboardingError).toContain("sign in again");
    expect(host.adminBotOnboardingBusyStepId).toBeNull();
  });
});

describe("device-token recovery latch", () => {
  // A stale device token rejected before sign-in cannot recover: recoverFromRejectedDeviceToken
  // needs a member session and returns false without one. It still sets the once-per-session latch,
  // so the very next connect — the one right after logging in — refused to try again, and the
  // member saw "Auth did not match / device token mismatch" until they reloaded the page.
  it("re-arms recovery when a member signs in", async () => {
    const host = makeHost({ memberEmail: "a@b.co", memberPassword: "pw" });
    host.deviceTokenRecoveryAttempted = true;
    mockLoginAndDevice({
      session_token: "sess",
      expires_at: "2026-08-01T00:00:00Z",
      member: { id: "pat", privilege_level: "member" },
      gateway: { url: "ws://127.0.0.1:18789" },
    });

    await submitMemberAuth(host);

    expect(host.deviceTokenRecoveryAttempted).toBe(false);
    expect(host.connect).toHaveBeenCalled();
  });
});
