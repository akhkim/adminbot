// Control UI AdminBot controller tests cover explicit data-loading modes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { clearStoredMemberSession, saveStoredMemberSession } from "../auth/session.ts";
import {
  ADMINBOT_SERVICE_UNREACHABLE_MESSAGE,
  approveAdminBotAction,
  createEmptyAdminBotDashboardData,
  createEmptyAdminBotMemberList,
  createEmptyAdminBotMemberNudgeState,
  createEmptyAdminBotReimbursementState,
  loadAdminBot,
  loadAdminBotMemberList,
  loadAdminBotRoster,
  removePendingAdminBotAction,
  removeSelectedPendingAdminBotActions,
  sendAdminBotReimbursementMessage,
  saveAdminBotMember,
  saveAdminBotPaper,
  saveAdminBotOwnProfile,
  sendAdminBotMemberNudge,
  type AdminBotHost,
} from "./admin.js";

function createHost(outputs: Record<string, unknown>) {
  const calls: string[] = [];
  const host: AdminBotHost = {
    client: {
      request: async (_method: string, params: { name?: string }) => {
        const name = params.name ?? "";
        calls.push(name);
        return { ok: true, toolName: name, output: outputs[name] };
      },
    } as never,
    connected: true,
    adminBotLoading: false,
    adminBotError: null,
    adminBotData: createEmptyAdminBotDashboardData(),
    adminBotBusyActionId: null,
    adminBotSelectedActionIds: [],
    adminBotBulkActionBusy: false,
    adminBotNotice: null,
    adminBotPhotoPolishBusy: false,
    adminBotPhotoApplyBusy: false,
    adminBotReimbursement: createEmptyAdminBotReimbursementState(),
    adminBotMemberNudge: createEmptyAdminBotMemberNudgeState(),
    settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
  };
  return { host, calls };
}

