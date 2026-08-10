// AdminBot setup writes the dedicated agent, plugin config, and optional Slack route.
import { applyAgentBindings } from "../commands/agents/agents.bindings.js";
import { applyAgentConfig } from "../commands/agents/agents.config.js";
import type { AgentRouteBinding } from "../config/types/agents.js";
import type { OpenClawConfig } from "../config/types/openclaw.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";

export const ADMINBOT_AGENT_ID = "adminbot";
export const ADMINBOT_PLUGIN_ID = "adminbot";
export const ADMINBOT_SERVICE_BASE_URL = "http://127.0.0.1:8765";
export const ADMINBOT_SERVICE_TOKEN_ENV = "ADMINBOT_SERVICE_TOKEN";
export const ADMINBOT_LOCAL_MODEL = {
  primary: "ollama/gemma4:e4b",
  fallbacks: ["ollama/gpt-oss:20b"],
};
export const ADMINBOT_CONTROL_UI_LAUNCH_URL = "https://jinesis-admin.vercel.app/";
export const ADMINBOT_CONTROL_UI_ORIGIN = "https://jinesis-admin.vercel.app";
// The Control UI talks to the AdminBot HTTP service directly (a different origin than the
// Gateway that serves the UI itself), so its CSP connect-src needs these explicitly. The TLS
// port entry is host-wildcarded because the actual tailnet/production hostname varies per
// deployment and isn't known at config time; the port itself is AdminBot's fixed default.
export const ADMINBOT_SERVICE_CONNECT_SRC_ORIGINS = [ADMINBOT_SERVICE_BASE_URL, "https://*:8443"];

export const ADMINBOT_SKILLS = [
  "adminbot-workflows",
  "adminbot-candidate-workflow",
  "adminbot-join-form-triage",
  "adminbot-reimbursements",
  "adminbot-access-invites",
  "adminbot-slack-management",
  "adminbot-recommendation-letters",
  "adminbot-social-posts",
  "adminbot-calendar-email",
  "adminbot-email-automation",
  "adminbot-paper-publish",
] as const;

export const ADMINBOT_TOOLS = [
  "message",
  // Allow the AdminBot plugin id as well as concrete tools so optional plugin
  // tools materialize for workflow skills when the agent uses a minimal profile.
  ADMINBOT_PLUGIN_ID,
  "adminbot_run_email_automation",
  "adminbot_reason",
  "adminbot_propose_action",
  "adminbot_propose_candidate_decision",
  "adminbot_draft_social_post",
  "adminbot_prepare_paper_social_posts",
  "adminbot_prepare_overleaf_paper_edit",
  "adminbot_prepare_reimbursement_packet",
  "adminbot_reimbursement_converse",
  "adminbot_reimbursement_generate",
  "adminbot_suggest_calendar_change",
  "adminbot_propose_slack_message",
  "adminbot_classify_join_form_response",
  "adminbot_upsert_lab_member",
  "adminbot_list_lab_members",
  "adminbot_get_settings",
  "adminbot_update_settings",
  "adminbot_list_unreviewed_applicants",
  "adminbot_mark_applicants_reviewed",
  "adminbot_get_sensitive_info",
  "adminbot_update_sensitive_info",
  "adminbot_upsert_paper",
  "adminbot_list_papers",
  "adminbot_list_paper_nudges",
  "adminbot_propose_paper_nudge",
  "adminbot_list_pending_actions",
  "adminbot_delete_paper",
  "adminbot_approve_action",
  "adminbot_execute_approved_action",
  "adminbot_remove_pending_action",
] as const;

export const ADMINBOT_DENIED_TOOLS = ["session_status"] as const;

export type AdminBotSetupConfig = {
  serviceBaseUrl: string;
  serviceTokenEnv: string;
  defaultDryRun: boolean;
  workspace: string;
  bindSlack: boolean;
};

export type AdminBotSetupResult = {
  config: OpenClawConfig;
  slackBinding: {
    added: boolean;
    skipped: boolean;
    conflicts: string[];
  };
};

type AgentConfigEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

function adminBotPluginConfig(config: OpenClawConfig): Record<string, unknown> {
  return config.plugins?.entries?.[ADMINBOT_PLUGIN_ID]?.config ?? {};
}

