import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
// AdminBot plugin entrypoint registers typed action-broker tools.
import { Type } from "typebox";
import {
  createAdminBotToolHandlers,
  defaultAdminBotConfig,
  type AdminBotPluginConfig,
} from "./src/adapters/openclaw/index.js";
import {
  accessGrantSchema,
  actionTypeSchema,
  collaboratorSubgroupSchema,
  evidencePointerSchema,
  paperArtifactsSchema,
  paperReminderSchema,
  paperStepSchema,
  privilegeLevelSchema,
  riskTierSchema,
  sensitiveInfoSchema,
  settingsSchema,
} from "./src/contracts/tool-schemas.js";

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
      name: "adminbot_run_email_automation",
      label: "AdminBot run email automation",
      description:
        "Run the hourly AdminBot inbox processor now, wait for it to finish, and return completion, review, skip, and failure counts for the final chat response.",
      optional: true,
      parameters: Type.Object({}),
      execute: (_params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).runEmailAutomation(),
    }),
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
      name: "guidebook_ask",
      label: "AdminBot guidebook",
      description:
        "Answer a question from the lab guidebook. Retrieval and drafting run entirely on the local model and only the resulting prose comes back — guidebook text itself never enters this conversation. Use this for questions about lab policy, procedures, onboarding, reimbursement rules, or anything the guidebook would cover, and quote the answer rather than guessing from memory.",
      optional: true,
      parameters: Type.Object({
        question: Type.String({ minLength: 1 }),
        maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 12 })),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).askGuidebook(params),
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
        controlUiConfirmed: Type.Optional(Type.Boolean()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).proposeAction(params),
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
        controlUiConfirmed: Type.Optional(Type.Boolean()),
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
        controlUiConfirmed: Type.Optional(Type.Boolean()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).prepareOverleafPaperEdit(params),
    }),
    tool({
      name: "adminbot_reimbursement_converse",
      label: "AdminBot reimbursement conversation",
      description:
        "Privately extract receipt PDFs or photos and continue a natural-language reimbursement intake. Returns the merged draft, missing fields, and the next clarification question.",
      optional: true,
      parameters: Type.Object({
        message: Type.String({ minLength: 1, maxLength: 20000 }),
        receipts: Type.Optional(
          Type.Array(
            Type.Object(
              {
                name: Type.String({ minLength: 1, maxLength: 160 }),
                media_type: Type.Union([
                  Type.Literal("application/pdf"),
                  Type.Literal("image/png"),
                  Type.Literal("image/jpeg"),
                ]),
                data_base64: Type.String({ minLength: 1 }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 12 },
          ),
        ),
        messages: Type.Optional(
          Type.Array(
            Type.Object(
              {
                role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
                content: Type.String({ maxLength: 20000 }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 20 },
          ),
        ),
        draft: Type.Optional(unknownRecord),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).converseReimbursement(params),
    }),
    tool({
      name: "adminbot_reimbursement_generate",
      label: "AdminBot generate reimbursement forms",
      description:
        "Fill the canonical Compute Expense and Trip Summary forms from a complete reviewed reimbursement draft. Returns both files for download without submitting them.",
      optional: true,
      parameters: Type.Object({ draft: unknownRecord }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).generateReimbursement(params),
    }),
    tool({
      name: "adminbot_suggest_calendar_change",
      label: "AdminBot suggest calendar change",
      description:
        "Create a pending calendar proposal from explicit fields or extract its summary and date range from a Google Docs URL, Gmail message id, or Gmail query. This tool never schedules or changes an event; report success only as proposed and awaiting approval. A Google Calendar URL selects the writable destination calendar.",
      optional: true,
      parameters: Type.Object({
        changeType: Type.Unsafe<"tentative_hold" | "send_invite" | "reschedule" | "cancel">({
          type: "string",
          enum: ["tentative_hold", "send_invite", "reschedule", "cancel"],
        }),
        summary: Type.Optional(
          Type.String({
            description:
              "Event title. Optional when sourceUrl, emailMessageId, or emailQuery supplies it.",
          }),
        ),
        attendees: Type.Optional(Type.Array(Type.String())),
        timeWindow: Type.Optional(
          Type.String({
            description:
              "Explicit date/time range. Optional when the Google or Gmail source supplies it.",
          }),
        ),
        sourceUrl: Type.Optional(
          Type.String({
            description:
              "Google Docs or Gmail URL to read. For compatibility, a Google Calendar URL here is treated as calendarUrl.",
          }),
        ),
        calendarUrl: Type.Optional(
          Type.String({
            description:
              "Google Calendar embed/share URL. Its src or cid value becomes proposed_payload.calendar_id.",
          }),
        ),
        calendarName: Type.Optional(
          Type.Unsafe<"personal" | "jinesis">({
            type: "string",
            enum: ["personal", "jinesis"],
            description:
              "Named destination: personal selects the private group calendar (ADMINBOT_CALENDAR_ID); jinesis selects the bot's own Google account (ADMINBOT_BOT_EMAIL).",
          }),
        ),
        emailMessageId: Type.Optional(
          Type.String({ description: "Gmail message id to read with authenticated gog." }),
        ),
        emailQuery: Type.Optional(
          Type.String({
            description:
              "Gmail search query. AdminBot reads the first matching thread as the calendar source.",
          }),
        ),
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
        controlUiConfirmed: Type.Optional(Type.Boolean()),
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
        "Create or update a lab member privilege record and compute the default access profile for that privilege level. For an external collaborator, also set collaboratorSubgroup, which decides the access items (spreadsheet depth, Slack channels, Drive folders, meetings, rec letters) they get.",
      optional: true,
      parameters: Type.Object({
        id: Type.String(),
        name: Type.String(),
        email: Type.Optional(Type.String()),
        slackUserId: Type.Optional(Type.String()),
        privilegeLevel: Type.Optional(privilegeLevelSchema),
        collaboratorSubgroup: Type.Optional(collaboratorSubgroupSchema),
        accessOverrides: Type.Optional(Type.Array(accessGrantSchema)),
        notes: Type.Optional(Type.String()),
        role: Type.Optional(Type.String()),
        status: Type.Optional(
          Type.Union([
            Type.Literal("active"),
            Type.Literal("part_time"),
            Type.Literal("on_leave"),
            Type.Literal("alumni"),
            Type.Literal("external"),
          ]),
        ),
        researchBranch: Type.Optional(Type.String()),
        researchTopics: Type.Optional(Type.Array(Type.String())),
        projects: Type.Optional(Type.Array(Type.String())),
        hoursPerWeek: Type.Optional(Type.Number({ minimum: 0, maximum: 168 })),
        availability: Type.Optional(
          Type.String({
            description:
              'Time availability, one period per line: "Until 09032026: 20% Rebuttals, 80% Studying". Percentages per period must not exceed 100.',
          }),
        ),
        location: Type.Optional(Type.String()),
        affiliation: Type.Optional(Type.String()),
        timezone: Type.Optional(Type.String()),
        personalWebsite: Type.Optional(Type.String()),
        openreviewId: Type.Optional(
          Type.String({ description: 'OpenReview tilde id, e.g. "~Jane_Doe1".' }),
        ),
        reviewerExempt: Type.Optional(
          Type.Boolean({
            description:
              "Never propose or assign this person as an emergency reviewer, whatever their topic match.",
          }),
        ),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).upsertLabMember(params),
    }),
    tool({
      name: "adminbot_openreview_status",
      label: "AdminBot OpenReview status",
      description:
        "List the reviewing cycles AdminBot is tracking (venue, role, review deadline, outstanding reviews) and the reminder milestones that have already fired.",
      optional: true,
      parameters: Type.Object({}),
      execute: (_params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).listOpenReviewStatus(),
    }),
    tool({
      name: "adminbot_openreview_run_cycle",
      label: "AdminBot run OpenReview cycle",
      description:
        "Run one pass of the reviewing-cycle automation: discover venues, compute missing reviews, and fire whichever reminder milestone is due. Defaults to a dry run; pass send=true to actually deliver.",
      optional: true,
      parameters: Type.Object({
        send: Type.Optional(
          Type.Boolean({
            description: "Deliver the due reminders instead of only reporting what would be sent.",
          }),
        ),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).runOpenReviewCycle(params),
    }),
    tool({
      name: "adminbot_openreview_suggest_reviewers",
      label: "AdminBot suggest emergency reviewers",
      description:
        "For each submission still missing a review at a venue, rank Jinesis lab members by research overlap as emergency reviewer candidates. Suggestion only; assigning is a separate explicit action.",
      optional: true,
      parameters: Type.Object({
        venueId: Type.String({
          description: "OpenReview venue id, e.g. NeurIPS.cc/2026/Conference",
        }),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).suggestOpenReviewReviewers(params),
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
      name: "adminbot_list_unreviewed_applicants",
      label: "AdminBot list unreviewed applicants",
      description:
        "List mentee-application form submissions received since applicant_last_reviewed_at, returning each applicant's name, email, CV link, and submission timestamp. Requires applicant_sheet_id in AdminBot settings. CV links are external URLs the reviewer opens; AdminBot does not copy the files.",
      optional: true,
      parameters: Type.Object({
        since: Type.Optional(
          Type.String({
            description:
              "ISO timestamp override. Defaults to the stored applicant_last_reviewed_at; unset means every row.",
          }),
        ),
        sheetRange: Type.Optional(
          Type.String({ description: "A1 range override, such as 'Form Responses 1'!A:ZZ." }),
        ),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).listUnreviewedApplicants(params),
    }),
    tool({
      name: "adminbot_mark_applicants_reviewed",
      label: "AdminBot mark applicants reviewed",
      description:
        "Advance the applicant review cursor by writing applicant_last_reviewed_at into AdminBot settings so the next listing only returns newer submissions.",
      optional: true,
      parameters: Type.Object({
        reviewedAt: Type.Optional(
          Type.String({ description: "ISO timestamp to record. Defaults to now." }),
        ),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).markApplicantsReviewed(params),
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
      name: "adminbot_delete_paper",
      label: "AdminBot delete paper",
      description: "Delete an AdminBot paper pipeline record by id.",
      optional: true,
      parameters: Type.Object({
        paperId: Type.String({ minLength: 1 }),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).deletePaper(params),
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
        controlUiConfirmed: Type.Optional(Type.Boolean()),
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
        "Approve one immutable AdminBot action from the Control UI Pending Actions section. Chat approval is disabled.",
      optional: true,
      approval: () => undefined,
      parameters: Type.Object({
        actionId: Type.String(),
        payloadHash: Type.String(),
        approverRole: Type.String(),
        approverId: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
        controlUiConfirmed: Type.Optional(Type.Boolean()),
      }),
      execute: (params, config, context) => {
        if (!isConfirmedControlUiCall(params, context)) {
          throw new Error("Approve AdminBot actions from the Control UI Pending Actions section.");
        }
        return createAdminBotToolHandlers(resolveConfig(config)).approveAction(params);
      },
    }),
    tool({
      name: "adminbot_remove_pending_action",
      label: "AdminBot remove pending action",
      description:
        "Remove a pending AdminBot action from the queue while retaining its audit record.",
      optional: true,
      approval: (params, context) => {
        if (isConfirmedControlUiCall(params, context)) {
          return undefined;
        }
        return {
          title: "Remove pending AdminBot action",
          description:
            "Remove pending AdminBot action " +
            approvalDisplayValue(params.actionId, "unknown action") +
            ". The proposal will be retained as rejected for audit history.",
          severity: "warning",
          allowedDecisions: ["allow-once", "deny"],
          timeoutBehavior: "deny",
        };
      },
      parameters: Type.Object({
        actionId: Type.String(),
        actor: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
        controlUiConfirmed: Type.Optional(Type.Boolean()),
      }),
      execute: (params, config) =>
        createAdminBotToolHandlers(resolveConfig(config)).removePendingAction(params),
    }),
    tool({
      name: "adminbot_execute_approved_action",
      label: "AdminBot execute approved action",
      description:
        "Execute an action once it has collected the approvals its risk tier requires, from the Control UI Pending Actions section. Chat execution is disabled.",
      optional: true,
      approval: () => undefined,
      parameters: Type.Object({
        actionId: Type.String(),
        idempotencyKey: Type.Optional(Type.String()),
        controlUiConfirmed: Type.Optional(Type.Boolean()),
      }),
      execute: (params, config, context) => {
        if (!isConfirmedControlUiCall(params, context)) {
          throw new Error(
            "Approved AdminBot actions execute from the Control UI Pending Actions section; chat execution is disabled.",
          );
        }
        return createAdminBotToolHandlers(resolveConfig(config)).executeApprovedAction(params);
      },
    }),
  ],
});

function resolveConfig(config: Partial<AdminBotPluginConfig>): AdminBotPluginConfig {
  return { ...defaultAdminBotConfig, ...config };
}

function isConfirmedControlUiCall(
  params: { controlUiConfirmed?: boolean },
  context: { toolCallId?: string },
): boolean {
  // The marker is model-visible, so require the host-owned RPC id to prevent model approval bypass.
  return params.controlUiConfirmed === true && context.toolCallId?.startsWith("rpc-") === true;
}

function approvalDisplayValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
