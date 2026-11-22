/**
 * Replies to reminders, applied without a reviewer when that is safe, and undone on request.
 *
 * service.reminder-replies.ts turns one reply into one resolution. This decides whether that
 * resolution may be applied with no admin ("safe auto"), and runs it when it may. Safe auto is
 * narrow on purpose: an authenticated reply from the member's roster address, on the reminder's
 * own thread, not forwarded, reading as a plain "done" for exactly one open PaperFlow stage. The
 * member then gets a fixed-template receipt from the bot mailbox, and replying "undo" puts it
 * back. Everything else -- including every other kind of resolution -- goes to the review queue
 * as an `email_review.resolve` proposal and changes nothing until an admin approves it.
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
export const reminderReplyAutoMinConfidence = 0.9;

/** Off unless set to exactly "1", like every sweep that mails members. */
export function resolveReminderReplyAutoConfig(env: Readonly<Record<string, string | undefined>>): {
  enabled: boolean;
} {
  return { enabled: env[REMINDER_REPLY_AUTO_ENABLED_ENV]?.trim() === "1" };
}

/**
 * What the mail itself shows about who sent it, from headers the sender does not get to write.
 *
 * Built once by the mail pass and stored on the proposal, so the execute arm and the backfill
 * re-check the same facts rather than trusting that somebody checked them earlier.
 */
export type ReminderReplySenderEvidence = {
  /** Gmail's own Authentication-Results show an aligned DMARC, DKIM or SPF pass for From. */
  authenticated: boolean;
  method?: "dmarc" | "dkim" | "spf";
  /** The bare From address, lower-cased. */
  from: string;
  reply_to?: string;
  in_reply_to?: string;
  forwarded: boolean;
};

/** The bare address in a header value such as `"Name" <a@b.c>`, lower-cased. */
export function bareAddress(value: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/u.exec(value);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase().replace(/\.$/u, "");
}

