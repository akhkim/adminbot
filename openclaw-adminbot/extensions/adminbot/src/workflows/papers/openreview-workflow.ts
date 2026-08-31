// Drives one pass of the reviewing-cycle automation: discover the venues this profile
// serves, work out who still owes a review, fire whichever cadence milestone is due, and
// record it so it never fires twice.
//
// Sending is deliberately not done here. Each due milestone becomes a proposal, and the
// existing propose -> approve -> execute path delivers it: routine reminders are
// auto-approved and executed inline, overdue warnings wait in Pending actions for a human.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdminBotLabMember,
  AdminBotOpenReviewCycleRecord,
  AdminBotOpenReviewMilestoneRecord,
  AdminBotOpenReviewMilestoneStatus,
  AdminBotOpenReviewRole,
} from "../../contracts/actions.js";
import type { AdminBotService, AdminBotServiceStore } from "../../kernel/service.js";
import {
  dueMilestones,
  missedMilestones,
  renderMilestoneMessage,
  requiresApproval,
  type AdminBotOpenReviewMilestone,
} from "./openreview-cadence.js";
import {
  reviewerExemptionReason,
  suggestReviewersForSubmission,
  type AdminBotReviewerSuggestion,
} from "./openreview-matching.js";

const execFile = promisify(execFileCallback);
const BRIDGE_TIMEOUT_MS = 300_000;
const BRIDGE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
// Ceiling on messages a single run may emit. A wrong deadline or a mis-detected role
// would otherwise mail an entire committee; hitting the cap aborts the run rather than
// half-sending, so the operator sees it before anything else goes out.
const DEFAULT_MAX_SENDS_PER_RUN = 50;

type BridgeResult = Record<string, unknown>;

type OpenReviewStore = Pick<
  AdminBotServiceStore,
  | "saveOpenReviewCycle"
  | "listOpenReviewCycles"
  | "recordOpenReviewMilestone"
  | "listOpenReviewMilestones"
  | "listLabMembers"
>;

export type AdminBotOpenReviewWorkflowOptions = {
  scriptPath: string;
  pythonCommand?: string;
  env?: NodeJS.ProcessEnv;
  service: AdminBotService;
  store: OpenReviewStore;
  maxSendsPerRun?: number;
  now?: () => number;
  run?: (args: string[]) => Promise<BridgeResult>;
};

export type AdminBotOpenReviewRunOutcome = {
  venue_id: string;
  role: AdminBotOpenReviewRole;
  milestone_key?: string;
  status: AdminBotOpenReviewMilestoneStatus | "no_milestone_due";
  recipients?: number;
  detail?: string;
};

export type AdminBotOpenReviewRunResult = {
  ran_at: string;
  venues: number;
  // Venues discovery deliberately dropped, with the reason per venue. Without this a
  // run that found nothing is indistinguishable from one that filtered everything out.
  skipped: Array<{ venue_id: string; role: string; reason: string }>;
  outcomes: AdminBotOpenReviewRunOutcome[];
  missed: Array<{ venue_id: string; role: AdminBotOpenReviewRole; milestone_key: string }>;
  errors: Array<{ venue_id?: string; reason: string; error: string }>;
};

export type AdminBotOpenReviewWorkflow = {
  runCycle(options?: { dryRun?: boolean }): Promise<AdminBotOpenReviewRunResult>;
  loadForms(): Promise<BridgeResult[]>;
  suggestReviewers(venueId: string): Promise<
    Array<{
      submission_number: number;
      title: string;
      missing_reviewers: number;
      suggestions: AdminBotReviewerSuggestion[];
    }>
  >;
  applyAssignment(input: {
    venueId: string;
    submission: string;
    reviewer: string;
    remove?: boolean;
  }): Promise<BridgeResult>;
};