describe("loadAdminBot", () => {
  it("keeps members and papers visible when an auxiliary admin tool is unavailable", async () => {
    const calls: string[] = [];
    const host: AdminBotHost = {
      client: {
        request: async (_method: string, params: { name?: string }) => {
          const name = params.name ?? "";
          calls.push(name);
          if (name === "adminbot_get_sensitive_info") {
            return {
              ok: false,
              toolName: name,
              error: { code: "not_found", message: `Tool not available: ${name}` },
            };
          }
          if (name === "adminbot_list_lab_members") {
            return { ok: true, toolName: name, output: { members: [{ id: "member-1" }] } };
          }
          if (name === "adminbot_list_papers") {
            return { ok: true, toolName: name, output: { papers: [{ id: "paper-1" }] } };
          }
          return { ok: true, toolName: name, output: {} };
        },
      } as never,
      connected: true,
      adminBotLoading: false,
      adminBotError: null,
      adminBotData: createEmptyAdminBotDashboardData(),
      adminBotBusyActionId: null,
      adminBotSelectedActionIds: [],
      adminBotBulkActionBusy: false,
      adminBotNotice: null,
      adminBotPhotoPolishBusy: false,
      adminBotPhotoApplyBusy: false,
      adminBotReimbursement: createEmptyAdminBotReimbursementState(),
      adminBotMemberNudge: createEmptyAdminBotMemberNudgeState(),
      settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
    };

    await loadAdminBot(host, "admin");

    expect(calls).toContain("adminbot_get_sensitive_info");
    expect(host.adminBotError).toBeNull();
    expect(host.adminBotData.members).toHaveLength(1);
    expect(host.adminBotData.papers).toHaveLength(1);
    expect(host.adminBotData.sensitiveInfo).toBeNull();
  });

  it("loads only member and paper records in general mode", async () => {
    const { host, calls } = createHost({
      adminbot_list_lab_members: {
        members: [
          {
            id: "zhijing",
            name: "Zhijing",
            privilege_level: "admin",
            access: [],
            created_at: "2026-06-01T00:00:00.000Z",
            updated_at: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
      adminbot_list_papers: {
        papers: [
          {
            id: "paper-1",
            title: "Causal Garden Planning",
            authors: ["alice"],
            current_step: "overleaf_writing",
            created_at: "2026-06-01T00:00:00.000Z",
            updated_at: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
    });

    await loadAdminBot(host, "general");

    expect(calls).toEqual(["adminbot_list_lab_members", "adminbot_list_papers"]);
    expect(host.adminBotData.members).toHaveLength(1);
    expect(host.adminBotData.papers).toHaveLength(1);
    expect(host.adminBotData.proposals).toEqual([]);
    expect(host.adminBotData.nudges).toEqual([]);
    expect(host.adminBotData.settings).toBeNull();
    expect(host.adminBotData.sensitiveInfo).toBeNull();
  });
});

describe("loadAdminBot gateway-only session boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["admin", "general"] as const)(
    "does not overwrite B after a delayed gateway-only %s load",
    async (mode) => {
      const { host } = createHost({});
      let finishMembers: ((response: unknown) => void) | undefined;
      host.client = {
        request: async (_method: string, params: { name?: string }) => {
          const name = params.name ?? "";
          if (name === "adminbot_list_lab_members") {
            return new Promise((resolve) => {
              finishMembers = resolve;
            });
          }
          return {
            ok: true,
            toolName: name,
            output: name === "adminbot_list_papers" ? { papers: [{ id: "a-paper" }] } : {},
          };
        },
      } as never;
      const loading = loadAdminBot(host, mode);
      if (mode === "admin") {
        saveStoredMemberSession({ sessionToken: "member-b", expiresAt: "later" });
      } else {
        host.client = { request: vi.fn() } as never;
      }
      host.adminBotData = {
        ...createEmptyAdminBotDashboardData(),
        members: [{ id: "b-member" } as never],
      };
      host.adminBotLoading = true;
      finishMembers?.({
        ok: true,
        toolName: "adminbot_list_lab_members",
        output: { members: [{ id: "a-member" }] },
      });
      await loading;
      expect(host.adminBotData.members.map((member) => member.id)).toEqual(["b-member"]);
      expect(host.adminBotLoading).toBe(true);
      expect(host.adminBotError).toBeNull();
    },
  );
});

// A signed-in member reads the dashboard over their own session. The gateway tool path needs
// operator.write, which a plain member's paired device does not hold, so leaving reads there left
// them with an empty dashboard -- and made their own saves look like they never persisted.
describe("loadAdminBot over the member session", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("requests only the selected roster page and preserves the server's filtered total", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    host.adminBotMemberList = createEmptyAdminBotMemberList();
    const fetchMock = routedFetch({
      "/lab/members?": () =>
        json({
          members: [{ id: "person-51", name: "Causal Researcher" }],
          total: 81,
          limit: 50,
          offset: 50,
        }),
    });

    await loadAdminBotMemberList(host, "causal", 50);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=50&offset=50&q=causal");
    expect(host.adminBotMemberList).toMatchObject({
      rows: [{ id: "person-51" }],
      total: 81,
      offset: 50,
      query: "causal",
      loading: false,
    });
  });

  it("discards a roster response after the session changes", async () => {
    saveStoredMemberSession({ sessionToken: "old-session", expiresAt: "later" });
    const { host } = createHost({});
    let resolveResponse: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const pending = loadAdminBotMemberList(host);
    clearStoredMemberSession();
    host.adminBotMemberList = createEmptyAdminBotMemberList();
    resolveResponse(json({ members: [{ id: "old-private" }], total: 1 }));
    await pending;
    expect(host.adminBotMemberList.rows).toEqual([]);
  });

  it("discards dashboard responses after the session changes", async () => {
    saveStoredMemberSession({ sessionToken: "old-session", expiresAt: "later" });
    const { host } = createHost({});
    let resolveMembers: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).includes("/lab/members")
        ? new Promise<Response>((resolve) => {
            resolveMembers = resolve;
          })
        : Promise.resolve(json({ papers: [] })),
    );
    const pending = loadAdminBot(host, "general");
    clearStoredMemberSession();
    host.adminBotData = createEmptyAdminBotDashboardData();
    resolveMembers(json({ member: { id: "old-private" } }));
    await pending;
    expect(host.adminBotData.members).toEqual([]);
  });

  it("keeps a failed roster page retryable with a useful error", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    routedFetch({ "/lab/members?": () => json({ error: { message: "temporary" } }, 503) });

    await loadAdminBotMemberList(host);

    expect(host.adminBotMemberList).toMatchObject({
      loading: false,
      loadedAt: null,
      error: "Could not load lab members. Please try again.",
    });
  });

  it("reads members and papers over HTTP instead of the gateway tool", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host, calls } = createHost({});
    const fetchMock = routedFetch({
      "/lab/members/self": () => json({ member: { id: "pat" } }),
      "/papers": () => json({ papers: [{ id: "paper-1" }] }),
    });

    await loadAdminBot(host, "general");

    expect(calls).toEqual([]);
    expect(host.adminBotData.members).toHaveLength(1);
    expect(host.adminBotData.papers).toHaveLength(1);
    expect(host.adminBotError).toBeNull();
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: "Bearer member-sess-tok" }),
      });
    }
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/lab/members?view=summary")),
    ).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/lab/members/self"))).toBe(
      true,
    );
  });

  it("opens a non-paper page without fetching papers, then loads them when requested", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    const fetchMock = routedFetch({
      "/lab/members/self": () => json({ member: { id: "pat" } }),
      "/papers": () => json({ papers: [{ id: "paper-1" }] }),
    });

    await loadAdminBot(host, "general", false);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:8765/lab/members/self",
    ]);
    expect(host.adminBotData.loadedAt).not.toBeNull();
    expect(host.adminBotData.papersLoadedAt).toBeNull();
    expect(host.adminBotError).toBeNull();

    host.adminBotRosterLoadedAt = 123;
    host.adminBotData.members = [{ id: "pat" }, { id: "lee" }] as never;
    host.adminBotMemberList = { ...createEmptyAdminBotMemberList(), loadedAt: 456 };
    await loadAdminBot(host, "general", true, true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/papers"))).toHaveLength(1);
    expect(host.adminBotData.papers.map((paper) => paper.id)).toEqual(["paper-1"]);
    expect(host.adminBotData.papersLoadedAt).not.toBeNull();
    expect(host.adminBotData.members.map((member) => member.id).toSorted()).toEqual(["lee", "pat"]);
    expect(host.adminBotRosterLoadedAt).toBe(123);
    expect(host.adminBotMemberList?.loadedAt).toBe(456);
  });

  it("makes the own profile available before a slow paper read completes", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    host.memberId = "pat";
    host.requestUpdate = vi.fn();
    let resolvePapers: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/lab/members/self")) {
        return Promise.resolve(json({ member: { id: "pat", name: "Pat" } }));
      }
      if (url.includes("/papers")) {
        return new Promise<Response>((resolve) => {
          resolvePapers = resolve;
        });
      }
      return Promise.resolve(json({}));
    });

    const pending = loadAdminBot(host, "general");
    await vi.waitFor(() => expect(host.adminBotData.members[0]?.id).toBe("pat"));
    expect(host.adminBotData.loadedAt).toBeNull();
    expect(host.adminBotLoading).toBe(true);
    expect(host.requestUpdate).toHaveBeenCalled();

    resolvePapers(json({ papers: [{ id: "paper-1" }] }));
    await pending;
    expect(host.adminBotData.papers[0]?.id).toBe("paper-1");
    expect(host.adminBotData.loadedAt).not.toBeNull();
  });

  it("uses the legacy roster only when the self route is absent during rollout", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    host.memberId = "pat";
    const fetchMock = routedFetch({
      "/lab/members/self": () => json({ error: { message: "not found" } }, 404),
      "/lab/members": () =>
        json({
          members: [
            { id: "pat", name: "Pat" },
            { id: "lee", name: "Lee" },
          ],
        }),
      "/papers": () => json({ papers: [] }),
    });
    await loadAdminBot(host, "general");
    expect(host.adminBotData.members).toEqual([{ id: "pat", name: "Pat" }]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/lab/members"))).toBe(true);
  });

  it("loads the full signed-in profile first, then compact peers only on demand", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    routedFetch({
      "/lab/members/self": () =>
        json({ member: { id: "pat", name: "Pat", milestones: [{ id: "deadline-1" }] } }),
      "/lab/members?view=summary": () =>
        json({
          members: [
            { id: "pat", name: "Pat", onboarding: { steps: [] } },
            {
              id: "lee",
              name: "Lee",
              onboarding: { steps: [{ id: "intro", status: "complete" }] },
            },
          ],
          self: { id: "pat", name: "Pat", milestones: [{ id: "deadline-1" }] },
        }),
      "/papers": () => json({ papers: [] }),
    });

    await loadAdminBot(host, "general");
    expect(host.adminBotData.members).toEqual([
      expect.objectContaining({ id: "pat", milestones: [{ id: "deadline-1" }] }),
    ]);
    await loadAdminBotRoster(host);

    expect(host.adminBotData.members).toEqual([
      expect.objectContaining({ id: "pat", milestones: [{ id: "deadline-1" }] }),
      expect.objectContaining({
        id: "lee",
        onboarding: { steps: [{ id: "intro", status: "complete" }] },
      }),
    ]);
  });

  it("discards a late full roster after a different member signs in", async () => {
    saveStoredMemberSession({ sessionToken: "old-token", expiresAt: "later" });
    const { host } = createHost({});
    host.adminBotData.members = [{ id: "old-self" } as never];
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    const loading = loadAdminBotRoster(host);
    saveStoredMemberSession({ sessionToken: "new-token", expiresAt: "later" });
    host.adminBotData.members = [{ id: "new-self" } as never];
    host.adminBotRosterLoading = false;
    finish(json({ members: [{ id: "old-self" }, { id: "old-peer" }], self: { id: "old-self" } }));
    await loading;
    expect(host.adminBotData.members).toEqual([{ id: "new-self" }]);
    expect(host.adminBotRosterLoadedAt).toBeUndefined();
  });

  it("still shows the roster when the privileged extras are refused", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    routedFetch({
      "/lab/members/self": () => json({ member: { id: "pat" } }),
      "/papers/nudges": () => json({ error: { message: "nope" } }, 403),
      "/papers": () => json({ papers: [{ id: "paper-1" }] }),
      "/proposals/pending": () => json({ error: { message: "nope" } }, 403),
      "/settings": () => json({ error: { message: "nope" } }, 403),
      "/sensitive-info": () => json({ error: { message: "nope" } }, 403),
    });

    await loadAdminBot(host, "admin");

    expect(host.adminBotError).toBeNull();
    expect(host.adminBotData.members).toHaveLength(1);
    expect(host.adminBotData.papers).toHaveLength(1);
    expect(host.adminBotData.proposals).toEqual([]);
    expect(host.adminBotData.settings).toBeNull();
    expect(host.adminBotData.sensitiveInfo).toBeNull();
  });

  it("reports an error when the member's own profile cannot be read", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    routedFetch({
      "/lab/members/self": () => json({ error: { message: "nope" } }, 401),
      "/papers": () => json({ papers: [] }),
    });

    await loadAdminBot(host, "general");

    expect(host.adminBotError).not.toBeNull();
    expect(host.adminBotLoading).toBe(false);
  });
});

