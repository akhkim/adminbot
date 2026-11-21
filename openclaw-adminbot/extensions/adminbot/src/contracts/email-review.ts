import type { AdminBotNudgeDomain } from "./paper-cycle.js";
import type { AdminBotPaperflowStage } from "./paperflow-stages.js";

/** One inbound message the hourly pass deliberately left for an administrator to decide. */
export type AdminBotEmailReviewItem = {
  message_id: string;
  thread_id: string;
  sender: string;
  subject?: string;
  category: string;
  reason?: string;
  received_at?: string;
  updated_at: string;
};

/** A paper and its one currently open venue stage, offered as a safe attachment target. */
export type AdminBotEmailReviewPaperflowCandidate = {
  paper_id: string;
  title: string;
  stage: AdminBotPaperflowStage;
  stage_label: string;
  venue?: string;
};

export type AdminBotEmailReviewResolution =
  | { kind: "paperflow_evidence"; paper_id: string; stage: string; note?: string }
  /**
   * Close a stage the member says will never produce venue mail -- the paper went to a journal,
   * or the stage does not apply to this venue. With `later_stages`, every stage after it closes
   * too, so a paper that left the conference track is not then chased about registration.
   */
  | {
      kind: "paperflow_skipped";
      paper_id: string;
      stage: string;
      note: string;
      later_stages?: boolean;
    }
  | { kind: "paper_slot_waived"; paper_id: string; slot: string; note: string }
  /** The head professor says the letters went in: mark these schools submitted on the request. */
  | { kind: "rec_letter_submitted"; request_id: string; schools: string[] }
  /** The student says their own letter went in, answering the after-deadline question. */
  | { kind: "rec_letter_confirmed"; request_id: string; member_id: string }
  /** The member needs more time: keep the reminder quiet until `until`, then ask again. */
  | {
      kind: "reminder_snoozed";
      domain: AdminBotReminderReplyDomain;
      subject_id: string;
      member_id: string;
      until: string;
    }
  | { kind: "dismissed" };

export const adminBotEmailReviewResolutionKinds = [
  "paperflow_evidence",
  "paperflow_skipped",
  "paper_slot_waived",
  "rec_letter_submitted",
  "rec_letter_confirmed",
  "reminder_snoozed",
  "dismissed",
] as const satisfies ReadonlyArray<AdminBotEmailReviewResolution["kind"]>;

/**
 * The nudge ledger domain a reply to a reminder answers. Any of them: a reminder is a ledger row,
 * and "give me two weeks" means the same thing whichever row it is. What a "done" can close is
 * per domain (service.reminder-replies.ts).
 */
export type AdminBotReminderReplyDomain = AdminBotNudgeDomain;

/**
 * What a member's reply to a reminder says, as the model reads it.
 *
 * Four answers and no more, because each maps to exactly one thing an admin can approve: close it
 * with the evidence, close it as not applying, give it more time, or answer the person.
 */
export const adminBotReminderReplyIntents = [
  "done",
  "not_applicable",
  "needs_time",
  "question",
] as const;
export type AdminBotReminderReplyIntent = (typeof adminBotReminderReplyIntents)[number];

/** One thing a reminder asked about, in the ledger's own terms. */
export type AdminBotReminderReplyTarget = {
  domain: AdminBotReminderReplyDomain;
  subject_id: string;
  /** Whose ledger row: the member who was asked. */
  member_id: string;
  label: string;
  /** False when the thing was already settled by the time the reply arrived. */
  open: boolean;
  paper_id?: string;
  stage?: AdminBotPaperflowStage;
  slot?: string;
  request_id?: string;
  schools?: string[];
};

/** A reply matched to the AdminBot reminder it answers and to the person that reminder asked. */
export type AdminBotReminderReplyMatch = {
  reminder_action_id: string;
  reminder_type: string;
  reminder_subject: string;
  reminder_body: string;
  reminder_sent_at: string;
  member_id: string;
  member_name: string;
  /** How the reply was tied to the reminder. Thread is exact; subject is the fallback for old sends. */
  matched_by: "thread" | "subject";
  targets: AdminBotReminderReplyTarget[];
};

/** The model's reading of one reply, before anything is proposed. */
export type AdminBotReminderReplyReading = {
  intent: AdminBotReminderReplyIntent;
  /** One line in the member's own terms, e.g. "moved to a Springer journal". */
  note: string;
  /** A link the member gave as evidence, when there is one. */
  evidence_url?: string;
  /** Only for needs_time: the date the member said to come back, when they gave one. */
  until?: string;
  /**
   * The paper left this venue's track altogether -- a journal, a different conference -- so no
   * later stage of this cycle will happen either.
   */
  moved_elsewhere: boolean;
  confidence: number;
};

/** A settled decision, retained so the queue does not erase its own audit context. */
export type AdminBotResolvedEmailReviewItem = AdminBotEmailReviewItem & {
  resolution: AdminBotEmailReviewResolution["kind"];
  resolved_at: string;
  resolved_by: string;
  resolved_by_name?: string;
  paper_id?: string;
  paper_title?: string;
  stage?: AdminBotPaperflowStage;
  stage_label?: string;
};