function readStringConfig(config: OpenClawConfig, key: string, fallback: string): string {
  const value = adminBotPluginConfig(config)[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readBooleanConfig(config: OpenClawConfig, key: string, fallback: boolean): boolean {
  const value = adminBotPluginConfig(config)[key];
  return typeof value === "boolean" ? value : fallback;
}

function findAdminBotWorkspace(config: OpenClawConfig, fallbackWorkspace: string): string {
  const existing = config.agents?.list?.find((agent) => agent.id === ADMINBOT_AGENT_ID)?.workspace;
  return typeof existing === "string" && existing.trim() ? existing.trim() : fallbackWorkspace;
}

function hasSlackRouteToAdminBot(config: OpenClawConfig): boolean {
  return (config.bindings ?? []).some(
    (binding) =>
      (binding.type === undefined || binding.type === "route") &&
      binding.agentId === ADMINBOT_AGENT_ID &&
      binding.match.channel === "slack",
  );
}

function hasAnySlackRoute(config: OpenClawConfig): boolean {
  return (config.bindings ?? []).some(
    (binding) =>
      (binding.type === undefined || binding.type === "route") && binding.match.channel === "slack",
  );
}

function defaultAdminBotWorkspace(workspaceDir: string): string {
  const trimmed = workspaceDir.trim();
  return trimmed.endsWith("-adminbot") ? trimmed : `${trimmed}-adminbot`;
}

function removeExplicitAllow<T extends { allow?: string[] }>(
  tools: T | undefined,
): Omit<T, "allow"> {
  const next = { ...tools } as T;
  delete next.allow;
  return next;
}

function withAdminBotControlUiConfig(config: OpenClawConfig): OpenClawConfig {
  const existingOrigins = config.gateway?.controlUi?.allowedOrigins ?? [];
  const allowedOrigins = Array.from(new Set([...existingOrigins, ADMINBOT_CONTROL_UI_ORIGIN]));
  const existingConnectSrc = config.gateway?.controlUi?.extraConnectSrc ?? [];
  const extraConnectSrc = Array.from(
    new Set([...existingConnectSrc, ...ADMINBOT_SERVICE_CONNECT_SRC_ORIGINS]),
  );
  return {
    ...config,
    gateway: {
      ...config.gateway,
      controlUi: {
        ...config.gateway?.controlUi,
        launchUrl: ADMINBOT_CONTROL_UI_LAUNCH_URL,
        allowedOrigins,
        extraConnectSrc,
      },
    },
  };
}

function validateUrl(value: string): string | undefined {
  return URL.canParse(value) ? undefined : t("wizard.adminbot.invalidUrl");
}

function validateNonEmpty(value: string): string | undefined {
  return value.trim() ? undefined : t("wizard.adminbot.required");
}

function validateEnvName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return t("wizard.adminbot.required");
  }
  return /\s/.test(trimmed) ? t("wizard.adminbot.invalidEnv") : undefined;
}

export function buildAdminBotSlackBinding(): AgentRouteBinding {
  return {
    type: "route",
    agentId: ADMINBOT_AGENT_ID,
    comment: "AdminBot setup: route unmatched Slack conversations to AdminBot.",
    match: { channel: "slack", accountId: "*" },
  };
}

