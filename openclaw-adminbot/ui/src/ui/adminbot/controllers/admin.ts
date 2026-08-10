import type { GatewayBrowserClient } from "../../gateway.ts";
import type { UiSettings } from "../../storage.ts";
// Control UI controller for the AdminBot dashboard surface.
import {
  type MemberNudgeChannel,
  type MemberProfileUpdate,
  approveActionAsMember,
  executeActionAsMember,
  removePendingAction,
  fetchMemberResource,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  sendOnboardingGuide as sendOnboardingGuideRequest,
  saveOwnPaper,
  sendMemberNudge,
  updateOwnProfile,
  upsertLabMemberAsAdmin,
} from "../auth/session.ts";
import type { AvailabilityRow, TimeOffRow } from "../data/availability.js";

export type AdminBotPrivilegeLevel = "external_collaborator" | "trial" | "member" | "admin";

// Mirrors `adminBotExternalCollaboratorSubgroups` in extensions/adminbot/src/contracts/actions.ts. Copied
// rather than imported for the same reason as AdminBotPrivilegeLevel above: the Control UI does not
// reach across the extensions boundary. Only meaningful while privilege_level is
// "external_collaborator" — the service rejects it on any other level and clears it on promotion.
export type AdminBotExternalCollaboratorSubgroup =
  | "interviewee"
  | "slightly_better_than_emails"
  | "acquaintance"
  | "alumni"
  | "coauthor_minor"
  | "coauthor_major"
  | "disappearing_coauthor"
  | "external_prof";

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
  collaborator_subgroup?: AdminBotExternalCollaboratorSubgroup;
  access: AdminBotAccessGrant[];
  role?: string;
  status?: AdminBotMemberStatus;
  research_branch?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  availability?: AvailabilityRow[];
  time_off?: TimeOffRow[];
  location?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
  // Self-attested checklist state (see extensions/adminbot/src/workflows/onboarding/onboarding.ts); the dashboard
  // only reads step id + status to preselect nudge recipients.
  onboarding?: { steps?: Array<{ id: string; status: string }> } | null;
  created_at: string;
  updated_at: string;
};

