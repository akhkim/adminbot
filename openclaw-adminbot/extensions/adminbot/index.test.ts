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
      "adminbot-candidate-workflow",
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
    expect(orchestrator).toContain("adminbot-candidate-workflow");
    expect(orchestrator).toContain("adminbot-paper-publish");
    expect(orchestrator).toContain("adminbot_propose_slack_message");
  });

  it("shows the concrete action summary in approval confirmations", async () => {
    const captured = createCapturedPluginRegistration({ id: "adminbot" });
    const on = vi.fn();
    captured.api.on = on as typeof captured.api.on;

    adminbotPlugin.register(captured.api);

    const handler = on.mock.calls[0]?.[1] as (
      event: {
        toolName: string;
        params: Record<string, unknown>;
        toolCallId?: string;
      },
      ctx: { agentId?: string; sessionKey?: string },
    ) => Promise<unknown>;
    await expect(
      handler(
        {
          toolName: "adminbot_approve_action",
          params: {
            actionId: "act_9aeae1fd-40d1-406d-8433-5739e6e65dd3",
            payloadHash: "34a5bd8cf28d0000",
            actionSummary: "Send email to xxx@gmail.com",
          },
          toolCallId: "call-1",
        },
        { agentId: "adminbot", sessionKey: "session-1" },
      ),
    ).resolves.toEqual({
      requireApproval: expect.objectContaining({
        title: "Approve AdminBot action",
        description:
          "Approve AdminBot action: Send email to xxx@gmail.com. Action id act_9aeae1fd-40d1-406d-8433-5739e6e65dd3; payload hash 34a5bd8cf28d.",
      }),
    });
  });
});
