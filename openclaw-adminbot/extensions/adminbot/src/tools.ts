import { selectUnreviewedApplicants } from "./applicant-sheet.js";
import { resolveCalendarSource } from "./calendar-source.js";
import { AdminBotClient, type AdminBotClientConfig, type FetchLike } from "./client.js";
import type {
  AdminBotActionProposal,
  AdminBotActionType,
  AdminBotAccessGrant,
  AdminBotEvidencePointer,
  AdminBotExternalCollaboratorSubgroup,
  AdminBotLabMemberInput,
  AdminBotLabMember,
  AdminBotPaperRecordInput,
  AdminBotPaperRecord,
  AdminBotPaperStep,
  AdminBotPrivilegeLevel,
  AdminBotRiskTier,
  AdminBotSensitiveInfoRecord,
  AdminBotSettingsInput,
} from "./contracts.js";
import { readGogSheetRows } from "./gog-executor.js";
import { buildOverleafEditPayload, type AdminBotOverleafEditMode } from "./overleaf-editing.js";
import type {
  AdminBotReimbursementMessage,
  AdminBotReimbursementReceipt,
} from "./reimbursement-workflow.js";
import { buildPaperSocialPayload, type AdminBotSocialPlatform } from "./social-posting.js";

export type AdminBotPluginConfig = {
  serviceBaseUrl: string;
  serviceTokenEnv?: string;
  allowInsecureRemoteService: boolean;
  defaultDryRun: boolean;
};

export const defaultAdminBotConfig = {
  serviceBaseUrl: "http://127.0.0.1:8765",
  serviceTokenEnv: "ADMINBOT_SERVICE_TOKEN",
  allowInsecureRemoteService: false,
  defaultDryRun: false,
} satisfies AdminBotPluginConfig;

type ToolFactoryOptions = {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  readSheetRows?: typeof readGogSheetRows;
};

type EvidenceParams = {
  evidence?: AdminBotEvidencePointer[];
};

type PrivacyTaskParams = {
  task: string;
  privacy?: "auto" | "private";
  sensitiveTerms?: string[];
};

type GenericProposalParams = EvidenceParams & {
  type: AdminBotActionType;
  summary: string;
  target?: Record<string, unknown>;
  proposedPayload?: unknown;
  riskTier?: AdminBotRiskTier;
  rationale?: string;
  undoPlan?: string;
  idempotencyKey?: string;
};

type CandidateDecisionParams = EvidenceParams & {
  decision: "accept_for_trial" | "accept_direct" | "decline";
  candidateName: string;
  candidateEmail?: string;
  summary: string;
  rationale?: string;
  proposedPayload?: unknown;
};

type SocialPostParams = EvidenceParams & {
  subject: string;
  sourceWork: string;
  audience?: string;
  tone?: string;
};

type PaperSocialPostParams = EvidenceParams & {
  paperId?: string;
  title?: string;
  summary: string;
  url?: string;
  authors?: string[];
  tone?: string;
  hashtags?: string[];
  platforms?: AdminBotSocialPlatform[];
  linkedinVisibility?: "PUBLIC" | "CONNECTIONS";
  idempotencyKey?: string;
};

type PaperOverleafEditParams = EvidenceParams & {
  paperId?: string;
  title?: string;
  authors?: string[];
  overleafEditUrl?: string;
  requestedEdits: string;
  targetFiles?: string[];
  mode?: AdminBotOverleafEditMode;
  policySource?: string;
  idempotencyKey?: string;
};

type ReimbursementParams = EvidenceParams & {
  claimant: string;
  expenseSummary: string;
  amount?: string;
  proposedPayload?: unknown;
};

type ReimbursementConversationParams = {
  message: string;
  receipts?: AdminBotReimbursementReceipt[];
  messages?: AdminBotReimbursementMessage[];
  draft?: Record<string, unknown>;
};
type CalendarParams = EvidenceParams & {
  changeType: "tentative_hold" | "send_invite" | "reschedule" | "cancel";
  summary?: string;
  attendees?: string[];
  timeWindow?: string;
  proposedPayload?: unknown;
  sourceUrl?: string;
  calendarUrl?: string;
  calendarName?: "personal" | "jinesis";
  emailMessageId?: string;
  emailQuery?: string;
};