export type AdminBotSettings = {
  paper_escalation_business_days: number;
  head_professor_member_id?: string;
  head_professor_whatsapp?: string;
  applicant_sheet_id?: string;
  applicant_last_reviewed_at?: string;
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
  collaboratorSubgroup?: AdminBotExternalCollaboratorSubgroup;
  notes?: string;
  role?: string;
  status?: AdminBotMemberStatus;
  researchTopics?: string[];
  projects?: string[];
  hoursPerWeek?: number;
  availability?: string;
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

export type AdminBotOnboardingResult = {
  template_id: string;
  subject: string;
  body: string;
  sent: boolean;
  drive_folder_link?: string;
  slack_connect_link?: string;
};

export type AdminBotOnboardingHost = {
  onboardingTemplateId?: string;
  onboardingName?: string;
  onboardingEmail?: string;
  onboardingValues?: Record<string, string>;
  onboardingBusy?: boolean;
  onboardingError?: string | null;
  onboardingMissing?: string[];
  onboardingResult?: AdminBotOnboardingResult | null;
  settings: UiSettings;
};

/**
 * Previews or sends an onboarding guide.
 *
 * The service is the authority on whether this may happen at all: POST /onboarding/guide requires
 * an admin member session and rejects the shared service principal, so hiding the tab is only an
 * affordance and this call is not the permission check. The service also owns the "every required
 * value is present" rule, so a 422 comes back with the exact list and is rendered rather than
 * re-derived here.
 */
export async function sendOnboardingGuide(
  host: AdminBotOnboardingHost,
  options: { preview: boolean },
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.onboardingError = "Sign in again to send onboarding guides.";
    return;
  }
  host.onboardingBusy = true;
  host.onboardingError = null;
  host.onboardingMissing = [];
  if (!options.preview) {
    host.onboardingResult = null;
  }
  try {
    const result = await sendOnboardingGuideRequest(
      {
        templateId: host.onboardingTemplateId ?? "",
        name: host.onboardingName ?? "",
        email: host.onboardingEmail ?? "",
        values: host.onboardingValues ?? {},
        preview: options.preview,
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (result.ok) {
      host.onboardingResult = result.value;
      return;
    }
    if (result.kind === "missing") {
      host.onboardingMissing = result.missing;
      return;
    }
    host.onboardingError =
      result.kind === "unreachable"
        ? "The AdminBot service is unreachable — try again in a moment."
        : result.kind === "forbidden"
          ? "Only an admin can send onboarding guides."
          : // The service names the actual refusal -- unconfigured mail, Drive or Slack
            // provisioning that is not wired up, an unknown template. Show it: telling an admin to
            // "check the details" when the details are fine and the server is missing an
            // environment variable sends them round a loop nothing they type can break.
            result.kind === "rejected"
            ? result.message
            : "Couldn't send that guide — check the details and try again.";
  } finally {
    host.onboardingBusy = false;
  }
}

export type AdminBotSettingsSaveInput = {
  paper_escalation_business_days?: number;
  head_professor_member_id?: string;
  head_professor_whatsapp?: string;
  applicant_sheet_id?: string;
  applicant_last_reviewed_at?: string;
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
  // Set by the service when a member files a paper themselves; one of the signals that lets the
  // UI offer them the edit form.
  submitted_by_member_id?: string;
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

export type AdminBotDashboardMode = "admin" | "general";
export type AdminBotLoadMode = AdminBotDashboardMode | "members";

export type AdminBotDashboardData = {
  proposals: AdminBotActionProposal[];
  members: AdminBotLabMember[];
  papers: AdminBotPaperRecord[];
  nudges: AdminBotPaperNudge[];
  settings: AdminBotSettings | null;
  sensitiveInfo: AdminBotSensitiveInfoRecord | null;
  loadedAt: number | null;
  loadedMode: AdminBotLoadMode | null;
};

// Draft state for the "Announcements" compose form (member_nudge.send): channel + message text
// plus which members are currently checked. Filtering the recipient table stays pure client-side
// DOM hide/show (same pattern as the Lab Members and Papers filter forms); only the checked
// selection itself needs to survive across filter changes and re-renders, hence state here.
export type AdminBotMemberNudgeState = {
  channel: MemberNudgeChannel;
  message: string;
  subject: string;
  selectedMemberIds: string[];
  busy: boolean;
};

// The guest flow runs before any gateway connection exists, so it needs only the reimbursement
// slice of the host plus the resolved AdminBot origin -- deliberately not the full AdminBotHost,
// which would imply a client/session this path does not have.
export type GuestReimbursementHost = {
  adminBotReimbursement: AdminBotReimbursementState;
  guestReimbursementBaseUrl: string;
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
  adminBotMemberNudge: AdminBotMemberNudgeState;
  // Needed to resolve the AdminBot HTTP base URL for the direct admin-write path in
  // saveAdminBotMember — see the comment there for why this bypasses the gateway tool.
  settings: UiSettings;
};

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

export function createEmptyAdminBotMemberNudgeState(): AdminBotMemberNudgeState {
  return {
    channel: "slack",
    message: "",
    subject: "",
    selectedMemberIds: [],
    busy: false,
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
    loadedMode: null,
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

// Dashboard read path for a signed-in member. Members and papers are the two surfaces every
// signed-in person may read, so a failure there is a real error; the privileged extras (pending
// queue, nudges, settings, sensitive info) are fetched best-effort and simply stay empty for a
// member whose session the server refuses them to.
async function loadAdminBotOverSession(
  host: AdminBotHost,
  mode: AdminBotLoadMode,
  session: { sessionToken: string; baseUrl: string },
): Promise<void> {
  host.adminBotLoading = true;
  host.adminBotError = null;
  const read = async (path: string): Promise<unknown> => {
    const result = await fetchMemberResource(path, session.sessionToken, session.baseUrl);
    if (!result.ok) {
      throw new Error(
        result.kind === "unreachable" ? ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE : result.kind,
      );
    }
    return result.value;
  };
  const optional = async (path: string): Promise<unknown> => {
    const result = await fetchMemberResource(path, session.sessionToken, session.baseUrl);
    return result.ok ? result.value : undefined;
  };
  try {
    if (mode === "members") {
      const members = await read("/lab/members");
      host.adminBotData = {
        ...host.adminBotData,
        members: readArray<AdminBotLabMember>(members, "members"),
        loadedAt: Date.now(),
        loadedMode: host.adminBotData.loadedMode ?? "members",
      };
      return;
    }
    const [members, papers] = await Promise.all([read("/lab/members"), read("/papers")]);
    if (mode === "general") {
      host.adminBotData = {
        ...createEmptyAdminBotDashboardData(),
        members: readArray<AdminBotLabMember>(members, "members"),
        papers: readArray<AdminBotPaperRecord>(papers, "papers"),
        loadedAt: Date.now(),
        loadedMode: host.adminBotData.loadedMode === "admin" ? "admin" : "general",
      };
      return;
    }
    const [pending, nudges, settings, sensitiveInfo] = await Promise.all([
      optional("/proposals/pending?limit=50"),
      optional("/papers/nudges"),
      optional("/settings"),
      optional("/sensitive-info"),
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
      loadedMode: "admin",
    };
  } catch (err) {
    host.adminBotError = err instanceof Error ? err.message : String(err);
  } finally {
    host.adminBotLoading = false;
  }
}

export async function loadAdminBot(
  host: AdminBotHost,
  mode: AdminBotLoadMode = "admin",
): Promise<void> {
  // A signed-in member reads through their own session. The gateway tool path needs
  // operator.write, which a plain member's paired device deliberately does not hold, so for them
  // every tool call fails and the dashboard renders empty -- including after a successful save,
  // which is what made edits look like they never persisted.
  const stored = loadStoredMemberSession();
  if (stored) {
    await loadAdminBotOverSession(host, mode, {
      sessionToken: stored.sessionToken,
      baseUrl: resolveAdminBotBaseUrl(host.settings),
    });
    return;
  }
  const unavailable = adminBotUnavailableError(host);
  if (unavailable) {
    host.adminBotError = unavailable;
    host.adminBotLoading = false;
    return;
  }
  host.adminBotLoading = true;
  host.adminBotError = null;
  try {
    if (mode === "members") {
      const members = await invokeAdminBotTool(host, "adminbot_list_lab_members");
      host.adminBotData = {
        ...host.adminBotData,
        members: readArray<AdminBotLabMember>(members, "members"),
        loadedAt: Date.now(),
        loadedMode: host.adminBotData.loadedMode ?? "members",
      };
      return;
    }
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
        loadedMode: host.adminBotData.loadedMode === "admin" ? "admin" : "general",
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
      loadedMode: "admin",
    };
  } catch (err) {
    host.adminBotError = formatAdminBotToolError(err);
  } finally {
    host.adminBotLoading = false;
  }
}

function approvalFailureMessage(kind: string): string {
  if (kind === "unreachable") {
    return ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE;
  }
  if (kind === "forbidden") {
    return "Your session no longer has approval rights — sign in again and retry.";
  }
  if (kind === "rate-limited") {
    return "Too many attempts. Wait a moment and try again.";
  }
  return "Couldn't record this approval. Reload the pending list and try again.";
}

export async function approveAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    const approved = await approveActionAsMember(
      proposal.id,
      proposal.payload_hash,
      session.sessionToken,
      session.baseUrl,
    );
    if (!approved.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(approved.kind) };
      return;
    }
    // High-risk actions need a second distinct approver; stop here rather than executing an
    // action that is still pending quorum.
    if (approved.value.status !== "approved") {
      const need = approved.value.approval_requirement.min_approvals;
      const have = new Set(
        approved.value.approvals.map((entry) => entry.approver_id ?? entry.approver_role),
      ).size;
      host.adminBotNotice = {
        kind: "success",
        text: `Recorded your approval of ${proposal.id}. ${have} of ${need} approvals — another admin or core member must approve before it runs.`,
      };
      await loadAdminBot(host);
      return;
    }
    const executed = await executeActionAsMember(
      proposal.id,
      `control-ui-${proposal.id}`,
      session.sessionToken,
      session.baseUrl,
    );
    if (!executed.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(executed.kind) };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: `${executed.value.status === "executed" ? "Approved and executed" : "Approved and simulated"} ${proposal.id}.`,
    };
    await loadAdminBot(host);
  } finally {
    host.adminBotBusyActionId = null;
  }
}

// Approvals require a real privileged member session — the gateway service principal is
// rejected by the server (403) so that chat-driven privileged actions are impossible.
function requirePrivilegedSession(
  host: AdminBotHost,
): { sessionToken: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your lab account to approve or dismiss actions.",
    };
    return null;
  }
  return { sessionToken: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(host.settings) };
}

