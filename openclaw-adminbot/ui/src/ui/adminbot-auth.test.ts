// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  changeMemberEmail,
  claimMember,
  clearStoredMemberSession,
  fetchMemberSession,
  fetchRelevantPapers,
  fetchRoster,
  hasSeenOnboardingWelcome,
  loadStoredMemberSession,
  loginMember,
  markOnboardingWelcomeSeen,
  resolveAdminBotBaseUrl,
  saveStoredMemberSession,
  signupMember,
  updateOwnProfile,
} from "./adminbot-auth.ts";

const BASE_URL = "http://127.0.0.1:8765";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("location", { hostname: "127.0.0.1" } as Location);
});

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => {
  clearStoredMemberSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveAdminBotBaseUrl", () => {
  it("prefers the settings override and trims trailing slashes", () => {
    expect(resolveAdminBotBaseUrl({ adminBotUrl: "http://lab.example:9000/" })).toBe(
      "http://lab.example:9000",
    );
  });

  it("defaults to the current hostname on port 8765", () => {
    expect(resolveAdminBotBaseUrl(null)).toBe(`http://${location.hostname}:8765`);
  });

  it("defaults to the TLS AdminBot port on https pages", () => {
    vi.stubGlobal("location", {
      hostname: "aurora-adminbot.example.ts.net",
      protocol: "https:",
    } as Location);
    expect(resolveAdminBotBaseUrl(null)).toBe("https://aurora-adminbot.example.ts.net:8443");
  });
});

describe("loginMember / claimMember error mapping", () => {
  it("returns the session payload on success", async () => {
    const session = {
      session_token: "sess",
      expires_at: "2026-08-01T00:00:00Z",
      member: { privilege_level: "member" },
      gateway: { url: "ws://127.0.0.1:18789", token: "gw" },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, session));
    const result = await loginMember("a@b.co", "pw", BASE_URL);
    expect(result).toEqual({ ok: true, value: session });
  });

  it("maps 401 to auth-failed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(401, { error: "nope" }));
    const result = await loginMember("a@b.co", "pw", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "auth-failed" });
  });

  it("maps 429 to rate-limited with retry seconds from the body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(429, { error: "slow down", retry_after_seconds: 30 }),
    );
    const result = await loginMember("a@b.co", "pw", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "rate-limited", retryAfterSeconds: 30 });
  });

  it("maps login 403 pending_approval to pending-approval", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(403, { error: "not yet", code: "pending_approval" }),
    );
    const result = await loginMember("a@b.co", "pw", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "pending-approval" });
  });

  it("sends member_id and returns no session on a successful claim", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { status: "pending" }));
    const result = await claimMember("member-7", "a@b.co", "longenoughpw", BASE_URL);
    expect(result).toEqual({ ok: true, value: undefined });
    const init = spy.mock.calls[0]?.[1];
    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/auth/claim`);
    expect(JSON.parse(String(init?.body))).toEqual({
      member_id: "member-7",
      email: "a@b.co",
      password: "longenoughpw",
    });
  });

  it("maps claim 400 to weak-password", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(400, { error: "weak" }));
    const result = await claimMember("member-1", "a@b.co", "short", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "weak-password" });
  });

  it("maps claim 403 to auth-failed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(403, {}));
    const result = await claimMember("member-1", "a@b.co", "longenoughpw", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "auth-failed" });
  });

  it("posts a profile envelope and returns no session on a successful signup", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { status: "pending" }));
    const result = await signupMember(
      { name: "Ada Lovelace", affiliation: "Analytical Engine", research_topics: ["compilers"] },
      "ada@b.co",
      "longenoughpw",
      BASE_URL,
    );
    expect(result).toEqual({ ok: true, value: undefined });
    const init = spy.mock.calls[0]?.[1];
    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/auth/signup`);
    expect(JSON.parse(String(init?.body))).toEqual({
      profile: {
        name: "Ada Lovelace",
        affiliation: "Analytical Engine",
        research_topics: ["compilers"],
      },
      email: "ada@b.co",
      password: "longenoughpw",
    });
  });

  it("maps signup 400 to weak-password", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(400, { error: "weak" }));
    const result = await signupMember({ name: "Ada" }, "ada@b.co", "short", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "weak-password" });
  });

  it("maps a network error to unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("failed to fetch"));
    const result = await loginMember("a@b.co", "pw", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "unreachable" });
  });

  it("sends Bearer-only session requests and returns session info", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { expires_at: "x", member: {}, gateway: { url: "u", token: "t" } }),
      );
    const result = await fetchMemberSession("token-123", BASE_URL);
    expect(result.ok).toBe(true);
    const init = spy.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("omit");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-123");
  });
});

