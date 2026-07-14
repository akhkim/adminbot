import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
// AdminBot plugin entrypoint registers typed action-broker tools.
import { Type } from "typebox";
import {
  accessGrantSchema,
  actionTypeSchema,
  evidencePointerSchema,
  paperArtifactsSchema,
  paperReminderSchema,
  paperStepSchema,
  privilegeLevelSchema,
  riskTierSchema,
  sensitiveInfoSchema,
  settingsSchema,
} from "./src/tool-schemas.js";
import {
  createAdminBotToolHandlers,
  defaultAdminBotConfig,
  type AdminBotPluginConfig,
} from "./src/tools.js";

const adminBotConfigSchema = Type.Object(
  {
    serviceBaseUrl: Type.Optional(Type.String()),
    serviceTokenEnv: Type.Optional(Type.String()),
    allowInsecureRemoteService: Type.Optional(Type.Boolean()),
    defaultDryRun: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const unknownRecord = Type.Record(Type.String(), Type.Unknown());
const evidenceArray = Type.Optional(Type.Array(evidencePointerSchema));

export default defineToolPlugin({
  id: "adminbot",
  name: "AdminBot",
  description: "Typed proposal, approval, and execution broker for sensitive admin workflows.",
  configSchema: adminBotConfigSchema,
  tools: (tool) => [
    tool({
      name: "adminbot_reason",
      label: "AdminBot private reasoning",
      description:
        "Run reasoning through the local privacy gate. Generic tasks may use NVIDIA NIM; private tasks use validated placeholders and are finalized locally. Use privacy=private or sensitiveTerms when the user marks data as sensitive.",
      optional: true,
      parameters: Type.Object({
        task: Type.String({ minLength: 1 }),
        privacy: Type.Optional(
          Type.Unsafe<"auto" | "private">({ type: "string", enum: ["auto", "private"] }),
        ),
        sensitiveTerms: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      }),
      execute: (params, config) => createAdminBotToolHandlers(resolveConfig(config)).reason(params),
    }),
    tool({
      name: "adminbot_propose_action",
      label: "AdminBot propose action",
      description:
        "Create a typed AdminBot action proposal. OpenClaw proposes only; the AdminBot service owns policy, approval, execution, and audit logging.",
      optional: true,
      parameters: Type.Object({
        type: actionTypeSchema,
        summary: Type.String(),
        target: Type.Optional(unknownRecord),
        evidence: evidenceArray,
        proposedPayload: Type.Optional(Type.Unknown()),
        riskTier: Type.Optional(riskTierSchema),
        rationale: Type.Optional(Type.String()),
        undoPlan: Type.Optional(Type.String()),
        idempotencyKey: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).proposeAction(params),
    }),
    tool({
      name: "adminbot_propose_candidate_decision",
      label: "AdminBot propose candidate decision",
      description:
        "Propose accepting a candidate for trial, accepting directly, or declining. Candidate decisions are T4 and require explicit service-side approval.",
      optional: true,
      parameters: Type.Object({
        decision: Type.Unsafe<"accept_for_trial" | "accept_direct" | "decline">({
          type: "string",
          enum: ["accept_for_trial", "accept_direct", "decline"],
        }),
        candidateName: Type.String(),
        candidateEmail: Type.Optional(Type.String()),
        summary: Type.String(),
        evidence: evidenceArray,
        rationale: Type.Optional(Type.String()),
        proposedPayload: Type.Optional(Type.Unknown()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).proposeCandidateDecision(params),
    }),
    tool({
      name: "adminbot_draft_social_post",
      label: "AdminBot draft social post",
      description:
        "Ask AdminBot to draft a social media post from trusted context. Publishing remains a separate T4 proposal.",
      optional: true,
      parameters: Type.Object({
        subject: Type.String(),
        sourceWork: Type.String(),
        audience: Type.Optional(Type.String()),
        tone: Type.Optional(Type.String()),
        evidence: evidenceArray,
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).draftSocialPost(params),
    }),
    tool({
      name: "adminbot_prepare_paper_social_posts",
      label: "AdminBot prepare paper social posts",
      description:
        "Prepare approval-gated LinkedIn and X posts for a paper. AdminBot resolves author tags from lab member notes, records missing tags for user follow-up, and splits X content into 280-character-safe thread posts.",
      optional: true,
      parameters: Type.Object({
        paperId: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        summary: Type.String({ minLength: 1 }),
        url: Type.Optional(Type.String()),
        authors: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        tone: Type.Optional(Type.String()),
        hashtags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        platforms: Type.Optional(
          Type.Array(Type.Unsafe<"linkedin" | "x">({ type: "string", enum: ["linkedin", "x"] })),
        ),
        linkedinVisibility: Type.Optional(
          Type.Unsafe<"PUBLIC" | "CONNECTIONS">({
            type: "string",
            enum: ["PUBLIC", "CONNECTIONS"],
          }),
        ),
        evidence: evidenceArray,
        idempotencyKey: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).preparePaperSocialPosts(params),
    }),
    tool({
      name: "adminbot_prepare_overleaf_paper_edit",
      label: "AdminBot prepare Overleaf paper edit",
      description:
        "Prepare approval-gated Overleaf source edits from a paper project link. Can run affiliation checks against the AdminBot member list and supplied affiliation policy before any approved write.",
      optional: true,
      parameters: Type.Object({
        paperId: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        authors: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        overleafEditUrl: Type.Optional(Type.String()),
        requestedEdits: Type.String({ minLength: 1 }),
        targetFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        mode: Type.Optional(
          Type.Unsafe<"manual" | "affiliation_check">({
            type: "string",
            enum: ["manual", "affiliation_check"],
          }),
        ),
        policySource: Type.Optional(Type.String()),
        evidence: evidenceArray,
        idempotencyKey: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).prepareOverleafPaperEdit(params),
    }),
    tool({
      name: "adminbot_prepare_reimbursement_packet",
      label: "AdminBot prepare reimbursement packet",
      description:
        "Prepare a reimbursement packet proposal. Submitting payment or reimbursement forms remains a separate T4 action.",
      optional: true,
      parameters: Type.Object({
        claimant: Type.String(),
        expenseSummary: Type.String(),
        amount: Type.Optional(Type.String()),
        evidence: evidenceArray,
        proposedPayload: Type.Optional(Type.Unknown()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).prepareReimbursementPacket(params),
    }),
    tool({
      name: "adminbot_suggest_calendar_change",
      label: "AdminBot suggest calendar change",
      description:
        "Suggest a calendar hold, invite, reschedule, or cancellation through AdminBot policy and approvals.",
      optional: true,
      parameters: Type.Object({
        changeType: Type.Unsafe<"tentative_hold" | "send_invite" | "reschedule" | "cancel">({
          type: "string",
          enum: ["tentative_hold", "send_invite", "reschedule", "cancel"],
        }),
        summary: Type.String(),
        attendees: Type.Optional(Type.Array(Type.String())),
        timeWindow: Type.Optional(Type.String()),
        evidence: evidenceArray,
        proposedPayload: Type.Optional(Type.Unknown()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).suggestCalendarChange(params),
    }),
    tool({
      name: "adminbot_propose_slack_message",
      label: "AdminBot propose Slack message",
      description:
        "Propose sending a Slack DM or channel message through OpenClaw's message tool. The proposal records the exact recipient and message before approval/execution.",
      optional: true,
      parameters: Type.Object({
        target: Type.String({
          description:
            "Slack user id, channel id, or target address the OpenClaw message tool should send to.",
        }),
        message: Type.String({ minLength: 1 }),
        channel: Type.Optional(
          Type.String({ description: "OpenClaw channel id; defaults to slack." }),
        ),
        recipientName: Type.Optional(Type.String()),
        threadTs: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        evidence: evidenceArray,
        proposedPayload: Type.Optional(Type.Unknown()),
        idempotencyKey: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).proposeSlackMessage(params),
    }),
    tool({
      name: "adminbot_classify_join_form_response",
      label: "AdminBot classify join form response",
      description:
        "Classify a join-the-lab form response. Classification is observational; accept or decline decisions require separate T4 proposals.",
      optional: true,
      parameters: Type.Object({
        responseId: Type.String(),
        applicantName: Type.Optional(Type.String()),
        answers: unknownRecord,
        rubric: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).classifyJoinFormResponse(params),
    }),
    tool({
      name: "adminbot_upsert_lab_member",
      label: "AdminBot upsert lab member",
      description:
        "Create or update a lab member privilege record and compute the default access profile for that privilege level.",
      optional: true,
      parameters: Type.Object({
        id: Type.String(),
        name: Type.String(),
        email: Type.Optional(Type.String()),
        slackUserId: Type.Optional(Type.String()),
        privilegeLevel: Type.Optional(privilegeLevelSchema),
        accessOverrides: Type.Optional(Type.Array(accessGrantSchema)),
        notes: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).upsertLabMember(params),
    }),
    tool({
      name: "adminbot_list_lab_members",
      label: "AdminBot list lab members",
      description: "List AdminBot lab members with privilege levels and computed access profiles.",
      optional: true,
      parameters: Type.Object({}),
      execute: (_params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).listLabMembers(),
    }),
    tool({
      name: "adminbot_get_settings",
      label: "AdminBot get settings",
      description:
        "Read AdminBot service settings, including the temporary default privilege level and paper reminder escalation defaults.",
      optional: true,
      parameters: Type.Object({}),
      execute: (_params, config) => createAdminBotToolHandlers(resolveConfig(config)).getSettings(),
    }),
    tool({
      name: "adminbot_update_settings",
      label: "AdminBot update settings",
      description:
        "Update AdminBot service settings such as the default privilege level, paper escalation window, and head professor member id.",
      optional: true,
      parameters: settingsSchema,
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).updateSettings(params),
    }),
    tool({
      name: "adminbot_get_sensitive_info",
      label: "AdminBot get sensitive info",
      description:
        "Read the user-editable AdminBot markdown that defines what the lab considers sensitive information.",
      optional: true,
      parameters: Type.Object({}),
      execute: (_params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).getSensitiveInfo(),
    }),
    tool({
      name: "adminbot_update_sensitive_info",
      label: "AdminBot update sensitive info",
      description:
        "Update the user-editable AdminBot markdown that documents sensitive information categories and lab-specific private terms.",
      optional: true,
      parameters: sensitiveInfoSchema,
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).updateSensitiveInfo(params),
    }),
    tool({
      name: "adminbot_upsert_paper",
      label: "AdminBot upsert paper",
      description:
        "Create or update a paper pipeline record with authors, current step, Overleaf/Drive/social/slide/poster links, and reminder state.",
      optional: true,
      parameters: Type.Object({
        id: Type.String(),
        title: Type.String(),
        authors: Type.Array(Type.String()),
        currentStep: paperStepSchema,
        artifacts: Type.Optional(paperArtifactsSchema),
        mentorMemberId: Type.Optional(Type.String()),
        checks: Type.Optional(
          Type.Object(
            {
              affiliation_checked: Type.Optional(Type.Boolean()),
              github_link_checked: Type.Optional(Type.Boolean()),
              paper_mentor_checked: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: false },
          ),
        ),
        reminder: Type.Optional(paperReminderSchema),
        notes: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).upsertPaper(params),
    }),
    tool({
      name: "adminbot_list_papers",
      label: "AdminBot list papers",
      description: "List AdminBot paper pipeline records and their current publication steps.",
      optional: true,
      parameters: Type.Object({}),
      execute: (_params, config) => createAdminBotToolHandlers(resolveConfig(config)).listPapers(),
    }),
    tool({
      name: "adminbot_list_paper_nudges",
      label: "AdminBot list paper nudges",
      description:
        "List paper pipeline reminders that are due, including escalation to the head professor after three business days without author reply.",
      optional: true,
      parameters: Type.Object({ nowIso: Type.Optional(Type.String()) }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).listPaperNudges(params),
    }),
    tool({
      name: "adminbot_propose_paper_nudge",
      label: "AdminBot propose paper nudge",
      description:
        "Create an approval-gated task that sends Zhijing or the configured head professor a direct Slack reminder to nudge a paper's authors, including the paper timeline used for the decision.",
      optional: true,
      parameters: Type.Object({
        paperId: Type.String({ minLength: 1 }),
        recipientMemberId: Type.Optional(Type.String()),
        slackTarget: Type.Optional(
          Type.String({
            description:
              "Explicit Slack message target, such as user:U0123456789. Defaults to the recipient member's slack_user_id.",
          }),
        ),
        message: Type.Optional(Type.String({ minLength: 1 })),
        evidence: evidenceArray,
        idempotencyKey: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).proposePaperNudge(params),
    }),
    tool({
      name: "adminbot_list_pending_actions",
      label: "AdminBot list pending actions",
      description: "List pending AdminBot action proposals from the local service.",
      optional: true,
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1 })) }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).listPendingActions(params),
    }),
    tool({
      name: "adminbot_approve_action",
      label: "AdminBot approve action",
      description:
        "Ask the user to confirm, then approve one immutable AdminBot action by action_id and payload hash. If the payload changes, the service must require a new approval.",
      optional: true,
      approval: (params) => ({
        title: "Approve AdminBot action",
        description: `Approve AdminBot action: ${params.actionSummary}. Action id ${params.actionId}; payload hash ${String(params.payloadHash).slice(0, 12)}.`,
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutBehavior: "deny",
      }),
      parameters: Type.Object({
        actionId: Type.String(),
        payloadHash: Type.String(),
        actionSummary: Type.String({
          minLength: 1,
          description:
            "Plain-language description copied from the pending proposal, such as 'Send email to xxx@gmail.com'.",
        }),
        approverRole: Type.String(),
        approverId: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).approveAction(params),
    }),
    tool({
      name: "adminbot_execute_approved_action",
      label: "AdminBot execute approved action",
      description:
        "Ask the user to confirm, then request execution of one approved AdminBot action. The AdminBot service rechecks approvals, policy, idempotency, connector scope, and dry-run mode.",
      optional: true,
      approval: (params) => ({
        title: "Execute AdminBot action",
        description: `Execute AdminBot action: ${params.actionSummary}. This can trigger AdminBot connector side effects, so OpenClaw waits for explicit user confirmation every time.`,
        severity: "critical",
        allowedDecisions: ["allow-once", "deny"],
        timeoutBehavior: "deny",
      }),
      parameters: Type.Object({
        actionId: Type.String(),
        actionSummary: Type.String({
          minLength: 1,
          description:
            "Plain-language description copied from the approved proposal, such as 'Send email to xxx@gmail.com'.",
        }),
        idempotencyKey: Type.Optional(Type.String()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).executeApprovedAction(params),
    }),
  ],
});

function resolveConfig(config: Partial<AdminBotPluginConfig>): AdminBotPluginConfig {
  return { ...defaultAdminBotConfig, ...config };
}
