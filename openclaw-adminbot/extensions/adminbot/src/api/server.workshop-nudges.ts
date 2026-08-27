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
export function readWorkshopNudgeRun(service: AdminBotService): WorkshopNudgeRunView {
  const run = service.latestWorkshopMatchRun();
  if (!run) {
    return { status: "none" };
  }
  return {
    status: run.status,
    started_at: run.started_at,
    ...(run.finished_at ? { finished_at: run.finished_at } : {}),
    ...(run.started_by ? { started_by: run.started_by } : {}),
    calls_done: run.calls_done,
    calls_total: run.calls_total,
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
  error?: string;
  preview?: WorkshopNudgePreview;
};

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
}): WorkshopNudgeRunView {
  const existing = params.service.latestWorkshopMatchRun();
  if (existing?.status === "running") {
    return readWorkshopNudgeRun(params.service);
  }
  const run: AdminBotWorkshopMatchRun = {
    id: `wsm_${randomUUID()}`,
    status: "running",
    started_at: new Date().toISOString(),
    ...(params.startedBy ? { started_by: params.startedBy } : {}),
    calls_done: 0,
    calls_total: 0,
  };
  params.service.saveWorkshopMatchRun(run);

  // Deliberately not awaited: see the note above.
  void (async () => {
    try {
      const preview = await previewWorkshopNudges({
        service: params.service,
        match: params.match,
        now: params.now,
        onProgress: (done, total) => {
          params.service.saveWorkshopMatchRun({
            ...run,
            calls_done: done,
            calls_total: total,
          });
        },
      });
      params.service.saveWorkshopMatchRun({
        ...run,
        status: "ready",
        finished_at: new Date().toISOString(),
        payload_json: JSON.stringify(preview),
      });
    } catch (error) {
      params.service.saveWorkshopMatchRun({
        ...run,
        status: "failed",
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return readWorkshopNudgeRun(params.service);
}

export async function previewWorkshopNudges(params: {
  service: AdminBotService;
  match: WorkshopMatcher;
  now: Date;
  onProgress?: (done: number, total: number) => void;
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
    match: params.onProgress
      ? (request) => params.match({ ...request, onProgress: params.onProgress })
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
