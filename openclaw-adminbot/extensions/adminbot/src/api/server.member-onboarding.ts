/**
 * Onboarding one new person, the same way from every door they can come in by.
 *
 * The roster has six ways in -- the Members tab's Add member, approving a member request, the
 * Onboarding tab's Add row and its "onboard selected rows", the weekly sheet sweep, and approving a
 * portal sign-up -- and each used to do its own subset of the work: one derived the access level
 * from the Member Type and the rest left everybody at the least-privileged default, one put people
 * on the Monday meeting and none of the others did, one granted the lab calendar to everyone it
 * approved regardless of who they were. Which access a person got depended on which button an
 * admin happened to press.
 *
 * So there is one sequence, and every path runs it:
 *
 *   1. **The record**, with its access level implied by its Member Type (`newMemberRecord`).
 *   2. **Enrollment** (`enrollNewMember`): the access design's consequences of holding that type,
 *      applied as the move from "nobody" to it -- Slack rooms, the Monday meeting, the lab calendar
 *      and the sheet's Member Type cell -- by the same `applyMemberTypeChange` a type change runs.
 *   3. **The guide** (`onboarding.send_guide`), for the Member Types the access design mails.
 *
 * An admin's click approves enrollment and the standard full-member guide on the spot.
 * The weekly sweep has nobody present, so its steps are filed and left in Pending Actions.
 */
