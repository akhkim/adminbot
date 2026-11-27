/**
 * Replies to AdminBot's own reminder emails.
 *
 * A member who answers "yes, we sent it to a Springer journal" to a camera-ready nudge has told
 * the lab something, but the inbox pass used to hold that reply as an unknown message while the
 * nudge kept going. This module ties a reply back to the reminder it answers and to the thing that
 * reminder asked about, and turns the model's reading of it into exactly one resolution an admin
 * can approve. Nothing here writes: the service saves, snoozes and proposes.
 */
import type { AdminBotExecutionResult, AdminBotPaperRecord } from "../contracts/actions.js";
import {
  adminBotReminderReplyIntents,
  type AdminBotEmailReviewResolution,
  type AdminBotReminderReplyMatch,
  type AdminBotReminderReplyReading,
  type AdminBotReminderReplyTarget,
} from "../contracts/email-review.js";
import { adminBotNudgeDomains, type AdminBotNudgeLedgerRecord } from "../contracts/paper-cycle.js";
import {
  adminBotPaperflowStageRegistry,
  adminBotPaperflowStages,
  type AdminBotPaperflowStage,
} from "../contracts/paperflow-stages.js";
import { memberAddresses } from "../workflows/calendar/standing-meetings.js";
import { isLetterStatusSubmitted } from "../workflows/logistics/requests.js";
import type { AdminBotServiceStore } from "./service.js";

/** How far back a reply can reach. Older reminders have been re-sent by then, or settled. */
export const reminderReplyLookbackDays = 60;
/** The longest quiet a reply buys, matching the cap on an author-set snooze. */
export const reminderReplySnoozeDays = 14;
/** Below this the reading is a guess, and a guess is not something to put in front of an approver. */
export const reminderReplyMinConfidence = 0.6;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One reminder AdminBot actually delivered by email. */
export type ReminderSend = {
  action_id: string;
  type:
    | "member_nudge.send"
    | "logistics.rec_letter_reminder"
    | "logistics.rec_letter_overdue_check";
  subject: string;
  body: string;
  sent_at: string;
  member_id: string;
  thread_id?: string;
  /** The RFC Message-ID Gmail gave the reminder, which a direct reply names in In-Reply-To. */
  message_id_header?: string;
};

/**
 * "Re: Fwd: AW: Camera ready: X" and "camera ready: x" are the same thread to a person.
 *
 * Reply prefixes are stripped repeatedly and in the languages the lab's mail clients use (German
 * AW/WG, Nordic SV, Dutch Antw, French TR), because a reply from ETH arrives as "AW:".
 */