// Approvals moved off the gateway tool path onto the signed-in member's own Bearer session:
// the gateway service principal is shared by every AdminBot chat call, so the server now
// rejects it on these routes to stop members driving privileged actions through chat.
describe("approveAdminBotAction", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const proposal = {
    id: "act_1",
    type: "slack.send_message" as const,
    summary: "Send test DM to Andrew Kim",
    risk_tier: "T3" as const,
    payload_hash: "hash_1",
    status: "pending" as const,
    approval_requirement: {
      requires_approval: true,
      approver_roles: ["admin"],
      min_approvals: 1,
    },
    approvals: [],
    created_at: "2026-07-14T19:00:00.000Z",
    updated_at: "2026-07-14T19:00:00.000Z",
  };

  it("approves then executes over the member session, never the gateway tool", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const toolInvocations: string[] = [];
    const { host } = createHost({});
    host.client = {
      request: async (_method: string, params: { name?: string }) => {
        toolInvocations.push(params.name ?? "");
        return { ok: true, toolName: params.name, output: {} };
      },
    } as never;
    // The approve call answers with the proposal view; `approved` is what releases the execute
    // call, so a single-approver policy runs straight through. A fresh Response per call because
    // a body can only be read once.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            ...proposal,
            status: "approved",
            approvals: [{ approver_role: "admin", approver_id: "zj" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    await approveAdminBotAction(host, proposal);

    expect(toolInvocations).not.toContain("adminbot_approve_action");
    expect(toolInvocations).not.toContain("adminbot_execute_approved_action");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/approvals/act_1/approve");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/actions/act_1/execute");
    // Only the two approval calls are asserted as POSTs; the dashboard reload that follows reads
    // over the same session with GETs.
    for (const call of fetchMock.mock.calls.slice(0, 2)) {
      expect(call[1]).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer admin-sess-tok" }),
      });
    }
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: "Bearer admin-sess-tok" }),
      });
    }
    expect(host.adminBotNotice).toMatchObject({ kind: "success" });
  });

  it("says the approval stuck and shows the connector's reason when the execute is refused", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/approve")) {
        return new Response(
          JSON.stringify({
            ...proposal,
            status: "approved",
            approvals: [{ approver_role: "admin", approver_id: "zj" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/execute")) {
        return new Response(
          JSON.stringify({ error: { message: "You are trying to edit a protected cell" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await approveAdminBotAction(host, proposal);

    expect(host.adminBotNotice).toEqual({
      kind: "error",
      text: "Approved act_1, but it did not run: You are trying to edit a protected cell",
    });
  });

  it("keeps the unreachable message when the execute request never lands", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/execute")) {
        throw new TypeError("Failed to fetch");
      }
      return new Response(
        JSON.stringify({
          ...proposal,
          status: "approved",
          approvals: [{ approver_role: "admin", approver_id: "zj" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await approveAdminBotAction(host, proposal);

    expect(host.adminBotNotice?.text).toBe(ADMINBOT_SERVICE_UNREACHABLE_MESSAGE);
  });

  it("reports a permission error instead of approving when the server refuses (403)", async () => {
    saveStoredMemberSession({ sessionToken: "plain-member-tok", expiresAt: "later" });
    const { host } = createHost({});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "insufficient privileges" } }), {
        status: 403,
      }),
    );

    await approveAdminBotAction(host, proposal);

    expect(host.adminBotNotice?.kind).toBe("error");
    expect(host.adminBotNotice?.text).toMatch(/approval rights/i);
  });

  it("refuses to approve at all when no member is signed in", async () => {
    const { host } = createHost({});
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await approveAdminBotAction(host, proposal);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.adminBotNotice?.kind).toBe("error");
    expect(host.adminBotNotice?.text).toMatch(/sign in/i);
  });
});

describe("removePendingAdminBotAction", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dismisses a pending action over the member session", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "removed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await removePendingAdminBotAction(host, {
      id: "act_remove",
      type: "slack.send_message",
      summary: "Remove test DM",
      risk_tier: "T3",
      payload_hash: "hash_remove",
      status: "pending",
      approval_requirement: { requires_approval: true, approver_roles: ["pi"], min_approvals: 1 },
      approvals: [],
      created_at: "2026-07-14T19:00:00.000Z",
      updated_at: "2026-07-14T19:00:00.000Z",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/proposals/act_remove/remove");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer admin-sess-tok" }),
    });
    expect(host.adminBotNotice).toMatchObject({ kind: "success" });
  });
});