type SlackMessageParams = EvidenceParams & {
  target: string;
  message: string;
  channel?: string;
  recipientName?: string;
  threadTs?: string;
  summary?: string;
  proposedPayload?: unknown;
  idempotencyKey?: string;
};

type JoinFormParams = {
  responseId: string;
  applicantName?: string;
  answers: Record<string, unknown>;
  rubric?: string;
};

type LabMemberParams = {
  id: string;
  name: string;
  email?: string;
  slackUserId?: string;
  privilegeLevel?: AdminBotPrivilegeLevel;
  collaboratorSubgroup?: AdminBotExternalCollaboratorSubgroup;
  accessOverrides?: AdminBotAccessGrant[];
  notes?: string;
  role?: string;
  status?: AdminBotLabMemberInput["status"];
  researchBranch?: string;
  researchTopics?: string[];
  projects?: string[];
  hoursPerWeek?: number;
  location?: string;
  affiliation?: string;
  timezone?: string;
  personalWebsite?: string;
  openreviewId?: string;
  reviewerExempt?: boolean;
};

type PaperParams = {
  id: string;
  title: string;
  authors: string[];
  currentStep: AdminBotPaperStep;
  artifacts?: AdminBotPaperRecordInput["artifacts"];
  mentorMemberId?: string;
  checks?: AdminBotPaperRecordInput["checks"];
  reminder?: AdminBotPaperRecordInput["reminder"];
  notes?: string;
};
type PaperNudgeParams = EvidenceParams & {
  paperId: string;
  recipientMemberId?: string;
  slackTarget?: string;
  message?: string;
  idempotencyKey?: string;
};

