// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import {
  changeMemberEmail,
  claimMember,
  loginMember,
  issueDeviceToken,
  pairDevice,
  signupMember,
} from "../api/auth.ts";
import { resolveEmailReviewAsAdmin } from "../api/email-review.ts";
import { updateOwnProfile } from "../api/members.ts";
import { fetchMemberSheet, nudgeOnboardingStep, setOnboardingStep } from "../api/onboarding.ts";
import { enqueueAdminBotMutation, resetAdminBotOfflineMemory } from "../offline/outbox.ts";
import {
  flushOfflineReads,
  offlineReadStoreStats,
  readOfflineRead,
} from "../offline/read-store.ts";
import { resolveOfflineScope } from "./offline-reads.ts";
import { forgetSessionReads } from "./read-cache.ts";
import {
  clearStoredMemberSession,
  fetchMemberSession,
  fetchMemberResource,
  fetchRelevantPapers,
  fetchRoster,
  flushQueuedAdminBotWrites,
  hasAcknowledgedOnboardingChecklist,
  loadStoredMemberSession,
  logoutMember,
  markOnboardingChecklistAcknowledged,
  pendingQueuedAdminBotWriteCount,
  resolveAdminBotBaseUrl,
  saveStoredMemberSession,
} from "./session.ts";

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

  it("maps 404 to not-found rather than auth-failed", async () => {
    // A missing route is version skew, not a credentials problem. This used to fall through to
    // auth-failed, which sent people to check a login that was working fine while the real cause
    // was a service running older code than the console.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, { error: "not found" }));
    const result = await loginMember("a@b.co", "pw", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "not-found" });
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

  it("sends a search query without credentials", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { members: [] }));
    await fetchRoster(BASE_URL, "Ada Δ");
    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/auth/roster?q=Ada%20%CE%94`);
    expect(spy.mock.calls[0]?.[1]?.credentials).toBe("omit");
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

describe("fetchMemberSheet", () => {
  it("returns the grid the service read", async () => {
    const view = { spreadsheet_id: "1ZqdaRze", tab: "Full Slack Member List", rows: [] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, view));
    expect(await fetchMemberSheet("session-token", BASE_URL)).toEqual({ ok: true, value: view });
  });

  it("reports a bare 404 as a service that predates the route, not a missing sheet", async () => {
    // The Control UI ships from Vercel and the service from Aurora, so the UI is routinely ahead.
    // "not found" here is the catch-all for an unrouted path, and reading it as a missing
    // spreadsheet sent people looking at Google for a deployment problem.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { error: { message: "not found" } }),
    );
    const result = await fetchMemberSheet("session-token", BASE_URL);
    expect(result).toMatchObject({ ok: false, kind: "not-found" });
    expect((result as { message?: string }).message).toContain("needs a deploy");
  });

  it("carries the service's own sentence when it has one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(502, {
        error: { message: 'the spreadsheet has no tab named "Full Slack Member List"' },
      }),
    );
    const result = await fetchMemberSheet("session-token", BASE_URL);
    expect((result as { message?: string }).message).toContain("no tab named");
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

  it("shares a read in flight and revalidates the next one by ETag", async () => {
    const papers = [{ id: "p1", title: "Causal Systems", current_step: "submission" }];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { papers }, { ETag: '"papers-1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const [first, second] = await Promise.all([
      fetchRelevantPapers("sess-shared", BASE_URL),
      fetchRelevantPapers("sess-shared", BASE_URL),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ ok: true, value: papers });
    expect(second).toEqual({ ok: true, value: papers });

    const third = await fetchRelevantPapers("sess-shared", BASE_URL);
    expect(spy).toHaveBeenCalledTimes(2);
    const headers = (spy.mock.calls[1]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["If-None-Match"]).toBe('"papers-1"');
    expect(third).toEqual({ ok: true, value: papers });
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

describe("onboarding checklist acknowledgement tracking", () => {
  it("is unacknowledged by default, then acknowledged after marking, scoped per member id", () => {
    expect(hasAcknowledgedOnboardingChecklist("pat")).toBe(false);
    markOnboardingChecklistAcknowledged("pat");
    expect(hasAcknowledgedOnboardingChecklist("pat")).toBe(true);
    expect(hasAcknowledgedOnboardingChecklist("other")).toBe(false);
  });

  it("marking multiple members preserves earlier entries", () => {
    markOnboardingChecklistAcknowledged("a");
    markOnboardingChecklistAcknowledged("b");
    expect(hasAcknowledgedOnboardingChecklist("a")).toBe(true);
    expect(hasAcknowledgedOnboardingChecklist("b")).toBe(true);
  });
});

describe("pairDevice", () => {
  it("POSTs the requestId with the member Bearer and returns granted scopes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { approved: true, scopes: ["operator.read"] }));

    const result = await pairDevice("req-1", "sess-tok", BASE_URL);

    expect(result).toEqual({ ok: true, value: { scopes: ["operator.read"] } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/auth/pair-device");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer sess-tok" }),
    });
    expect(JSON.parse(init!.body as string)).toEqual({ requestId: "req-1" });
  });

  it("maps 403 to forbidden", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(403, { error: "nope" }));
    const result = await pairDevice("req-2", "sess-tok", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "forbidden" });
  });

  it("maps a network failure to unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("failed to fetch"));
    const result = await pairDevice("req-3", "sess-tok", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "unreachable" });
  });
});

describe("issueDeviceToken", () => {
  it("POSTs the device key with the member Bearer and returns the minted token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { token: "dev-tok", scopes: ["operator.read"] }));

    const result = await issueDeviceToken(
      { deviceId: "dev-1", publicKey: "pk-1", platform: "Win32" },
      "sess-tok",
      BASE_URL,
    );

    expect(result).toEqual({ ok: true, value: { token: "dev-tok", scopes: ["operator.read"] } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/auth/device-token");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer sess-tok" }),
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      deviceId: "dev-1",
      publicKey: "pk-1",
      platform: "Win32",
    });
  });

  it("fails when the service answers without a token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { scopes: [] }));
    const result = await issueDeviceToken({ deviceId: "d", publicKey: "p" }, "sess-tok", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "auth-failed" });
  });

  it("maps a network failure to unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("failed to fetch"));
    const result = await issueDeviceToken({ deviceId: "d", publicKey: "p" }, "sess-tok", BASE_URL);
    expect(result).toEqual({ ok: false, kind: "unreachable" });
  });
});

describe("onboarding step completion", () => {
  it("POSTs the completion flag to the member's step route with a Bearer session", async () => {
    const updated = { id: "member-7", name: "Ada", privilege_level: "member" };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, updated));

    const result = await setOnboardingStep("member-7", "linkedin", true, "sess-tok", BASE_URL);

    expect(result).toEqual({ ok: true, value: updated });
    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/lab/members/member-7/onboarding/linkedin`);
    const init = spy.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sess-tok");
    expect(JSON.parse(String(init?.body))).toEqual({ complete: true });
  });

  it("maps a lost-privilege response to forbidden rather than a generic auth failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(403, { error: { message: "insufficient privileges" } }),
    );

    await expect(
      setOnboardingStep("someone-else", "linkedin", true, "sess-tok", BASE_URL),
    ).resolves.toEqual({ ok: false, kind: "forbidden" });
  });
});

