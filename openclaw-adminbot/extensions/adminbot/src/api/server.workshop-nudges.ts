import { randomUUID } from "node:crypto";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotWorkshopMatchRun } from "../contracts/paper-cycle.js";
import type { AdminBotService } from "../kernel/service.js";
import { DEADLINE_VENUES } from "../workflows/deadlines/generated/dataset.js";
import type { WorkshopMatcher } from "../workflows/papers/workshop-nudges.js";
import {
  matchWorkshopNudges,
  workshopNudgeInputsFromAdminBot,
  workshopProfilesFromDeadlines,
  type WorkshopNudgeCoverage,
  type WorkshopNudgeResult,
} from "../workflows/papers/workshop-nudges.js";

export type WorkshopNudgePreview = Omit<WorkshopNudgeResult, "recipients"> & {
  recipients: Array<
    WorkshopNudgeResult["recipients"][number] & {
      delivery_ready: boolean;
      delivery_blocked_reason?: string;
    }
  >;
  coverage: WorkshopNudgeCoverage;
};

export type WorkshopNudgeSendResult = {
  recomputed_at: string;
  created: Array<{ member_id: string; proposal_id: string; status: string }>;
  skipped: Array<{ member_id: string; reason: string }>;
};

/**
 * The stored answer, and whether a pass is producing a newer one.
 *
 * Reading is free and never starts work. A pass is thousands of model calls and tens of minutes;
 * making page-open trigger it is what put a batch job inside a request in the first place.
 */
export function readWorkshopNudgeRun(service: AdminBotService, now?: Date): WorkshopNudgeRunView {
  const stored = service.latestWorkshopMatchRun();
  if (!stored) {
    return { status: "none" };
  }
  // Reading *does* close out a pass that has stopped moving. Deciding that only when somebody
  // presses Find recommendations was the remaining half of the wedged tab: the page polls this
  // route every few seconds, so a stalled run kept being reported as `running` to every poll,
  // forever, and an administrator watching "1671 of 2540 model calls done" was watching a number
  // that could never change. Staleness is a fact about the row; the cheapest reader is as entitled
  // to notice it as the most expensive one.
  const run = workshopRunIsAbandoned(stored, now ?? new Date())
    ? abandonWorkshopRun(service, stored)
    : stored;
  return {
    status: run.status,
    started_at: run.started_at,
    ...(run.finished_at ? { finished_at: run.finished_at } : {}),
    ...(run.started_by ? { started_by: run.started_by } : {}),
    calls_done: run.calls_done,
    calls_total: run.calls_total,
    calls_failed: run.calls_failed ?? 0,
    ...(run.error ? { error: run.error } : {}),
    ...(run.payload_json ? { preview: JSON.parse(run.payload_json) as WorkshopNudgePreview } : {}),
  };
}

export type WorkshopNudgeRunView = {
  status: "none" | "running" | "ready" | "failed";
  started_at?: string;
  finished_at?: string;
  started_by?: string;
  calls_done?: number;
  calls_total?: number;
  /** How many of `calls_done` gave up rather than answered. */
  calls_failed?: number;
  error?: string;
  preview?: WorkshopNudgePreview;
};

/**
 * How long a pass may go without finishing a single model call before it is presumed dead.
 *
 * Generous on purpose: a batch against a busy model can take minutes, and killing a pass that is
 * merely slow costs the whole run. What this catches is the other case -- a pass whose process is
 * gone, or whose model endpoint stopped answering entirely -- where the row would otherwise say
 * `running` forever and every later pass would be refused in its name.
 */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/** Whether a run claiming to be in flight has stopped moving. */
export function workshopRunIsAbandoned(
  run: Pick<AdminBotWorkshopMatchRun, "status" | "started_at" | "progress_at">,
  now: Date,
): boolean {
  if (run.status !== "running") {
    return false;
  }
  const movedAt = Date.parse(run.progress_at ?? run.started_at);
  if (!Number.isFinite(movedAt)) {
    // A row with no readable clock is older than this column; it cannot be shown to be alive.
    return true;
  }
  return now.getTime() - movedAt > ABANDONED_AFTER_MS;
}

export const WORKSHOP_RUN_STALLED_MESSAGE =
  "This pass stopped answering and was abandoned. Its counts say how far it got; start a new one.";

/**
 * Write a stalled run off as failed, and return the row as it now reads.
 *
 * The counts are left exactly as they were: they are the only record of how far the pass got, and
 * a stalled pass that reported 1671 of 2540 is more useful to whoever has to explain it than one
 * reset to zero.
 */
function abandonWorkshopRun(
  service: AdminBotService,
  run: AdminBotWorkshopMatchRun,
): AdminBotWorkshopMatchRun {
  // If the task is somehow still alive in this process, stop it before declaring it dead --
  // otherwise it can wake up later and overwrite the row it was evicted from.
  abortWorkshopRun(run.id);
  const closed: AdminBotWorkshopMatchRun = {
    ...run,
    status: "failed",
    finished_at: run.finished_at ?? new Date().toISOString(),
    error: run.error ?? WORKSHOP_RUN_STALLED_MESSAGE,
  };
  service.saveWorkshopMatchRun(closed);
  return closed;
}