export function createAdminBotToolHandlers(
  config: AdminBotPluginConfig,
  options: ToolFactoryOptions = {},
) {
  const client = new AdminBotClient(toClientConfig(config), options.fetchImpl, options.env);
  const signal = options.signal;
  return {
    runEmailAutomation: () => client.runEmailAutomation(signal),
    converseReimbursement: (params: ReimbursementConversationParams) =>
      client.converseReimbursement(params, signal),
    generateReimbursement: (params: { draft: Record<string, unknown> }) =>
      client.generateReimbursement(params.draft, signal),
    reason: (params: PrivacyTaskParams) =>
      client.runPrivacyTask(
        {
          task: params.task,
          ...(params.privacy ? { privacy: params.privacy } : {}),
          ...(params.sensitiveTerms ? { sensitive_terms: params.sensitiveTerms } : {}),
        },
        signal,
      ),
    proposeAction: (params: GenericProposalParams) =>
      client.createProposal(
        {
          type: params.type,
          summary: params.summary,
          ...(params.target ? { target: params.target } : {}),
          ...(params.evidence ? { evidence: params.evidence } : {}),
          ...(params.proposedPayload !== undefined
            ? { proposed_payload: params.proposedPayload }
            : {}),
          ...(params.riskTier ? { risk_tier: params.riskTier } : {}),
          ...(params.rationale ? { rationale: params.rationale } : {}),
          ...(params.undoPlan ? { undo_plan: params.undoPlan } : {}),
          ...(params.idempotencyKey ? { idempotency_key: params.idempotencyKey } : {}),
        },
        signal,
      ),
    proposeCandidateDecision: (params: CandidateDecisionParams) =>
      client.createProposal(candidateDecisionProposal(params), signal),
    draftSocialPost: (params: SocialPostParams) =>
      client.createProposal(
        {
          type: "social_media.draft",
          risk_tier: "T1",
          summary: `Draft social post: ${params.subject}`,
          target: {
            subject: params.subject,
            sourceWork: params.sourceWork,
            ...(params.audience ? { audience: params.audience } : {}),
            ...(params.tone ? { tone: params.tone } : {}),
          },
          evidence: params.evidence,
          proposed_payload: {
            subject: params.subject,
            sourceWork: params.sourceWork,
            audience: params.audience,
            tone: params.tone,
          },
        },
        signal,
      ),
    preparePaperSocialPosts: async (params: PaperSocialPostParams) => {
      const [membersResult, papersResult] = await Promise.all([
        client.listLabMembers(signal),
        params.paperId ? client.listPapers(signal) : Promise.resolve(undefined),
      ]);
      const members = readArray<AdminBotLabMember>(membersResult, "members");
      const paper = params.paperId
        ? readArray<AdminBotPaperRecord>(papersResult, "papers").find(
            (entry) => entry.id === params.paperId,
          )
        : undefined;
      if (params.paperId && !paper && !params.title) {
        throw new Error(
          `paper ${params.paperId} was not found; provide title/authors/url explicitly`,
        );
      }
      const payload = buildPaperSocialPayload({
        paper,
        paperId: params.paperId,
        title: params.title,
        summary: params.summary,
        url: params.url,
        authors: params.authors,
        tone: params.tone,
        hashtags: params.hashtags,
        platforms: params.platforms,
        linkedinVisibility: params.linkedinVisibility,
        members,
      });
      const missing = payload.tags.missing.length
        ? ` Missing tags: ${payload.tags.missing
            .map((entry) => `${entry.name} (${entry.platform})`)
            .join(", ")}.`
        : "";
      return client.createProposal(
        {
          type: "social_media.post_publicly",
          risk_tier: "T4",
          summary: `Publish LinkedIn/X posts for paper: ${payload.paper.title}.${missing}`,
          target: {
            paper: payload.paper,
            platforms: payload.platforms,
            missing_tags: payload.tags.missing,
          },
          evidence: params.evidence,
          proposed_payload: payload,
          undo_plan:
            "Delete or correct the social posts manually in LinkedIn and X; if already indexed or reshared, publish a correction thread/post.",
          ...(params.idempotencyKey ? { idempotency_key: params.idempotencyKey } : {}),
        },
        signal,
      );
    },
    prepareOverleafPaperEdit: async (params: PaperOverleafEditParams) => {
      const [membersResult, papersResult] = await Promise.all([
        client.listLabMembers(signal),
        params.paperId ? client.listPapers(signal) : Promise.resolve(undefined),
      ]);
      const members = readArray<AdminBotLabMember>(membersResult, "members");
      const paper = params.paperId
        ? readArray<AdminBotPaperRecord>(papersResult, "papers").find(
            (entry) => entry.id === params.paperId,
          )
        : undefined;
      if (params.paperId && !paper && !params.title) {
        throw new Error(
          `paper ${params.paperId} was not found; provide title/authors/overleafEditUrl explicitly`,
        );
      }
      const payload = buildOverleafEditPayload({
        paper,
        paperId: params.paperId,
        title: params.title,
        authors: params.authors,
        overleafEditUrl: params.overleafEditUrl,
        requestedEdits: params.requestedEdits,
        targetFiles: params.targetFiles,
        mode: params.mode,
        members,
        policySource: params.policySource,
      });
      const issues =
        payload.affiliationPolicy?.issues.filter((issue) => issue.status !== "ok") ?? [];
      const issueSummary = issues.length
        ? ` Confirmation needed: ${issues
            .map((issue) => `${issue.author} (${issue.status})`)
            .join(", ")}.`
        : "";
      return client.createProposal(
        {
          type: "paper.overleaf_edit",
          risk_tier: "T4",
          summary: `Edit Overleaf paper: ${payload.paper.title}.${issueSummary}`,
          target: {
            paper: payload.paper,
            mode: payload.mode,
            target_files: payload.targetFiles,
            affiliation_issues: payload.affiliationPolicy?.issues ?? [],
          },
          evidence: params.evidence,
          proposed_payload: payload,
          rationale:
            payload.mode === "affiliation_check"
              ? "Affiliation-sensitive paper edits require explicit review against the supplied policy and member list before Overleaf is changed."
              : "Overleaf project source edits require explicit approval before applying changes.",
          undo_plan:
            "Use Overleaf project history to revert the edited files, or apply a follow-up corrective commit/edit in Overleaf.",
          ...(params.idempotencyKey ? { idempotency_key: params.idempotencyKey } : {}),
        },
        signal,
      );
    },
    prepareReimbursementPacket: (params: ReimbursementParams) =>
      client.createProposal(
        {
          type: "reimbursement.prepare_packet",
          risk_tier: "T1",
          summary: `Prepare reimbursement packet for ${params.claimant}`,
          target: {
            claimant: params.claimant,
            expenseSummary: params.expenseSummary,
            ...(params.amount ? { amount: params.amount } : {}),
          },
          evidence: params.evidence,
          proposed_payload: params.proposedPayload ?? {
            claimant: params.claimant,
            expenseSummary: params.expenseSummary,
            amount: params.amount,
          },
        },
        signal,
      ),
    suggestCalendarChange: async (params: CalendarParams) => {
      const resolved = await resolveCalendarSource(params, options.env ?? process.env);
      const normalized = normalizeCalendarProposalParams({
        ...params,
        ...resolved,
        evidence: resolved.evidence,
      });
      return await client.createProposal(calendarProposal(normalized), signal);
    },
    proposeSlackMessage: (params: SlackMessageParams) =>
      client.createProposal(slackMessageProposal(params), signal),
    classifyJoinFormResponse: (params: JoinFormParams) =>
      client.createProposal(
        {
          type: "join_form.classify",
          risk_tier: "T0",
          summary: `Classify join-the-lab form response ${params.responseId}`,
          target: {
            responseId: params.responseId,
            ...(params.applicantName ? { applicantName: params.applicantName } : {}),
          },
          evidence: [{ source: "google_form", id: params.responseId }],
          proposed_payload: {
            answers: params.answers,
            rubric: params.rubric,
          },
        },
        signal,
      ),
    upsertLabMember: (params: LabMemberParams) =>
      client.upsertLabMember(labMemberRecord(params), signal),
    listLabMembers: () => client.listLabMembers(signal),
    getSettings: () => client.getSettings(signal),
    updateSettings: (params: AdminBotSettingsInput) => client.updateSettings(params, signal),
    listUnreviewedApplicants: async (params: { since?: string; sheetRange?: string }) => {
      const settings = readRecord(await client.getSettings(signal));
      const sheetId = readString(settings, "applicant_sheet_id");
      if (!sheetId) {
        throw new Error(
          "no applicant sheet configured, set it in AdminBot settings first (applicant_sheet_id)",
        );
      }
      const since = params.since?.trim() || readString(settings, "applicant_last_reviewed_at");
      const readSheetRows = options.readSheetRows ?? readGogSheetRows;
      const rows = await readSheetRows(sheetId, {
        ...(options.env ? { env: options.env } : {}),
        ...(params.sheetRange ? { range: params.sheetRange } : {}),
      });
      return {
        sheet_id: sheetId,
        ...(since ? { since } : {}),
        applicants: selectUnreviewedApplicants(rows, since),
      };
    },
    markApplicantsReviewed: (params: { reviewedAt?: string }) =>
      client.updateSettings(
        { applicant_last_reviewed_at: params.reviewedAt?.trim() || new Date().toISOString() },
        signal,
      ),
    getSensitiveInfo: (): Promise<AdminBotSensitiveInfoRecord> => client.getSensitiveInfo(signal),
    updateSensitiveInfo: (params: { markdown: string }): Promise<AdminBotSensitiveInfoRecord> =>
      client.updateSensitiveInfo(params.markdown, signal),
    upsertPaper: (params: PaperParams) => client.upsertPaper(paperRecord(params), signal),
    deletePaper: (params: { paperId: string }) => client.deletePaper(params.paperId, signal),
    listPapers: () => client.listPapers(signal),
    listPaperNudges: (params: { nowIso?: string }) => client.listPaperNudges(params.nowIso, signal),
    listOpenReviewStatus: () => client.listOpenReviewStatus(signal),
    runOpenReviewCycle: (params: { send?: boolean }) =>
      client.runOpenReviewCycle(params.send === true, signal),
    suggestOpenReviewReviewers: (params: { venueId: string }) =>
      client.suggestOpenReviewReviewers(params.venueId, signal),
    proposePaperNudge: async (params: PaperNudgeParams) => {
      const [papersResult, membersResult, settingsResult] = await Promise.all([
        client.listPapers(signal),
        client.listLabMembers(signal),
        client.getSettings(signal),
      ]);
      const paper = readArray<AdminBotPaperRecord>(papersResult, "papers").find(
        (entry) => entry.id === params.paperId,
      );
      if (!paper) {
        throw new Error(`paper ${params.paperId} was not found`);
      }
      const members = readArray<AdminBotLabMember>(membersResult, "members");
      const settings = readRecord(settingsResult);
      const recipientMemberId =
        params.recipientMemberId ?? readString(settings, "head_professor_member_id");
      if (!recipientMemberId) {
        throw new Error(
          "recipientMemberId is required when AdminBot settings do not define head_professor_member_id",
        );
      }
      const recipient = members.find((member) => member.id === recipientMemberId);
      const slackTarget = params.slackTarget ?? slackTargetForMember(recipient);
      if (!slackTarget) {
        throw new Error(
          `Slack target is required for ${recipientMemberId}; add slack_user_id to the member record or pass slackTarget`,
        );
      }
      return client.createProposal(
        paperNudgeProposal({
          paper,
          recipientMemberId,
          recipientName: recipient?.name,
          slackTarget,
          message: params.message,
          evidence: params.evidence,
          idempotencyKey: params.idempotencyKey,
        }),
        signal,
      );
    },
    listPendingActions: (params: { limit?: number }) => client.listPending(params.limit, signal),
    approveAction: (params: {
      actionId: string;
      payloadHash: string;
      approverRole: string;
      approverId?: string;
      note?: string;
    }) =>
      client.approve(
        params.actionId,
        {
          payload_hash: params.payloadHash,
          approver_role: params.approverRole,
          ...(params.approverId ? { approver_id: params.approverId } : {}),
          ...(params.note ? { note: params.note } : {}),
        },
        signal,
      ),
    removePendingAction: (params: { actionId: string; actor?: string; note?: string }) =>
      client.removePending(
        params.actionId,
        {
          ...(params.actor ? { actor: params.actor } : {}),
          ...(params.note ? { note: params.note } : {}),
        },
        signal,
      ),
    executeApprovedAction: (params: { actionId: string; idempotencyKey?: string }) =>
      client.execute(
        params.actionId,
        params.idempotencyKey ? { idempotency_key: params.idempotencyKey } : {},
        signal,
      ),
  };
}

