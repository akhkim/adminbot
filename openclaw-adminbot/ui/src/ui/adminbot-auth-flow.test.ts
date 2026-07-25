// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  type MemberAuthHost,
  loadMemberPrivilege,
  resumeMemberSession,
  signOutMember,
  submitMemberAuth,
} from "./adminbot-auth-flow.ts";
import { clearStoredMemberSession, saveStoredMemberSession } from "./adminbot-auth.ts";
import type { UiSettings } from "./storage.ts";

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
    memberCapacityPercent: "",
    memberLocation: "",
    memberTimezone: "",
    memberPersonalWebsite: "",
    memberNotes: "",
    memberPrivilegeLevel: null,
    memberId: null,
    applySettings: vi.fn(),
    connect: vi.fn(),
    ...overrides,
  };
}

describe("memberPrivilegeLevel wiring", () => {
  it("applyMemberSession persists privilege on signin success", async () => {
    const host = makeHost({ memberEmail: "a@b.co", memberPassword: "pw" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        session_token: "sess",
        expires_at: "2026-08-01T00:00:00Z",
        member: { id: "pat", privilege_level: "core_member" },
        gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
      }),
    );
    await submitMemberAuth(host);
    expect(host.memberPrivilegeLevel).toBe("core_member");
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
      memberCapacityPercent: "not-a-number",
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