export function createAdminBotOpenReviewWorkflow(
  options: AdminBotOpenReviewWorkflowOptions,
): AdminBotOpenReviewWorkflow {
  const run = options.run ?? createBridgeRunner(options);
  const now = options.now ?? (() => Date.now());
  const maxSends = options.maxSendsPerRun ?? DEFAULT_MAX_SENDS_PER_RUN;

  async function statusFor(venueId: string, role: AdminBotOpenReviewRole): Promise<BridgeResult> {
    return run(["status", "--venue", venueId, "--role", role]);
  }

  return {
    async runCycle({ dryRun = false } = {}) {
      const ranAt = new Date(now()).toISOString();
      const result: AdminBotOpenReviewRunResult = {
        ran_at: ranAt,
        venues: 0,
        skipped: [],
        outcomes: [],
        missed: [],
        errors: [],
      };

      const discovered = await run(["discover"]);
      if (discovered.ok !== true) {
        result.errors.push({
          reason: asText(discovered.reason) || "discover_failed",
          error: asText(discovered.error),
        });
        return result;
      }

      const venues = asRecords(discovered.venues);
      result.venues = venues.length;
      result.skipped = asRecords(discovered.skipped).map((entry) => ({
        venue_id: asString(entry.venue_id) ?? "unknown",
        role: asString(entry.role) ?? "unknown",
        reason: asText(entry.reason) || "unspecified",
      }));
      let sends = 0;

      for (const venue of venues) {
        const venueId = asString(venue.venue_id);
        const role = asRole(venue.role);
        if (!venueId || !role) {
          continue;
        }
        const cycle = {
          venue_id: venueId,
          role,
          deadline_ms: asNumber(venue.deadline_ms) ?? 0,
          cycle_start_ms: asNumber(venue.cycle_start_ms) ?? null,
        };
        // Read the fired set per cycle rather than once per run: recordOpenReviewMilestone
        // writes as we go, so this is what keeps a second milestone in the same run from
        // seeing stale history.
        const firedHere = new Set(
          options.store
            .listOpenReviewMilestones(venueId)
            .filter((milestone) => milestone.role === role)
            .map((milestone) => milestone.milestone_key),
        );
        const due = dueMilestones(cycle, now(), firedHere);
        for (const milestone of missedMilestones(cycle, now(), firedHere)) {
          result.missed.push({ venue_id: venueId, role, milestone_key: milestone.key });
        }

        // A cycle with nothing due still gets its snapshot refreshed only if we have to
        // query anyway; skipping the status call is the difference between a cheap
        // 6-hourly tick and hammering OpenReview for every venue every time.
        if (due.length === 0) {
          saveCycle(options.store, venue, cycle, ranAt);
          result.outcomes.push({ venue_id: venueId, role, status: "no_milestone_due" });
          continue;
        }

        const status = await statusFor(venueId, role);
        if (status.ok !== true) {
          saveCycle(
            options.store,
            venue,
            cycle,
            ranAt,
            asText(status.error) || asText(status.reason),
          );
          result.errors.push({
            venue_id: venueId,
            reason: asText(status.reason) || "status_failed",
            error: asText(status.error),
          });
          continue;
        }
        const papers = asRecords(status.papers);
        saveCycle(options.store, venue, cycle, ranAt, undefined, {
          papers_total: papers.length,
          reviews_missing: asNumber(status.total_missing) ?? 0,
        });

        for (const milestone of due) {
          const targets = papers.filter((paper) => asArray(paper.missing_reviewers).length > 0);
          if (targets.length === 0) {
            recordOutcome(options.store, result, venueId, role, milestone, "skipped", 0, ranAt, {
              detail: "every assigned review is already in",
            });
            continue;
          }
          if (sends + targets.length > maxSends) {
            result.errors.push({
              venue_id: venueId,
              reason: "send_cap_reached",
              error: `run would exceed the ${maxSends}-message cap; aborting before sending`,
            });
            return result;
          }

          const outcome = await fireMilestone({
            service: options.service,
            venue,
            venueId,
            role,
            milestone,
            targets,
            dryRun,
          });
          sends += outcome.recipients;
          recordOutcome(
            options.store,
            result,
            venueId,
            role,
            milestone,
            outcome.status,
            outcome.recipients,
            ranAt,
            { detail: outcome.detail },
          );
        }
      }
      return result;
    },

    async loadForms() {
      const discovered = await run(["discover"]);
      if (discovered.ok !== true) {
        return [];
      }
      const forms: BridgeResult[] = [];
      for (const venue of asRecords(discovered.venues)) {
        const venueId = asString(venue.venue_id);
        const role = asRole(venue.role);
        if (!venueId || !role) {
          continue;
        }
        const form = await run(["load-form", "--venue", venueId, "--role", role]);
        if (form.ok === true) {
          forms.push(form);
        }
      }
      return forms;
    },

    // The emergency-reviewer worklist: for every submission still missing a review, the
    // Jinesis members whose research overlaps it. Suggestion only — assigning is a
    // separate, explicit call.
    async suggestReviewers(venueId) {
      const status = await statusFor(venueId, "ac");
      if (status.ok !== true) {
        return [];
      }
      const members: AdminBotLabMember[] = options.store.listLabMembers();
      const operatorOpenReviewId = asString(status.profile_id);
      return asRecords(status.papers)
        .filter((paper) => asArray(paper.missing_reviewers).length > 0)
        .map((paper) => ({
          submission_number: asNumber(paper.number) ?? 0,
          title: asString(paper.title) ?? "",
          missing_reviewers: asArray(paper.missing_reviewers).length,
          suggestions: suggestReviewersForSubmission(
            members,
            {
              number: asNumber(paper.number) ?? 0,
              title: asString(paper.title) ?? "",
              abstract: asString(paper.abstract) ?? "",
              keywords: asArray(paper.keywords).flatMap((entry) =>
                typeof entry === "string" ? [entry] : [],
              ),
              assigned_reviewers: asArray(paper.assigned_reviewers).flatMap((entry) =>
                typeof entry === "string" ? [entry] : [],
              ),
            },
            {
              todayIso: new Date(now()).toISOString().slice(0, 10),
              ...(operatorOpenReviewId ? { operatorOpenReviewId } : {}),
            },
          ),
        }));
    },

    async applyAssignment({ venueId, submission, reviewer, remove }) {
      // Defence in depth: the suggester greys these people out, but the route is
      // reachable directly, and adding an exempt reviewer is exactly the mistake the
      // exemption exists to prevent. Removal stays allowed — taking someone off is
      // always safe, and may be how an exemption gets enforced retroactively.
      if (!remove) {
        const member = options.store
          .listLabMembers()
          .find((entry) => entry.openreview_id === reviewer);
        const exempt = member ? reviewerExemptionReason(member) : undefined;
        if (member && exempt) {
          return {
            ok: false,
            reason: "reviewer_exempt",
            error: `${member.name} is ${exempt}`,
          };
        }
      }
      const args = [
        "assign",
        "--venue",
        venueId,
        "--submission",
        submission,
        "--reviewer",
        reviewer,
      ];
      if (remove) {
        args.push("--remove");
      }
      return run(args);
    },
  };
}

