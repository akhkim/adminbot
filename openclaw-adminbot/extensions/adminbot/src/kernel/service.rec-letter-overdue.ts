// The after-deadline "did your letter go in?" sweep, cut from service.ts so it stays off its
// file-size ratchet. Which requests are due and what the mail says are pure
// (workflows/logistics/rec-letter-overdue.ts); this is the half with a ledger and a mailbox.
//
// It writes to students, which no other letter sweep does, so it is off by default
// (ADMINBOT_REC_LETTER_OVERDUE_CONFIRM_ENABLED) and a dry run previews every mail without sending
// or stamping anything, whether or not it is on.
import type {
  AdminBotActionProposal,
  AdminBotExecutionRequest,
  AdminBotExecutionResult,
  AdminBotLetterConfirmationVia,
  AdminBotLogisticsRequest,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import { adminBotOutreachEmail } from "../contracts/member-outreach-email.js";
import {
  recLetterOverdueBody,
  recLetterOverdueConfirmationsDue,
  recLetterOverdueLedgerPrefix,
  recLetterOverdueLedgerSubject,
  recLetterOverdueSubject,
  type RecLetterOverdueDue,
} from "../workflows/logistics/rec-letter-overdue.js";
import { clearSettledRequestFiles } from "../workflows/logistics/signed-documents.js";
import type { AdminBotServiceResponse, AdminBotServiceStore } from "./service.js";

const DOMAIN = "rec_letter_overdue";

export const REC_LETTER_OVERDUE_ENABLED_ENV = "ADMINBOT_REC_LETTER_OVERDUE_CONFIRM_ENABLED";

export type RecLetterOverdueConfig = { enabled: boolean };

/** Off unless set to exactly "1", the professor digest's rule: mail to students is opt-in. */
export function resolveRecLetterOverdueConfig(
  env: Readonly<Record<string, string | undefined>>,
): RecLetterOverdueConfig {
  return { enabled: env[REC_LETTER_OVERDUE_ENABLED_ENV]?.trim() === "1" };
}

/** One portal notification per request, so settling it can retract exactly that card. */
export function recLetterOverdueNotificationId(requestId: string): string {
  return `notif_rec_letter_overdue_${requestId}`;
}

/** Where the mail sends the student: their own requests list, not the letters form. */
export function recLetterOverdueRequestsUrl(portalUrl: string): string {
  return `${portalUrl}/rec-letters?view=requests`;
}

type Deps = {
  store: Pick<
    AdminBotServiceStore,
    | "getLabMember"
    | "listLogisticsRequests"
    | "listNudgeLedger"
    | "saveNudgeLedgerEntry"
    | "saveMemberNotification"
  >;
  createProposal: (
    proposal: AdminBotActionProposal,
  ) => AdminBotServiceResponse<AdminBotStoredProposal>;
  execute: (
    actionId: string,
    request: AdminBotExecutionRequest,
  ) => Promise<AdminBotServiceResponse<AdminBotExecutionResult>>;
  recordAudit: (event: {
    type: "rec_letter_overdue.swept";
    actor: string;
    details: Record<string, unknown>;
  }) => void;
  portalUrl: string;
};

type Requests = Array<Pick<RecLetterOverdueDue, "request_id" | "deadline_at" | "days_overdue">>;

export type RecLetterOverdueSweepResult = {
  outcome: "disabled" | "nothing_due" | "preview" | "swept";
  /** Mailed this run, one row per student. */
  sent: Array<{ member_id: string; to: string; proposal_id: string; requests: Requests }>;
  /** What would be mailed, on a dry run. */
  previews: Array<{
    member_id: string;
    member_name: string;
    to: string;
    subject: string;
    body: string;
    requests: Requests;
  }>;
  /** Students who could not be asked. Never stamped, so fixing the roster re-arms them. */
  skipped: Array<{
    member_id: string;
    member_name: string;
    reason: "not_on_roster" | "no_email";
    requests: Requests;
  }>;
  /** Sends that failed. Unstamped, so the next run tries again. */
  failed: Array<{ member_id: string; to: string; error: string; requests: Requests }>;
};

export async function sweepRecLetterOverdueConfirmations(
  deps: Deps,
  actor: string,
  config: RecLetterOverdueConfig,
  options: { nowIso?: string; dryRun?: boolean } = {},
): Promise<AdminBotServiceResponse<RecLetterOverdueSweepResult>> {
  const result: RecLetterOverdueSweepResult = {
    outcome: "swept",
    sent: [],
    previews: [],
    skipped: [],
    failed: [],
  };
  if (!config.enabled && !options.dryRun) {
    return { ok: true, status: 200, payload: { ...result, outcome: "disabled" } };
  }
  const now = options.nowIso ? new Date(options.nowIso) : new Date();
  const nowIso = now.toISOString();
  const said = new Set(
    deps.store
      .listNudgeLedger(DOMAIN)
      .filter((entry) => entry.last_nudged_at)
      .map((entry) => entry.subject_id),
  );
  const due = recLetterOverdueConfirmationsDue(deps.store.listLogisticsRequests(), now).filter(
    (entry) => !said.has(recLetterOverdueLedgerSubject(entry)),
  );
  if (!due.length) {
    return { ok: true, status: 200, payload: { ...result, outcome: "nothing_due" } };
  }

  // One mail per student, however many of their letters are overdue.
  const byMember = new Map<string, RecLetterOverdueDue[]>();
  for (const entry of due) {
    byMember.set(entry.member_id, [...(byMember.get(entry.member_id) ?? []), entry]);
  }
  const requestsUrl = recLetterOverdueRequestsUrl(deps.portalUrl);

  for (const [memberId, entries] of byMember) {
    const requests = entries.map(({ request_id, deadline_at, days_overdue }) => ({
      request_id,
      deadline_at,
      days_overdue,
    }));
    const member = deps.store.getLabMember(memberId);
    const memberName = member?.name ?? entries[0]?.member_name ?? memberId;
    // The roster is the only place this address may come from. A student with none is reported,
    // never guessed at: "did your letter go in?" to the wrong inbox is somebody else's business.
    const to = member ? adminBotOutreachEmail(member) : "";
    if (!member || !to) {
      result.skipped.push({
        member_id: memberId,
        member_name: memberName,
        reason: member ? "no_email" : "not_on_roster",
        requests,
      });
      continue;
    }
    const subject = recLetterOverdueSubject(entries);
    const body = recLetterOverdueBody(
      entries.map((entry) => ({ ...entry, member_name: memberName })),
      requestsUrl,
    );
    if (options.dryRun) {
      result.previews.push({
        member_id: memberId,
        member_name: memberName,
        to,
        subject,
        body,
        requests,
      });
      continue;
    }

    const proposed = deps.createProposal({
      type: "logistics.rec_letter_overdue_check",
      summary:
        entries.length === 1
          ? `Ask ${memberName} whether their letter (due ${entries[0]?.deadline_label}) went in`
          : `Ask ${memberName} whether ${entries.length} past-due letters went in`,
      target: { service: "email", channel: "email", target: to },
      proposed_payload: { to, subject, body },
      undo_plan: "Send an email follow-up correcting or retracting the question.",
    });
    if (!proposed.ok) {
      result.failed.push({ member_id: memberId, to, error: proposed.error.message, requests });
      continue;
    }
    const executed = await deps.execute(proposed.payload.id, { dry_run: false });
    if (!executed.ok) {
      // Left unstamped even when the send may have half-happened: a question asked twice costs a
      // student a second read, one never asked leaves the professor's queue wrong all season.
      result.failed.push({ member_id: memberId, to, error: executed.error.message, requests });
      continue;
    }
    for (const entry of entries) {
      deps.store.saveNudgeLedgerEntry({
        domain: DOMAIN,
        subject_id: recLetterOverdueLedgerSubject(entry),
        member_id: memberId,
        last_nudged_at: nowIso,
        nudge_count: 1,
      });
      const schools = entry.schools.length ? entry.schools.join(", ") : "your recommendation";
      deps.store.saveMemberNotification({
        id: recLetterOverdueNotificationId(entry.request_id),
        member_id: memberId,
        kind: "rec_letter",
        title: `Did the letter for ${schools} go in?`,
        body: `The deadline (${entry.deadline_label}) has passed and the request still shows as not submitted. If the letter went in, mark it “Letter was submitted” on your requests.`,
        tab: "adminbotRecLetters",
        created_at: nowIso,
      });
    }
    result.sent.push({ member_id: memberId, to, proposal_id: proposed.payload.id, requests });
  }

  if (options.dryRun) {
    return { ok: true, status: 200, payload: { ...result, outcome: "preview" } };
  }
  deps.recordAudit({
    type: "rec_letter_overdue.swept",
    actor,
    details: {
      sent: result.sent.map(({ member_id, to, proposal_id, requests }) => ({
        member_id,
        to,
        proposal_id,
        request_ids: requests.map((request) => request.request_id),
      })),
      skipped: result.skipped.map(({ member_id, reason, requests }) => ({
        member_id,
        reason,
        request_ids: requests.map((request) => request.request_id),
      })),
      failed: result.failed.map(({ member_id, to, error }) => ({ member_id, to, error })),
    },
  });
  return { ok: true, status: 200, payload: result };
}

// ---------------------------------------------------------------------------
// Saying it went in
//
// The student's answer to the question above, or the same answer given unprompted. Their own
// request only, and only a recommendation letter: a requester settling their own signature request
// would make the queue useless to the people working it, but a letter goes from the professor to
// the school and the student is often the only one the school tells.

export type LetterConfirmDeps = {
  store: Pick<
    AdminBotServiceStore,
    | "getLogisticsRequest"
    | "saveLogisticsRequest"
    | "getLabMember"
    | "listNudgeLedger"
    | "listMemberNotifications"
    | "saveMemberNotification"
  >;
  recordAudit: (event: {
    type: "logistics_request.letter_confirmed" | "logistics_request.letter_confirmation_undone";
    actor: string;
    details: Record<string, unknown>;
  }) => void;
  auditClearedFiles: (
    before: AdminBotLogisticsRequest,
    after: AdminBotLogisticsRequest,
    actor: string,
  ) => void;
};

const CONFIRMATION_FIELDS = [
  "confirmed_by",
  "confirmed_by_name",
  "confirmed_at",
  "confirmed_via",
] as const;

const MEMBER_VIAS = new Set<AdminBotLetterConfirmationVia>(["member", "member_after_reminder"]);

/** The request with no record of who confirmed it, for a request that is open again. */
export function withoutLetterConfirmation(
  request: AdminBotLogisticsRequest,
): AdminBotLogisticsRequest {
  const next = { ...request };
  for (const field of CONFIRMATION_FIELDS) {
    delete next[field];
  }
  return next;
}

/**
 * The confirmation fields an admin status change leaves behind.
 *
 * Completing a letter records the admin as the one who said so; moving it anywhere else clears
 * whatever confirmation it carried, so "Submitted, confirmed by" never sits on a request that is
 * not submitted. Re-completing an already completed request keeps the original answer.
 */
export function applyAdminLetterConfirmation(
  existing: AdminBotLogisticsRequest,
  next: AdminBotLogisticsRequest,
  actor: { id: string; name?: string },
  nowIso: string,
): AdminBotLogisticsRequest {
  if (next.kind !== "recommendation_letters") {
    return next;
  }
  if (next.status !== "completed") {
    return withoutLetterConfirmation(next);
  }
  if (existing.status === "completed" && existing.confirmed_at) {
    return next;
  }
  return {
    ...next,
    confirmed_by: actor.id,
    ...(actor.name ? { confirmed_by_name: actor.name } : {}),
    confirmed_at: nowIso,
    confirmed_via: "admin",
  };
}

/** Retract the overdue card once the request it asks about is settled or answered. */
export function resolveRecLetterOverdueNotification(
  store: Pick<AdminBotServiceStore, "listMemberNotifications" | "saveMemberNotification">,
  memberId: string,
  requestId: string,
  nowIso: string,
): void {
  const id = recLetterOverdueNotificationId(requestId);
  for (const notification of store.listMemberNotifications(memberId)) {
    if (notification.id !== id || notification.resolved_at) {
      continue;
    }
    store.saveMemberNotification({
      ...notification,
      resolved_at: nowIso,
      read_at: notification.read_at ?? nowIso,
    });
  }
}

export function confirmLetterSubmitted(
  deps: LetterConfirmDeps,
  requestId: string,
  memberId: string,
): AdminBotServiceResponse<AdminBotLogisticsRequest> {
  const existing = deps.store.getLogisticsRequest(requestId);
  // Someone else's request is reported as missing, the withdraw route's rule, so the id of a
  // request a member does not own tells them nothing.
  if (!existing || existing.member_id !== memberId) {
    return failure(404, `unknown logistics request ${requestId}`);
  }
  if (existing.kind !== "recommendation_letters") {
    return failure(
      400,
      "only a recommendation letter request can be marked submitted by its requester",
    );
  }
  if (existing.status !== "submitted" && existing.status !== "in_progress") {
    return failure(409, `this request is already ${existing.status}`);
  }
  const nowIso = new Date().toISOString();
  // "After the reminder" is a fact about the ledger, not something the caller claims: the student
  // was asked about this request if the overdue sweep stamped any deadline it carried.
  const prefix = recLetterOverdueLedgerPrefix(requestId);
  const asked = deps.store
    .listNudgeLedger(DOMAIN)
    .some((entry) => entry.subject_id.startsWith(prefix) && entry.last_nudged_at);
  const via: AdminBotLetterConfirmationVia = asked ? "member_after_reminder" : "member";
  const member = deps.store.getLabMember(memberId);
  const stored = clearSettledRequestFiles({
    ...existing,
    status: "completed",
    updated_at: nowIso,
    decided_by: memberId,
    decided_at: nowIso,
    confirmed_by: memberId,
    confirmed_by_name: member?.name ?? existing.member_name,
    confirmed_at: nowIso,
    confirmed_via: via,
  });
  deps.store.saveLogisticsRequest(stored);
  deps.recordAudit({
    type: "logistics_request.letter_confirmed",
    actor: memberId,
    details: { request_id: requestId, from: existing.status, to: "completed", via },
  });
  deps.auditClearedFiles(existing, stored, memberId);
  resolveRecLetterOverdueNotification(deps.store, memberId, requestId, nowIso);
  return { ok: true, status: 200, payload: stored };
}

/**
 * Taking it back: the letter had not gone in after all, or the button was pressed by mistake.
 *
 * Only the student's own confirmation can be undone this way. One an admin made is the professor's
 * record, and a student reopening it would be grading the queue again.
 */
export function undoLetterConfirmation(
  deps: LetterConfirmDeps,
  requestId: string,
  memberId: string,
): AdminBotServiceResponse<AdminBotLogisticsRequest> {
  const existing = deps.store.getLogisticsRequest(requestId);
  if (!existing || existing.member_id !== memberId) {
    return failure(404, `unknown logistics request ${requestId}`);
  }
  if (
    existing.status !== "completed" ||
    existing.confirmed_by !== memberId ||
    !existing.confirmed_via ||
    !MEMBER_VIAS.has(existing.confirmed_via)
  ) {
    return failure(409, "only a letter you marked submitted yourself can be reopened here");
  }
  const nowIso = new Date().toISOString();
  const stored = withoutLetterConfirmation({
    ...existing,
    status: "submitted",
    updated_at: nowIso,
    decided_by: memberId,
    decided_at: nowIso,
  });
  deps.store.saveLogisticsRequest(stored);
  deps.recordAudit({
    type: "logistics_request.letter_confirmation_undone",
    actor: memberId,
    details: {
      request_id: requestId,
      from: "completed",
      to: "submitted",
      via: existing.confirmed_via,
      confirmed_at: existing.confirmed_at,
    },
  });
  return { ok: true, status: 200, payload: stored };
}

function failure<T>(status: number, message: string): AdminBotServiceResponse<T> {
  return { ok: false, status, error: { message } };
}