describe("onboarding step nudge", () => {
  it("POSTs the channel to the step's nudge route", async () => {
    const value = { created: [{ id: "act_1" }], skipped: [] };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, value));

    const result = await nudgeOnboardingStep("linkedin", "slack", "sess-tok", BASE_URL);

    expect(result).toEqual({ ok: true, value });
    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/onboarding/linkedin/nudge`);
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({ channel: "slack" });
  });

  it("passes an override message through when one is given", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { created: [], skipped: [] }));

    await nudgeOnboardingStep("linkedin", "email", "sess-tok", BASE_URL, "Please join us.");

    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({
      channel: "email",
      message: "Please join us.",
    });
  });
});

describe("offline GET cache and mutation outbox", () => {
  // Disk writes and wipes are fire-and-forget; let them land before looking.
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushOfflineReads();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  async function stored(token: string, path: string) {
    const scope = await resolveOfflineScope(BASE_URL, token);
    return scope ? await readOfflineRead(scope, path) : undefined;
  }

  it("returns the member's own last profile only to the same session", async () => {
    await resetAdminBotOfflineMemory();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { member: { id: "ada" } }));
    await fetchMemberResource("/lab/members/self", "ada-session", BASE_URL);
    fetchMock.mockRejectedValue(new Error("offline"));

    await expect(
      fetchMemberResource("/lab/members/self", "ada-session", BASE_URL),
    ).resolves.toEqual({ ok: true, value: { member: { id: "ada" } }, cached: true });
    await expect(
      fetchMemberResource("/lab/members/self", "mei-session", BASE_URL),
    ).resolves.toEqual({ ok: false, kind: "unreachable" });
  });

  it("never writes the roster or admin-only reads to disk", async () => {
    await resetAdminBotOfflineMemory();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, { secret: "admin-only" }, { ETag: 'W/"a"' }));
    for (const path of ["/lab/members", "/sensitive-info", "/logistics/requests", "/papers"]) {
      await fetchMemberResource(path, "admin-session", BASE_URL);
    }
    await settle();
    for (const path of ["/lab/members", "/sensitive-info", "/logistics/requests", "/papers"]) {
      await expect(stored("admin-session", path)).resolves.toBeUndefined();
    }
    expect(offlineReadStoreStats().puts).toBe(0);
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(fetchMemberResource("/lab/members", "admin-session", BASE_URL)).resolves.toEqual({
      ok: false,
      kind: "unreachable",
    });
  });

  it("uses cached reads during a service outage but never for authorization failures", async () => {
    await resetAdminBotOfflineMemory();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { member: {} }));
    await fetchMemberResource("/lab/members/self", "synthetic", BASE_URL);
    fetcher.mockImplementation(async () => jsonResponse(503, {}));
    await expect(
      fetchMemberResource("/lab/members/self", "synthetic", BASE_URL),
    ).resolves.toMatchObject({ ok: true, cached: true });
    for (const code of [401, 403]) {
      fetcher.mockImplementation(async () => jsonResponse(code, {}));
      await expect(
        fetchMemberResource("/lab/members/self", "synthetic", BASE_URL),
      ).resolves.toMatchObject({ ok: false });
    }
  });

  it("wipes the stored copy on a 401", async () => {
    await resetAdminBotOfflineMemory();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { member: {} }));
    await fetchMemberResource("/lab/members/self", "synthetic", BASE_URL);
    await settle();
    await expect(stored("synthetic", "/lab/members/self")).resolves.toBeDefined();
    fetcher.mockResolvedValue(jsonResponse(401, {}));
    await fetchMemberResource("/papers", "synthetic", BASE_URL);
    await settle();
    await expect(stored("synthetic", "/lab/members/self")).resolves.toBeUndefined();
  });

  it("wipes the stored copies at sign-out", async () => {
    await resetAdminBotOfflineMemory();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { member: {} }));
    saveStoredMemberSession({ sessionToken: "ada-session", expiresAt: "" });
    await fetchMemberResource("/lab/members/self", "ada-session", BASE_URL);
    await settle();
    await expect(stored("ada-session", "/lab/members/self")).resolves.toBeDefined();
    clearStoredMemberSession();
    await settle();
    await expect(stored("ada-session", "/lab/members/self")).resolves.toBeUndefined();
  });

  it("wipes at View-as start and keeps nothing of the viewed member", async () => {
    await resetAdminBotOfflineMemory();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { member: {} }, { ETag: 'W/"v"' }));
    saveStoredMemberSession({ sessionToken: "admin-session", expiresAt: "" });
    await fetchMemberResource("/lab/members/self", "admin-session", BASE_URL);
    await settle();
    await expect(stored("admin-session", "/lab/members/self")).resolves.toBeDefined();
    const impersonator = { sessionToken: "admin-session", expiresAt: "" };
    saveStoredMemberSession({ sessionToken: "viewed-session", expiresAt: "", impersonator });
    await fetchMemberResource("/lab/members/self", "viewed-session", BASE_URL);
    await settle();
    await expect(stored("admin-session", "/lab/members/self")).resolves.toBeUndefined();
    await expect(stored("viewed-session", "/lab/members/self")).resolves.toBeUndefined();
    // And at View-as stop: back on the admin's token, nothing of the viewed member survives.
    saveStoredMemberSession({ sessionToken: "admin-session", expiresAt: "" });
    fetcher.mockRejectedValue(new Error("offline"));
    await expect(
      fetchMemberResource("/lab/members/self", "viewed-session", BASE_URL),
    ).resolves.toEqual({ ok: false, kind: "unreachable" });
  });

  it("revalidates against the disk copy after a page refresh and writes nothing on a 304", async () => {
    await resetAdminBotOfflineMemory();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { papers: ["mine"] }, { ETag: 'W/"m1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: 'W/"m1"' } }));
    await fetchMemberResource("/papers?scope=mine", "ada-session", BASE_URL);
    await settle();
    const writesAfterFirst = offlineReadStoreStats();
    forgetSessionReads(); // what a page refresh does to the in-memory copies
    const second = await fetchMemberResource("/papers?scope=mine", "ada-session", BASE_URL);
    const headers = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBe('W/"m1"');
    expect(second).toEqual({ ok: true, value: { papers: ["mine"] } });
    await settle();
    expect(offlineReadStoreStats()).toEqual(writesAfterFirst);
  });

  it("does not queue or replay failed profile writes after reconnect", async () => {
    await resetAdminBotOfflineMemory();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    await updateOwnProfile("ada", { name: "Ada" }, "ada-session", BASE_URL);
    await expect(pendingQueuedAdminBotWriteCount("ada-session", BASE_URL)).resolves.toBe(0);
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await fetchMemberResource("/prime", "ada-session", BASE_URL);
    fetchMock.mockClear();
    await expect(flushQueuedAdminBotWrites()).resolves.toEqual({ flushed: 0, remaining: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains legacy approval entries without replaying them", async () => {
    await resetAdminBotOfflineMemory();
    const token = "synthetic-legacy-session";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const principalKey = [...new Uint8Array(digest)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    await enqueueAdminBotMutation(
      { baseUrl: BASE_URL, principalKey },
      {
        method: "POST",
        path: "/proposals/synthetic/approve",
        payload: { hash: "synthetic" },
      },
    );
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, {}));
    await fetchMemberResource("/prime", token, BASE_URL);
    fetcher.mockClear();
    await expect(flushQueuedAdminBotWrites()).resolves.toEqual({ flushed: 0, remaining: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("clears replay credentials when the member logs out", async () => {
    await resetAdminBotOfflineMemory();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    await updateOwnProfile("ada", { name: "Ada" }, "ada-session", BASE_URL);
    fetchMock.mockResolvedValue(jsonResponse(200, { logged_out: true }));

    await logoutMember("ada-session", BASE_URL);
    fetchMock.mockClear();

    await expect(flushQueuedAdminBotWrites()).resolves.toEqual({ flushed: 0, remaining: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("revalidated GET reads", () => {
  function ifNoneMatch(call: unknown[] | undefined): string | undefined {
    const headers = (call?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    return headers?.["If-None-Match"];
  }

  it("sends the last tag back and reuses the kept body on a 304", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { papers: [{ id: "p1" }] }, { ETag: 'W/"v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: 'W/"v1"' } }));

    const first = await fetchMemberResource("/papers", "ada-session", BASE_URL);
    expect(ifNoneMatch(fetchMock.mock.calls[0])).toBeUndefined();
    const second = await fetchMemberResource("/papers", "ada-session", BASE_URL);
    expect(ifNoneMatch(fetchMock.mock.calls[1])).toBe('W/"v1"');
    expect(second).toEqual({ ok: true, value: { papers: [{ id: "p1" }] } });
    // A fresh parse: an in-place edit of the first copy must not come back on the next read.
    expect((second as { value: unknown }).value).not.toBe((first as { value: unknown }).value);
  });

  it("never offers one session's tag to another session", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { settings: "admin" }, { ETag: 'W/"admin"' }))
      .mockResolvedValueOnce(jsonResponse(403, {}));
    await fetchMemberResource("/settings", "admin-session", BASE_URL);
    await fetchMemberResource("/settings", "member-session", BASE_URL);
    expect(ifNoneMatch(fetchMock.mock.calls[1])).toBeUndefined();
  });

  it("forgets kept bodies when the stored session changes or is cleared", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, { ok: true }, { ETag: 'W/"t"' }));
    saveStoredMemberSession({ sessionToken: "ada-session", expiresAt: "" });
    await fetchMemberResource("/lab/members/self", "ada-session", BASE_URL);
    // View-as swaps the token and parks the admin's; back again is a second swap.
    saveStoredMemberSession({ sessionToken: "viewed-session", expiresAt: "" });
    saveStoredMemberSession({ sessionToken: "ada-session", expiresAt: "" });
    await fetchMemberResource("/lab/members/self", "ada-session", BASE_URL);
    expect(ifNoneMatch(fetchMock.mock.calls[1])).toBeUndefined();

    await fetchMemberResource("/lab/members/self", "ada-session", BASE_URL);
    expect(ifNoneMatch(fetchMock.mock.calls[2])).toBe('W/"t"');
    clearStoredMemberSession();
    await fetchMemberResource("/lab/members/self", "ada-session", BASE_URL);
    expect(ifNoneMatch(fetchMock.mock.calls[3])).toBeUndefined();
  });

  it("shares one request between concurrent reads of the same URL and session", async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const a = fetchMemberResource("/papers", "ada-session", BASE_URL);
    const b = fetchMemberResource("/papers", "ada-session", BASE_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(jsonResponse(200, { papers: [] }));
    await expect(a).resolves.toEqual({ ok: true, value: { papers: [] } });
    await expect(b).resolves.toEqual({ ok: true, value: { papers: [] } });
  });

  it("does not let a read after a write join a read from before it", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, init) =>
        init?.method === "GET"
          ? new Promise<Response>((resolve) => pending.push(resolve))
          : Promise.resolve(jsonResponse(200, { ok: true })),
      );
    const before = fetchMemberResource("/lab/members/self", "ada-session", BASE_URL);
    await updateOwnProfile("ada", { name: "Ada" }, "ada-session", BASE_URL);
    const after = fetchMemberResource("/lab/members/self", "ada-session", BASE_URL);
    // An own read on a cold memory cache looks at its disk copy before going out.
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(2),
    );
    pending.forEach((resolve, index) => resolve(jsonResponse(200, { n: index })));
    await expect(before).resolves.toEqual({ ok: true, value: { n: 0 } });
    await expect(after).resolves.toEqual({ ok: true, value: { n: 1 } });
  });
});

describe("email review resolution", () => {
  it("posts the administrator's exact paper and stage decision", async () => {
    const value = { resolution: "paperflow_evidence", evidence_recorded: true };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, value));

    const result = await resolveEmailReviewAsAdmin(
      "gmail/message-1",
      { kind: "paperflow_evidence", paper_id: "paper-1", stage: "reviews_out" },
      "sess-tok",
      BASE_URL,
    );

    expect(result).toEqual({ ok: true, value });
    expect(spy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/automation/email/review/gmail%2Fmessage-1`);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer sess-tok" }),
    });
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({
      kind: "paperflow_evidence",
      paper_id: "paper-1",
      stage: "reviews_out",
    });
  });
});
