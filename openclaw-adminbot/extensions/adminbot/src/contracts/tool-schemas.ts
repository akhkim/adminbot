import { Type } from "typebox";
import {
  adminBotActionTypes,
  adminBotExternalCollaboratorSubgroups,
  adminBotPaperSteps,
  adminBotPrivilegeLevels,
  adminBotRiskTiers,
  type AdminBotActionType,
  type AdminBotExternalCollaboratorSubgroup,
  type AdminBotPaperStep,
  type AdminBotPrivilegeLevel,
  type AdminBotRiskTier,
} from "./actions.js";

export const actionTypeSchema = Type.Unsafe<AdminBotActionType>({
  type: "string",
  enum: [...adminBotActionTypes],
});

export const riskTierSchema = Type.Unsafe<AdminBotRiskTier>({
  type: "string",
  enum: [...adminBotRiskTiers],
});

export const privilegeLevelSchema = Type.Unsafe<AdminBotPrivilegeLevel>({
  type: "string",
  enum: [...adminBotPrivilegeLevels],
});

export const collaboratorSubgroupSchema = Type.Unsafe<AdminBotExternalCollaboratorSubgroup>({
  type: "string",
  enum: [...adminBotExternalCollaboratorSubgroups],
  description:
    "Which kind of external collaborator this is, ordered least to most engaged. Only accepted when the member's privilege level is external_collaborator.",
});

export const paperStepSchema = Type.Unsafe<AdminBotPaperStep>({
  type: "string",
  enum: [...adminBotPaperSteps],
});

export const accessGrantSchema = Type.Object(
  {
    service: Type.String(),
    access: Type.Unsafe<"none" | "view" | "comment" | "edit" | "admin">({
      type: "string",
      enum: ["none", "view", "comment", "edit", "admin"],
    }),
    scope: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const settingsSchema = Type.Object(
  {
    paper_escalation_business_days: Type.Optional(Type.Integer({ minimum: 1 })),
    head_professor_member_id: Type.Optional(Type.String()),
    applicant_sheet_id: Type.Optional(Type.String()),
    applicant_last_reviewed_at: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const sensitiveInfoSchema = Type.Object(
  {
    markdown: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const paperArtifactsSchema = Type.Object(
  {
    conference: Type.Optional(Type.String()),
    topic: Type.Optional(Type.String()),
    brainstorming_doc_url: Type.Optional(Type.String()),
    overleaf_view_url: Type.Optional(Type.String()),
    overleaf_edit_url: Type.Optional(Type.String()),
    submission_url: Type.Optional(Type.String()),
    google_drive_pdf_url: Type.Optional(Type.String()),
    arxiv_url: Type.Optional(Type.String()),
    github_url: Type.Optional(Type.String()),
    twitter_draft_url: Type.Optional(Type.String()),
    linkedin_draft_url: Type.Optional(Type.String()),
    google_slides_url: Type.Optional(Type.String()),
    poster_url: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const paperReminderSchema = Type.Object(
  {
    status: Type.Optional(
      Type.Unsafe<"idle" | "waiting_on_authors" | "blocked" | "complete">({
        type: "string",
        enum: ["idle", "waiting_on_authors", "blocked", "complete"],
      }),
    ),
    requested_step_at: Type.Optional(Type.String()),
    last_author_dm_at: Type.Optional(Type.String()),
    last_author_reply_at: Type.Optional(Type.String()),
    next_nudge_at: Type.Optional(Type.String()),
    escalation_after_business_days: Type.Optional(Type.Integer({ minimum: 1 })),
    head_professor_member_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// The email payload shape, mirroring AdminBotEmailPayload. `additionalProperties` stays open: an
// email-channel `member_nudge.send` carries a `channel` discriminator alongside these fields, and a
// schema that rejected it would fail closed on payloads the connector already handles.
//
// `body_html` is optional and was added after the field set was first written, so this schema
// accepts every payload the earlier one did.
const recipientsSchema = Type.Union([Type.String(), Type.Array(Type.String())]);

export const emailPayloadSchema = Type.Object({
  to: recipientsSchema,
  subject: Type.String(),
  body: Type.String(),
  body_html: Type.Optional(Type.String()),
  cc: Type.Optional(recipientsSchema),
  bcc: Type.Optional(recipientsSchema),
  reply_to: Type.Optional(Type.String()),
  account: Type.Optional(Type.String()),
});

export const evidencePointerSchema = Type.Object(
  {
    source: Type.String(),
    id: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    snippet: Type.Optional(Type.String()),
    hash: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