describe("saveAdminBotMember", () => {
  const baseInput = { id: "andrew-kim", name: "Andrew Kim", privilegeLevel: "admin" as const };

  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not show A's late save notice after B signs in", async () => {
    saveStoredMemberSession({ sessionToken: "admin-a", expiresAt: "later" });
    const { host } = createHost({});
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = saveAdminBotMember(host, baseInput);
    saveStoredMemberSession({ sessionToken: "member-b", expiresAt: "later" });
    finish?.(
      new Response(JSON.stringify({ id: baseInput.id }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.adminBotNotice).toBeNull();
  });

  it("writes governance fields directly via the member session, bypassing the gateway tool", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const toolInvocations: string[] = [];
    const { host } = createHost({});
    host.client = {
      request: async (_method: string, params: { name?: string }) => {
        toolInvocations.push(params.name ?? "");
        return { ok: true, toolName: params.name, output: {} };
      },
    } as never;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: "andrew-kim", name: "Andrew Kim", privilege_level: "admin" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    await saveAdminBotMember(host, baseInput);

    // The old bug: this write used to go through the gateway tool (shared service
    // principal), which since the privilege-escalation fix rejects privilege_level
    // even for a genuine admin. It must now go straight to the HTTP service instead.
    expect(toolInvocations).not.toContain("adminbot_upsert_lab_member");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/lab/members/andrew-kim"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Authorization: "Bearer admin-sess-tok" }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ privilege_level: "admin" });
    expect(host.adminBotNotice).toMatchObject({ kind: "success" });
  });

  it("surfaces a clear message when the session has lost admin privilege (403)", async () => {
    saveStoredMemberSession({ sessionToken: "demoted-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 }),
    );

    await saveAdminBotMember(host, baseInput);

    expect(host.adminBotNotice?.kind).toBe("error");
    expect(host.adminBotNotice?.text).toMatch(/admin access/i);
  });

  it("falls back to the gateway tool when there is no stored member session (break-glass access)", async () => {
    const toolInvocations: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { host } = createHost({});
    host.client = {
      request: async (
        _method: string,
        params: { name?: string; args?: Record<string, unknown> },
      ) => {
        toolInvocations.push({ name: params.name ?? "", args: params.args ?? {} });
        return { ok: true, toolName: params.name, output: {} };
      },
    } as never;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await saveAdminBotMember(host, baseInput);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toolInvocations[0]?.name).toBe("adminbot_upsert_lab_member");
    expect(toolInvocations[0]?.args).toMatchObject({ id: "andrew-kim", privilegeLevel: "admin" });
  });
});