function toClientConfig(config: AdminBotPluginConfig): AdminBotClientConfig {
  return {
    serviceBaseUrl: config.serviceBaseUrl,
    serviceTokenEnv: config.serviceTokenEnv,
    allowInsecureRemoteService: config.allowInsecureRemoteService,
    defaultDryRun: config.defaultDryRun,
  };
}

function labMemberRecord(params: LabMemberParams): AdminBotLabMemberInput {
  return {
    id: params.id,
    name: params.name,
    ...(params.privilegeLevel ? { privilege_level: params.privilegeLevel } : {}),
    ...(params.collaboratorSubgroup ? { collaborator_subgroup: params.collaboratorSubgroup } : {}),
    ...(params.email ? { email: params.email } : {}),
    ...(params.slackUserId ? { slack_user_id: params.slackUserId } : {}),
    ...(params.accessOverrides ? { access_overrides: params.accessOverrides } : {}),
    ...(params.notes ? { notes: params.notes } : {}),
    ...(params.role ? { role: params.role } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.researchBranch ? { research_branch: params.researchBranch } : {}),
    ...(params.researchTopics ? { research_topics: params.researchTopics } : {}),
    ...(params.projects ? { projects: params.projects } : {}),
    ...(params.hoursPerWeek !== undefined ? { hours_per_week: params.hoursPerWeek } : {}),
    ...(params.location ? { location: params.location } : {}),
    ...(params.affiliation ? { affiliation: params.affiliation } : {}),
    ...(params.timezone ? { timezone: params.timezone } : {}),
    ...(params.personalWebsite ? { personal_website: params.personalWebsite } : {}),
    ...(params.openreviewId ? { openreview_id: params.openreviewId } : {}),
    ...(params.reviewerExempt !== undefined ? { reviewer_exempt: params.reviewerExempt } : {}),
  };
}

