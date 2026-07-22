// Control UI AdminBot controller tests cover explicit data-loading modes.
import { describe, expect, it } from "vitest";
import {
  approveAdminBotAction,
  createEmptyAdminBotDashboardData,
  loadAdminBot,
  removePendingAdminBotAction,
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
