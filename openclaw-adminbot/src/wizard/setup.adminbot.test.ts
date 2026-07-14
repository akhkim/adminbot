// AdminBot setup tests cover the config mutation used by the setup wizard.
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "./prompts.js";
import {
  ADMINBOT_AGENT_ID,
  ADMINBOT_DENIED_TOOLS,
  ADMINBOT_CONTROL_UI_LAUNCH_URL,
  ADMINBOT_CONTROL_UI_ORIGIN,
  ADMINBOT_LOCAL_MODEL,
  ADMINBOT_PLUGIN_ID,
  ADMINBOT_SERVICE_BASE_URL,
  ADMINBOT_SERVICE_TOKEN_ENV,
  ADMINBOT_SKILLS,
  ADMINBOT_TOOLS,
  applyAdminBotSetupConfig,
  setupAdminBot,
} from "./setup.adminbot.js";

function findAdminBotAgent(config: OpenClawConfig) {
  return config.agents?.list?.find((agent) => agent.id === ADMINBOT_AGENT_ID);
}

describe("setupAdminBot", () => {
  it("creates a least-privilege agent and routes unmatched Slack traffic", () => {
    const result = applyAdminBotSetupConfig(
      {},
      {
        serviceBaseUrl: ADMINBOT_SERVICE_BASE_URL,
        serviceTokenEnv: ADMINBOT_SERVICE_TOKEN_ENV,
        defaultDryRun: true,
        workspace: "/tmp/openclaw-workspace-adminbot",
        bindSlack: true,
      },
    );

    expect(result.config.plugins?.entries?.adminbot).toMatchObject({
      enabled: true,
      config: {
        serviceBaseUrl: ADMINBOT_SERVICE_BASE_URL,
        serviceTokenEnv: ADMINBOT_SERVICE_TOKEN_ENV,
        defaultDryRun: true,
      },
    });
    expect(result.config.gateway?.controlUi).toMatchObject({
      launchUrl: ADMINBOT_CONTROL_UI_LAUNCH_URL,
      allowedOrigins: [ADMINBOT_CONTROL_UI_ORIGIN],
    });

    const agent = findAdminBotAgent(result.config);
    expect(agent).toMatchObject({
      id: ADMINBOT_AGENT_ID,
      name: "AdminBot",
      workspace: "/tmp/openclaw-workspace-adminbot",
      identity: { name: "AdminBot" },
      model: ADMINBOT_LOCAL_MODEL,
      tools: {
        profile: "minimal",
        alsoAllow: [...ADMINBOT_TOOLS],
        deny: [...ADMINBOT_DENIED_TOOLS],
        elevated: { enabled: false },
        exec: { mode: "deny" },
      },
    });
    expect(agent?.skills).toStrictEqual([...ADMINBOT_SKILLS]);
    expect(agent?.tools?.alsoAllow).toContain(ADMINBOT_PLUGIN_ID);
    expect(agent?.tools?.alsoAllow).toContain("adminbot_reason");
    expect(result.config.bindings).toContainEqual({
      type: "route",
      agentId: ADMINBOT_AGENT_ID,
      comment: "AdminBot setup: route unmatched Slack conversations to AdminBot.",
      match: { channel: "slack", accountId: "*" },
    });
    expect(result.slackBinding).toMatchObject({ added: true, conflicts: [] });
  });

  it("preserves existing Control UI allowed origins when setting the hosted AdminBot UI", () => {
    const result = applyAdminBotSetupConfig(
      {
        gateway: {
          controlUi: {
            allowedOrigins: ["https://control.example.com", ADMINBOT_CONTROL_UI_ORIGIN],
          },
        },
      },
      {
        serviceBaseUrl: ADMINBOT_SERVICE_BASE_URL,
        serviceTokenEnv: ADMINBOT_SERVICE_TOKEN_ENV,
        defaultDryRun: true,
        workspace: "/tmp/adminbot",
        bindSlack: false,
      },
    );

    expect(result.config.gateway?.controlUi?.launchUrl).toBe(ADMINBOT_CONTROL_UI_LAUNCH_URL);
    expect(result.config.gateway?.controlUi?.allowedOrigins).toStrictEqual([
      "https://control.example.com",
      ADMINBOT_CONTROL_UI_ORIGIN,
    ]);
  });

  it("leaves existing Slack bindings untouched when the Slack route is skipped", () => {
    const config: OpenClawConfig = {
      agents: { list: [{ id: "ops", workspace: "/tmp/ops" }] },
      bindings: [{ type: "route", agentId: "ops", match: { channel: "slack" } }],
    };

    const result = applyAdminBotSetupConfig(config, {
      serviceBaseUrl: ADMINBOT_SERVICE_BASE_URL,
      serviceTokenEnv: ADMINBOT_SERVICE_TOKEN_ENV,
      defaultDryRun: true,
      workspace: "/tmp/adminbot",
      bindSlack: false,
    });

    expect(result.config.bindings).toStrictEqual(config.bindings);
    expect(result.slackBinding).toMatchObject({ added: false, skipped: false, conflicts: [] });
  });

  it("keeps setup unchanged when the user declines AdminBot", async () => {
    const confirm = vi.fn(async () => false) as WizardPrompter["confirm"];
    const config: OpenClawConfig = { agents: { list: [{ id: "main" }] } };
    const prompter = createWizardPrompter({ confirm });

    await expect(
      setupAdminBot({
        config,
        prompter,
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    ).resolves.toBe(config);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("uses prompt defaults when the user accepts AdminBot setup", async () => {
    const confirm = vi.fn(async () => true) as WizardPrompter["confirm"];
    const text = vi.fn(
      async (params: Parameters<WizardPrompter["text"]>[0]) => params.initialValue ?? "",
    ) as WizardPrompter["text"];
    const prompter = createWizardPrompter({ confirm, text });

    const config = await setupAdminBot({
      config: {},
      prompter,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(findAdminBotAgent(config)?.workspace).toBe("/tmp/openclaw-workspace-adminbot");
    expect(config.plugins?.entries?.adminbot?.config).toMatchObject({
      serviceBaseUrl: ADMINBOT_SERVICE_BASE_URL,
      serviceTokenEnv: ADMINBOT_SERVICE_TOKEN_ENV,
      defaultDryRun: true,
    });
    expect(config.bindings).toHaveLength(1);
  });
});