function paperRecord(params: PaperParams): AdminBotPaperRecordInput {
  return {
    id: params.id,
    title: params.title,
    authors: params.authors,
    current_step: params.currentStep,
    ...(params.artifacts ? { artifacts: params.artifacts } : {}),
    ...(params.mentorMemberId ? { mentor_member_id: params.mentorMemberId } : {}),
    ...(params.checks ? { checks: params.checks } : {}),
    ...(params.reminder ? { reminder: params.reminder } : {}),
    ...(params.notes ? { notes: params.notes } : {}),
  };
}

function readArray<T>(value: unknown, key: string): T[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const raw = (value as Record<string, unknown>)[key];
  return Array.isArray(raw) ? (raw as T[]) : [];
}
function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function slackTargetForMember(member: AdminBotLabMember | undefined): string | undefined {
  const slackUserId = member?.slack_user_id?.trim();
  return slackUserId ? `user:${slackUserId}` : undefined;
}

function candidateDecisionProposal(params: CandidateDecisionParams): AdminBotActionProposal {
  const actionTypeByDecision = {
    accept_for_trial: "candidate.accept_for_trial",
    accept_direct: "candidate.accept_direct",
    decline: "candidate.decline",
  } as const satisfies Record<CandidateDecisionParams["decision"], AdminBotActionType>;
  return {
    type: actionTypeByDecision[params.decision],
    risk_tier: "T4",
    summary: params.summary,
    target: {
      name: params.candidateName,
      ...(params.candidateEmail ? { email: params.candidateEmail } : {}),
    },
    evidence: params.evidence,
    proposed_payload: params.proposedPayload ?? {
      decision: params.decision,
      candidateName: params.candidateName,
      candidateEmail: params.candidateEmail,
    },
    ...(params.rationale ? { rationale: params.rationale } : {}),
    undo_plan:
      "Return the candidate to review state and revoke any onboarding tasks that were created.",
  };
}

