// Control UI AdminBot controller tests cover explicit data-loading modes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import {
  approveAdminBotAction,
  createEmptyAdminBotDashboardData,
  createEmptyAdminBotMemberNudgeState,
  createEmptyAdminBotReimbursementState,
  loadAdminBot,
  removePendingAdminBotAction,
  saveAdminBotMember,
  saveAdminBotPaper,
  saveAdminBotOwnProfile,
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
    adminBotNotice: null,
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
      adminBotNotice: null,
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

  it("reads members and papers over HTTP instead of the gateway tool", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host, calls } = createHost({});
    const fetchMock = routedFetch({
      "/lab/members": () => json({ members: [{ id: "pat" }] }),
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
  });

  it("still shows the roster when the privileged extras are refused", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    routedFetch({
      "/lab/members": () => json({ members: [{ id: "pat" }] }),
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

  it("reports an error when the roster itself cannot be read", async () => {
    saveStoredMemberSession({ sessionToken: "member-sess-tok", expiresAt: "later" });
    const { host } = createHost({});
    routedFetch({
      "/lab/members": () => json({ error: { message: "nope" } }, 401),
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
    expect(host.adminBotNotice?.text).toMatch(/not available/i);
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
    host.client = {
      request: async (_method: string, params: { name?: string }) => {
        toolInvocations.push(params.name ?? "");
        return { ok: true, toolName: params.name, output: {} };
      },
    } as never;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "paper-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await saveAdminBotPaper(host, baseInput);

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
      artifacts: { conference: "NeurIPS 2026" },
    });
    expect(host.adminBotNotice).toMatchObject({ kind: "success" });
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
    const { host } = createHost({});
    host.client = {
      request: async (_method: string, params: { name?: string }) => {
        toolInvocations.push(params.name ?? "");
        return { ok: true, toolName: params.name, output: {} };
      },
    } as never;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await saveAdminBotPaper(host, baseInput);

    expect(toolInvocations).toContain("adminbot_upsert_paper");
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
});