export function applyAdminBotSetupConfig(
  config: OpenClawConfig,
  setup: AdminBotSetupConfig,
): AdminBotSetupResult {
  const nextPluginConfig = {
    ...adminBotPluginConfig(config),
    serviceBaseUrl: setup.serviceBaseUrl.trim(),
    serviceTokenEnv: setup.serviceTokenEnv.trim(),
    defaultDryRun: setup.defaultDryRun,
  };
  let nextConfig: OpenClawConfig = withAdminBotControlUiConfig({
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [ADMINBOT_PLUGIN_ID]: {
          ...config.plugins?.entries?.[ADMINBOT_PLUGIN_ID],
          enabled: true,
          config: nextPluginConfig,
        },
      },
    },
  });

  nextConfig = applyAgentConfig(nextConfig, {
    agentId: ADMINBOT_AGENT_ID,
    name: "AdminBot",
    workspace: setup.workspace.trim(),
    identity: {
      name: "AdminBot",
    },
  });

  const nextAgentList: AgentConfigEntry[] = [];
  for (const agent of nextConfig.agents?.list ?? []) {
    if (agent.id !== ADMINBOT_AGENT_ID) {
      nextAgentList.push(agent);
      continue;
    }
    nextAgentList.push({
      ...agent,
      model: ADMINBOT_LOCAL_MODEL,
      skills: [...ADMINBOT_SKILLS],
      tools: {
        ...removeExplicitAllow(agent.tools),
        profile: "minimal",
        alsoAllow: [...ADMINBOT_TOOLS],
        deny: [...ADMINBOT_DENIED_TOOLS],
        elevated: {
          ...agent.tools?.elevated,
          enabled: false,
        },
        exec: {
          ...agent.tools?.exec,
          mode: "deny",
        },
      },
    });
  }

  nextConfig = {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      list: nextAgentList,
    },
  };

  if (!setup.bindSlack) {
    return {
      config: nextConfig,
      slackBinding: { added: false, skipped: false, conflicts: [] },
    };
  }

  const bindingResult = applyAgentBindings(nextConfig, [buildAdminBotSlackBinding()]);
  return {
    config: bindingResult.config,
    slackBinding: {
      added: bindingResult.added.length > 0 || bindingResult.updated.length > 0,
      skipped: bindingResult.skipped.length > 0,
      conflicts: bindingResult.conflicts.map((conflict) => conflict.existingAgentId),
    },
  };
}

export async function setupAdminBot(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  workspaceDir: string;
}): Promise<OpenClawConfig> {
  const enabled = params.config.plugins?.entries?.[ADMINBOT_PLUGIN_ID]?.enabled === true;
  const shouldConfigure = await params.prompter.confirm({
    message: t("wizard.adminbot.enable"),
    initialValue: enabled,
  });
  if (!shouldConfigure) {
    return params.config;
  }

  await params.prompter.note(t("wizard.adminbot.intro"), t("wizard.adminbot.title"));

  const serviceBaseUrl = await params.prompter.text({
    message: t("wizard.adminbot.serviceBaseUrl"),
    initialValue: readStringConfig(params.config, "serviceBaseUrl", ADMINBOT_SERVICE_BASE_URL),
    validate: validateUrl,
  });
  const serviceTokenEnv = await params.prompter.text({
    message: t("wizard.adminbot.serviceTokenEnv"),
    initialValue: readStringConfig(params.config, "serviceTokenEnv", ADMINBOT_SERVICE_TOKEN_ENV),
    validate: validateEnvName,
  });
  const defaultDryRun = await params.prompter.confirm({
    message: t("wizard.adminbot.defaultDryRun"),
    initialValue: readBooleanConfig(params.config, "defaultDryRun", true),
  });
  const workspace = await params.prompter.text({
    message: t("wizard.adminbot.workspace"),
    initialValue: findAdminBotWorkspace(
      params.config,
      defaultAdminBotWorkspace(params.workspaceDir),
    ),
    validate: validateNonEmpty,
  });
  const bindSlack = await params.prompter.confirm({
    message: t("wizard.adminbot.bindSlack"),
    initialValue: hasSlackRouteToAdminBot(params.config) || !hasAnySlackRoute(params.config),
  });

  const result = applyAdminBotSetupConfig(params.config, {
    serviceBaseUrl,
    serviceTokenEnv,
    defaultDryRun,
    workspace,
    bindSlack,
  });

  const slackLine = bindSlack
    ? result.slackBinding.conflicts.length > 0
      ? t("wizard.adminbot.slackConflict", {
          agents: result.slackBinding.conflicts.join(", "),
        })
      : result.slackBinding.skipped
        ? t("wizard.adminbot.slackAlreadyConfigured")
        : t("wizard.adminbot.slackConfigured")
    : t("wizard.adminbot.slackSkipped");

  await params.prompter.note(
    `${t("wizard.adminbot.configured")}\n${slackLine}`,
    t("wizard.adminbot.title"),
  );

  return result.config;
}