export async function removePendingAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    const removed = await removePendingAction(proposal.id, session.sessionToken, session.baseUrl);
    if (!removed.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(removed.kind) };
      return;
    }
    host.adminBotNotice = { kind: "success", text: "Removed " + proposal.id + "." };
    await loadAdminBot(host);
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
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    const executed = await executeActionAsMember(
      proposal.id,
      `control-ui-${proposal.id}`,
      session.sessionToken,
      session.baseUrl,
    );
    if (!executed.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(executed.kind) };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: `${executed.value.status === "executed" ? "Executed" : "Simulated"} ${proposal.id}.`,
    };
    await loadAdminBot(host);
  } finally {
    host.adminBotBusyActionId = null;
  }
}

function adminMemberUpdatePayload(member: AdminBotLabMemberSaveInput) {
  return {
    name: member.name,
    ...(member.email ? { email: member.email } : {}),
    ...(member.slackUserId ? { slack_user_id: member.slackUserId } : {}),
    ...(member.privilegeLevel ? { privilege_level: member.privilegeLevel } : {}),
    ...(member.collaboratorSubgroup ? { collaborator_subgroup: member.collaboratorSubgroup } : {}),
    ...(member.notes ? { notes: member.notes } : {}),
    ...(member.role ? { role: member.role } : {}),
    ...(member.status ? { status: member.status } : {}),
    ...(member.researchTopics ? { research_topics: member.researchTopics } : {}),
    ...(member.projects ? { projects: member.projects } : {}),
    ...(member.hoursPerWeek !== undefined ? { hours_per_week: member.hoursPerWeek } : {}),
    ...(member.availability !== undefined ? { availability: member.availability } : {}),
    ...(member.location ? { location: member.location } : {}),
    ...(member.affiliation ? { affiliation: member.affiliation } : {}),
    ...(member.timezone ? { timezone: member.timezone } : {}),
    ...(member.personalWebsite ? { personal_website: member.personalWebsite } : {}),
  };
}