/**
 * Passes running in this process, so one can be stopped without stopping the service.
 *
 * Deliberately in-memory and not persisted: an entry here is a claim about a task in *this*
 * process, and the whole failure this file keeps running into is a persisted row outliving the
 * work it describes. A cancel that finds no controller still writes the row off -- the run is
 * gone either way, and the storage is only about reclaiming the model time too.
 */
const inFlightWorkshopRuns = new Map<string, AbortController>();

function abortWorkshopRun(runId: string): boolean {
  const controller = inFlightWorkshopRuns.get(runId);
  if (!controller) {
    return false;
  }
  controller.abort();
  inFlightWorkshopRuns.delete(runId);
  return true;
}

/**
 * Stop the pass in flight, if there is one.
 *
 * "Wait for the thirty-minute stall window" is the right default for a pass nobody is watching and
 * the wrong answer for an administrator standing in front of one they know is broken.
 */
export function cancelWorkshopNudgeRun(params: {
  service: AdminBotService;
  actor?: string;
}): WorkshopNudgeRunView {
  const existing = params.service.latestWorkshopMatchRun();
  if (existing?.status !== "running") {
    return readWorkshopNudgeRun(params.service);
  }
  abortWorkshopRun(existing.id);
  params.service.saveWorkshopMatchRun({
    ...existing,
    status: "failed",
    finished_at: new Date().toISOString(),
    error: params.actor
      ? `This pass was stopped by ${params.actor} after ${existing.calls_done} of ${existing.calls_total} model calls.`
      : `This pass was stopped after ${existing.calls_done} of ${existing.calls_total} model calls.`,
  });
  return readWorkshopNudgeRun(params.service);
}

/**
 * Start a pass, and return immediately.
 *
 * The work outlives the request on purpose. Awaiting it here is exactly the shape that failed:
 * the browser cannot hold a connection for the length of this pass, so it gave up and the page
 * called the service unreachable. The caller gets the run's id and polls the read above.
 *
 * One at a time. A second Refresh while a pass is in flight returns the pass already running
 * rather than doubling the model bill for the same answer.
 */
