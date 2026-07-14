// Control UI AdminBot controller tests cover general read-only loading.
import { describe, expect, it } from "vitest";
import {
  createEmptyAdminBotDashboardData,
  loadAdminBot,
  resolveAdminBotLoadMode,
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

describe("resolveAdminBotLoadMode", () => {
  it("routes the general password to the read-only AdminBot mode", () => {
    expect(resolveAdminBotLoadMode("jinesis")).toBe("general");
    expect(resolveAdminBotLoadMode(" admin-password ")).toBe("admin");
    expect(resolveAdminBotLoadMode(null)).toBe("admin");
  });
});

describe("loadAdminBot", () => {
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