describe("fetchRoster", () => {
  it("returns the unclaimed member list on success", async () => {
    const members = [
      { id: "m1", name: "Ada Lovelace" },
      { id: "m2", name: "Alan Turing" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { members }));
    const result = await fetchRoster(BASE_URL);
    expect(result).toEqual({ ok: true, value: members });
  });

  it("defaults to an empty list when members are absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, {}));
    const result = await fetchRoster(BASE_URL);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("maps a network error to unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("failed to fetch"));
    const result = await fetchRoster(BASE_URL);
    expect(result).toEqual({ ok: false, kind: "unreachable" });
  });

  it("maps a 429 to rate-limited with retry seconds", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(429, { retry_after_seconds: 15 }));
    const result = await fetchRoster(BASE_URL);
    expect(result).toEqual({ ok: false, kind: "rate-limited", retryAfterSeconds: 15 });
  });
});

describe("updateOwnProfile", () => {
  it("PUTs whitelisted fields to the member route with a Bearer session", async () => {
    const updated = { id: "member-7", name: "Ada", privilege_level: "member" };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));
    const result = await updateOwnProfile(
      "member-7",
      {
        name: "Ada",
        research_topics: ["compilers", "engines"],
        hours_per_week: 20,
      },
      "sess-tok",
      BASE_URL,
    );
    expect(result).toEqual({ ok: true, value: updated });
    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/lab/members/member-7`);
    const init = spy.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(init?.credentials).toBe("omit");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sess-tok");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      name: "Ada",
      research_topics: ["compilers", "engines"],
      hours_per_week: 20,
    });
    // The self-edit form must never send governance-owned fields.
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("privilege_level");
    expect(body).not.toHaveProperty("status");
  });

  it("maps a network error to unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("failed to fetch"));
    const result = await updateOwnProfile("m1", { name: "x" }, "tok", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "unreachable" });
  });
});

describe("changeMemberEmail", () => {
  it("POSTs the new email + current password and returns the updated email", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { email: "new@lab.co" }));
    const result = await changeMemberEmail("new@lab.co", "pw", "sess", BASE_URL);
    expect(result).toEqual({ ok: true, value: { email: "new@lab.co" } });
    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/auth/email`);
    const init = spy.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      new_email: "new@lab.co",
      current_password: "pw",
    });
  });

  it("maps 401 to auth-failed (wrong password)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(401, { error: "nope" }));
    const result = await changeMemberEmail("new@lab.co", "bad", "sess", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "auth-failed" });
  });

  it("maps 409 to email-unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, { error: { message: "email unavailable" } }),
    );
    const result = await changeMemberEmail("taken@lab.co", "pw", "sess", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "email-unavailable" });
  });

  it("maps 429 to rate-limited with retry seconds", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(429, { retry_after_seconds: 12 }));
    const result = await changeMemberEmail("new@lab.co", "pw", "sess", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "rate-limited", retryAfterSeconds: 12 });
  });
});

describe("fetchRelevantPapers", () => {
  it("returns the papers list with a Bearer session", async () => {
    const papers = [{ id: "p1", title: "Causal Systems", current_step: "submission" }];
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { papers }));
    const result = await fetchRelevantPapers("sess", BASE_URL);
    expect(result).toEqual({ ok: true, value: papers });
    const init = spy.mock.calls[0]?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sess");
  });

  it("defaults to an empty list when papers are absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, {}));
    const result = await fetchRelevantPapers("sess", BASE_URL);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("maps a 401 to auth-failed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(401, {}));
    const result = await fetchRelevantPapers("sess", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "auth-failed" });
  });
});

describe("stored member session", () => {
  it("persists only the session token and expiry (never the gateway token)", () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "later" });
    const raw = localStorage.getItem("openclaw.adminbot.session.v1") ?? "";
    expect(raw).not.toContain("gateway");
    expect(loadStoredMemberSession()).toEqual({ sessionToken: "sess", expiresAt: "later" });
  });

  it("clears the stored session", () => {
    saveStoredMemberSession({ sessionToken: "sess", expiresAt: "later" });
    clearStoredMemberSession();
    expect(loadStoredMemberSession()).toBeNull();
  });
});

describe("onboarding welcome dismissal tracking", () => {
  it("is unseen by default, then seen after marking, scoped per member id", () => {
    expect(hasSeenOnboardingWelcome("pat")).toBe(false);
    markOnboardingWelcomeSeen("pat");
    expect(hasSeenOnboardingWelcome("pat")).toBe(true);
    expect(hasSeenOnboardingWelcome("other")).toBe(false);
  });

  it("marking multiple members preserves earlier entries", () => {
    markOnboardingWelcomeSeen("a");
    markOnboardingWelcomeSeen("b");
    expect(hasSeenOnboardingWelcome("a")).toBe(true);
    expect(hasSeenOnboardingWelcome("b")).toBe(true);
  });
});