export function startWorkshopNudgeRun(params: {
  service: AdminBotService;
  match: WorkshopMatcher;
  now: Date;
  startedBy?: string;
  /**
   * Start a pass even though one claims to be running.
   *
   * The stall window is thirty minutes because killing a merely slow pass throws away real model
   * time. That is the right call for a guess and the wrong one for an administrator looking at a
   * progress count they have watched sit still: this is them saying they already know.
   */
  force?: boolean;
}): WorkshopNudgeRunView {
  const existing = params.service.latestWorkshopMatchRun();
  if (existing?.status === "running") {
    if (!params.force && !workshopRunIsAbandoned(existing, params.now)) {
      return readWorkshopNudgeRun(params.service);
    }
    // It stopped moving, or an administrator says to replace it regardless. Close it out rather
    // than leaving two rows claiming to be in flight, and say why: an operator pressing Refresh
    // again on a wedged tab deserves better than silence.
    abortWorkshopRun(existing.id);
    params.service.saveWorkshopMatchRun({
      ...existing,
      status: "failed",
      finished_at: new Date().toISOString(),
      error:
        existing.error ??
        "This pass stopped answering and was abandoned; the pass below replaces it.",
    });
  }
  const run: AdminBotWorkshopMatchRun = {
    id: `wsm_${randomUUID()}`,
    status: "running",
    started_at: new Date().toISOString(),
    ...(params.startedBy ? { started_by: params.startedBy } : {}),
    calls_done: 0,
    calls_total: 0,
    calls_failed: 0,
  };
  params.service.saveWorkshopMatchRun(run);
  const controller = new AbortController();
  inFlightWorkshopRuns.set(run.id, controller);

  // Deliberately not awaited: see the note above.
  void (async () => {
    // The last progress this pass reported. Carried forward onto the terminal row so a run that
    // finished with failures still says how many, and a cancelled one still says how far it got.
    let progress = { done: 0, total: 0, failed: 0 };
    /**
     * Persist only while this run is still the one the store believes in.
     *
     * A pass that was cancelled or aged out has already had its row written off. If its task then
     * wakes up -- a model call returning after the abort, a straggler finishing its batch -- and
     * writes `running` back, the tab returns to exactly the state this whole change exists to
     * end. The row is not this task's to touch any more.
     */
    const saveIfCurrent = (next: AdminBotWorkshopMatchRun): boolean => {
      const latest = params.service.latestWorkshopMatchRun();
      if (latest?.id !== run.id || latest.status !== "running") {
        return false;
      }
      params.service.saveWorkshopMatchRun(next);
      return true;
    };
    try {
      const preview = await previewWorkshopNudges({
        service: params.service,
        match: params.match,
        now: params.now,
        signal: controller.signal,
        onProgress: (done, total, failed) => {
          progress = { done, total, failed: failed ?? 0 };
          saveIfCurrent({
            ...run,
            calls_done: done,
            calls_total: total,
            calls_failed: progress.failed,
          });
        },
      });
      saveIfCurrent({
        ...run,
        status: "ready",
        finished_at: new Date().toISOString(),
        calls_done: progress.done,
        calls_total: progress.total,
        calls_failed: progress.failed,
        payload_json: JSON.stringify(preview),
        // A pass that answered can still be missing workshops. Saying so on a `ready` run is the
        // difference between "no workshop matched these papers" and "we never asked about them".
        ...(progress.failed > 0
          ? {
              error: `${progress.failed} of ${progress.total} model calls failed, so some workshops were not scored. The results below are what did answer.`,
            }
          : {}),
      });
    } catch (error) {
      saveIfCurrent({
        ...run,
        status: "failed",
        finished_at: new Date().toISOString(),
        calls_done: progress.done,
        calls_total: progress.total,
        calls_failed: progress.failed,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlightWorkshopRuns.delete(run.id);
    }
  })();

  return readWorkshopNudgeRun(params.service);
}

export async function previewWorkshopNudges(params: {
  service: AdminBotService;
  match: WorkshopMatcher;
  now: Date;
  onProgress?: (done: number, total: number, failed: number) => void;
  signal?: AbortSignal;
}): Promise<WorkshopNudgePreview> {
  const papers = servicePayload(params.service.listPapers()).papers;
  const members = servicePayload(params.service.listLabMembers()).members;
  const attendees = servicePayload(params.service.listConferenceAttendance()).attendees;
  const workshops = workshopProfilesFromDeadlines(DEADLINE_VENUES, params.now);
  if (!workshops.length) {
    throw new Error("no upcoming workshop profiles are available");
  }
  const source = workshopNudgeInputsFromAdminBot({ papers, members, attendees, workshops });
  const matched = await matchWorkshopNudges({
    papers: source.papers,
    workshops,
    attendance: source.attendance,
    // matchWorkshopNudges calls the matcher with only the papers and workshops it worked out, so
    // progress reporting and cancellation are threaded in here rather than through its signature.
    match:
      params.onProgress || params.signal
        ? (request) =>
            params.match({
              ...request,
              ...(params.onProgress ? { onProgress: params.onProgress } : {}),
              ...(params.signal ? { signal: params.signal } : {}),
            })
        : params.match,
    now: params.now,
  });
  const membersById = new Map(members.map((member) => [member.id, member]));
  return {
    ...matched,
    paper_count: new Set(papers.map((paper) => paper.id)).size,
    recipients: matched.recipients.map((recipient) => {
      const member = membersById.get(recipient.recipient_member_id);
      const blocked = !recipient.draft
        ? "No workshop recommendation is available."
        : !member?.slack_user_id
          ? "No Slack identity is linked."
          : undefined;
      return {
        ...recipient,
        delivery_ready: !blocked,
        ...(blocked ? { delivery_blocked_reason: blocked } : {}),
      };
    }),
    coverage: source.coverage,
  };
}

export async function sendWorkshopNudges(params: {
  service: AdminBotService;
  match: WorkshopMatcher;
  now: Date;
  actor: string;
  recipientMemberIds: readonly string[];
}): Promise<WorkshopNudgeSendResult> {
  const preview = await previewWorkshopNudges(params);
  const recipients = new Map(
    preview.recipients.map((recipient) => [recipient.recipient_member_id, recipient]),
  );
  const created: WorkshopNudgeSendResult["created"] = [];
  const skipped: WorkshopNudgeSendResult["skipped"] = [];
  for (const memberId of [...new Set(params.recipientMemberIds)]) {
    const recipient = recipients.get(memberId);
    if (!recipient?.draft || !recipient.delivery_ready) {
      skipped.push({
        member_id: memberId,
        reason:
          recipient?.delivery_blocked_reason ?? "No current workshop recommendation is available.",
      });
      continue;
    }
    const sent = await params.service.sendMemberNudge(
      {
        channel: "slack",
        recipient_member_ids: [memberId],
        message: recipient.draft.text,
        kind: "workshop",
        title: "Workshops that may fit your papers",
        tab: "myWork",
        // Not important: this is a suggestion an administrator chose to pass on, not something the
        // lab is owed. Escalating an unread suggestion would be the lab chasing its own idea.
      },
      params.actor,
    );
    if (!sent.ok) {
      skipped.push({ member_id: memberId, reason: sent.error.message });
      continue;
    }
    created.push(...sent.payload.created.map((proposal) => sentProposal(memberId, proposal)));
    skipped.push(...sent.payload.skipped);
  }
  return { recomputed_at: preview.generated_at, created, skipped };
}

function servicePayload<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function sentProposal(
  memberId: string,
  proposal: AdminBotStoredProposal,
): WorkshopNudgeSendResult["created"][number] {
  return { member_id: memberId, proposal_id: proposal.id, status: proposal.status };
}