// Saves a member from the Lab Members admin editor. Governance fields (privilege_level,
// status, email) can only ever be set by a genuine admin *member Bearer session* — the
// gateway-RPC tool path (adminbot_upsert_lab_member) always authenticates as the shared
// service principal regardless of who is signed in, and that principal is deliberately
// restricted to the same whitelist as a plain self-edit (the fix that closed the
// chat-based privilege-escalation hole). So a signed-in admin's edits here go straight to
// the AdminBot HTTP service with their own session token, bypassing the gateway tool
// entirely. Falls back to the gateway tool only when there's no stored member session at
// all (legacy break-glass access via the bare gateway token, predating member auth) —
// that path keeps today's already-restricted behavior rather than losing the save entirely.
export async function saveAdminBotMember(
  host: AdminBotHost,
  member: AdminBotLabMemberSaveInput,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (stored) {
    const result = await upsertLabMemberAsAdmin(
      member.id,
      adminMemberUpdatePayload(member),
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      const message =
        result.kind === "unreachable"
          ? ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : result.kind === "rate-limited"
              ? "Too many attempts. Wait a moment and try again."
              : "Couldn't save this member. Check the values and try again.";
      host.adminBotNotice = { kind: "error", text: message };
      return;
    }
    host.adminBotNotice = { kind: "success", text: `Saved member ${member.id}.` };
    await loadAdminBot(host);
    return;
  }
  try {
    await invokeAdminBotTool(host, "adminbot_upsert_lab_member", {
      id: member.id,
      name: member.name,
      ...(member.email ? { email: member.email } : {}),
      ...(member.slackUserId ? { slackUserId: member.slackUserId } : {}),
      ...(member.privilegeLevel ? { privilegeLevel: member.privilegeLevel } : {}),
      ...(member.collaboratorSubgroup ? { collaboratorSubgroup: member.collaboratorSubgroup } : {}),
      ...(member.notes ? { notes: member.notes } : {}),
      ...(member.role ? { role: member.role } : {}),
      ...(member.status ? { status: member.status } : {}),
      ...(member.researchTopics ? { researchTopics: member.researchTopics } : {}),
      ...(member.projects ? { projects: member.projects } : {}),
      ...(member.hoursPerWeek !== undefined ? { hoursPerWeek: member.hoursPerWeek } : {}),
      ...(member.availability !== undefined ? { availability: member.availability } : {}),
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

// Saves the signed-in member's own roster row from the Lab Members table. Uses the
// self-edit endpoint (PUT /lab/members/:id with a member Bearer session), whose server-side
// whitelist drops governance fields — so a plain member editing their own row can never
// reach the admin write path. Requires a real member session; break-glass gateway-token-only
// access has no signed-in member and never renders this affordance.
export async function saveAdminBotOwnProfile(
  host: AdminBotHost,
  memberId: string,
  fields: MemberProfileUpdate,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your member account to edit your profile.",
    };
    return;
  }
  const result = await updateOwnProfile(
    memberId,
    fields,
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (!result.ok) {
    const message =
      result.kind === "unreachable"
        ? ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE
        : result.kind === "rate-limited"
          ? "Too many attempts. Wait a moment and try again."
          : // 403 (editing someone else's id) folds into auth-failed here; the UI never
            // offers this affordance on another member's row, so it reads as a stale session.
            "Couldn't save your profile. Sign in again, check the values, and retry.";
    host.adminBotNotice = { kind: "error", text: message };
    return;
  }
  host.adminBotNotice = { kind: "success", text: "Saved your profile." };
  await loadAdminBot(host);
}

export function setAdminBotNudgeChannel(host: AdminBotHost, channel: MemberNudgeChannel): void {
  host.adminBotMemberNudge = { ...host.adminBotMemberNudge, channel };
}

export function setAdminBotNudgeMessage(host: AdminBotHost, message: string): void {
  host.adminBotMemberNudge = { ...host.adminBotMemberNudge, message };
}

export function setAdminBotNudgeSubject(host: AdminBotHost, subject: string): void {
  host.adminBotMemberNudge = { ...host.adminBotMemberNudge, subject };
}

export function toggleAdminBotNudgeRecipient(host: AdminBotHost, memberId: string): void {
  const selected = host.adminBotMemberNudge.selectedMemberIds;
  host.adminBotMemberNudge = {
    ...host.adminBotMemberNudge,
    selectedMemberIds: selected.includes(memberId)
      ? selected.filter((id) => id !== memberId)
      : [...selected, memberId],
  };
}

// Bulk-set the recipient list — used by "select all visible" (checks every filtered/visible row)
// and "clear" (empties it) in the Announcements recipient table.
export function setAdminBotNudgeRecipients(host: AdminBotHost, memberIds: string[]): void {
  host.adminBotMemberNudge = { ...host.adminBotMemberNudge, selectedMemberIds: memberIds };
}

// Sends the composed Announcements message to every selected recipient. Requires a real admin
// member session (same reasoning as saveAdminBotMember's direct-write path) since the server
// rejects this route outright for the shared service principal. Each recipient becomes its own
// member_nudge.send proposal awaiting pi/lab_manager approval in Pending actions — this never
// sends anything immediately.
export async function sendAdminBotMemberNudge(host: AdminBotHost): Promise<void> {
  host.adminBotNotice = null;
  const draft = host.adminBotMemberNudge;
  if (draft.busy) {
    return;
  }
  const message = draft.message.trim();
  if (!message) {
    host.adminBotNotice = { kind: "error", text: "Enter a message to send." };
    return;
  }
  if (draft.selectedMemberIds.length === 0) {
    host.adminBotNotice = { kind: "error", text: "Select at least one recipient." };
    return;
  }
  if (draft.channel === "email" && !draft.subject.trim()) {
    host.adminBotNotice = { kind: "error", text: "Enter a subject line for the email." };
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your admin account to send a nudge.",
    };
    return;
  }
  host.adminBotMemberNudge = { ...draft, busy: true };
  try {
    const result = await sendMemberNudge(
      {
        channel: draft.channel,
        recipient_member_ids: draft.selectedMemberIds,
        message,
        ...(draft.channel === "email" ? { subject: draft.subject.trim() } : {}),
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      const text =
        result.kind === "unreachable"
          ? ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : result.kind === "rate-limited"
              ? "Too many attempts. Wait a moment and try again."
              : "Couldn't send this nudge. Check the values and try again.";
      host.adminBotNotice = { kind: "error", text };
      return;
    }
    const { created, skipped } = result.value;
    const skippedNote =
      skipped.length > 0
        ? ` Skipped ${skipped.length}: ${skipped.map((entry) => entry.reason).join(", ")}.`
        : "";
    host.adminBotNotice = {
      kind: skipped.length > 0 ? "error" : "success",
      text: `Sent ${created.length} nudge${created.length === 1 ? "" : "s"}.${skippedNote}`,
    };
    host.adminBotMemberNudge = createEmptyAdminBotMemberNudgeState();
    await loadAdminBot(host);
  } finally {
    host.adminBotMemberNudge = { ...host.adminBotMemberNudge, busy: false };
  }
}

export async function saveAdminBotPaper(
  host: AdminBotHost,
  paper: AdminBotPaperSaveInput,
): Promise<void> {
  host.adminBotNotice = null;
  const artifacts = {
    ...(paper.overleafEditUrl ? { overleaf_edit_url: paper.overleafEditUrl } : {}),
    ...(paper.googleDrivePdfUrl ? { google_drive_pdf_url: paper.googleDrivePdfUrl } : {}),
    ...(paper.conference ? { conference: paper.conference } : {}),
    ...(paper.topic ? { topic: paper.topic } : {}),
  };
  // Prefer the member's own session: the service scopes the write to what that member may change
  // (any paper for an admin, their own for an author). The gateway tool path stays as the fallback
  // for break-glass sessions that hold a gateway token but no member login.
  const stored = loadStoredMemberSession();
  if (stored) {
    const saved = await saveOwnPaper(
      paper.id,
      {
        title: paper.title,
        authors: paper.authors,
        current_step: paper.currentStep,
        ...(Object.keys(artifacts).length > 0 ? { artifacts } : {}),
        ...(paper.reminderStatus ? { reminder: { status: paper.reminderStatus } } : {}),
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!saved.ok) {
      host.adminBotNotice = { kind: "error", text: paperSaveErrorText(saved.kind) };
      return;
    }
    host.adminBotNotice = { kind: "success", text: `Saved paper ${paper.id}.` };
    await loadAdminBot(host);
    return;
  }
  try {
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

function paperSaveErrorText(kind: string): string {
  switch (kind) {
    case "unreachable":
      return ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE;
    case "forbidden":
      return "You can only add or edit papers you authored.";
    case "rate-limited":
      return "Too many attempts. Wait a moment and try again.";
    default:
      return "Couldn't save this paper. Check the details and try again.";
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

// Narrowed to the slice it writes so the guest host (which has no client/session) can reuse it.
export function resetAdminBotReimbursement(
  host: Pick<AdminBotHost, "adminBotReimbursement">,
): void {
  host.adminBotReimbursement = createEmptyAdminBotReimbursementState();
}

const RECEIPT_MEDIA_TYPES_BY_EXTENSION: Record<
  string,
  "application/pdf" | "image/png" | "image/jpeg"
> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function resolveReceiptMediaType(
  file: File,
): "application/pdf" | "image/png" | "image/jpeg" | undefined {
  if (file.type === "application/pdf" || file.type === "image/png" || file.type === "image/jpeg") {
    return file.type;
  }
  const name = file.name.toLowerCase();
  const extension = Object.keys(RECEIPT_MEDIA_TYPES_BY_EXTENSION).find((candidate) =>
    name.endsWith(candidate),
  );
  return extension ? RECEIPT_MEDIA_TYPES_BY_EXTENSION[extension] : undefined;
}

// Guest (not-signed-in) reimbursement path. The signed-in flow reaches the workflow through the
// gateway's `tools.invoke`, which needs a connected gateway client and therefore a login; these two
// helpers talk to the AdminBot service's own HTTP routes instead, which accept anonymous callers.
// Everything else about the flow -- state shape, receipt encoding, error text -- stays shared, so
// the guest view and the signed-in view cannot drift apart.
async function guestReimbursementRequest(
  baseUrl: string,
  path: "/reimbursements/converse" | "/reimbursements/generate",
  payload: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      // No credentials: the route is anonymous, and sending them would be misleading.
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Could not reach the AdminBot service. Check that it is running.");
  }
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Too many reimbursement requests from this network. Try again later.");
    }
    throw new Error(body?.error?.message ?? `Reimbursement request failed (${response.status}).`);
  }
  return body;
}

export async function sendGuestReimbursementMessage(
  host: GuestReimbursementHost,
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
    const result = (await guestReimbursementRequest(
      host.guestReimbursementBaseUrl,
      "/reimbursements/converse",
      {
        message: userMessage,
        messages: host.adminBotReimbursement.messages,
        draft: host.adminBotReimbursement.draft,
        ...(receipts.length ? { receipts } : {}),
      },
    )) as ReimbursementConversationResult;
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

export async function generateGuestReimbursement(host: GuestReimbursementHost): Promise<void> {
  if (!host.adminBotReimbursement.ready || host.adminBotReimbursement.busy) return;
  host.adminBotReimbursement = { ...host.adminBotReimbursement, busy: true, error: null };
  try {
    const result = (await guestReimbursementRequest(
      host.guestReimbursementBaseUrl,
      "/reimbursements/generate",
      { draft: host.adminBotReimbursement.draft },
    )) as ReimbursementGenerationResult;
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

async function receiptPayload(file: File) {
  const mediaType = resolveReceiptMediaType(file);
  if (!mediaType) {
    throw new Error(`${file.name} is not a PDF, PNG, or JPEG file`);
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error(`${file.name} exceeds 12 MB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { name: file.name, media_type: mediaType, data_base64: btoa(binary) };
}
