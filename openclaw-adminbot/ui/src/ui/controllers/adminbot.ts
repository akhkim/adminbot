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

export type AdminBotMemberStatus = "active" | "part_time" | "on_leave" | "alumni" | "external";

export type AdminBotLabMember = {
  id: string;
  name: string;
  email?: string;
  slack_user_id?: string;
  notes?: string;
  privilege_level: AdminBotPrivilegeLevel;
  access: AdminBotAccessGrant[];
  role?: string;
  status?: AdminBotMemberStatus;
  research_branch?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  capacity_percent?: number;
  location?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
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
  role?: string;
  status?: AdminBotMemberStatus;
  researchBranch?: string;
  researchTopics?: string[];
  projects?: string[];
  hoursPerWeek?: number;
  capacityPercent?: number;
  location?: string;
  affiliation?: string;
  timezone?: string;
  personalWebsite?: string;
};

export type AdminBotPaperSaveInput = {
  id: string;
  title: string;
  authors: string[];
  currentStep: AdminBotPaperStep;
  overleafEditUrl?: string;
  googleDrivePdfUrl?: string;
  conference?: string;
  topic?: string;
  reminderStatus?: "idle" | "waiting_on_authors" | "blocked" | "complete";
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

export type AdminBotReimbursementArtifact = {
  filename: string;
  media_type: string;
  data_base64: string;
};

export type AdminBotReimbursementState = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  draft: Record<string, unknown>;
  missingFields: string[];
  receiptNames: string[];
  ready: boolean;
  busy: boolean;
  error: string | null;
  artifacts: AdminBotReimbursementArtifact[];
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
  adminBotReimbursement: AdminBotReimbursementState;
};

export type AdminBotLoadMode = "admin" | "general";