function normalizeCalendarProposalParams(
  params: CalendarParams & { summary: string },
): CalendarParams & { summary: string } {
  const supplied =
    params.proposedPayload &&
    typeof params.proposedPayload === "object" &&
    !Array.isArray(params.proposedPayload)
      ? { ...(params.proposedPayload as Record<string, unknown>) }
      : {};
  const suppliedAttendees = Array.isArray(supplied.attendees)
    ? supplied.attendees
    : supplied.attendees
      ? [supplied.attendees]
      : [];
  const attendees = [...(params.attendees ?? []), ...suppliedAttendees]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value, index, values) => isCalendarEmail(value) && values.indexOf(value) === index);
  if (attendees.length > 0) {
    supplied.attendees = attendees;
  } else {
    delete supplied.attendees;
  }
  return {
    ...params,
    changeType:
      params.changeType === "send_invite" && attendees.length === 0
        ? "tentative_hold"
        : params.changeType,
    ...(attendees.length > 0 ? { attendees } : { attendees: undefined }),
    proposedPayload: supplied,
  };
}

function isCalendarEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function calendarProposal(params: CalendarParams & { summary: string }): AdminBotActionProposal {
  const actionTypeByChange = {
    tentative_hold: "calendar.create_tentative_hold",
    send_invite: "calendar.send_invite",
    reschedule: "calendar.reschedule",
    cancel: "calendar.cancel",
  } as const satisfies Record<CalendarParams["changeType"], AdminBotActionType>;
  const riskByChange = {
    tentative_hold: "T2",
    send_invite: "T3",
    reschedule: "T3",
    cancel: "T3",
  } as const satisfies Record<CalendarParams["changeType"], AdminBotRiskTier>;
  return {
    type: actionTypeByChange[params.changeType],
    risk_tier: riskByChange[params.changeType],
    summary: params.summary,
    target: {
      changeType: params.changeType,
      attendees: params.attendees ?? [],
      ...(params.timeWindow ? { timeWindow: params.timeWindow } : {}),
    },
    evidence: params.evidence,
    // Preserve caller-supplied gog fields while ensuring proposal metadata is
    // present in the live execution payload as well.
    proposed_payload: calendarPayload(params),
    undo_plan:
      params.changeType === "tentative_hold"
        ? "Remove the tentative hold."
        : "Notify affected attendees and restore the prior calendar state when possible.",
  };
}

type PaperNudgeProposalParams = EvidenceParams & {
  paper: AdminBotPaperRecord;
  recipientMemberId: string;
  recipientName?: string;
  slackTarget: string;
  message?: string;
  idempotencyKey?: string;
};

