import type { AdminBotStoredProposal } from "../contracts/actions.js";
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

export async function previewWorkshopNudges(params: {
  service: AdminBotService;
  match: WorkshopMatcher;
  now: Date;
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
    match: params.match,
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