describe("saveAdminBotMember — onboarding the person just added", () => {
  const baseInput = {
    id: "grace",
    name: "Grace Hopper",
    email: "grace@lab.co",
    memberType: "full",
  };

  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Answers the guide route with `guide` and everything else (the save, the reload) with {}. */
  function routes(guide: Response) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/onboarding/guide")
          ? guide.clone()
          : new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      );
  }

  const guideCalls = (fetchMock: ReturnType<typeof routes>) =>
    fetchMock.mock.calls.filter((call) => String(call[0]).includes("/onboarding/guide"));

  it("queues the guide over the admin session once the record exists", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    const fetchMock = routes(
      new Response(
        JSON.stringify({ proposal_id: "act_7", template_id: "member", email: "grace@lab.co" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await saveAdminBotMember(host, baseInput, { onboard: true });

    const queued = guideCalls(fetchMock);
    expect(queued).toHaveLength(1);
    expect(String(queued[0]![0])).toContain("/lab/members/grace/onboarding/guide");
    expect(queued[0]![1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer admin-sess-tok" }),
    });
    // The save goes first: onboarding is about a member who is on the roster by then.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/lab/members/grace");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    expect(host.adminBotNotice?.kind).toBe("success");
    expect(host.adminBotNotice?.text).toMatch(/waiting for approval/i);
  });

  it("carries the member type, which is what decides the template", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    const fetchMock = routes(new Response("{}", { status: 200 }));

    await saveAdminBotMember(host, baseInput, { onboard: true });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ member_type: "full" });
  });

  // The member is on the roster either way, so the save is not undone -- but the admin ticked a
  // box for something that did not happen, and the service's sentence is what they can act on.
  it("keeps the save and reports why the guide was refused", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    routes(
      new Response(
        JSON.stringify({
          error: { message: "acquaintance sends no onboarding mail" },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );

    await saveAdminBotMember(host, baseInput, { onboard: true });

    expect(host.adminBotNotice?.kind).toBe("error");
    expect(host.adminBotNotice?.text).toContain("Saved member grace");
    expect(host.adminBotNotice?.text).toContain("acquaintance sends no onboarding mail");
  });

  it("leaves onboarding alone when the form did not ask for it", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    const fetchMock = routes(new Response("{}", { status: 200 }));

    await saveAdminBotMember(host, baseInput);

    expect(guideCalls(fetchMock)).toHaveLength(0);
    expect(host.adminBotNotice).toMatchObject({ kind: "success" });
  });

  // Break-glass access authenticates as the shared service principal, which the guide route
  // refuses. Saying so beats a tick that silently did nothing.
  it("says onboarding needs an admin sign-in on the break-glass path", async () => {
    const { host } = createHost({});
    host.client = {
      request: async (_method: string, params: { name?: string }) => ({
        ok: true,
        toolName: params.name,
        output: {},
      }),
    } as never;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await saveAdminBotMember(host, baseInput, { onboard: true });

    expect(guideCalls(fetchMock as never)).toHaveLength(0);
    expect(host.adminBotNotice?.kind).toBe("error");
    expect(host.adminBotNotice?.text).toMatch(/admin sign-in/i);
  });
});