function calendarPayload(params: CalendarParams & { summary: string }): Record<string, unknown> {
  const supplied =
    params.proposedPayload &&
    typeof params.proposedPayload === "object" &&
    !Array.isArray(params.proposedPayload)
      ? (params.proposedPayload as Record<string, unknown>)
      : {};
  const payload: Record<string, unknown> = {
    changeType: params.changeType,
    ...(params.attendees ? { attendees: params.attendees } : {}),
    ...(params.timeWindow ? { timeWindow: params.timeWindow } : {}),
    ...supplied,
    summary:
      typeof supplied.summary === "string" && supplied.summary.trim()
        ? supplied.summary
        : params.summary,
  };
  if (params.changeType !== "tentative_hold" && params.changeType !== "send_invite") {
    return payload;
  }
  const timestampRange = calendarTimestampRange(params, payload);
  if (timestampRange) {
    return {
      ...payload,
      from: timestampRange.from,
      to: timestampRange.to,
      all_day: false,
    };
  }
  const range = calendarDateRange(params, payload);
  if (range) {
    return {
      ...payload,
      ...(calendarString(payload, "from") ? {} : { from: range.from }),
      ...(calendarString(payload, "to") ? {} : { to: range.to }),
      ...(payload.all_day === undefined ? { all_day: true } : {}),
    };
  }
  const date = calendarDateOnly(params, payload);
  if (!date && (!calendarString(payload, "from") || !calendarString(payload, "to"))) {
    throw new Error(
      "Calendar create proposals need an RFC3339 from/to range or a date-only timeWindow (for example, 2026-07-30).",
    );
  }
  if (!date) {
    return payload;
  }
  return {
    ...payload,
    ...(calendarString(payload, "from") ? {} : { from: date }),
    ...(calendarString(payload, "to") ? {} : { to: nextCalendarDate(date) }),
    ...(payload.all_day === undefined ? { all_day: true } : {}),
  };
}

function calendarTimestampRange(
  params: CalendarParams,
  payload: Record<string, unknown>,
): { from: string; to: string } | undefined {
  const candidates = [params.timeWindow, calendarString(payload, "timeWindow")];
  const timestamp = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))\b/gu;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const matches = [...candidate.matchAll(timestamp)].map((match) => match[1]);
    if (matches.length >= 2) {
      return { from: matches[0], to: matches[1] };
    }
  }
  return undefined;
}

function calendarDateRange(
  params: CalendarParams,
  payload: Record<string, unknown>,
): { from: string; to: string } | undefined {
  const candidates = [params.timeWindow, params.summary, calendarString(payload, "timeWindow")];
  const namedDate =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/giu;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const matches = [...candidate.matchAll(namedDate)];
    if (matches.length < 2) continue;
    const between = candidate.slice(
      (matches[0].index ?? 0) + matches[0][0].length,
      matches[1].index ?? candidate.length,
    );
    if (!/(?:-|–|—|\bto\b|\bthrough\b)/iu.test(between)) continue;
    const year = Number(matches[0][3] ?? matches[1][3] ?? new Date().getUTCFullYear());
    const from = calendarIsoDate(year, calendarMonth(matches[0][1]), Number(matches[0][2]));
    const end = calendarIsoDate(
      Number(matches[1][3] ?? year),
      calendarMonth(matches[1][1]),
      Number(matches[1][2]),
    );
    if (from && end) return { from, to: nextCalendarDate(end) };
  }
  return undefined;
}