export function normalizeReminderSubject(subject: string | undefined): string {
  let text = (subject ?? "").trim();
  const prefix = /^(?:re|fwd?|aw|wg|sv|antw|tr)(?:\[\d+\])?\s*:\s*/iu;
  while (prefix.test(text)) {
    text = text.replace(prefix, "");
  }
  return text.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function delivered(result: AdminBotExecutionResult | undefined): result is AdminBotExecutionResult {
  return Boolean(result && result.status === "executed" && !result.dry_run);
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * Every reminder email that left the building inside the lookback, newest first.
 *
 * Only executed, live sends: a dry run or a proposal nobody approved never reached anyone, so a
 * reply cannot be answering it. The two letter mails are addressed by email rather than by member,
 * so their member is whoever on the roster owns the address it went to.
 */
export function listReminderSends(
  store: Pick<
    AdminBotServiceStore,
    "listProposalsByType" | "getExecutionResult" | "listLabMembers"
  >,
  now: Date,
): ReminderSend[] {
  const since = now.getTime() - reminderReplyLookbackDays * DAY_MS;
  const roster = store.listLabMembers();
  const sends: ReminderSend[] = [];
  for (const type of [
    "member_nudge.send",
    "logistics.rec_letter_reminder",
    "logistics.rec_letter_overdue_check",
  ] as const) {
    for (const proposal of store.listProposalsByType(type)) {
      const payload = payloadRecord(proposal.proposed_payload);
      const target = payloadRecord(proposal.target);
      if (type === "member_nudge.send" && payload.channel !== "email") {
        continue;
      }
      const subject = typeof payload.subject === "string" ? payload.subject : "";
      if (!subject.trim()) {
        continue;
      }
      const result = store.getExecutionResult(proposal.id);
      if (!delivered(result) || Date.parse(result.executed_at) < since) {
        continue;
      }
      let memberId: string | undefined;
      if (type === "member_nudge.send") {
        memberId =
          typeof target.recipientMemberId === "string" ? target.recipientMemberId : undefined;
      } else {
        const to = typeof payload.to === "string" ? payload.to.trim().toLowerCase() : "";
        memberId = to
          ? roster.find((member) => memberAddresses(member).includes(to))?.id
          : undefined;
      }
      if (!memberId) {
        continue;
      }
      const threadId = result.artifacts?.gmail_thread_id;
      const messageIdHeader = result.artifacts?.rfc_message_id;
      sends.push({
        action_id: proposal.id,
        type,
        subject,
        body: typeof payload.body === "string" ? payload.body : "",
        sent_at: result.executed_at,
        member_id: memberId,
        ...(threadId ? { thread_id: threadId } : {}),
        ...(messageIdHeader ? { message_id_header: messageIdHeader } : {}),
      });
    }
  }
  return sends.sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
}

/**
 * The reminder this reply answers, if it answers one and came from the person it was sent to.
 *
 * Thread first, because a Gmail thread id is exact. The subject is the fallback for reminders sent
 * before thread ids were recorded, and it is safe only because of the sender check: a stranger
 * replying "Re: Camera ready: X" is not the author it was asked of, and is left to the normal pass.
 */
export function matchReminderSend(
  sends: readonly ReminderSend[],
  reply: { sender: string; subject?: string; threadId?: string },
  addressesOf: (memberId: string) => string[],
): { send: ReminderSend; matched_by: "thread" | "subject" } | undefined {
  const sender = reply.sender.trim().toLowerCase();
  if (!sender) {
    return undefined;
  }
  const fromMember = (send: ReminderSend) => addressesOf(send.member_id).includes(sender);
  if (reply.threadId) {
    const byThread = sends.find((send) => send.thread_id === reply.threadId);
    if (byThread) {
      return fromMember(byThread) ? { send: byThread, matched_by: "thread" } : undefined;
    }
  }
  const subject = normalizeReminderSubject(reply.subject);
  if (!subject) {
    return undefined;
  }
  const bySubject = sends.find(
    (send) => normalizeReminderSubject(send.subject) === subject && fromMember(send),
  );
  return bySubject ? { send: bySubject, matched_by: "subject" } : undefined;
}

/** How close to a send a ledger stamp must be to belong to that mail: sweeps stamp just after. */
const STAMP_BEFORE_MS = 60_000;
const STAMP_AFTER_MS = 10 * 60_000;

function stampedWith(entry: AdminBotNudgeLedgerRecord, send: ReminderSend): boolean {
  const sentAt = Date.parse(send.sent_at);
  const stamped = Date.parse(entry.last_nudged_at ?? "");
  return (
    !Number.isNaN(stamped) &&
    stamped >= sentAt - STAMP_BEFORE_MS &&
    stamped <= sentAt + STAMP_AFTER_MS
  );
}

export type ReminderTargetDeps = {
  papers: readonly AdminBotPaperRecord[];
  /** The stages open right now, from the same walk the sweep sends from. */
  openStages: ReadonlyArray<{ paper_id: string; stage: AdminBotPaperflowStage }>;
  /** Slots on this paper still asked of this member, from the same walk the slot sweep sends from. */
  openSlots: (
    paper: AdminBotPaperRecord,
    memberId: string,
  ) => Array<{ slot: string; label: string }>;
  /** Every domain's rows: a generic nudge is tied to its subject only by the stamp beside it. */
  ledger: readonly AdminBotNudgeLedgerRecord[];
  getLogisticsRequest: AdminBotServiceStore["getLogisticsRequest"];
};

/**
 * What one reminder asked about, in ledger terms, and whether each is still open.
 *
 * Read back from what was sent rather than re-derived from today's state: the reply answers the
 * question that was asked, and a stage that closed since is reported closed so nobody closes it twice.
 */
export function reminderTargets(
  send: ReminderSend,
  deps: ReminderTargetDeps,
): AdminBotReminderReplyTarget[] {
  if (send.type === "logistics.rec_letter_reminder") {
    return recLetterTargets(send, deps);
  }
  if (send.type === "logistics.rec_letter_overdue_check") {
    return recLetterOverdueTargets(send, deps);
  }
  const stage = paperflowTarget(send, deps);
  if (stage) {
    return [stage];
  }
  const slots = paperSlotTargets(send, deps);
  return slots.length ? slots : ledgerTargets(send, deps);
}

/**
 * Any other nudge, by the ledger row its sweep stamped for this member as the mail went out.
 *
 * Every sweep writes one, so this reaches every domain -- profile fields, attendance, thesis
 * milestones -- without a parser per subject line. What it cannot do is know what "done" would
 * close for that domain, so only a snooze is ever built on it; the rest goes to a person.
 */
function ledgerTargets(
  send: ReminderSend,
  deps: ReminderTargetDeps,
): AdminBotReminderReplyTarget[] {
  const now = Date.now();
  return deps.ledger
    .filter(
      (entry) =>
        entry.member_id === send.member_id &&
        (adminBotNudgeDomains as readonly string[]).includes(entry.domain) &&
        entry.domain !== "email_review" &&
        stampedWith(entry, send),
    )
    .map((entry) => ({
      domain: entry.domain,
      subject_id: entry.subject_id,
      member_id: entry.member_id,
      label: `${entry.domain.replace(/_/gu, " ")} reminder (${entry.subject_id})`,
      open: !entry.snoozed_until || Date.parse(entry.snoozed_until) <= now,
    }));
}

/**
 * The student's own letter requests one "did it go in?" mail asked about.
 *
 * Same stamp-beside-the-send rule as the professor's reminder, but under the student, and the
 * request is open only while it is still waiting on a submission.
 */
function recLetterOverdueTargets(
  send: ReminderSend,
  deps: ReminderTargetDeps,
): AdminBotReminderReplyTarget[] {
  const targets: AdminBotReminderReplyTarget[] = [];
  const seen = new Set<string>();
  for (const entry of deps.ledger) {
    if (
      entry.domain !== "rec_letter_overdue" ||
      entry.member_id !== send.member_id ||
      !stampedWith(entry, send)
    ) {
      continue;
    }
    const requestId = entry.subject_id.split("|")[1];
    if (!requestId || seen.has(requestId)) {
      continue;
    }
    seen.add(requestId);
    const request = deps.getLogisticsRequest(requestId);
    if (!request) {
      continue;
    }
    const schools = (request.schools ?? []).map((school) => school.school);
    targets.push({
      domain: "rec_letter_overdue",
      subject_id: entry.subject_id,
      member_id: send.member_id,
      label: `your letter for ${schools.join(", ") || "your recommendation"}`,
      open: request.status === "submitted" || request.status === "in_progress",
      request_id: requestId,
      schools,
    });
  }
  return targets;
}

/** A PaperFlow nudge's subject is `${label}: ${title}` (workflows/papers/paperflow-stages.ts). */
function paperflowTarget(
  send: ReminderSend,
  deps: ReminderTargetDeps,
): AdminBotReminderReplyTarget | undefined {
  for (const stage of adminBotPaperflowStages) {
    const prefix = `${adminBotPaperflowStageRegistry[stage].label}: `;
    if (!send.subject.startsWith(prefix)) {
      continue;
    }
    const title = send.subject.slice(prefix.length).trim().toLocaleLowerCase();
    const paper = deps.papers.find((row) => row.title.trim().toLocaleLowerCase() === title);
    if (!paper) {
      return undefined;
    }
    return {
      domain: "paperflow_stage",
      subject_id: `${paper.id}:${stage}`,
      member_id: send.member_id,
      label: `${adminBotPaperflowStageRegistry[stage].label} for ${paper.title}`,
      open: deps.openStages.some((item) => item.paper_id === paper.id && item.stage === stage),
      paper_id: paper.id,
      stage,
    };
  }
  return undefined;
}

/**
 * Slots on a paper an email reminder names, still asked of the member it went to.
 *
 * The scheduled slot chase goes out on Slack, so these come from the email nudges an admin or a
 * workflow sends about one paper. A paper is "named" when its title is in the subject or the body.
 */
function paperSlotTargets(
  send: ReminderSend,
  deps: ReminderTargetDeps,
): AdminBotReminderReplyTarget[] {
  const text = `${send.subject}\n${send.body}`.toLocaleLowerCase();
  const targets: AdminBotReminderReplyTarget[] = [];
  for (const paper of deps.papers) {
    const title = paper.title.trim().toLocaleLowerCase();
    if (title.length < 8 || !text.includes(title)) {
      continue;
    }
    for (const slot of deps.openSlots(paper, send.member_id)) {
      targets.push({
        domain: "paper_slot",
        subject_id: `${paper.id}:${slot.slot}`,
        member_id: send.member_id,
        label: `${slot.label} for ${paper.title}`,
        open: true,
        paper_id: paper.id,
        slot: slot.slot,
      });
    }
  }
  return targets;
}

/**
 * The letter requests one rec-letter reminder covered.
 *
 * The mail itself carries no request ids, but the sweep stamps one say-once ledger row per request
 * moments after the send succeeds, under the head professor. Rows stamped in that window are this
 * mail's requests; a row from another morning is another mail.
 */
function recLetterTargets(
  send: ReminderSend,
  deps: ReminderTargetDeps,
): AdminBotReminderReplyTarget[] {
  const requestIds = new Set<string>();
  for (const entry of deps.ledger) {
    if (
      entry.domain !== "rec_letter_reminder" ||
      entry.member_id !== send.member_id ||
      !stampedWith(entry, send)
    ) {
      continue;
    }
    const requestId = entry.subject_id.split("|")[1];
    if (requestId) {
      requestIds.add(requestId);
    }
  }
  const targets: AdminBotReminderReplyTarget[] = [];
  for (const requestId of requestIds) {
    const request = deps.getLogisticsRequest(requestId);
    if (!request) {
      continue;
    }
    const schools = (request.schools ?? [])
      .filter((school) => !isLetterStatusSubmitted(school.letter_status))
      .map((school) => school.school);
    targets.push({
      domain: "rec_letter_reminder",
      subject_id: requestId,
      member_id: send.member_id,
      label: `Recommendation letters for ${request.member_name || requestId}`,
      open: schools.length > 0,
      request_id: requestId,
      schools,
    });
  }
  return targets;
}

/**
 * The one resolution a reading supports, and the line the approver reads.
 *
 * Deliberately narrow. Each intent maps to one action on one open target; anything that would need
 * a choice -- two open targets, a question, a reading the model was unsure of -- becomes a dismissal
 * whose summary tells the admin to answer the person by hand. A dismissal closes nothing, so a
 * wrong one costs a reminder, never a stage.
 */
export function reminderReplyResolution(
  match: AdminBotReminderReplyMatch,
  reading: AdminBotReminderReplyReading,
  now: Date,
): { resolution: AdminBotEmailReviewResolution; summary: string; undo_plan: string } {
  const who = match.member_name;
  const note = reading.note.trim() || reading.intent;
  const byHand = (why: string) => ({
    resolution: { kind: "dismissed" } as const,
    summary: `Reply from ${who} to "${match.reminder_subject}": ${why}; answer them by hand, then dismiss`,
    undo_plan:
      "Dismissing closes nothing; the reminder carries on and the message stays in the mailbox.",
  });
  const open = match.targets.filter((target) => target.open);
  if (reading.intent === "question") {
    return byHand(`they asked "${note}"`);
  }
  if (reading.confidence < reminderReplyMinConfidence) {
    return byHand(`unclear reply ("${note}")`);
  }
  if (open.length === 0) {
    return byHand(
      match.targets.length ? `already settled ("${note}")` : `nothing on file matches ("${note}")`,
    );
  }
  if (open.length > 1) {
    return byHand(`it could settle ${open.length} things ("${note}")`);
  }
  const target = open[0] as AdminBotReminderReplyTarget;
  const withUrl = reading.evidence_url ? `${note} (${reading.evidence_url})` : note;

  if (reading.intent === "needs_time") {
    // Both letter mails are said once per deadline, so there is no cadence for a snooze to pause.
    if (target.domain === "rec_letter_reminder" || target.domain === "rec_letter_overdue") {
      return byHand(`they need more time on the letters ("${note}")`);
    }
    const cap = now.getTime() + reminderReplySnoozeDays * DAY_MS;
    const asked = Date.parse(reading.until ?? "");
    const until = new Date(
      Number.isNaN(asked) || asked <= now.getTime() ? cap : Math.min(asked, cap),
    ).toISOString();
    return {
      resolution: {
        kind: "reminder_snoozed",
        domain: target.domain,
        subject_id: target.subject_id,
        member_id: target.member_id,
        until,
      },
      summary: `Snooze ${target.label} for ${who} until ${until.slice(0, 10)}: ${note}`,
      undo_plan: "Clear the snooze on the ledger row; the reminder resumes on its normal cadence.",
    };
  }

  if (target.domain === "paperflow_stage" && target.paper_id && target.stage) {
    const label = adminBotPaperflowStageRegistry[target.stage].label.toLocaleLowerCase();
    if (reading.intent === "done") {
      return {
        resolution: {
          kind: "paperflow_evidence",
          paper_id: target.paper_id,
          stage: target.stage,
          note: withUrl,
        },
        summary: `Close ${label} for ${target.label.split(" for ").slice(1).join(" for ")} as done (${who}: ${withUrl})`,
        undo_plan:
          "Delete the recorded PaperFlow evidence for this stage, which reopens it for the chase.",
      };
    }
    const later = reading.moved_elsewhere;
    return {
      resolution: {
        kind: "paperflow_skipped",
        paper_id: target.paper_id,
        stage: target.stage,
        note,
        ...(later ? { later_stages: true } : {}),
      },
      summary: `Close ${target.stage} as skipped${later ? " with every later stage" : ""}: ${note} (${who})`,
      undo_plan:
        "Delete the skipped stage's evidence rows, which reopens the earliest for the chase.",
    };
  }

  if (target.domain === "paper_slot" && target.paper_id && target.slot) {
    if (reading.intent === "done") {
      // A slot is settled by its artifact -- a link, a file -- which a reply sentence is not.
      return byHand(
        `they say ${target.label} is done ("${withUrl}"); fill the slot from their link`,
      );
    }
    return {
      resolution: {
        kind: "paper_slot_waived",
        paper_id: target.paper_id,
        slot: target.slot,
        note,
      },
      summary: `Waive ${target.label}: ${note} (${who})`,
      undo_plan: "Un-waive the slot on the paper card; the chase resumes.",
    };
  }

  if (target.domain === "rec_letter_reminder" && target.request_id && reading.intent === "done") {
    return {
      resolution: {
        kind: "rec_letter_submitted",
        request_id: target.request_id,
        schools: target.schools ?? [],
      },
      summary: `Mark ${target.label} submitted (${(target.schools ?? []).join(", ")}): ${note}`,
      undo_plan: "Set the schools' letter status back on the request.",
    };
  }
  if (target.domain === "rec_letter_overdue" && target.request_id && reading.intent === "done") {
    return {
      resolution: {
        kind: "rec_letter_confirmed",
        request_id: target.request_id,
        member_id: target.member_id,
      },
      summary: `Mark ${who}'s letter request submitted, as they confirmed: ${note}`,
      undo_plan: "Reopen the request; it goes back to waiting on the professor.",
    };
  }
  return byHand(`"${note}"`);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Parse a stored resolution back into its type, or nothing.
 *
 * This is what an approval press turns into a write, so a shape that does not parse fails the
 * execution loudly rather than settling the wrong thing.
 */
export function parseEmailReviewResolution(
  value: unknown,
): AdminBotEmailReviewResolution | undefined {
  const row = payloadRecord(value);
  switch (row.kind) {
    case "dismissed":
      return { kind: "dismissed" };
    case "paperflow_evidence": {
      const paperId = text(row.paper_id);
      const stage = text(row.stage);
      const note = text(row.note);
      return paperId && stage
        ? { kind: "paperflow_evidence", paper_id: paperId, stage, ...(note ? { note } : {}) }
        : undefined;
    }
    case "paperflow_skipped": {
      const paperId = text(row.paper_id);
      const stage = text(row.stage);
      const note = text(row.note);
      return paperId && stage && note
        ? {
            kind: "paperflow_skipped",
            paper_id: paperId,
            stage,
            note,
            ...(row.later_stages === true ? { later_stages: true } : {}),
          }
        : undefined;
    }
    case "paper_slot_waived": {
      const paperId = text(row.paper_id);
      const slot = text(row.slot);
      const note = text(row.note);
      return paperId && slot && note
        ? { kind: "paper_slot_waived", paper_id: paperId, slot, note }
        : undefined;
    }
    case "rec_letter_submitted": {
      const requestId = text(row.request_id);
      const schools = Array.isArray(row.schools)
        ? row.schools.filter((school): school is string => typeof school === "string")
        : undefined;
      return requestId && schools && schools.length
        ? { kind: "rec_letter_submitted", request_id: requestId, schools }
        : undefined;
    }
    case "reminder_snoozed": {
      const domain = row.domain;
      const subjectId = text(row.subject_id);
      const memberId = text(row.member_id);
      const until = text(row.until);
      return typeof domain === "string" &&
        (adminBotNudgeDomains as readonly string[]).includes(domain) &&
        domain !== "email_review" &&
        subjectId &&
        memberId &&
        until
        ? {
            kind: "reminder_snoozed",
            domain: domain as AdminBotReminderReplyTarget["domain"],
            subject_id: subjectId,
            member_id: memberId,
            until,
          }
        : undefined;
    }
    case "rec_letter_confirmed": {
      const requestId = text(row.request_id);
      const memberId = text(row.member_id);
      return requestId && memberId
        ? { kind: "rec_letter_confirmed", request_id: requestId, member_id: memberId }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** A reading from the model, re-checked before anything is built on it. */
export function isReminderReplyReading(value: unknown): value is AdminBotReminderReplyReading {
  const row = payloadRecord(value);
  return (
    (adminBotReminderReplyIntents as readonly unknown[]).includes(row.intent) &&
    typeof row.note === "string" &&
    typeof row.moved_elsewhere === "boolean" &&
    typeof row.confidence === "number" &&
    row.confidence >= 0 &&
    row.confidence <= 1
  );
}