/** Relaxed alignment: the same domain, or one a subdomain of the other. Never a bare TLD. */
function alignedDomains(a: string, b: string): boolean {
  if (!a.includes(".") || !b.includes(".")) {
    return false;
  }
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** The receiving server Gmail stamps on the Authentication-Results header it adds. */
const gmailAuthservId = "mx.google.com";

/**
 * Which check, if any, proves the From domain, read from Gmail's Authentication-Results.
 *
 * Only the first such header counts. Gmail adds its own above everything that arrived with the
 * mail, so a header the sender wrote further down -- even one claiming to be mx.google.com -- is
 * never read. DMARC must name the From domain exactly; DKIM's signing domain and SPF's envelope
 * domain must align with it.
 */
export function authenticatedSenderMethod(
  from: string,
  authenticationResults: readonly string[],
): ReminderReplySenderEvidence["method"] {
  const header = authenticationResults[0];
  if (!header) {
    return undefined;
  }
  let text = header.replace(/\s+/gu, " ");
  // Comments, e.g. "(google.com: domain of x designates ...)", carry no verdict and may nest.
  for (let pass = 0; pass < 5 && /\([^()]*\)/u.test(text); pass += 1) {
    text = text.replace(/\([^()]*\)/gu, " ");
  }
  const [authserv, ...results] = text.split(";").map((part) => part.trim());
  if (authserv?.split(" ")[0]?.toLowerCase() !== gmailAuthservId) {
    return undefined;
  }
  const fromDomain = domainOf(bareAddress(from));
  if (!fromDomain) {
    return undefined;
  }
  const passed = new Set<NonNullable<ReminderReplySenderEvidence["method"]>>();
  for (const result of results) {
    const found = /^(dmarc|dkim|spf)\s*=\s*([a-z]+)(.*)$/iu.exec(result);
    if (!found || found[2]?.toLowerCase() !== "pass") {
      continue;
    }
    const method = found[1]!.toLowerCase() as "dmarc" | "dkim" | "spf";
    const props = new Map<string, string>();
    for (const prop of (found[3] ?? "").matchAll(/([a-z]+\.[a-z-]+)\s*=\s*("[^"]*"|[^\s;]+)/giu)) {
      props.set(prop[1]!.toLowerCase(), prop[2]!.replace(/^"|"$/gu, "").toLowerCase());
    }
    if (method === "dmarc") {
      if (props.get("header.from") === fromDomain) {
        passed.add("dmarc");
      }
    } else if (method === "dkim") {
      const signer = props.get("header.d") ?? domainOf(props.get("header.i") ?? "");
      if (alignedDomains(signer, fromDomain)) {
        passed.add("dkim");
      }
    } else if (alignedDomains(domainOf(props.get("smtp.mailfrom") ?? ""), fromDomain)) {
      passed.add("spf");
    }
  }
  return (["dmarc", "dkim", "spf"] as const).find((method) => passed.has(method));
}

/** A forward rather than a reply: by its subject prefix or by the forwarded-message block. */
export function isForwardedReply(subject: string, body: string): boolean {
  let rest = subject.trim();
  for (let pass = 0; pass < 10; pass += 1) {
    const prefix = /^([a-z]{2,3})\s*(?:\[\d+\])?\s*:\s*/iu.exec(rest);
    if (!prefix) {
      break;
    }
    if (/^(fwd?|fw|wg|tr)$/iu.test(prefix[1]!)) {
      return true;
    }
    if (!/^(re|aw|sv)$/iu.test(prefix[1]!)) {
      break;
    }
    rest = rest.slice(prefix[0].length);
  }
  return (
    /-{2,}\s*forwarded message\s*-{2,}/iu.test(body) || /^\s*begin forwarded message:/imu.test(body)
  );
}

/**
 * The part of a reply the member wrote: everything above the first quote or quoted-header block.
 *
 * Only this goes to the model. Text under "On ... wrote:" is AdminBot's own reminder, or somebody
 * else's mail, and neither is the member's answer.
 */
export function authoredReplyText(body: string): string {
  const lines = body.split(/\r?\n/u);
  const kept: string[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const next = lines[index + 1]?.trim() ?? "";
    if (
      line.startsWith(">") ||
      /^on\s.+wrote:$/iu.test(line) ||
      (/^on\s/iu.test(line) && /wrote:$/iu.test(next) && !/^on\s/iu.test(next)) ||
      /^-{2,}\s*(original|forwarded) message\s*-{2,}/iu.test(line) ||
      /^begin forwarded message:/iu.test(line) ||
      /^_{5,}$/u.test(line) ||
      /^from:\s/iu.test(line)
    ) {
      break;
    }
    kept.push(raw);
  }
  return kept.join("\n").trim();
}

export function reminderReplySenderEvidence(params: {
  from: string;
  replyTo?: string;
  inReplyTo?: string;
  authenticationResults: readonly string[];
  subject?: string;
  body: string;
}): ReminderReplySenderEvidence {
  const method = authenticatedSenderMethod(params.from, params.authenticationResults);
  const replyTo = params.replyTo?.trim() ? bareAddress(params.replyTo) : undefined;
  const inReplyTo = params.inReplyTo?.trim() || undefined;
  return {
    authenticated: Boolean(method),
    ...(method ? { method } : {}),
    from: bareAddress(params.from),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
    forwarded: isForwardedReply(params.subject ?? "", params.body),
  };
}

export function parseSenderEvidence(raw: unknown): ReminderReplySenderEvidence | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  if (
    typeof row.authenticated !== "boolean" ||
    typeof row.from !== "string" ||
    typeof row.forwarded !== "boolean" ||
    (row.method !== undefined && !["dmarc", "dkim", "spf"].includes(String(row.method))) ||
    (row.reply_to !== undefined && typeof row.reply_to !== "string") ||
    (row.in_reply_to !== undefined && typeof row.in_reply_to !== "string")
  ) {
    return undefined;
  }
  return {
    authenticated: row.authenticated,
    ...(row.method ? { method: row.method as ReminderReplySenderEvidence["method"] } : {}),
    from: row.from,
    ...(row.reply_to ? { reply_to: row.reply_to as string } : {}),
    ...(row.in_reply_to ? { in_reply_to: row.in_reply_to as string } : {}),
    forwarded: row.forwarded,
  };
}

/** The only resolution the safe path writes: done, on one stage, with a fixed note and no URL. */
export type ReminderReplySafeResolution = Extract<
  AdminBotEmailReviewResolution,
  { kind: "paperflow_evidence" }
>;

export function safeAutoResolution(
  target: Pick<AdminBotReminderReplyTarget, "paper_id" | "stage">,
): ReminderReplySafeResolution {
  return {
    kind: "paperflow_evidence",
    paper_id: target.paper_id ?? "",
    stage: target.stage ?? "",
    note: "member replied done to the reminder",
  };
}

export type ReminderReplySafeAutoVerdict =
  | { ok: true; target: AdminBotReminderReplyTarget; resolution: ReminderReplySafeResolution }
  | { ok: false; why: string };

/**
 * Whether a reply may be applied with no admin. Every condition must hold; the first that fails
 * is the reason it goes to review.
 *
 * The model's reading only gets to say "this is a plain done" or not. What gets written is built
 * here from the matched target, so nothing the model wrote -- a note, a URL, "later stages", a
 * different kind -- can reach the record without an admin.
 */
export function safeAutoVerdict(params: {
  match: Pick<AdminBotReminderReplyMatch, "matched_by" | "targets">;
  reading: AdminBotReminderReplyReading;
  evidence: ReminderReplySenderEvidence | undefined;
  sender: string;
  rosterAddresses: readonly string[];
}): ReminderReplySafeAutoVerdict {
  const no = (why: string): ReminderReplySafeAutoVerdict => ({ ok: false, why });
  const { evidence, reading, match } = params;
  const sender = bareAddress(params.sender);
  const roster = new Set(params.rosterAddresses.map((address) => address.trim().toLowerCase()));
  if (!evidence) {
    return no("no sender authentication on record");
  }
  if (!evidence.authenticated) {
    return no("the sender is not authenticated (no aligned DMARC, DKIM or SPF pass)");
  }
  if (evidence.from !== sender || !roster.has(sender)) {
    return no("the From address is not the member's roster address");
  }
  if (evidence.reply_to && evidence.reply_to !== sender) {
    return no("Reply-To points somewhere other than the sender");
  }
  if (evidence.forwarded) {
    return no("the mail is forwarded");
  }
  if (match.matched_by !== "thread" || !evidence.in_reply_to) {
    return no("not a direct reply on the reminder's own thread");
  }
  if (reading.intent !== "done") {
    return no(
      reading.intent === "question"
        ? "the member asked a question"
        : `the reply reads as ${reading.intent}, not done`,
    );
  }
  if (reading.moved_elsewhere) {
    return no("the reply says the paper moved elsewhere");
  }
  if (!(reading.confidence >= reminderReplyAutoMinConfidence)) {
    return no(`only ${Math.round(reading.confidence * 100)}% confident`);
  }
  const open = match.targets.filter((target) => target.open);
  if (open.length !== 1) {
    return no(
      open.length === 0
        ? "the item it answers is no longer open"
        : "the reply could settle more than one item",
    );
  }
  const target = open[0]!;
  if (target.domain !== "paperflow_stage" || !target.paper_id || !target.stage) {
    return no("only a PaperFlow stage is settled without an admin");
  }
  return { ok: true, target, resolution: safeAutoResolution(target) };
}

function firstName(memberName: string): string {
  return memberName.trim().split(/\s+/u)[0] || "there";
}

/** "Re: <the reminder's subject>", so the receipt reads as part of the same conversation. */
export function reminderReplyReceiptSubject(reminderSubject: string): string {
  const subject = reminderSubject.trim();
  return /^re\s*:/iu.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * The receipt the member gets: a fixed template naming the stage and how to undo it.
 *
 * Fixed on purpose. No word of it comes from the model or from the member's mail; the name is the
 * roster's and the label is the stage's. The execute arm rebuilds it and refuses any other text.
 */
export function reminderReplyConfirmationBody(params: {
  memberName: string;
  label: string;
}): string {
  return [
    `Hi ${firstName(params.memberName)},`,
    "",
    `Thanks, I've marked ${params.label} as done.`,
    "",
    `If that's wrong, reply "undo" to this email and I'll put it back.`,
    "",
    "AdminBot",
  ].join("\n");
}

/** The line after an undo: it is back the way it was, and a person will pick it up. */
export function reminderReplyUndoBody(params: { memberName: string; label: string }): string {
  return [
    `Hi ${firstName(params.memberName)},`,
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
  /** The subject of the reminder AdminBot sent, for the receipt's "Re:" line. */
  reminder_subject: string;
  /** Where the receipt goes: the roster address the authenticated From matched. */
  receipt_to: string;
  sender_evidence: ReminderReplySenderEvidence;
  reading: AdminBotReminderReplyReading;
  resolution: ReminderReplySafeResolution;
};

export function parseApplyPayload(
  proposal: Pick<AdminBotStoredProposal, "type" | "proposed_payload">,
): ReminderReplyApplyPayload | undefined {
  if (proposal.type !== "reminder_reply.apply") {
    return undefined;
  }
  const row = proposal.proposed_payload as Partial<ReminderReplyApplyPayload> | undefined;
  const resolution = parseEmailReviewResolution(row?.resolution);
  const evidence = parseSenderEvidence(row?.sender_evidence);
  const review = row?.review;
  if (
    !row ||
    !resolution ||
    resolution.kind !== "paperflow_evidence" ||
    !evidence ||
    !review ||
    typeof review.message_id !== "string" ||
    typeof review.thread_id !== "string" ||
    typeof review.sender !== "string" ||
    typeof row.member_id !== "string" ||
    typeof row.member_name !== "string" ||
    typeof row.label !== "string" ||
    typeof row.reminder_action_id !== "string" ||
    typeof row.reminder_subject !== "string" ||
    typeof row.receipt_to !== "string"
  ) {
    return undefined;
  }
  return { ...(row as ReminderReplyApplyPayload), resolution, sender_evidence: evidence };
}

/**
 * The only receipt text the confirm arm accepts for an apply, or for its undo.
 *
 * Rebuilt from the stored apply, never read from the confirm's own payload, so a confirm that was
 * edited or forged cannot mail anyone anything else.
 */
export function expectedReceipt(
  apply: ReminderReplyApplyPayload,
  kind: "applied" | "undone",
): { to: string; subject: string; body: string } {
  const params = { memberName: apply.member_name, label: apply.label };
  return {
    to: apply.receipt_to,
    subject: reminderReplyReceiptSubject(apply.reminder_subject),
    body:
      kind === "applied" ? reminderReplyConfirmationBody(params) : reminderReplyUndoBody(params),
  };
}

export type ReminderReplyAutoDeps = {
  store: UndoStore &
    Pick<
      AdminBotServiceStore,
      "saveEmailReview" | "getProposal" | "getExecutionResult" | "listProposalsByType"
    >;
  /**
   * Create a service-internal reminder_reply.* proposal under a key enforced in storage. A second
   * call with the same key, in any status, returns the first proposal with `created: false`.
   */
  createKeyedProposal: (
    proposal: AdminBotActionProposal,
    key: string,
  ) => AdminBotServiceResponse<{ proposal: AdminBotStoredProposal; created: boolean }>;
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
 * reminder; the audit row says so in their name. The caller re-checks the match and the safe-auto
 * verdict before calling this.
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
      paper_id: payload.resolution.paper_id,
      stage: payload.resolution.stage,
      sender_auth: payload.sender_evidence.method ?? "none",
    },
  });
  return {
    ok: true,
    status: 200,
    payload: { resolution: payload.resolution.kind, undo_state: JSON.stringify(state) },
  };
}