describe("reimbursement session privacy", () => {
  it("does not restore a previous member's receipt conversation after the cache is cleared", async () => {
    const { host } = createHost({});
    let finish!: (result: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    host.client = {
      request,
    } as never;
    const pending = sendAdminBotReimbursementMessage(host, "Old receipt", []);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    host.adminBotReimbursement = createEmptyAdminBotReimbursementState();
    finish({
      ok: true,
      toolName: "adminbot_reimbursement_converse",
      output: {
        assistant_message: "Old response",
        draft: { amount: "200" },
        ready: true,
      },
    });
    await pending;
    expect(host.adminBotReimbursement.messages).toEqual([]);
    expect(host.adminBotReimbursement.draft).toEqual({});
  });
});

describe("saveAdminBotOwnProfile", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("PUTs the self-edit whitelist with the member's own session and never touches the gateway tool", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const toolInvocations: string[] = [];
    const { host } = createHost({});
    host.adminBotData.members = [
      { id: "pat", name: "Pat", assigned_badges: [{ id: "badge-1" }] } as never,
    ];
    host.adminBotMemberList = {
      ...createEmptyAdminBotMemberList(),
      rows: [{ id: "pat", name: "Pat" } as never, { id: "lee", name: "Lee" } as never],
      loadedAt: 12,
    };
    host.client = {
      request: async (_method: string, params: { name?: string }) => {
        toolInvocations.push(params.name ?? "");
        return { ok: true, toolName: params.name, output: {} };
      },
    } as never;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "pat", name: "Pat Doe" }), { status: 200 }),
      );

    await saveAdminBotOwnProfile(host, "pat", { name: "Pat Doe", role: "Industry Researcher" });

    expect(toolInvocations).not.toContain("adminbot_upsert_lab_member");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/lab/members/pat"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Authorization: "Bearer member-sess-tok" }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      name: "Pat Doe",
      role: "Industry Researcher",
    });
    expect(host.adminBotNotice).toMatchObject({ kind: "success" });
    expect(host.adminBotData.members[0]).toMatchObject({
      id: "pat",
      name: "Pat Doe",
      assigned_badges: [{ id: "badge-1" }],
    });
    expect(host.adminBotMemberList.rows.map((member) => member.name)).toEqual(["Pat Doe", "Lee"]);
    expect(host.adminBotMemberList.loadedAt).toBe(12);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.adminBotLoading).toBe(false);
  });

  it("serializes autosaves so an older slow profile write cannot win", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    host.adminBotData.members = [{ id: "pat", name: "Pat" } as never];
    let finishFirst!: (response: Response) => void;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "pat", name: "Pat Latest" }), { status: 200 }),
      );
    const first = saveAdminBotOwnProfile(host, "pat", { name: "Pat Older" });
    const second = saveAdminBotOwnProfile(host, "pat", { name: "Pat Latest" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    finishFirst(new Response(JSON.stringify({ id: "pat", name: "Pat Older" }), { status: 200 }));
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.adminBotData.members[0]?.name).toBe("Pat Latest");
  });

  it("refuses without a member session instead of falling back to the gateway tool", async () => {
    const { host } = createHost({});
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await saveAdminBotOwnProfile(host, "pat", { name: "Pat Doe" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.adminBotNotice?.kind).toBe("error");
  });

  it("reports an unreachable AdminBot service", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await saveAdminBotOwnProfile(host, "pat", { name: "Pat Doe" });

    expect(host.adminBotNotice?.kind).toBe("error");
    // The fetch was rejected, so the message has to be about reaching the service. It used to say
    // the gateway was missing its adminbot plugin, which was never what a dead fetch meant.
    expect(host.adminBotNotice?.text).toMatch(/reach the AdminBot service/i);
    expect(host.adminBotNotice?.text).not.toMatch(/plugin/i);
  });
});