import type {
  AdminBotAuditEvent,
  AdminBotLabMember,
  AdminBotLabMemberInput,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import type {
  AdminBotExecutorOutcome,
  AdminBotService,
  AdminBotServiceResponse,
} from "../kernel/service.js";
import {
  newMemberRecord,
  privilegeForMemberTypeChange,
} from "../workflows/members/member-type-access.js";
import { templateForMemberType } from "../workflows/onboarding/member-type-template.js";
import {
  type MemberSheetApprover,
  type MemberSheetSource,
  approveAndExecute,
} from "./server.member-sheet.js";
import { applyMemberTypeChange, type MemberTypeChangeResult } from "./server.member-type-change.js";

/** Everything enrollment needs from the route, built once per request by the caller. */
export type NewMemberOnboardingDeps = {
  service: AdminBotService;
  /** Absent: each step is queued for approval rather than approved here. */
  approver?: MemberSheetApprover;
  actor: string;
  memberSheet?: MemberSheetSource;
  readGroupMeeting?: () => Promise<
    | { calendarId: string; seriesId: string; targets: string[] }
    | { error: { status: number; message: string } }
  >;
  recordAudit: (event: Pick<AdminBotAuditEvent, "type" | "actor" | "details">) => void;
};

/**
 * Step 2: what holding this record's type grants, applied as the move from holding nothing.
 *
 * `skipSheet` names why the sheet's Member Type cell is already right -- the row was just appended,
 * or the person was read off it -- so the step does not file a write that changes nothing.
 * `skipGroupMeeting` is for a save whose Meetings checkboxes set the Monday meeting explicitly.
 */
export async function enrollNewMember(
  deps: NewMemberOnboardingDeps,
  member: AdminBotLabMember,
  options: { skipSheet?: string; skipGroupMeeting?: boolean } = {},
): Promise<MemberTypeChangeResult> {
  const nobody: AdminBotLabMember = {
    ...member,
    member_type: "",
    privilege_level: "external_collaborator",
    collaborator_subgroup: undefined,
  };
  return applyMemberTypeChange(
    {
      ...deps,
      // The guide step below is this person's one onboarding mail; the guide inside a type change
      // would be a second copy of it.
      skipGuide: true,
      guideSendsSlackConnect: templateForMemberType(member.member_type).ok,
      skipGroupMeeting: options.skipGroupMeeting,
      skipSheet:
        options.skipSheet ??
        (member.member_type?.trim() ? undefined : "no Member Type to write to the sheet"),
    },
    nobody,
    member,
  );
}

/** How step 3 went, in the shape the Onboarding tab already reports steps in. */
export type NewMemberGuideStep =
  | { status: "done"; proposal_id: string; template_id: string; email: string; detail: string }
  | { status: "queued"; proposal_id: string; template_id: string; email: string; detail: string }
  | { status: "skipped"; reason: string }
  | {
      status: "failed";
      reason: string;
      http_status?: number;
      proposal_id?: string;
      template_id?: string;
    };

/**
 * Step 3: the onboarding guide, if this person's Member Type is one the access design mails.
 *
 * Queued through `queueOnboardingGuideForMember`, which refuses a second copy of a guide already
 * sent or waiting -- so a person reached by two paths is mailed once. With an approver it is also
 * approved and sent now. Standard full-member guides use the enrollment admin’s approval
 * automatically; unattended imports still wait in Pending Actions.
 */
export async function queueNewMemberGuide(
  deps: Pick<NewMemberOnboardingDeps, "service" | "approver" | "actor">,
  memberId: string,
  options: {
    email?: string;
    values?: Record<string, string>;
    slackChannels?: readonly string[];
    send?: boolean;
    /** See `queueOnboardingGuideForMember`: an admin mailing the guide again on purpose. */
    resend?: boolean;
  } = {},
): Promise<NewMemberGuideStep> {
  const queued = deps.service.queueOnboardingGuideForMember({
    memberId,
    actor: deps.actor,
    ...(options.email ? { email: options.email } : {}),
    ...(options.values ? { values: options.values } : {}),
    ...(options.slackChannels ? { slackChannels: options.slackChannels } : {}),
    ...(options.resend ? { resend: true } : {}),
  });
  if (!queued.ok) {
    // 422 is a Member Type the design does not mail, or nobody to mail: a decision, not a fault.
    return queued.status === 422
      ? { status: "skipped", reason: queued.error.message }
      : { status: "failed", reason: queued.error.message, http_status: queued.status };
  }
  const { proposal_id: proposalId, template_id: templateId, email } = queued.payload;
  // Full-member enrollment already has a human admin's approval. Reuse it for the standard
  // guide; never let an unattended spreadsheet import supply that approval for itself.
  if ((!options.send && templateId !== "member") || !deps.approver) {
    return {
      status: "queued",
      proposal_id: proposalId,
      template_id: templateId,
      email,
      detail: `waiting for approval to send to ${email}`,
    };
  }
  const guide = deps.service.getProposal(proposalId);
  const sent = guide
    ? await approveAndExecute(deps.service, guide, deps.approver)
    : { ok: false as const, reason: `proposal ${proposalId} vanished` };
  return sent.ok
    ? {
        status: "done",
        proposal_id: proposalId,
        template_id: templateId,
        email,
        detail: `sent to ${email}`,
      }
    : { status: "failed", reason: sent.reason, proposal_id: proposalId, template_id: templateId };
}

export type NewMemberOnboardingResult = {
  member: AdminBotLabMember;
  member_type_change: MemberTypeChangeResult;
  onboarding?: NewMemberGuideStep;
};

/**
 * Steps 1-3 for a person who is not on the roster yet.
 *
 * `guide: "none"` is for the two Control UI paths that queue the guide themselves right after the
 * save, because that call carries the project channels the admin picked in the same form.
 */
export async function onboardNewMember(
  deps: NewMemberOnboardingDeps,
  input: AdminBotLabMemberInput,
  options: {
    origin: { source: "admin" | "import"; actor: string };
    guide: "none" | "queue" | "send";
    skipSheet?: string;
  },
): Promise<AdminBotServiceResponse<NewMemberOnboardingResult>> {
  const saved = deps.service.upsertLabMember(newMemberRecord(input), options.origin);
  if (!saved.ok) {
    return saved;
  }
  const memberTypeChange = await enrollNewMember(
    deps,
    saved.payload,
    options.skipSheet ? { skipSheet: options.skipSheet } : {},
  );
  const onboarding =
    options.guide === "none"
      ? undefined
      : await queueNewMemberGuide(deps, saved.payload.id, { send: options.guide === "send" });
  return {
    ok: true,
    status: 200,
    payload: {
      member: saved.payload,
      member_type_change: memberTypeChange,
      ...(onboarding ? { onboarding } : {}),
    },
  };
}

/**
 * The `lab_member.enroll` action: steps 1-2 for a member the weekly sweep created unattended.
 *
 * The sweep leaves them at the least-privileged level, because a spreadsheet row is not an
 * authorization. Approving this is: it sets the level the Member Type implies and runs the same
 * enrollment every other path runs, each step approved by the admin who approved this.
 *
 * Refuses, rather than acting on a stale card, when the Member Type changed after it was filed or
 * the member was already enrolled some other way -- a Members tab save in between, say.
 */
export async function executeMemberEnrollment(
  deps: Omit<NewMemberOnboardingDeps, "approver" | "actor"> & {
    getMember: (memberId: string) => AdminBotLabMember | undefined;
    alreadyEnrolled: (memberId: string) => boolean;
  },
  proposal: AdminBotStoredProposal,
): Promise<AdminBotExecutorOutcome> {
  const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
  const memberId = typeof payload.member_id === "string" ? payload.member_id : "";
  const approval = proposal.approvals.at(-1);
  if (!memberId || !approval?.approver_id) {
    return { handled: false, reason: "member_id and an approving admin are required" };
  }
  const member = deps.getMember(memberId);
  if (!member) {
    return { handled: true, delivered: false, reason: `no member ${memberId}` };
  }
  if ((member.member_type ?? "").trim() !== String(payload.member_type ?? "").trim()) {
    return {
      handled: true,
      delivered: false,
      reason: `${memberId}'s Member Type changed after this was filed; change it on the Members tab instead`,
    };
  }
  if (deps.alreadyEnrolled(memberId)) {
    return { handled: true, delivered: false, reason: `${memberId} has already been enrolled` };
  }
  const approver = { approver_role: approval.approver_role, approver_id: approval.approver_id };
  let enrolled = member;
  // Raised only from the level the sweep left them at: an admin who has set it by hand since
  // made the explicit choice this action exists to ask for.
  if (member.privilege_level === "external_collaborator") {
    const implied = privilegeForMemberTypeChange(member, member.member_type);
    if (implied && implied.privilege_level !== member.privilege_level) {
      const saved = deps.service.upsertLabMember(
        {
          id: member.id,
          privilege_level: implied.privilege_level,
          ...(implied.collaborator_subgroup
            ? { collaborator_subgroup: implied.collaborator_subgroup }
            : {}),
        } as AdminBotLabMemberInput,
        { source: "admin", actor: approval.approver_id },
      );
      if (!saved.ok) {
        return { handled: true, delivered: false, reason: saved.error.message };
      }
      enrolled = saved.payload;
    }
  }
  const result = await enrollNewMember(
    { ...deps, approver, actor: approval.approver_id },
    enrolled,
    { skipSheet: "the member was read from the sheet" },
  );
  return {
    handled: true,
    delivered: true,
    artifacts: {
      privilege_level: result.privilege_level.to,
      steps: result.steps.map((step) => `${step.step}:${step.status}`).join(", "),
    },
  };
}