/** An executed undo for this apply, if there is one. An apply is undone at most once. */
export function undoneBy(
  store: Pick<AdminBotServiceStore, "listProposalsByType" | "getExecutionResult">,
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
 * Only the member the reply was applied for may undo it, and only by an authenticated reply (the
 * caller checks the mail; this checks the name). Back in the queue because an undo means the
 * reading was wrong, and the right answer is now a person's to give.
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
  if (actor !== payload.member_id) {
    return failure(403, "only the member who replied can undo their reply");
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
  /** "duplicate": this message already has an apply, in whatever state; nothing ran again. */
  outcome: "applied" | "apply_failed" | "duplicate";
  apply_action_id?: string;
  confirm_action_id?: string;
  /** Present when the apply went through but the receipt did not. The apply stands. */
  confirm_error?: string;
  error?: string;
};

/**
 * Apply one reply that passed safeAutoVerdict, and send its fixed receipt.
 *
 * The keyed apply is created first: a second pass over the same message -- concurrent or later,
 * whatever state the first is in -- gets "duplicate" and runs nothing. A failed apply is returned
 * for the caller to fall back to a proposal; a failed receipt never unwinds the apply.
 */
export async function autoApplyReminderReply(
  deps: ReminderReplyAutoDeps,
  params: {
    review: AdminBotEmailReviewItem;
    match: AdminBotReminderReplyMatch;
    reading: AdminBotReminderReplyReading;
    resolution: ReminderReplySafeResolution;
    evidence: ReminderReplySenderEvidence;
    summary: string;
    label: string;
    receiptTo: string;
    account?: string;
  },
): Promise<ReminderReplyAutoOutcome> {
  const payload: ReminderReplyApplyPayload = {
    review: params.review,
    member_id: params.match.member_id,
    member_name: params.match.member_name,
    label: params.label,
    reminder_action_id: params.match.reminder_action_id,
    reminder_subject: params.match.reminder_subject,
    receipt_to: params.receiptTo,
    sender_evidence: params.evidence,
    reading: params.reading,
    resolution: params.resolution,
  };
  const key = `reminder_reply.apply:${params.review.message_id}`;
  const created = deps.createKeyedProposal(
    {
      type: "reminder_reply.apply",
      summary: params.summary,
      target: { service: "adminbot", channel: "adminbot", target: params.review.message_id },
      proposed_payload: payload,
      rationale: `${params.match.member_name} replied "done" to "${params.match.reminder_subject}" on its own thread, from an authenticated roster address (${params.evidence.method}).`,
      undo_plan: `The member replies "undo" to the receipt.`,
      idempotency_key: key,
    },
    key,
  );
  if (!created.ok) {
    return { outcome: "apply_failed", error: created.error.message };
  }
  if (!created.payload.created) {
    return { outcome: "duplicate", apply_action_id: created.payload.proposal.id };
  }
  const applyId = created.payload.proposal.id;
  deps.store.saveEmailReview(params.review);
  const executed = await deps.execute(applyId, { dry_run: false, idempotency_key: key });
  if (!executed.ok) {
    return { outcome: "apply_failed", apply_action_id: applyId, error: executed.error.message };
  }
  const receipt = expectedReceipt(payload, "applied");
  const confirm = await sendReminderReplyNote(deps, {
    sourceActionId: applyId,
    kind: "applied",
    ...receipt,
    summary: `Tell ${params.match.member_name} ${params.label} was marked done`,
    account: params.account,
    key: `reminder_reply.confirm:${params.review.message_id}`,
  });
  return { outcome: "applied", apply_action_id: applyId, ...confirm };
}

/**
 * One fixed-template mail from the bot mailbox to the member's roster address, as an action so it
 * is audited. A fresh send, never a Gmail reply: a reply would follow the incoming Reply-To.
 */
export async function sendReminderReplyNote(
  deps: Pick<ReminderReplyAutoDeps, "createKeyedProposal" | "execute">,
  params: {
    sourceActionId: string;
    kind: "applied" | "undone";
    to: string;
    subject: string;
    body: string;
    summary: string;
    account?: string;
    key: string;
  },
): Promise<{ confirm_action_id?: string; confirm_error?: string }> {
  const created = deps.createKeyedProposal(
    {
      type: "reminder_reply.confirm",
      summary: params.summary,
      target: { service: "email", channel: "email", target: params.to },
      proposed_payload: {
        source_action_id: params.sourceActionId,
        kind: params.kind,
        to: params.to,
        subject: params.subject,
        body: params.body,
        ...(params.account ? { account: params.account } : {}),
      },
      undo_plan: "Send a follow-up correcting it.",
      idempotency_key: params.key,
    },
    params.key,
  );
  if (!created.ok) {
    return { confirm_error: created.error.message };
  }
  const id = created.payload.proposal.id;
  if (!created.payload.created) {
    return { confirm_action_id: id };
  }
  const sent = await deps.execute(id, { dry_run: false, idempotency_key: params.key });
  return sent.ok
    ? { confirm_action_id: id }
    : { confirm_action_id: id, confirm_error: sent.error.message };
}

/**
 * The applied reply an "undo" on this thread takes back: the newest, not yet undone, from the
 * member it was applied for. The thread is either the member's reply thread or the receipt's own
 * (a fresh send starts one). A stranger on the thread cannot undo someone else's answer.
 */
export function findUndoableApply(
  store: ReminderReplyAutoDeps["store"],
  params: { threadId: string; sender: string; addressesOf: (memberId: string) => string[] },
): { proposal: AdminBotStoredProposal; payload: ReminderReplyApplyPayload } | undefined {
  const sender = bareAddress(params.sender);
  const receiptThreads = new Map<string, string>();
  for (const confirm of store.listProposalsByType("reminder_reply.confirm")) {
    const row = confirm.proposed_payload as
      | { source_action_id?: unknown; kind?: unknown }
      | undefined;
    const source = row?.source_action_id;
    const thread = store.getExecutionResult(confirm.id)?.artifacts?.gmail_thread_id;
    // Only the receipt for the apply: the later "undone" note shares its source id.
    if (typeof source === "string" && thread && row?.kind === "applied") {
      receiptThreads.set(source, thread);
    }
  }
  const candidates: Array<{
    proposal: AdminBotStoredProposal;
    payload: ReminderReplyApplyPayload;
    at: number;
  }> = [];
  for (const proposal of store.listProposalsByType("reminder_reply.apply")) {
    const payload = parseApplyPayload(proposal);
    if (
      !payload ||
      (payload.review.thread_id !== params.threadId &&
        receiptThreads.get(proposal.id) !== params.threadId)
    ) {
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