function calendarMonth(value: string): number {
  const key = value.toLowerCase().slice(0, 3);
  return [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(key);
}

function calendarIsoDate(year: number, month: number, day: number): string | undefined {
  const parsed = new Date(Date.UTC(year, month, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month &&
    parsed.getUTCDate() === day
    ? parsed.toISOString().slice(0, 10)
    : undefined;
}

function calendarString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function calendarDateOnly(
  params: CalendarParams,
  payload: Record<string, unknown>,
): string | undefined {
  const candidates = [
    calendarString(payload, "date"),
    calendarString(payload, "start_date"),
    params.timeWindow,
    params.summary,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const iso = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(candidate)?.[1];
    if (iso) return iso;
    const numeric = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/u.exec(candidate);
    if (numeric) {
      const month = Number(numeric[1]) - 1;
      const day = Number(numeric[2]);
      const yearText = numeric[3];
      const year = yearText
        ? yearText.length === 2
          ? 2000 + Number(yearText)
          : Number(yearText)
        : new Date().getUTCFullYear();
      const parsed = new Date(Date.UTC(year, month, day));
      if (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month &&
        parsed.getUTCDate() === day
      ) {
        return parsed.toISOString().slice(0, 10);
      }
    }
    const named =
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/iu.exec(
        candidate.trim(),
      );
    if (!named) continue;
    const months = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const month = months.indexOf(named[1].toLowerCase());
    const day = Number(named[2]);
    const year = named[3] ? Number(named[3]) : new Date().getUTCFullYear();
    const parsed = new Date(Date.UTC(year, month, day));
    if (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month &&
      parsed.getUTCDate() === day
    ) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return undefined;
}

function nextCalendarDate(date: string): string {
  const next = new Date(date + "T00:00:00.000Z");
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function paperNudgeProposal(params: PaperNudgeProposalParams): AdminBotActionProposal {
  const recipientLabel = params.recipientName ?? params.recipientMemberId;
  const message = params.message ?? paperNudgeMessage(params.paper, recipientLabel);
  return {
    type: "paper_publish.nudge_author",
    risk_tier: "T3",
    summary: `Ask ${recipientLabel} to nudge paper authors: ${params.paper.title}`,
    target: {
      service: "slack",
      channel: "slack",
      target: params.slackTarget,
      recipientMemberId: params.recipientMemberId,
      ...(params.recipientName ? { recipientName: params.recipientName } : {}),
      paperId: params.paper.id,
      step: params.paper.current_step,
      authors: params.paper.authors,
    },
    evidence: params.evidence,
    proposed_payload: {
      tool: "message",
      action: "send",
      channel: "slack",
      target: params.slackTarget,
      message,
      paper: {
        id: params.paper.id,
        title: params.paper.title,
        current_step: params.paper.current_step,
        authors: params.paper.authors,
      },
      ...(params.paper.timeline ? { timeline: params.paper.timeline } : {}),
    },
    ...(params.idempotencyKey ? { idempotency_key: params.idempotencyKey } : {}),
    undo_plan:
      "Send a Slack follow-up correcting or cancelling the reminder before Zhijing nudges the authors.",
  };
}

function paperNudgeMessage(paper: AdminBotPaperRecord, recipientLabel: string): string {
  const current = paper.timeline?.items.find(
    (item) => item.status === "current" || item.status === "blocked",
  );
  const next = paper.timeline?.items.find((item) => item.status === "upcoming");
  const currentLabel = current?.label ?? paper.current_step;
  const nextLabel = next ? ` Next dependency: ${next.label}.` : "";
  const progress = paper.timeline ? ` Timeline progress: ${paper.timeline.progress_percent}%.` : "";
  return (
    `Hi ${recipientLabel}, please nudge ${paper.authors.join(", ")} about ` +
    `\"${paper.title}\". Current step: ${currentLabel}.${progress}${nextLabel}`
  );
}
function slackMessageProposal(params: SlackMessageParams): AdminBotActionProposal {
  const channel = params.channel ?? "slack";
  const targetLabel = params.recipientName ?? params.target;
  return {
    type: "slack.send_message",
    risk_tier: "T3",
    summary: params.summary ?? `Send Slack message to ${targetLabel}`,
    target: {
      service: "slack",
      channel,
      target: params.target,
      ...(params.recipientName ? { recipientName: params.recipientName } : {}),
      ...(params.threadTs ? { threadTs: params.threadTs } : {}),
    },
    evidence: params.evidence,
    proposed_payload: params.proposedPayload ?? {
      tool: "message",
      action: "send",
      channel,
      target: params.target,
      message: params.message,
      ...(params.threadTs ? { threadTs: params.threadTs } : {}),
    },
    ...(params.idempotencyKey ? { idempotency_key: params.idempotencyKey } : {}),
    undo_plan:
      "Send a follow-up correction in Slack, or delete the message if the workspace policy and connector permissions allow it.",
  };
}