export function createEmptyAdminBotReimbursementState(): AdminBotReimbursementState {
  return {
    messages: [],
    draft: {},
    missingFields: [],
    receiptNames: [],
    ready: false,
    busy: false,
    error: null,
    artifacts: [],
  };
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

function unwrapAdminBotToolOutput(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  const record = readRecord(value);
  if (Object.hasOwn(record, "details") && record.details !== undefined) {
    return record.details;
  }
  if (Array.isArray(record.content)) {
    const textBlock = record.content.find(
      (entry) =>
        Boolean(entry) &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string",
    ) as { text?: string } | undefined;
    if (textBlock?.text) {
      try {
        return JSON.parse(textBlock.text);
      } catch {
        return textBlock.text;
      }
    }
  }
  return value;
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
  return unwrapAdminBotToolOutput(response.output);
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
    const [
      pendingResult,
      membersResult,
      papersResult,
      nudgesResult,
      settingsResult,
      sensitiveResult,
    ] = await Promise.allSettled([
      invokeAdminBotTool(host, "adminbot_list_pending_actions", { limit: 50 }),
      invokeAdminBotTool(host, "adminbot_list_lab_members"),
      invokeAdminBotTool(host, "adminbot_list_papers"),
      invokeAdminBotTool(host, "adminbot_list_paper_nudges"),
      invokeAdminBotTool(host, "adminbot_get_settings"),
      invokeAdminBotTool(host, "adminbot_get_sensitive_info"),
    ]);
    const essentialFailures = [membersResult, papersResult].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (essentialFailures.length > 0) {
      throw essentialFailures[0].reason;
    }
    const pending = pendingResult.status === "fulfilled" ? pendingResult.value : undefined;
    const members = membersResult.status === "fulfilled" ? membersResult.value : undefined;
    const papers = papersResult.status === "fulfilled" ? papersResult.value : undefined;
    const nudges = nudgesResult.status === "fulfilled" ? nudgesResult.value : undefined;
    const settings = settingsResult.status === "fulfilled" ? settingsResult.value : undefined;
    const sensitiveInfo =
      sensitiveResult.status === "fulfilled" ? sensitiveResult.value : undefined;
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
    const role = "admin";
    await invokeAdminBotTool(host, "adminbot_approve_action", {
      actionId: proposal.id,
      payloadHash: proposal.payload_hash,
      approverRole: role,
      approverId: "control-ui",
      controlUiConfirmed: true,
    });
    const result = (await invokeAdminBotTool(host, "adminbot_execute_approved_action", {
      actionId: proposal.id,
      idempotencyKey: `control-ui-${proposal.id}`,
      controlUiConfirmed: true,
    })) as AdminBotExecutionResult;
    host.adminBotNotice = {
      kind: "success",
      text: `${result.status === "executed" ? "Approved and executed" : "Approved and simulated"} ${proposal.id}.`,
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

export async function removePendingAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  try {
    await invokeAdminBotTool(host, "adminbot_remove_pending_action", {
      actionId: proposal.id,
      actor: "control-ui",
      controlUiConfirmed: true,
    });
    host.adminBotNotice = { kind: "success", text: "Removed " + proposal.id + "." };
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
      controlUiConfirmed: true,
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
      ...(member.role ? { role: member.role } : {}),
      ...(member.status ? { status: member.status } : {}),
      ...(member.researchBranch ? { researchBranch: member.researchBranch } : {}),
      ...(member.researchTopics ? { researchTopics: member.researchTopics } : {}),
      ...(member.projects ? { projects: member.projects } : {}),
      ...(member.hoursPerWeek !== undefined ? { hoursPerWeek: member.hoursPerWeek } : {}),
      ...(member.capacityPercent !== undefined ? { capacityPercent: member.capacityPercent } : {}),
      ...(member.location ? { location: member.location } : {}),
      ...(member.affiliation ? { affiliation: member.affiliation } : {}),
      ...(member.timezone ? { timezone: member.timezone } : {}),
      ...(member.personalWebsite ? { personalWebsite: member.personalWebsite } : {}),
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

export async function saveAdminBotPaper(
  host: AdminBotHost,
  paper: AdminBotPaperSaveInput,
): Promise<void> {
  host.adminBotNotice = null;
  try {
    const artifacts = {
      ...(paper.overleafEditUrl ? { overleaf_edit_url: paper.overleafEditUrl } : {}),
      ...(paper.googleDrivePdfUrl ? { google_drive_pdf_url: paper.googleDrivePdfUrl } : {}),
      ...(paper.conference ? { conference: paper.conference } : {}),
      ...(paper.topic ? { topic: paper.topic } : {}),
    };
    await invokeAdminBotTool(host, "adminbot_upsert_paper", {
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      currentStep: paper.currentStep,
      ...(Object.keys(artifacts).length > 0 ? { artifacts } : {}),
      ...(paper.reminderStatus ? { reminder: { status: paper.reminderStatus } } : {}),
    });
    host.adminBotNotice = { kind: "success", text: `Saved paper ${paper.id}.` };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  }
}

export async function deleteAdminBotPaper(
  host: AdminBotHost,
  paper: Pick<AdminBotPaperRecord, "id" | "title">,
): Promise<void> {
  host.adminBotBusyActionId = paper.id;
  host.adminBotNotice = null;
  try {
    await invokeAdminBotTool(host, "adminbot_delete_paper", { paperId: paper.id });
    host.adminBotNotice = { kind: "success", text: `Deleted paper ${paper.title}.` };
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

type ReimbursementConversationResult = {
  assistant_message: string;
  draft: Record<string, unknown>;
  missing_fields: string[];
  ready: boolean;
  receipt_names: string[];
};

type ReimbursementGenerationResult = {
  artifacts: AdminBotReimbursementArtifact[];
};

export async function sendAdminBotReimbursementMessage(
  host: AdminBotHost,
  message: string,
  files: File[],
): Promise<void> {
  const userMessage = message.trim();
  if (!userMessage || host.adminBotReimbursement.busy) return;
  host.adminBotReimbursement = {
    ...host.adminBotReimbursement,
    busy: true,
    error: null,
    artifacts: [],
  };
  try {
    const receipts = await Promise.all(files.map(receiptPayload));
    const result = (await invokeAdminBotTool(host, "adminbot_reimbursement_converse", {
      message: userMessage,
      messages: host.adminBotReimbursement.messages,
      draft: host.adminBotReimbursement.draft,
      ...(receipts.length ? { receipts } : {}),
    })) as ReimbursementConversationResult;
    host.adminBotReimbursement = {
      messages: [
        ...host.adminBotReimbursement.messages,
        { role: "user", content: userMessage },
        { role: "assistant", content: result.assistant_message },
      ],
      draft: readRecord(result.draft),
      missingFields: Array.isArray(result.missing_fields) ? result.missing_fields : [],
      receiptNames: [
        ...new Set([
          ...host.adminBotReimbursement.receiptNames,
          ...(Array.isArray(result.receipt_names) ? result.receipt_names : []),
        ]),
      ],
      ready: result.ready === true,
      busy: false,
      error: null,
      artifacts: [],
    };
  } catch (err) {
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

export async function generateAdminBotReimbursement(host: AdminBotHost): Promise<void> {
  if (!host.adminBotReimbursement.ready || host.adminBotReimbursement.busy) return;
  host.adminBotReimbursement = { ...host.adminBotReimbursement, busy: true, error: null };
  try {
    const result = (await invokeAdminBotTool(host, "adminbot_reimbursement_generate", {
      draft: host.adminBotReimbursement.draft,
    })) as ReimbursementGenerationResult;
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    };
  } catch (err) {
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

export function resetAdminBotReimbursement(host: AdminBotHost): void {
  host.adminBotReimbursement = createEmptyAdminBotReimbursementState();
}

async function receiptPayload(file: File) {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error(`${file.name} is not a PDF`);
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error(`${file.name} exceeds 12 MB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { name: file.name, media_type: "application/pdf", data_base64: btoa(binary) };
}
