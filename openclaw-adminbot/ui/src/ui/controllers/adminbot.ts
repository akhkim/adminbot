// Control UI controller for the AdminBot dashboard surface.
import type { GatewayBrowserClient } from "../gateway.ts";

export type AdminBotPrivilegeLevel =
  | "external_collaborator"
  | "trial"
  | "member"
  | "core_member"
  | "admin";

export type AdminBotAccessGrant = {
  service: string;
  access: "none" | "view" | "comment" | "edit" | "admin";
  scope?: string;
};

export type AdminBotLabMember = {
  id: string;
  name: string;
  email?: string;
  slack_user_id?: string;
  notes?: string;
  privilege_level: AdminBotPrivilegeLevel;
  access: AdminBotAccessGrant[];
  created_at: string;
  updated_at: string;
};

export type AdminBotSettings = {
  default_privilege_level: AdminBotPrivilegeLevel;
  paper_escalation_business_days: number;
  head_professor_member_id?: string;
  updated_at: string;
};

export type AdminBotSensitiveInfoRecord = {
  markdown: string;
  path?: string;
};

export type AdminBotLabMemberSaveInput = {
  id: string;
  name: string;
  email?: string;
  slackUserId?: string;
  privilegeLevel?: AdminBotPrivilegeLevel;
  notes?: string;
};

export type AdminBotSettingsSaveInput = {
  default_privilege_level?: AdminBotPrivilegeLevel;
  paper_escalation_business_days?: number;
  head_professor_member_id?: string;
};

export type AdminBotPaperStep =
  | "brainstorming_docs"
  | "overleaf_writing"
  | "submission"
  | "google_drive_pdf"
  | "arxiv_polish"
  | "social_posts"
  | "slide_making"
  | "poster_making";
export type AdminBotPaperTimelineItem = {
  step: AdminBotPaperStep;
  label: string;
  dependency_group: string;
  depends_on: AdminBotPaperStep[];
  status: "complete" | "current" | "upcoming" | "blocked";
  offset_start_business_day: number;
  offset_end_business_day: number;
  duration_business_days: number;
  color: string;
};

export type AdminBotPaperTimeline = {
  progress_percent: number;
  current_step_index: number;
  total_estimated_business_days: number;
  items: AdminBotPaperTimelineItem[];
};

export type AdminBotPaperRecord = {
  id: string;
  title: string;
  authors: string[];
  current_step: AdminBotPaperStep;
  artifacts?: Record<string, string | undefined>;
  mentor_member_id?: string;
  checks?: Record<string, boolean | undefined>;
  reminder?: {
    status?: string;
    requested_step_at?: string;
    last_author_dm_at?: string;
    last_author_reply_at?: string;
    next_nudge_at?: string;
    escalation_after_business_days?: number;
    head_professor_member_id?: string;
  };
  notes?: string;
  timeline?: AdminBotPaperTimeline;
  created_at: string;
  updated_at: string;
};

export type AdminBotActionProposal = {
  id: string;
  type: string;
  risk_tier: "T0" | "T1" | "T2" | "T3" | "T4";
  summary: string;
  status: "pending" | "approved" | "executed" | "rejected";
  payload_hash: string;
  approval_requirement: {
    requires_approval: boolean;
    approver_roles: string[];
    min_approvals: number;
  };
  approvals: Array<{ approver_role: string; approver_id?: string; note?: string }>;
  created_at: string;
  updated_at: string;
};

export type AdminBotPaperNudge = {
  type: "author_nudge" | "head_professor_escalation";
  paper_id: string;
  title: string;
  step: AdminBotPaperStep;
  recipients: string[];
  message: string;
  business_days_since_author_dm?: number;
  timeline?: AdminBotPaperTimeline;
};

export type AdminBotExecutionResult = {
  action_id: string;
  status: "simulated" | "executed";
  dry_run: boolean;
  idempotency_key?: string;
  executed_at: string;
};

export type AdminBotDashboardData = {
  proposals: AdminBotActionProposal[];
  members: AdminBotLabMember[];
  papers: AdminBotPaperRecord[];
  nudges: AdminBotPaperNudge[];
  settings: AdminBotSettings | null;
  sensitiveInfo: AdminBotSensitiveInfoRecord | null;
  loadedAt: number | null;
};

export type AdminBotHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  adminBotLoading: boolean;
  adminBotError: string | null;
  adminBotData: AdminBotDashboardData;
  adminBotBusyActionId: string | null;
  adminBotNotice: { kind: "success" | "error"; text: string } | null;
};

export type AdminBotLoadMode = "admin" | "general";

export function resolveAdminBotLoadMode(password: string | null | undefined): AdminBotLoadMode {
  return password?.trim() === "jinesis" ? "general" : "admin";
}

type ToolsInvokeResult = {
  ok: boolean;
  toolName: string;
  output?: unknown;
  error?: { code: string; message: string };
};

const ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE =
  "AdminBot tools are not available in this Gateway. Enable the adminbot plugin for the adminbot agent, then restart or reload OpenClaw.";

export function createEmptyAdminBotDashboardData(): AdminBotDashboardData {
  return {
    proposals: [],
    members: [],
    papers: [],
    nudges: [],
    settings: null,
    sensitiveInfo: null,
    loadedAt: null,
  };
}

function adminBotUnavailableError(host: Pick<AdminBotHost, "connected" | "client">): string | null {
  if (!host.connected) {
    return "Gateway is not connected.";
  }
  if (!host.client) {
    return "Gateway client is not ready.";
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, key: string): string | undefined {
  const record = readRecord(value);
  const raw = record[key];
  return typeof raw === "string" ? raw : undefined;
}

function formatAdminBotToolError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/tool not available:\s*adminbot_/iu.test(message) || /unknown tool/iu.test(message)) {
    return ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE;
  }
  return message;
}