// Turns one due milestone into one proposal per affected submission. Recipients are the
// venue's own committee groups, so an anonymous reviewer is never resolved to a person.
async function fireMilestone(input: {
  service: AdminBotService;
  venue: BridgeResult;
  venueId: string;
  role: AdminBotOpenReviewRole;
  milestone: AdminBotOpenReviewMilestone;
  targets: BridgeResult[];
  dryRun: boolean;
}): Promise<{ status: AdminBotOpenReviewMilestoneStatus; recipients: number; detail?: string }> {
  const needsApproval = requiresApproval(input.milestone);
  const title = asString(input.venue.title) ?? input.venueId;
  const deadlineMs = asNumber(input.venue.deadline_ms) ?? 0;
  let sent = 0;
  // Of those, how many the connector composed but declined to deliver.
  let withheld = 0;
  const problems: string[] = [];

  for (const paper of input.targets) {
    const number = asNumber(paper.number) ?? 0;
    // An SAC nudges the ACs holding the paper; everyone else nudges the reviewers.
    const groupId =
      input.role === "sac"
        ? asString(paper.area_chairs_group_id)
        : asString(paper.reviewers_group_id);
    const signature =
      input.role === "sac" ? asString(paper.my_sac_signature) : asString(paper.my_ac_signature);
    if (!groupId || !signature) {
      problems.push(`submission ${number}: no ${input.role} signature or recipient group`);
      continue;
    }
    const message = renderMilestoneMessage(input.role, input.milestone, {
      venue_title: title,
      submission_number: number,
      submission_title: asString(paper.title) ?? "",
      deadline_ms: deadlineMs,
      missing_count: asArray(paper.missing_reviewers).length,
    });
    const invitation = messageInvitationFor(input.venue, input.role, number);
    const created = input.service.createProposal({
      type: needsApproval ? "openreview.warning" : "openreview.nudge",
      summary: `${title} submission ${number}: ${message.subject}`,
      target: { service: "openreview", venue_id: input.venueId, submission: number },
      proposed_payload: {
        invitation,
        signature,
        groups: [groupId],
        subject: message.subject,
        body: message.body,
      },
      undo_plan: "Send a follow-up message through the same OpenReview thread.",
      // Idempotent per (venue, role, milestone, submission) so a retried run reuses the
      // existing proposal instead of stacking duplicates.
      idempotency_key: `openreview:${input.venueId}:${input.role}:${input.milestone.key}:${number}`,
    });
    if (!created.ok) {
      problems.push(`submission ${number}: ${created.error.message}`);
      continue;
    }
    if (needsApproval || input.dryRun) {
      sent += 1;
      continue;
    }
    const executed = await input.service.execute(created.payload.id, { dry_run: false });
    if (!executed.ok) {
      problems.push(`submission ${number}: ${executed.error.message}`);
      continue;
    }
    // A real execute can still come back simulated: the OpenReview bridge has a delivery kill
    // switch (ADMINBOT_OPENREVIEW_SEND), and when it is off the message is composed, validated and
    // not posted. Counting that as sent is what made this pass report deliveries nobody received.
    if (executed.payload.status !== "executed") {
      withheld += 1;
    }
    sent += 1;
  }

  const detail = problems.length > 0 ? problems.join("; ") : undefined;
  if (sent === 0) {
    return { status: "blocked", recipients: 0, detail: detail ?? "no deliverable recipients" };
  }
  // `dry_run` covers both ways of not delivering -- the caller asking for a rehearsal, and the
  // deploy-time kill switch answering for one -- because they are the same fact to whoever reads
  // this: the cycle ran and nothing went out.
  const status: AdminBotOpenReviewMilestoneStatus =
    input.dryRun || withheld > 0
      ? "dry_run"
      : needsApproval
        ? "proposed"
        : "sent";
  return { status, recipients: sent, ...(detail ? { detail } : {}) };
}