describe("saveAdminBotPaper", () => {
  const baseInput = {
    id: "paper-1",
    title: "World Models Survey",
    authors: ["Pat Doe"],
    currentStep: "overleaf_writing" as const,
    conference: "NeurIPS 2026",
  };

  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("saves over the member session so the service can scope the write to that member", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const toolInvocations: string[] = [];
    const { host } = createHost({});
    host.adminBotData.papers = [
      {
        id: "paper-1",
        title: "Old title",
        authors: ["Pat Doe"],
        current_step: "overleaf_writing",
      } as never,
      {
        id: "paper-2",
        title: "Another paper",
        authors: [],
        current_step: "overleaf_writing",
      } as never,
    ];
    host.adminBotData.loadedAt = 42;
    host.client = {
      request: async (_method: string, params: { name?: string }) => {
        toolInvocations.push(params.name ?? "");
        return { ok: true, toolName: params.name, output: {} };
      },
    } as never;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "paper-1",
          title: "World Models Survey",
          authors: ["Pat Doe"],
          current_step: "overleaf_writing",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await saveAdminBotPaper(host, {
      ...baseInput,
      venueDecision: "accept",
      acceptedVenue: "ICLR 2027",
      acceptedYear: "2027",
      isArchival: "true",
      presentationType: "spotlight",
      publicationTrack: "main",
      decisionEmailSent: "accept:ICLR 2027",
    });

    // A plain member's paired device holds read-only gateway scopes, so the tool path is not
    // available to them at all — and it would run as the privileged service principal anyway.
    expect(toolInvocations).not.toContain("adminbot_upsert_paper");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/papers/paper-1"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Authorization: "Bearer member-sess-tok" }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({
      title: "World Models Survey",
      current_step: "overleaf_writing",
      artifacts: {
        conference: "NeurIPS 2026",
        decision_coauthor_email_sent: "accept:ICLR 2027",
        publication_track: "main",
      },
      venue_decision: "accept",
      accepted_venue: "ICLR 2027",
      accepted_year: 2027,
      is_archival: true,
      presentation_type: "spotlight",
    });
    expect(host.adminBotNotice).toMatchObject({ kind: "success" });
    expect(host.adminBotData.papers.map((row) => row.id)).toEqual(["paper-1", "paper-2"]);
    expect(host.adminBotData.papers[0]?.title).toBe("World Models Survey");
    expect(host.adminBotData.loadedAt).toBe(42);
    expect(host.adminBotLoading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping paper autosaves and keeps the last edit", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    host.adminBotData.papers = [
      {
        id: "paper-1",
        title: "Initial",
        authors: ["Pat Doe"],
        current_step: "overleaf_writing",
      } as never,
    ];
    let finishFirst!: (response: Response) => void;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "paper-1",
            title: "Latest",
            authors: ["Pat Doe"],
            current_step: "overleaf_writing",
          }),
          { status: 200 },
        ),
      );
    const first = saveAdminBotPaper(host, { ...baseInput, title: "Older" });
    const second = saveAdminBotPaper(host, { ...baseInput, title: "Latest" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    finishFirst(
      new Response(
        JSON.stringify({
          id: "paper-1",
          title: "Older",
          authors: ["Pat Doe"],
          current_step: "overleaf_writing",
        }),
        { status: 200 },
      ),
    );
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.adminBotData.papers[0]?.title).toBe("Latest");
    expect(host.adminBotLoading).toBe(false);
  });

  it("forwards Not said as an explicit clear instead of silently omitting it", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "paper-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await saveAdminBotPaper(host, {
      ...baseInput,
      acceptedVenue: "",
      acceptedYear: "",
      isArchival: "",
      presentationType: "",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({
      accepted_venue: "",
      accepted_year: "",
      is_archival: "",
      presentation_type: "",
    });
  });

  it("explains a refusal instead of saving when the member does not own the paper (403)", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await saveAdminBotPaper(host, baseInput);

    expect(host.adminBotNotice).toMatchObject({
      kind: "error",
      text: "You can only add or edit papers you authored.",
    });
  });

  it("falls back to the gateway tool for a break-glass session with no member login", async () => {
    const toolInvocations: string[] = [];
    let toolArgs: Record<string, unknown> | undefined;
    const { host } = createHost({});
    host.client = {
      request: async (
        _method: string,
        params: { name?: string; args?: Record<string, unknown> },
      ) => {
        toolInvocations.push(params.name ?? "");
        if (params.name === "adminbot_upsert_paper") {
          toolArgs = params.args;
        }
        return { ok: true, toolName: params.name, output: {} };
      },
    } as never;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await saveAdminBotPaper(host, {
      ...baseInput,
      venueDecision: "reject",
      acceptedVenue: "ACL 2026",
      acceptedYear: "2026",
      isArchival: "false",
      presentationType: "poster",
    });

    expect(toolInvocations).toContain("adminbot_upsert_paper");
    expect(toolArgs).toMatchObject({
      venueDecision: "reject",
      acceptedVenue: "ACL 2026",
      acceptedYear: 2026,
      isArchival: false,
      presentationType: "poster",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("approveAdminBotAction", () => {
  const pendingProposal = {
    id: "act_1",
    type: "slack.send_message" as const,
    summary: "Send test DM to Andrew Kim",
    risk_tier: "T3" as const,
    payload_hash: "hash_1",
    status: "pending" as const,
    approval_requirement: {
      requires_approval: true,
      approver_roles: ["admin"],
      min_approvals: 1,
    },
    approvals: [],
    created_at: "2026-07-14T19:00:00.000Z",
    updated_at: "2026-07-14T19:00:00.000Z",
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Approvals go over the member session, never the gateway tool: the service refuses to record
  // an approval for the shared service principal because it cannot name a person.
  it("approves over the member session and executes once quorum is met", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const toolInvocations: string[] = [];
    const { host } = createHost({});
    host.client = {
      request: async (_method: string, params: { name?: string }) => {
        toolInvocations.push(params.name ?? "");
        return { ok: true, toolName: params.name, output: {} };
      },
    } as never;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          ...pendingProposal,
          status: "approved",
          approvals: [{ approver_role: "admin", approver_id: "boss" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ action_id: "act_1", status: "executed", dry_run: false }),
      )
      .mockResolvedValue(jsonResponse({}));

    await approveAdminBotAction(host, pendingProposal);

    expect(toolInvocations).not.toContain("adminbot_approve_action");
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("/approvals/act_1/approve"),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer admin-sess-tok" }),
      }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(expect.stringContaining("/actions/act_1/execute"));
    expect(host.adminBotNotice).toMatchObject({ kind: "success" });
  });

  it("stops without executing while a second approver is still required", async () => {
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...pendingProposal,
        approval_requirement: {
          requires_approval: true,
          approver_roles: ["admin"],
          min_approvals: 2,
        },
        status: "pending",
        approvals: [{ approver_role: "admin", approver_id: "boss" }],
      }),
    );

    await approveAdminBotAction(host, pendingProposal);

    // The approval is the only write: executing a proposal still short of quorum would defeat
    // the two-person rule the service enforces. The dashboard reload that follows is all GETs.
    const writes = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(writes).toHaveLength(1);
    expect(String(writes[0]?.[0])).toContain("/approvals/act_1/approve");
    expect(host.adminBotNotice).toMatchObject({
      kind: "success",
      text: expect.stringContaining("1 of 2 approvals"),
    });
  });

  it("does not continue A's approval after B signs in", async () => {
    saveStoredMemberSession({ sessionToken: "admin-a", expiresAt: "later" });
    const { host } = createHost({});
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = approveAdminBotAction(host, pendingProposal);
    saveStoredMemberSession({ sessionToken: "member-b", expiresAt: "later" });
    host.adminBotBusyActionId = null;
    finish?.(jsonResponse({ status: "approved" }));
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.adminBotNotice).toBeNull();
    expect(host.adminBotBusyActionId).toBeNull();
  });
});

