import { gogFailedBeforeSending } from "../connectors/mail-send-failure.js";
// The professor's daily escalation digest, cut from service.ts so it stays under its file-size
// ratchet. The grouping and the wording are pure (workflows/nudges/professor-digest.ts); this is
// the half with a clock, a ledger and a mailbox.
//
// Sending goes through the service's createProposal + execute, the same typed
// `professor.escalation_digest` action every other mail uses: the proposal is audited, gog's
// retries and credential alerting apply, and the outcome is on the record.
import type {
  AdminBotActionProposal,
  AdminBotExecutionRequest,
  AdminBotExecutionResult,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import {
  groupProfessorDigest,
  isValidTimezone,
  PROFESSOR_DIGEST_DEFAULT_TIMEZONE,
  professorDigestBody,
  professorDigestBuckets,
  professorDigestCount,
  professorDigestItems,
  professorDigestLocalClock,
  professorDigestSubject,
  type ProfessorDigestBucket,
  type ProfessorDigestConfig,
  type ProfessorDigestQueues,
} from "../workflows/nudges/professor-digest.js";
import type { AdminBotServiceResponse, AdminBotServiceStore } from "./service.js";

/** The nudge-ledger domain: one "sent" row for the day gate, one row per item for its count. */
const DOMAIN = "professor_digest";
const SENT_SUBJECT = "sent";
const itemSubject = (key: string) => `item:${key}`;

type Deps = {
  store: Pick<
    AdminBotServiceStore,
    | "getLabMember"
    | "listLogisticsRequests"
    | "listNudgeLedger"
    | "listPending"
    | "saveNudgeLedgerEntry"
  >;
  headProfessorMemberId: () => string | undefined;
  piReviewQueue: () => ProfessorDigestQueues["papers"];
  escalatedMembers: () => ProfessorDigestQueues["missingInfo"];
  createProposal: (
    proposal: AdminBotActionProposal,
  ) => AdminBotServiceResponse<AdminBotStoredProposal>;
  execute: (
    actionId: string,
    request: AdminBotExecutionRequest,
  ) => Promise<AdminBotServiceResponse<AdminBotExecutionResult>>;
  recordAudit: (event: {
    type: "professor_digest.swept";
    actor: string;
    details: Record<string, unknown>;
  }) => void;
  portalUrl: string;
};

export type ProfessorDigestSweepResult = {
  /** "sent", or why nothing went out -- every quiet run says which gate held it. */
  outcome:
    | "sent"
    | "preview"
    | "disabled"
    | "before_send_hour"
    | "already_sent_today"
    | "nothing_due";
  local_date: string;
  timezone: string;
  recipient?: string;
  counts?: Record<ProfessorDigestBucket, number>;
  subject?: string;
  body?: string;
  proposal_id?: string;
};

/**
 * One digest per local day, from the send hour on, only when something is due.
 *
 * Hourly cron runs are what make it reliable rather than what make it frequent: the first run at
 * or after the send hour sends, a missed or failed one is caught up by the next, and every later
 * run that day stops at the ledger. `dryRun` builds the mail without sending or stamping, so an
 * operator can read tomorrow's digest before turning it on.
 */
export async function sweepProfessorDigest(
  deps: Deps,
  actor: string,
  config: ProfessorDigestConfig,
  options: { nowIso?: string; dryRun?: boolean } = {},
): Promise<AdminBotServiceResponse<ProfessorDigestSweepResult>> {
  const now = options.nowIso ? new Date(options.nowIso) : new Date();
  const nowIso = now.toISOString();
  const headProfessorId = deps.headProfessorMemberId();
  const headProfessor = headProfessorId ? deps.store.getLabMember(headProfessorId) : undefined;
  // Her own zone when the roster has one, since the point is that it is in her inbox by morning.
  const timezone =
    config.timezone ??
    (headProfessor?.timezone && isValidTimezone(headProfessor.timezone)
      ? headProfessor.timezone
      : PROFESSOR_DIGEST_DEFAULT_TIMEZONE);
  const clock = professorDigestLocalClock(now, timezone);
  const quiet = (outcome: ProfessorDigestSweepResult["outcome"]) =>
    ({
      ok: true,
      status: 200,
      payload: { outcome, local_date: clock.date, timezone },
    }) as const;

  if (!config.enabled && !options.dryRun) {
    return quiet("disabled");
  }
  if (!options.dryRun) {
    if (clock.hour < config.sendHour) {
      return quiet("before_send_hour");
    }
    const sent = ledgerEntry(deps, SENT_SUBJECT, headProfessorId);
    if (
      sent?.last_nudged_at &&
      professorDigestLocalClock(new Date(sent.last_nudged_at), timezone).date === clock.date
    ) {
      return quiet("already_sent_today");
    }
  }

  const items = professorDigestItems(
    {
      papers: deps.piReviewQueue(),
      requests: deps.store.listLogisticsRequests(),
      missingInfo: deps.escalatedMembers(),
      pending: deps.store.listPending(),
    },
    now,
    config,
  );
  const groups = groupProfessorDigest(items, now, config);
  if (professorDigestCount(groups) === 0) {
    // Quiet when nothing is due: a daily "all clear" is a mail she learns to filter, and then the
    // one that matters is filtered with it.
    return quiet("nothing_due");
  }

  // Resolved after the queues rather than before, so a deployment with no head professor on file
  // is only an error on a day there was something to say -- the rec-letter reminder's rule.
  if (!headProfessorId) {
    return failure(409, "no head professor is configured to receive the escalation digest");
  }
  if (!headProfessor) {
    return failure(409, "the configured head professor is not on the roster");
  }
  const recipient = headProfessor.email?.trim();
  if (!recipient) {
    return failure(
      409,
      `${headProfessor.name} has no email address on the roster, so the escalation digest cannot be sent`,
    );
  }

  const digested = professorDigestBuckets.flatMap((bucket) => groups[bucket]);
  const timesFlagged = new Map(
    digested.map((item) => [
      item.key,
      ledgerEntry(deps, itemSubject(item.key), headProfessorId)?.nudge_count ?? 0,
    ]),
  );
  const subject = `AdminBot: ${professorDigestSubject(groups, timesFlagged)}`;
  const body = professorDigestBody({
    groups,
    now,
    timezone,
    portalUrl: deps.portalUrl,
    timesFlagged,
  });
  const counts = Object.fromEntries(
    professorDigestBuckets.map((bucket) => [bucket, groups[bucket].length]),
  ) as Record<ProfessorDigestBucket, number>;
  const result = { local_date: clock.date, timezone, recipient, counts, subject, body };
  if (options.dryRun) {
    return { ok: true, status: 200, payload: { outcome: "preview", ...result } };
  }

  const proposed = deps.createProposal({
    type: "professor.escalation_digest",
    summary: `Email ${headProfessor.name} the daily digest of ${digested.length} waiting item${digested.length === 1 ? "" : "s"}`,
    target: { service: "email", channel: "email", target: recipient },
    proposed_payload: { to: recipient, subject, body },
    undo_plan: "Send an email follow-up correcting the digest.",
  });
  if (!proposed.ok) {
    return failure(proposed.status, proposed.error.message);
  }
  const executed = await deps.execute(proposed.payload.id, { dry_run: false });
  if (!executed.ok) {
    // A 502 is the connector failing mid-send, so the mail may have gone out -- unless gog says it
    // never reached Google. Possibly-sent counts as sent for the day gate: one missing digest is
    // caught up tomorrow, but a duplicate every hour until someone looks would be the bot nagging.
    // Item counts are left alone, since nobody knows whether she saw them.
    const ambiguous = executed.status === 502 && !gogFailedBeforeSending(executed.error.message);
    if (ambiguous) {
      stamp(deps, SENT_SUBJECT, headProfessorId, nowIso);
    }
    deps.recordAudit({
      type: "professor_digest.swept",
      actor,
      details: {
        outcome: ambiguous ? "unknown" : "failed",
        to: recipient,
        local_date: clock.date,
        proposal_id: proposed.payload.id,
        error: executed.error.message,
      },
    });
    return failure(502, `could not email the escalation digest: ${executed.error.message}`);
  }
  stamp(deps, SENT_SUBJECT, headProfessorId, nowIso);
  for (const item of digested) {
    stamp(deps, itemSubject(item.key), headProfessorId, nowIso);
  }
  deps.recordAudit({
    type: "professor_digest.swept",
    actor,
    details: {
      outcome: "sent",
      to: recipient,
      local_date: clock.date,
      counts,
      proposal_id: proposed.payload.id,
    },
  });
  return {
    ok: true,
    status: 200,
    payload: { outcome: "sent", ...result, proposal_id: proposed.payload.id },
  };
}

function ledgerEntry(deps: Deps, subjectId: string, memberId: string | undefined) {
  return deps.store
    .listNudgeLedger(DOMAIN)
    .find((entry) => entry.subject_id === subjectId && (!memberId || entry.member_id === memberId));
}

/** Advance a row's count. Re-read rather than indexed once, so a stamp never writes a stale count. */
function stamp(deps: Deps, subjectId: string, memberId: string, nowIso: string): void {
  const entry = ledgerEntry(deps, subjectId, memberId);
  deps.store.saveNudgeLedgerEntry({
    domain: DOMAIN,
    subject_id: subjectId,
    member_id: memberId,
    last_nudged_at: nowIso,
    nudge_count: (entry?.nudge_count ?? 0) + 1,
  });
}

function failure<T>(status: number, message: string): AdminBotServiceResponse<T> {
  return { ok: false, status, error: { message } };
}