async function invokeAdminBotTool(
  host: AdminBotHost,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const unavailable = adminBotUnavailableError(host);
  if (unavailable) {
    throw new Error(unavailable);
  }
  const client = host.client;
  if (!client) {
    throw new Error("Gateway client is not ready.");
  }
  const response = await client.request<ToolsInvokeResult>("tools.invoke", {
    name,
    agentId: "adminbot",
    args,
  });
  if (!response.ok) {
    throw new Error(formatAdminBotToolError(response.error?.message ?? `${name} failed`));
  }
  return response.output;
}

function readArray<T>(value: unknown, key: string): T[] {
  const record = readRecord(value);
  const raw = record[key];
  return Array.isArray(raw) ? (raw as T[]) : [];
}

export async function loadAdminBot(
  host: AdminBotHost,
  mode: AdminBotLoadMode = "admin",
): Promise<void> {
  const unavailable = adminBotUnavailableError(host);
  if (unavailable) {
    host.adminBotError = unavailable;
    host.adminBotLoading = false;
    return;
  }
  host.adminBotLoading = true;
  host.adminBotError = null;
  try {
    if (mode === "general") {
      const [members, papers] = await Promise.all([
        invokeAdminBotTool(host, "adminbot_list_lab_members"),
        invokeAdminBotTool(host, "adminbot_list_papers"),
      ]);
      host.adminBotData = {
        ...createEmptyAdminBotDashboardData(),
        members: readArray<AdminBotLabMember>(members, "members"),
        papers: readArray<AdminBotPaperRecord>(papers, "papers"),
        loadedAt: Date.now(),
      };
      return;
    }
    const [pending, members, papers, nudges, settings, sensitiveInfo] = await Promise.all([
      invokeAdminBotTool(host, "adminbot_list_pending_actions", { limit: 50 }),
      invokeAdminBotTool(host, "adminbot_list_lab_members"),
      invokeAdminBotTool(host, "adminbot_list_papers"),
      invokeAdminBotTool(host, "adminbot_list_paper_nudges"),
      invokeAdminBotTool(host, "adminbot_get_settings"),
      invokeAdminBotTool(host, "adminbot_get_sensitive_info"),
    ]);
    const settingsRecord = readRecord(settings);
    const sensitiveInfoRecord = readRecord(sensitiveInfo);
    const markdown = readString(sensitiveInfoRecord, "markdown");
    const filePath = readString(sensitiveInfoRecord, "path");
    host.adminBotData = {
      proposals: readArray<AdminBotActionProposal>(pending, "proposals"),
      members: readArray<AdminBotLabMember>(members, "members"),
      papers: readArray<AdminBotPaperRecord>(papers, "papers"),
      nudges: readArray<AdminBotPaperNudge>(nudges, "nudges"),
      settings:
        Object.keys(settingsRecord).length > 0 ? (settingsRecord as AdminBotSettings) : null,
      sensitiveInfo: markdown ? { markdown, ...(filePath ? { path: filePath } : {}) } : null,
      loadedAt: Date.now(),
    };
  } catch (err) {
    host.adminBotError = formatAdminBotToolError(err);
  } finally {
    host.adminBotLoading = false;
  }
}

export async function approveAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  try {
    const role = proposal.approval_requirement.approver_roles[0] ?? "pi";
    await invokeAdminBotTool(host, "adminbot_approve_action", {
      actionId: proposal.id,
      payloadHash: proposal.payload_hash,
      approverRole: role,
      approverId: "control-ui",
    });
    host.adminBotNotice = { kind: "success", text: `Approved ${proposal.id}.` };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  } finally {
    host.adminBotBusyActionId = null;
  }
}

export async function executeAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  try {
    const result = (await invokeAdminBotTool(host, "adminbot_execute_approved_action", {
      actionId: proposal.id,
      idempotencyKey: `control-ui-${proposal.id}`,
    })) as AdminBotExecutionResult;
    host.adminBotNotice = {
      kind: "success",
      text: `${result.status === "executed" ? "Executed" : "Simulated"} ${proposal.id}.`,
    };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  } finally {
    host.adminBotBusyActionId = null;
  }
}

export async function saveAdminBotMember(
  host: AdminBotHost,
  member: AdminBotLabMemberSaveInput,
): Promise<void> {
  host.adminBotNotice = null;
  try {
    await invokeAdminBotTool(host, "adminbot_upsert_lab_member", {
      id: member.id,
      name: member.name,
      ...(member.email ? { email: member.email } : {}),
      ...(member.slackUserId ? { slackUserId: member.slackUserId } : {}),
      ...(member.privilegeLevel ? { privilegeLevel: member.privilegeLevel } : {}),
      ...(member.notes ? { notes: member.notes } : {}),
    });
    host.adminBotNotice = { kind: "success", text: `Saved member ${member.id}.` };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  }
}

export async function saveAdminBotSettings(
  host: AdminBotHost,
  settings: AdminBotSettingsSaveInput,
): Promise<void> {
  host.adminBotNotice = null;
  try {
    await invokeAdminBotTool(host, "adminbot_update_settings", settings);
    host.adminBotNotice = { kind: "success", text: "Saved AdminBot settings." };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  }
}

export async function saveAdminBotSensitiveInfo(
  host: AdminBotHost,
  markdown: string,
): Promise<void> {
  host.adminBotNotice = null;
  try {
    await invokeAdminBotTool(host, "adminbot_update_sensitive_info", { markdown });
    host.adminBotNotice = { kind: "success", text: "Saved sensitive-information markdown." };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  }
}
