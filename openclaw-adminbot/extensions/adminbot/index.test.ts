import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createCapturedPluginRegistration } from "../../src/plugins/captured-registration.js";
import adminbotPlugin from "./index.js";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

describe("adminbot plugin metadata", () => {
  it("bundles the AdminBot workflow skill set with the plugin", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "openclaw.plugin.json"), "utf8"),
    ) as { skills?: string[] };
    const skillNames = fs
      .readdirSync(path.join(packageRoot, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
    const orchestrator = fs.readFileSync(
      path.join(packageRoot, "skills", "adminbot-workflows", "SKILL.md"),
      "utf8",
    );

    expect(manifest.skills).toEqual(["./skills"]);
    expect(skillNames).toEqual([
      "adminbot-access-invites",
      "adminbot-calendar-email",
      "adminbot-email-automation",
      "adminbot-join-form-triage",
      "adminbot-linkedin-from-twitter",
      "adminbot-paper-publish",
      "adminbot-recommendation-letters",
      "adminbot-reimbursements",
      "adminbot-slack-management",
      "adminbot-social-posts",
      "adminbot-workflows",
    ]);
    expect(orchestrator).toContain("name: adminbot-workflows");
    expect(orchestrator).toContain("adminbot-paper-publish");
    expect(orchestrator).toContain("adminbot_propose_slack_message");
  });

  it("declares every registered agent tool in the manifest contract", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "openclaw.plugin.json"), "utf8"),
    ) as { contracts?: { tools?: string[] } };
    const captured = createCapturedPluginRegistration({ id: "adminbot" });

    adminbotPlugin.register(captured.api);

    expect(new Set(manifest.contracts?.tools)).toEqual(
      new Set(captured.tools.map((tool) => tool.name)),
    );
    expect(manifest.contracts?.tools).toContain("adminbot_run_email_automation");
    expect(manifest.contracts?.tools).toContain("adminbot_reason");
    expect(manifest.contracts?.tools).toContain("adminbot_list_lab_members");
    expect(manifest.contracts?.tools).toContain("adminbot_list_papers");
  });

  // Approving and executing are reachable only from the Control UI, which the host marks with an
  // `rpc-` tool-call id. The `controlUiConfirmed` flag alone is model-visible and must not be
  // enough on its own, or the model could approve its own proposals.
  it.each([["adminbot_approve_action"], ["adminbot_execute_approved_action"]])(
    "%s refuses any call the host did not originate from the Control UI",
    async (toolName) => {
      const captured = createCapturedPluginRegistration({ id: "adminbot" });

      adminbotPlugin.register(captured.api);

      const target = captured.tools.find((entry) => entry.name === toolName);
      expect(target).toBeDefined();
      const params = {
        actionId: "act_9aeae1fd-40d1-406d-8433-5739e6e65dd3",
        payloadHash: "34a5bd8cf28d0000",
        approverRole: "admin",
      };

      await expect(target?.execute("call-1", params)).rejects.toThrow(/Control UI/u);
      await expect(
        target?.execute("call-1", { ...params, controlUiConfirmed: true }),
      ).rejects.toThrow(/Control UI/u);
      await expect(target?.execute("rpc-dashboard-1", params)).rejects.toThrow(/Control UI/u);
    },
  );

  it("still asks the user before removing a pending action from chat", async () => {
    const captured = createCapturedPluginRegistration({ id: "adminbot" });
    const on = vi.fn();
    captured.api.on = on as typeof captured.api.on;

    adminbotPlugin.register(captured.api);

    const handler = on.mock.calls[0]?.[1] as (
      event: { toolName: string; params: Record<string, unknown>; toolCallId?: string },
      ctx: { agentId?: string; sessionKey?: string },
    ) => Promise<unknown>;
    await expect(
      handler(
        {
          toolName: "adminbot_remove_pending_action",
          params: {
            actionId: "act_9aeae1fd-40d1-406d-8433-5739e6e65dd3",
            controlUiConfirmed: true,
          },
          toolCallId: "model-call-3",
        },
        { agentId: "adminbot", sessionKey: "session-1" },
      ),
    ).resolves.toEqual({
      requireApproval: expect.objectContaining({
        title: "Remove pending AdminBot action",
      }),
    });
  });
});
