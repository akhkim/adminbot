// Control UI AdminBot controller tests cover explicit data-loading modes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { saveStoredMemberSession } from "../adminbot-auth.ts";
import type { UiSettings } from "../storage.ts";
import {
  approveAdminBotAction,
  createEmptyAdminBotDashboardData,
  createEmptyAdminBotReimbursementState,
  loadAdminBot,
  removePendingAdminBotAction,
  saveAdminBotMember,
  saveAdminBotOwnProfile,
  type AdminBotHost,
} from "./adminbot.js";

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

describe("approveAdminBotAction", () => {
  it("approves and executes an action with one explicit dashboard click", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const host: AdminBotHost = {
      client: {
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          return {
            ok: true,
            toolName: params.name,
            output:
              params.name === "adminbot_execute_approved_action"
                ? {
                    status: "executed",
                    action_id: "act_1",
                    dry_run: false,
                    executed_at: "2099-01-01T00:00:00.000Z",
                  }
                : undefined,
          };
        },
      } as never,
      connected: true,
      adminBotLoading: false,
      adminBotError: null,
      adminBotData: createEmptyAdminBotDashboardData(),
      adminBotBusyActionId: null,
      adminBotNotice: null,
      adminBotReimbursement: createEmptyAdminBotReimbursementState(),
      settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
    };

    await approveAdminBotAction(host, {
      id: "act_1",
      type: "slack.send_message",
      summary: "Send test DM to Andrew Kim",
      risk_tier: "T3",
      payload_hash: "hash_1",
      status: "pending",
      approval_requirement: { requires_approval: true, approver_roles: ["pi"], min_approvals: 1 },
      approvals: [],
      created_at: "2026-07-14T19:00:00.000Z",
      updated_at: "2026-07-14T19:00:00.000Z",
    });

    expect(requests[0]).toMatchObject({
      method: "tools.invoke",
      params: {
        name: "adminbot_approve_action",
        agentId: "adminbot",
        args: {
          actionId: "act_1",
          payloadHash: "hash_1",
          approverRole: "admin",
          approverId: "control-ui",
          controlUiConfirmed: true,
        },
      },
    });
    expect(requests[1]).toMatchObject({
      method: "tools.invoke",
      params: {
        name: "adminbot_execute_approved_action",
        agentId: "adminbot",
        args: {
          actionId: "act_1",
          idempotencyKey: "control-ui-act_1",
          controlUiConfirmed: true,
        },
      },
    });
  });
});

describe("removePendingAdminBotAction", () => {
  it("invokes the audited removal tool as an explicit dashboard action", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const host: AdminBotHost = {
      client: {
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          return { ok: true, toolName: params.name, output: undefined };
        },
      } as never,
      connected: true,
      adminBotLoading: false,
      adminBotError: null,
      adminBotData: createEmptyAdminBotDashboardData(),
      adminBotBusyActionId: null,
      adminBotNotice: null,
      adminBotReimbursement: createEmptyAdminBotReimbursementState(),
      settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
    };
    const proposal = {
      id: "act_remove",
      type: "slack.send_message" as const,
      summary: "Remove test DM",
      risk_tier: "T3" as const,
      payload_hash: "hash_remove",
      status: "pending" as const,
      approval_requirement: { requires_approval: true, approver_roles: ["pi"], min_approvals: 1 },
      approvals: [],
      created_at: "2026-07-14T19:00:00.000Z",
      updated_at: "2026-07-14T19:00:00.000Z",
    };

    await removePendingAdminBotAction(host, proposal);

    expect(requests[0]).toMatchObject({
      method: "tools.invoke",
      params: {
        name: "adminbot_remove_pending_action",
        agentId: "adminbot",
        args: {
          actionId: "act_remove",
          actor: "control-ui",
          controlUiConfirmed: true,
        },
      },
    });
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

    await saveAdminBotOwnProfile(host, "pat", { name: "Pat Doe", role: "Research scientist" });

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
      role: "Research scientist",
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