describe("removeSelectedPendingAdminBotActions", () => {
  function proposal(id: string) {
    return {
      id,
      type: "slack.send_message",
      risk_tier: "T3" as const,
      summary: `Proposal ${id}`,
      status: "pending" as const,
      payload_hash: `hash_${id}`,
      approval_requirement: { requires_approval: true, approver_roles: ["pi"], min_approvals: 1 },
      approvals: [],
      created_at: "2026-07-14T19:00:00.000Z",
      updated_at: "2026-07-14T19:00:00.000Z",
    };
  }

  function seed(ids: string[], selected: string[]) {
    const { host } = createHost({});
    host.adminBotData = {
      ...createEmptyAdminBotDashboardData(),
      proposals: ids.map(proposal),
    };
    host.adminBotSelectedActionIds = selected;
    return host;
  }

  const ok = () =>
    new Response(JSON.stringify({ status: "removed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "admin-sess-tok", expiresAt: "later" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("removes every ticked proposal and clears the selection", async () => {
    const host = seed(["act_one", "act_two"], ["act_one", "act_two"]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());

    await removeSelectedPendingAdminBotActions(host);

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/proposals/act_one/remove"))).toBe(true);
    expect(urls.some((url) => url.includes("/proposals/act_two/remove"))).toBe(true);
    expect(host.adminBotNotice).toMatchObject({
      kind: "success",
      text: "Removed 2 pending actions.",
    });
    expect(host.adminBotSelectedActionIds).toEqual([]);
    expect(host.adminBotBulkActionBusy).toBe(false);
  });

  // A bulk clear must never reach the execute route: removing discards a suggestion, executing
  // sends the mail.
  it("never executes anything", async () => {
    const host = seed(["act_one", "act_two"], ["act_one", "act_two"]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());

    await removeSelectedPendingAdminBotActions(host);

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/execute");
      expect(String(call[0])).not.toContain("/approve");
    }
  });

  it("keeps the ones that refused ticked, and says how many went", async () => {
    const host = seed(["act_one", "act_two"], ["act_one", "act_two"]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "nope" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await removeSelectedPendingAdminBotActions(host);

    expect(host.adminBotSelectedActionIds).toEqual(["act_two"]);
    expect(host.adminBotNotice?.kind).toBe("error");
    expect(host.adminBotNotice?.text).toContain("Removed 1 of 2");
  });

  // A tick can outlive its row -- somebody else cleared it first. Asking the service to remove a
  // proposal that is already gone would report a failure for work that is in fact done.
  it("does not call the service for a selection whose rows are already gone", async () => {
    const host = seed(["act_live"], ["act_stale"]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());

    await removeSelectedPendingAdminBotActions(host);

    const removeCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/remove"));
    expect(removeCalls).toHaveLength(0);
    expect(host.adminBotSelectedActionIds).toEqual([]);
    expect(host.adminBotNotice).toMatchObject({ kind: "success" });
  });

  it("does nothing at all when nothing is ticked", async () => {
    const host = seed(["act_one"], []);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());

    await removeSelectedPendingAdminBotActions(host);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not restore A's selected actions after a late removal response under B", async () => {
    const host = seed(["a-action"], ["a-action"]);
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = removeSelectedPendingAdminBotActions(host);
    saveStoredMemberSession({ sessionToken: "member-b", expiresAt: "later" });
    host.adminBotSelectedActionIds = [];
    host.adminBotBulkActionBusy = false;
    finish?.(ok());
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.adminBotSelectedActionIds).toEqual([]);
    expect(host.adminBotNotice).toBeNull();
    expect(host.adminBotBulkActionBusy).toBe(false);
  });

  it("does not restore A's announcement draft after a late send response under B", async () => {
    const host = seed([], []);
    host.adminBotMemberNudge = {
      channel: "slack",
      subject: "",
      message: "A's private message",
      selectedMemberIds: ["a-peer"],
      busy: false,
    };
    let finish: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = sendAdminBotMemberNudge(host);
    saveStoredMemberSession({ sessionToken: "member-b", expiresAt: "later" });
    host.adminBotMemberNudge = createEmptyAdminBotMemberNudgeState();
    finish?.(
      new Response(
        JSON.stringify({ created: [{ id: "a-nudge", status: "pending" }], skipped: [] }),
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    await pending;
    expect(host.adminBotMemberNudge).toEqual(createEmptyAdminBotMemberNudgeState());
    expect(host.adminBotNotice).toBeNull();
  });
});
