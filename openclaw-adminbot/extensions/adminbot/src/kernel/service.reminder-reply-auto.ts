/**
 * Replies to reminders, applied without a reviewer when that is safe, and undone on request.
 *
 * service.reminder-replies.ts turns one reply into one resolution. This is what happens next when
 * the reading is confident and the sender is the member the reminder went to: the resolution is
 * applied as a `reminder_reply.apply` action, the member gets one line back from the bot mailbox
 * saying what changed, and answering "undo" on that thread puts it back. Anything less certain --
 * a question, a low-confidence reading, a reply that could settle two things -- still goes to the
 * review queue as an `email_review.resolve` proposal.
 *
 * Off by default (ADMINBOT_REMINDER_REPLY_AUTO_ENABLED). It writes to members.
 */
import type {
  AdminBotActionProposal,
  AdminBotExecutionRequest,
  AdminBotExecutionResult,
  AdminBotLogisticsSchool,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import type {
  AdminBotEmailReviewItem,
  AdminBotEmailReviewResolution,
  AdminBotReminderReplyMatch,
  AdminBotReminderReplyReading,
  AdminBotReminderReplyTarget,
} from "../contracts/email-review.js";
import type { AdminBotNudgeLedgerRecord, AdminBotNudgeDomain } from "../contracts/paper-cycle.js";
import type { AdminBotPaperSlotRecord } from "../contracts/paper-slots.js";
import { adminBotPaperflowStages } from "../contracts/paperflow-stages.js";
import type { AdminBotServiceResponse, AdminBotServiceStore } from "./service.js";
import { parseEmailReviewResolution } from "./service.reminder-replies.js";

export const REMINDER_REPLY_AUTO_ENABLED_ENV = "ADMINBOT_REMINDER_REPLY_AUTO_ENABLED";

/**
 * The bar for acting without a person. Higher than the 0.6 that earns a proposal: a proposal that
 * is wrong costs an approver a click, an applied resolution that is wrong costs a member an undo.
 */
export const reminderReplyAutoMinConfidence = 0.8;

/** Off unless set to exactly "1", like every sweep that mails members. */
export function resolveReminderReplyAutoConfig(env: Readonly<Record<string, string | undefined>>): {
  enabled: boolean;
} {
  return { enabled: env[REMINDER_REPLY_AUTO_ENABLED_ENV]?.trim() === "1" };
}

/**
 * Whether this resolution may be applied without a reviewer.
 *
 * A dismissal is by definition "answer them by hand", and a question is never settled by a write.
 * Everything else is one write on one open target that the member themself asked for.
 */
export function canAutoApplyReminderReply(
  reading: AdminBotReminderReplyReading,
  resolution: AdminBotEmailReviewResolution,
): boolean {
  return (
    reading.intent !== "question" &&
    reading.confidence >= reminderReplyAutoMinConfidence &&
    resolution.kind !== "dismissed"
  );
}

/** The one open target a non-dismissal resolution acts on, for the wording of the confirmation. */
export function resolutionTarget(
  match: Pick<AdminBotReminderReplyMatch, "targets">,
  resolution: AdminBotEmailReviewResolution,
): AdminBotReminderReplyTarget | undefined {
  return match.targets.find((target) => {
    if (!target.open) {
      return false;
    }
    switch (resolution.kind) {
      case "paperflow_evidence":
      case "paperflow_skipped":
        return target.paper_id === resolution.paper_id && target.stage === resolution.stage;
      case "paper_slot_waived":
        return target.paper_id === resolution.paper_id && target.slot === resolution.slot;
      case "rec_letter_submitted":
      case "rec_letter_confirmed":
        return target.request_id === resolution.request_id;
      case "reminder_snoozed":
        return target.domain === resolution.domain && target.subject_id === resolution.subject_id;
      default:
        return false;
    }
  });
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The line the member gets back, e.g. "Thanks, I've marked Camera-ready for X as skipped: moved to
 * a Springer journal."
 *
 * Says exactly what changed, in the member's own reason, and how to take it back. Short on
 * purpose: it is a receipt, not a conversation.
 */
export function reminderReplyConfirmationBody(params: {
  memberName: string;
  label: string;
  resolution: AdminBotEmailReviewResolution;
}): string {
  const first = params.memberName.trim().split(/\s+/u)[0] || "there";
  const { resolution, label } = params;
  let line: string;
  switch (resolution.kind) {
    case "paperflow_evidence":
      line = `I've marked ${label} as done${resolution.note ? `: ${resolution.note}` : ""}`;
      break;
    case "paperflow_skipped":
      line = `I've marked ${label} as skipped${resolution.later_stages ? ", along with the later conference steps for this paper" : ""}: ${resolution.note}`;
      break;
    case "paper_slot_waived":
      line = `I've marked ${label} as not needed: ${resolution.note}`;
      break;
    case "rec_letter_submitted":
      line = `I've marked the letters for ${resolution.schools.join(", ")} as submitted`;
      break;
    case "rec_letter_confirmed":
      line = `I've marked ${label} as submitted`;
      break;
    case "reminder_snoozed":
      line = `I'll hold off on the ${label} until ${resolution.until.slice(0, 10)}`;
      break;
    default:
      line = `I've noted your reply about ${label}`;
  }
  return [
    `Hi ${first},`,
    "",
    `Thanks, ${sentence(line)}`,
    "",
    `Reply "undo" if that's wrong and I'll put it back.`,
    "",
    "AdminBot",
  ].join("\n");
}

/** The line after an undo: it is back the way it was, and a person will pick it up. */
export function reminderReplyUndoBody(params: { memberName: string; label: string }): string {
  const first = params.memberName.trim().split(/\s+/u)[0] || "there";
  return [
    `Hi ${first},`,
    "",
    `Done, I've undone that: ${params.label} is open again. Someone from the lab will follow up with you.`,
    "",
    "AdminBot",
  ].join("\n");
}

/**
 * Whether a reply's own text (not the quoted mail under it) is asking to undo.
 *
 * The first line the member wrote must start with "undo" and be short. "Please don't undo the
 * camera-ready" is not an undo; "Undo please" and "undo - wrong paper" are.
 */
export function isUndoReply(body: string): boolean {
  for (const raw of body.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith(">") || /^on .+wrote:$/iu.test(line)) {
      return false;
    }
    return line.length <= 80 && /^undo\b/iu.test(line);
  }
  return false;
}

/**
 * What the store looked like before one apply, as much as the undo needs and no more.
 *
 * Stored on the apply's execution artifacts as JSON, so the undo restores what was there rather
 * than guessing at a default, and refuses if somebody changed the same thing since.
 */
export type ReminderReplyUndoState =
  | { kind: "paperflow"; paper_id: string; stages: string[]; message_id: string }
  | {
      kind: "paper_slot";
      paper_id: string;
      slot: string;
      previous: AdminBotPaperSlotRecord | null;
    }
  | {
      kind: "rec_letter_schools";
      request_id: string;
      previous: Array<Pick<AdminBotLogisticsSchool, "school" | "letter_status">>;
    }
  | { kind: "rec_letter_confirmed"; request_id: string; member_id: string }
  | {
      kind: "snooze";
      domain: AdminBotNudgeDomain;
      subject_id: string;
      member_id: string;
      previous: AdminBotNudgeLedgerRecord | null;
    };

type UndoStore = Pick<
  AdminBotServiceStore,
  | "listPaperflowEvidence"
  | "deletePaperflowEvidence"
  | "listPaperSlots"
  | "savePaperSlot"
  | "getLogisticsRequest"
  | "saveLogisticsRequest"
  | "listNudgeLedger"
  | "saveNudgeLedgerEntry"
>;

function paperflowStagesFor(resolution: AdminBotEmailReviewResolution): string[] {
  if (resolution.kind === "paperflow_evidence") {
    return [resolution.stage];
  }
  if (resolution.kind !== "paperflow_skipped") {
    return [];
  }
  const index = (adminBotPaperflowStages as readonly string[]).indexOf(resolution.stage);
  return resolution.later_stages && index >= 0
    ? adminBotPaperflowStages.slice(index)
    : [resolution.stage];
}

/** The before-picture, taken just ahead of the write. Paperflow is finished off after it. */
export function snapshotForUndo(
  store: UndoStore,
  resolution: AdminBotEmailReviewResolution,
  messageId: string,
): ReminderReplyUndoState | undefined {
  switch (resolution.kind) {
    case "paperflow_evidence":
    case "paperflow_skipped": {
      // The stages already closed before this reply are not this reply's to reopen.
      const closed = new Set<string>(
        store.listPaperflowEvidence(resolution.paper_id).map((row) => row.stage),
      );
      return {
        kind: "paperflow",
        paper_id: resolution.paper_id,
        stages: paperflowStagesFor(resolution).filter((stage) => !closed.has(stage)),
        message_id: messageId,
      };
    }
    case "paper_slot_waived":
      return {
        kind: "paper_slot",
        paper_id: resolution.paper_id,
        slot: resolution.slot,
        previous:
          store.listPaperSlots(resolution.paper_id).find((row) => row.slot === resolution.slot) ??
          null,
      };
    case "rec_letter_submitted": {
      const request = store.getLogisticsRequest(resolution.request_id);
      const named = new Set(resolution.schools);
      return {
        kind: "rec_letter_schools",
        request_id: resolution.request_id,
        previous: (request?.schools ?? [])
          .filter((school) => named.has(school.school))
          .map((school) => ({ school: school.school, letter_status: school.letter_status })),
      };
    }
    case "rec_letter_confirmed":
      return {
        kind: "rec_letter_confirmed",
        request_id: resolution.request_id,
        member_id: resolution.member_id,
      };
    case "reminder_snoozed":
      return {
        kind: "snooze",
        domain: resolution.domain,
        subject_id: resolution.subject_id,
        member_id: resolution.member_id,
        previous:
          store
            .listNudgeLedger(resolution.domain)
            .find(
              (row) =>
                row.subject_id === resolution.subject_id && row.member_id === resolution.member_id,
            ) ?? null,
      };
    default:
      return undefined;
  }
}

function failure<T>(status: number, message: string): AdminBotServiceResponse<T> {
  return { ok: false, status, error: { message } };
}

/**
 * Put back what one apply changed. Refuses, rather than overwrites, anything changed since.
 *
 * `undoLetterConfirmation` is the letters module's own undo, passed in so its rules (only the
 * member who confirmed may reopen) are the ones that apply here too.
 */
export function revertUndoState(
  store: UndoStore,
  state: ReminderReplyUndoState,
  undoLetterConfirmation: (requestId: string, memberId: string) => AdminBotServiceResponse<unknown>,
): AdminBotServiceResponse<{ reverted: string }> {
  switch (state.kind) {
    case "paperflow": {
      const rows = store.listPaperflowEvidence(state.paper_id);
      let reopened = 0;
      for (const stage of state.stages) {
        const row = rows.find((entry) => entry.stage === stage);
        // Only a row this reply wrote. One an admin or a venue mail recorded since stays.
        if (row && row.recorded_by === "reply" && row.message_id === state.message_id) {
          reopened += store.deletePaperflowEvidence(state.paper_id, stage) ? 1 : 0;
        }
      }
      return { ok: true, status: 200, payload: { reverted: `${reopened} stage(s) reopened` } };
    }
    case "paper_slot": {
      const current = store.listPaperSlots(state.paper_id).find((row) => row.slot === state.slot);
      if (current && current.status !== "waived") {
        return failure(409, "the slot was changed after the reply; leaving it as it is");
      }
      store.savePaperSlot(
        state.previous ?? {
          paper_id: state.paper_id,
          slot: state.slot as AdminBotPaperSlotRecord["slot"],
          status: "missing",
        },
      );
      return { ok: true, status: 200, payload: { reverted: "slot un-waived" } };
    }
    case "rec_letter_schools": {
      const request = store.getLogisticsRequest(state.request_id);
      if (!request) {
        return failure(404, "letter request not found");
      }
      const previous = new Map(state.previous.map((row) => [row.school, row.letter_status]));
      store.saveLogisticsRequest({
        ...request,
        schools: (request.schools ?? []).map((school) => {
          if (!previous.has(school.school)) {
            return school;
          }
          const status = previous.get(school.school);
          const next = { ...school };
          if (status === undefined) {
            delete next.letter_status;
          } else {
            next.letter_status = status;
          }
          return next;
        }),
        updated_at: new Date().toISOString(),
      });
      return { ok: true, status: 200, payload: { reverted: "letter status restored" } };
    }
    case "rec_letter_confirmed": {
      const undone = undoLetterConfirmation(state.request_id, state.member_id);
      return undone.ok
        ? { ok: true, status: 200, payload: { reverted: "letter request reopened" } }
        : failure(undone.status, undone.error.message);
    }
    case "snooze": {
      const current = store
        .listNudgeLedger(state.domain)
        .find((row) => row.subject_id === state.subject_id && row.member_id === state.member_id);
      const base = state.previous ??
        current ?? {
          domain: state.domain,
          subject_id: state.subject_id,
          member_id: state.member_id,
          nudge_count: 0,
        };
      // Keep whatever the sweep stamped since; only the snooze is this reply's.
      const restored: AdminBotNudgeLedgerRecord = {
        ...(current ?? base),
        ...(state.previous?.snoozed_until ? { snoozed_until: state.previous.snoozed_until } : {}),
      };
      if (!state.previous?.snoozed_until) {
        delete restored.snoozed_until;
      }
      store.saveNudgeLedgerEntry(restored);
      return { ok: true, status: 200, payload: { reverted: "snooze cleared" } };
    }
  }
}

export function parseUndoState(raw: string | undefined): ReminderReplyUndoState | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const value = JSON.parse(raw) as { kind?: unknown };
    return value &&
      typeof value === "object" &&
      ["paperflow", "paper_slot", "rec_letter_schools", "rec_letter_confirmed", "snooze"].includes(
        String(value.kind),
      )
      ? (value as ReminderReplyUndoState)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What a `reminder_reply.apply` proposal carries. Built here, read back by the execute arm. */
export type ReminderReplyApplyPayload = {
  review: AdminBotEmailReviewItem;
  member_id: string;
  member_name: string;
  label: string;
  reminder_action_id: string;
  reading: AdminBotReminderReplyReading;
  resolution: AdminBotEmailReviewResolution;
};

export function parseApplyPayload(
  proposal: Pick<AdminBotStoredProposal, "type" | "proposed_payload">,
): ReminderReplyApplyPayload | undefined {
  if (proposal.type !== "reminder_reply.apply") {
    return undefined;
  }
  const row = proposal.proposed_payload as Partial<ReminderReplyApplyPayload> | undefined;
  const resolution = parseEmailReviewResolution(row?.resolution);
  const review = row?.review;
  if (
    !row ||
    !resolution ||
    resolution.kind === "dismissed" ||
    !review ||
    typeof review.message_id !== "string" ||
    typeof review.thread_id !== "string" ||
    typeof review.sender !== "string" ||
    typeof row.member_id !== "string" ||
    typeof row.label !== "string"
  ) {
    return undefined;
  }
  return { ...(row as ReminderReplyApplyPayload), resolution };
}

export type ReminderReplyAutoDeps = {
  store: UndoStore &
    Pick<
      AdminBotServiceStore,
      "saveEmailReview" | "getProposal" | "getExecutionResult" | "listProposalsByType"
    >;
  createProposal: (
    proposal: AdminBotActionProposal,
  ) => AdminBotServiceResponse<AdminBotStoredProposal>;
  execute: (
    actionId: string,
    request: AdminBotExecutionRequest,
  ) => Promise<AdminBotServiceResponse<AdminBotExecutionResult>>;
  resolveEmailReview: (params: {
    messageId: string;
    resolution: AdminBotEmailReviewResolution;
    actor: string;
    recordedBy: "reply";
  }) => AdminBotServiceResponse<unknown>;
  undoLetterConfirmation: (requestId: string, memberId: string) => AdminBotServiceResponse<unknown>;
  recordAudit: (event: {
    type: "reminder_reply.applied" | "reminder_reply.undone";
    actor: string;
    action_id?: string;
    details: Record<string, unknown>;
  }) => void;
};

/**
 * The execute arm for `reminder_reply.apply`: snapshot, write, and keep the snapshot.
 *
 * The actor is the member who replied. The approval-less path is only safe because it is their own
 * reminder; the audit row says so in their name.
 */
export function executeReminderReplyApply(
  deps: ReminderReplyAutoDeps,
  proposal: AdminBotStoredProposal,
): AdminBotServiceResponse<Record<string, string>> {
  const payload = parseApplyPayload(proposal);
  if (!payload) {
    return failure(400, "reminder reply payload is invalid");
  }
  const state = snapshotForUndo(deps.store, payload.resolution, payload.review.message_id);
  if (!state) {
    return failure(400, "this resolution cannot be applied from a reply");
  }
  const applied = deps.resolveEmailReview({
    messageId: payload.review.message_id,
    resolution: payload.resolution,
    actor: payload.member_id,
    recordedBy: "reply",
  });
  if (!applied.ok) {
    return failure(applied.status, applied.error.message);
  }
  deps.recordAudit({
    type: "reminder_reply.applied",
    actor: payload.member_id,
    action_id: proposal.id,
    details: {
      message_id: payload.review.message_id,
      reminder_action_id: payload.reminder_action_id,
      resolution: payload.resolution.kind,
      note: payload.reading.note,
    },
  });
  return {
    ok: true,
    status: 200,
    payload: { resolution: payload.resolution.kind, undo_state: JSON.stringify(state) },
  };
}

/** An executed undo for this apply, if there is one. An apply is undone at most once. */
function undoneBy(
  store: ReminderReplyAutoDeps["store"],
  applyActionId: string,
): string | undefined {
  for (const proposal of store.listProposalsByType("reminder_reply.undo")) {
    const payload = proposal.proposed_payload as { apply_action_id?: unknown } | undefined;
    if (payload?.apply_action_id !== applyActionId) {
      continue;
    }
    const result = store.getExecutionResult(proposal.id);
    if (result?.status === "executed" && !result.dry_run) {
      return proposal.id;
    }
  }
  return undefined;
}

/**
 * The execute arm for `reminder_reply.undo`: revert, then put the reply back in the review queue.
 *
 * Back in the queue because an undo means the reading was wrong, and the right answer is now a
 * person's to give -- the same place any unclear reply goes.
 */
export function executeReminderReplyUndo(
  deps: ReminderReplyAutoDeps,
  proposal: AdminBotStoredProposal,
  actor: string,
): AdminBotServiceResponse<Record<string, string>> {
  const applyActionId = (proposal.proposed_payload as { apply_action_id?: unknown } | undefined)
    ?.apply_action_id;
  if (typeof applyActionId !== "string") {
    return failure(400, "reminder reply undo payload is invalid");
  }
  const apply = deps.store.getProposal(applyActionId);
  const payload = apply ? parseApplyPayload(apply) : undefined;
  const result = deps.store.getExecutionResult(applyActionId);
  if (!apply || !payload || result?.status !== "executed" || result.dry_run) {
    return failure(404, "no applied reminder reply with that id");
  }
  if (undoneBy(deps.store, applyActionId)) {
    return failure(409, "that reply was already undone");
  }
  const state = parseUndoState(result.artifacts?.undo_state);
  if (!state) {
    return failure(409, "that reply left no record of what to put back");
  }
  const reverted = revertUndoState(deps.store, state, deps.undoLetterConfirmation);
  if (!reverted.ok) {
    return failure(reverted.status, reverted.error.message);
  }
  deps.store.saveEmailReview({
    ...payload.review,
    reason: `undone by ${actor}: ${payload.review.reason ?? "reminder reply"}`,
    updated_at: new Date().toISOString(),
  });
  deps.recordAudit({
    type: "reminder_reply.undone",
    actor,
    action_id: proposal.id,
    details: {
      apply_action_id: applyActionId,
      message_id: payload.review.message_id,
      resolution: payload.resolution.kind,
      reverted: reverted.payload.reverted,
    },
  });
  return {
    ok: true,
    status: 200,
    payload: { apply_action_id: applyActionId, reverted: reverted.payload.reverted },
  };
}

export type ReminderReplyAutoOutcome = {
  outcome: "applied" | "apply_failed";
  apply_action_id?: string;
  confirm_action_id?: string;
  /** Present when the apply went through but the receipt did not. The apply stands. */
  confirm_error?: string;
  error?: string;
};

/**
 * Apply one confident reply and send its receipt.
 *
 * The review row is saved first, because the apply settles it and needs it there. A failed apply
 * is returned as such for the caller to fall back to a proposal; a failed receipt is reported but
 * never unwinds the apply, since the member's answer was still right.
 */
export async function autoApplyReminderReply(
  deps: ReminderReplyAutoDeps,
  params: {
    review: AdminBotEmailReviewItem;
    match: AdminBotReminderReplyMatch;
    reading: AdminBotReminderReplyReading;
    resolution: AdminBotEmailReviewResolution;
    summary: string;
    label: string;
    to: string;
    account?: string;
  },
): Promise<ReminderReplyAutoOutcome> {
  deps.store.saveEmailReview(params.review);
  const payload: ReminderReplyApplyPayload = {
    review: params.review,
    member_id: params.match.member_id,
    member_name: params.match.member_name,
    label: params.label,
    reminder_action_id: params.match.reminder_action_id,
    reading: params.reading,
    resolution: params.resolution,
  };
  const created = deps.createProposal({
    type: "reminder_reply.apply",
    summary: params.summary,
    target: { service: "adminbot", channel: "adminbot", target: params.review.message_id },
    proposed_payload: payload,
    rationale: `${params.match.member_name} replied to "${params.match.reminder_subject}" (${Math.round(params.reading.confidence * 100)}% confident, matched by ${params.match.matched_by}).`,
    undo_plan: `The member replies "undo", or an admin runs reminder_reply.undo with this action id.`,
    idempotency_key: `reminder_reply.apply:${params.review.message_id}`,
  });
  if (!created.ok) {
    return { outcome: "apply_failed", error: created.error.message };
  }
  const executed = await deps.execute(created.payload.id, {
    dry_run: false,
    idempotency_key: `reminder_reply.apply:${params.review.message_id}`,
  });
  if (!executed.ok) {
    return {
      outcome: "apply_failed",
      apply_action_id: created.payload.id,
      error: executed.error.message,
    };
  }
  const body = reminderReplyConfirmationBody({
    memberName: params.match.member_name,
    label: params.label,
    resolution: params.resolution,
  });
  const confirm = await sendReminderReplyNote(deps, {
    messageId: params.review.message_id,
    threadId: params.review.thread_id,
    to: params.to,
    body,
    summary: `Tell ${params.match.member_name} what their reply changed`,
    account: params.account,
    key: `reminder_reply.confirm:${params.review.message_id}`,
  });
  return {
    outcome: "applied",
    apply_action_id: created.payload.id,
    ...confirm,
  };
}

/** One reply on the member's thread from the bot mailbox, as an action so it is audited. */
export async function sendReminderReplyNote(
  deps: Pick<ReminderReplyAutoDeps, "createProposal" | "execute">,
  params: {
    messageId: string;
    threadId: string;
    to: string;
    body: string;
    summary: string;
    account?: string;
    key: string;
  },
): Promise<{ confirm_action_id?: string; confirm_error?: string }> {
  const created = deps.createProposal({
    type: "reminder_reply.confirm",
    summary: params.summary,
    target: { service: "email", channel: "email", target: params.to },
    proposed_payload: {
      message_id: params.messageId,
      thread_id: params.threadId,
      to: params.to,
      body: params.body,
      ...(params.account ? { account: params.account } : {}),
    },
    undo_plan: "Send a follow-up on the same thread correcting it.",
    idempotency_key: params.key,
  });
  if (!created.ok) {
    return { confirm_error: created.error.message };
  }
  const sent = await deps.execute(created.payload.id, {
    dry_run: false,
    idempotency_key: params.key,
  });
  return sent.ok
    ? { confirm_action_id: created.payload.id }
    : { confirm_action_id: created.payload.id, confirm_error: sent.error.message };
}

/**
 * The applied reply an "undo" on this thread takes back: the newest, not yet undone, from the
 * member it was applied for. A stranger on the thread cannot undo someone else's answer.
 */
export function findUndoableApply(
  store: ReminderReplyAutoDeps["store"],
  params: { threadId: string; sender: string; addressesOf: (memberId: string) => string[] },
): { proposal: AdminBotStoredProposal; payload: ReminderReplyApplyPayload } | undefined {
  const sender = params.sender.trim().toLowerCase();
  const candidates: Array<{
    proposal: AdminBotStoredProposal;
    payload: ReminderReplyApplyPayload;
    at: number;
  }> = [];
  for (const proposal of store.listProposalsByType("reminder_reply.apply")) {
    const payload = parseApplyPayload(proposal);
    if (!payload || payload.review.thread_id !== params.threadId) {
      continue;
    }
    if (!params.addressesOf(payload.member_id).includes(sender)) {
      continue;
    }
    const result = store.getExecutionResult(proposal.id);
    if (result?.status !== "executed" || result.dry_run || undoneBy(store, proposal.id)) {
      continue;
    }
    candidates.push({ proposal, payload, at: Date.parse(result.executed_at) });
  }
  candidates.sort((a, b) => b.at - a.at);
  const newest = candidates[0];
  return newest ? { proposal: newest.proposal, payload: newest.payload } : undefined;
}