function messageInvitationFor(
  venue: BridgeResult,
  role: AdminBotOpenReviewRole,
  number: number,
): string {
  const template =
    role === "sac"
      ? asString(venue.area_chairs_message_submission_id)
      : asString(venue.reviewers_message_submission_id);
  const venueId = asString(venue.venue_id) ?? "";
  const submissionName = asString(venue.submission_name) ?? "Submission";
  const fallback =
    role === "sac"
      ? `${venueId}/${submissionName}${number}/Area_Chairs/-/Message`
      : `${venueId}/${submissionName}${number}/-/Message`;
  return (template ?? fallback).replace("{number}", String(number));
}

function recordOutcome(
  store: OpenReviewStore,
  result: AdminBotOpenReviewRunResult,
  venueId: string,
  role: AdminBotOpenReviewRole,
  milestone: AdminBotOpenReviewMilestone,
  status: AdminBotOpenReviewMilestoneStatus,
  recipients: number,
  firedAt: string,
  extra: { detail?: string } = {},
): void {
  const record: AdminBotOpenReviewMilestoneRecord = {
    venue_id: venueId,
    role,
    milestone_key: milestone.key,
    fired_at: firedAt,
    status,
    recipients,
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
  store.recordOpenReviewMilestone(record);
  result.outcomes.push({
    venue_id: venueId,
    role,
    milestone_key: milestone.key,
    status,
    recipients,
    ...(extra.detail ? { detail: extra.detail } : {}),
  });
}

function saveCycle(
  store: OpenReviewStore,
  venue: BridgeResult,
  cycle: {
    venue_id: string;
    role: AdminBotOpenReviewRole;
    deadline_ms: number;
    cycle_start_ms: number | null;
  },
  updatedAt: string,
  lastError?: string,
  snapshot?: { papers_total: number; reviews_missing: number },
): void {
  const existing = store
    .listOpenReviewCycles()
    .find((entry) => entry.venue_id === cycle.venue_id && entry.role === cycle.role);
  const record: AdminBotOpenReviewCycleRecord = {
    venue_id: cycle.venue_id,
    role: cycle.role,
    title: asString(venue.title) ?? cycle.venue_id,
    deadline_ms: cycle.deadline_ms,
    ...(cycle.cycle_start_ms !== null ? { cycle_start_ms: cycle.cycle_start_ms } : {}),
    discovered_at: existing?.discovered_at ?? updatedAt,
    updated_at: updatedAt,
    ...(snapshot ?? {
      ...(existing?.papers_total !== undefined ? { papers_total: existing.papers_total } : {}),
      ...(existing?.reviews_missing !== undefined
        ? { reviews_missing: existing.reviews_missing }
        : {}),
    }),
    ...(lastError ? { last_error: lastError } : {}),
  };
  store.saveOpenReviewCycle(record);
}

function createBridgeRunner(
  options: AdminBotOpenReviewWorkflowOptions,
): (args: string[]) => Promise<BridgeResult> {
  const python = options.pythonCommand ?? "python3";
  return async (args) => {
    const { stdout } = await execFile(python, [options.scriptPath, ...args], {
      env: options.env ?? process.env,
      maxBuffer: BRIDGE_MAX_OUTPUT_BYTES,
      timeout: BRIDGE_TIMEOUT_MS,
      windowsHide: true,
    });
    const line = stdout.trim().split("\n").at(-1) ?? "";
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed as BridgeResult;
    } catch {
      return { ok: false, reason: "bad_bridge_output", error: line.slice(0, 300) };
    }
  };
}

function asRecords(value: unknown): BridgeResult[] {
  return Array.isArray(value) ? (value as BridgeResult[]) : [];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Bridge output is untyped JSON, so a field that should be a message can be an object.
// Render it as JSON rather than letting it stringify to "[object Object]" in an error.
function asText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRole(value: unknown): AdminBotOpenReviewRole | undefined {
  return value === "reviewer" || value === "ac" || value === "sac" ? value : undefined;
}
