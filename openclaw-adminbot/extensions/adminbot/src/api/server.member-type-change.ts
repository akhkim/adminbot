/**
 * A Member Type changed on the Lab Members tab, applied on the spot.
 *
 * Changing somebody's type is re-onboarding them without the welcome mail: their access level moves
 * with it, and the rooms and meetings that follow from the new type are joined or left. The admin's
 * save is the approval, the same rule Add row uses (see `approveAndExecute`), so every external step
 * is still a typed proposal, approved by that admin, executed and audited -- just not left waiting
 * in Pending Actions.
 *
 * One mail is sent, and only in one case: somebody moving *into* alumni gets the alumni guide.
 * Every other step is silent -- Slack channel moves notify inside Slack only, calendar writes pass
 * `--send-updates none`, and the lab-calendar share suppresses Google's notification.
 *
 * Each step is reported on its own and none stops the others: the database write has already
 * happened, and a Slack outage should not also leave the Monday meeting unreconciled.
 */
import {
  adminBotIsAlumniType,
  type AdminBotAuditEvent,
  type AdminBotLabMember,
} from "../contracts/actions.js";
import type { AdminBotService } from "../kernel/service.js";
import {
  type AdminBotStandingMeeting,
  memberAddresses,
  planMeetingMembership,
} from "../workflows/calendar/standing-meetings.js";
import {
  hasAccessConsequences,
  memberAccessDelta,
} from "../workflows/members/member-type-access.js";
import type { CalendarInviteRunner } from "../workflows/onboarding/calendar-invite.js";
import { templateForMemberType } from "../workflows/onboarding/member-type-template.js";
import {
  approveAndExecute,
  type MemberSheetApprover,
  type MemberSheetSource,
  writeMemberTypeToSheet,
} from "./server.member-sheet.js";

export type MemberTypeChangeStep = {
  step: "sheet" | "slack" | "group_meeting" | "lab_calendar" | "alumni_mail" | "meeting";
  /** The channel, series or address the step was about. */
  target?: string;
  status: "done" | "skipped" | "failed";
  detail?: string;
  proposal_id?: string;
};

export type MemberTypeChangeResult = {
  from?: string;
  to?: string;
  privilege_level: { from: string; to: string };
  collaborator_subgroup: { from?: string; to?: string };
  steps: MemberTypeChangeStep[];
};

export type MemberTypeChangeDeps = {
  service: AdminBotService;
  approver: MemberSheetApprover;
  actor: string;
  memberSheet?: MemberSheetSource;
  /** The live Monday series, or why it could not be read. */
  readGroupMeeting?: () => Promise<
    | { calendarId: string; seriesId: string; targets: string[] }
    | { error: { status: number; message: string } }
  >;
  inviteToLabCalendar?: CalendarInviteRunner;
  /**
   * Leave the Monday meeting to the Meetings checkboxes: the admin ticked or unticked it in the
   * same save, and that explicit answer outranks what the type would have implied.
   */
  skipGroupMeeting?: boolean;
  /** Writes one audit row; the id and timestamp are the caller's to stamp. */
  recordAudit: (event: Pick<AdminBotAuditEvent, "type" | "actor" | "details">) => void;
};

/** The Google identity to invite: an ACL or a guest slot is granted to a Google account. */
function calendarAddress(member: AdminBotLabMember): string | undefined {
  return (
    (member.calendar_email ?? member.email ?? member.correspondence_email)?.trim() || undefined
  );
}

async function runAction(
  deps: Pick<MemberTypeChangeDeps, "service" | "approver">,
  step: MemberTypeChangeStep["step"],
  target: string,
  proposal: Parameters<AdminBotService["createProposal"]>[0],
): Promise<MemberTypeChangeStep> {
  const created = deps.service.createProposal(proposal);
  if (!created.ok) {
    return { step, target, status: "failed", detail: created.error.message };
  }
  const ran = await approveAndExecute(deps.service, created.payload, deps.approver);
  return ran.ok
    ? { step, target, status: "done", proposal_id: created.payload.id }
    : { step, target, status: "failed", detail: ran.reason, proposal_id: created.payload.id };
}

/**
 * Carry out what moving `before` to `after` means for this person, outside the database.
 *
 * `after` is the record as saved, so the access level, subgroup and type it reflects are the ones
 * that were actually stored -- including an admin's explicit Privilege choice in the same save.
 */
export async function applyMemberTypeChange(
  deps: MemberTypeChangeDeps,
  before: AdminBotLabMember,
  after: AdminBotLabMember,
): Promise<MemberTypeChangeResult> {
  const delta = memberAccessDelta(before, after);
  const steps: MemberTypeChangeStep[] = [];
  const label = after.name || after.id;
  const typeNote = `member type ${before.member_type?.trim() || "unset"} -> ${
    after.member_type?.trim() || "unset"
  }`;

  // 1. The sheet, first: until it agrees, the nightly roster sync would put the old type back.
  if (!deps.memberSheet) {
    steps.push({ step: "sheet", status: "skipped", detail: "no member spreadsheet configured" });
  } else {
    try {
      const written = await writeMemberTypeToSheet(
        deps.service,
        deps.memberSheet,
        after,
        deps.approver,
        deps.actor,
      );
      steps.push(
        written.status === "done"
          ? {
              step: "sheet",
              target: `row ${written.sheet_row}`,
              status: "done",
              proposal_id: written.proposal_id,
            }
          : {
              step: "sheet",
              status: written.status,
              detail: written.reason,
              ...(written.status === "failed" && written.proposal_id
                ? { proposal_id: written.proposal_id }
                : {}),
            },
      );
    } catch (error) {
      steps.push({
        step: "sheet",
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 2. Slack rooms the access matrix names. Invites and removals both notify inside Slack only.
  const channelMoves = [
    ...delta.slack_channels_to_remove.map((channel) => ({ channel, remove: true })),
    ...delta.slack_channels_to_add.map((channel) => ({ channel, remove: false })),
  ];
  const slackUserId = after.slack_user_id?.trim();
  if (channelMoves.length > 0 && !slackUserId) {
    steps.push({
      step: "slack",
      status: "skipped",
      detail: "no linked Slack account, so there is no one to add or remove",
    });
  }
  for (const move of slackUserId ? channelMoves : []) {
    steps.push(
      await runAction(deps, "slack", `#${move.channel}`, {
        type: move.remove ? "slack.remove_from_channel" : "slack.invite_to_channel",
        summary: `${move.remove ? "Remove" : "Add"} ${label} ${move.remove ? "from" : "to"} #${
          move.channel
        } (${typeNote})`,
        target: {
          service: "slack",
          channel: "slack",
          target: move.channel,
          recipientMemberId: after.id,
        },
        proposed_payload: { channel: move.channel, user_id: slackUserId },
        undo_plan: move.remove
          ? "Invite the member back to the channel."
          : "Remove the member from the channel.",
      }),
    );
  }

  // 3. The Monday group meeting, unless the same save set it explicitly.
  if (delta.group_meeting !== "unchanged" && !deps.skipGroupMeeting) {
    const meeting = deps.readGroupMeeting
      ? await deps.readGroupMeeting()
      : { error: { status: 503, message: "calendar reading is not configured" } };
    if ("error" in meeting) {
      steps.push({ step: "group_meeting", status: "failed", detail: meeting.error.message });
    } else if (delta.group_meeting === "lost") {
      steps.push(
        await runAction(deps, "group_meeting", meeting.seriesId, {
          type: "calendar.remove_attendees",
          summary: `Remove ${label} from the Monday group meeting (${typeNote})`,
          target: { service: "calendar", channel: "calendar", target: meeting.targets[0] ?? "" },
          proposed_payload: {
            calendar_id: meeting.calendarId,
            event_id: meeting.targets[0],
            event_ids: meeting.targets,
            meeting_series: meeting.seriesId,
            // Every address on file: the executor subtracts whichever the live guest list carries.
            removed_attendees: memberAddresses(before),
          },
          undo_plan: "Re-invite the member with calendar.add_attendees.",
        }),
      );
    } else {
      const address = calendarAddress(after);
      if (!address) {
        steps.push({ step: "group_meeting", status: "skipped", detail: "no address on file" });
      }
      for (const eventId of address ? meeting.targets : []) {
        steps.push(
          await runAction(deps, "group_meeting", eventId, {
            type: "calendar.add_attendees",
            summary: `Add ${label} to the Monday group meeting (${typeNote})`,
            target: { service: "calendar", channel: "calendar", target: eventId },
            proposed_payload: {
              calendar_id: meeting.calendarId,
              event_id: eventId,
              attendees: [address],
            },
            undo_plan: "Remove the member with calendar.remove_attendees.",
          }),
        );
      }
    }
  }

  // 4. Read access to the lab calendar. Granted silently; there is no typed action that revokes a
  //    calendar share, so a loss is reported for somebody to act on rather than guessed at.
  if (delta.lab_calendar === "gained") {
    const address = calendarAddress(after);
    if (!address || !deps.inviteToLabCalendar) {
      steps.push({
        step: "lab_calendar",
        status: "skipped",
        detail: address ? "the lab calendar is not configured" : "no address on file",
      });
    } else {
      try {
        await deps.inviteToLabCalendar(address);
        deps.recordAudit({
          type: "auth.calendar_invite_sent",
          actor: deps.actor,
          details: { member_id: after.id, email: address, reason: typeNote },
        });
        steps.push({ step: "lab_calendar", target: address, status: "done" });
      } catch (error) {
        steps.push({
          step: "lab_calendar",
          target: address,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else if (delta.lab_calendar === "lost") {
    steps.push({
      step: "lab_calendar",
      status: "skipped",
      detail:
        "calendar shares are not revoked automatically; remove them in the lab calendar's sharing settings if needed",
    });
  }

  // 5. The one mail: moving into alumni. Only when alumni is what decides their template -- a row
  //    that is also `full` would otherwise be sent the alumni farewell while still in the lab.
  if (!adminBotIsAlumniType(before.member_type) && adminBotIsAlumniType(after.member_type)) {
    const template = templateForMemberType(after.member_type);
    if (!template.ok || template.templateId !== "alumni") {
      steps.push({
        step: "alumni_mail",
        status: "skipped",
        detail: template.ok
          ? `their type onboards as ${template.templateId}, not alumni`
          : template.reason,
      });
    } else {
      const queued = deps.service.queueOnboardingGuideForMember({
        memberId: after.id,
        actor: deps.actor,
      });
      if (!queued.ok) {
        steps.push({ step: "alumni_mail", status: "failed", detail: queued.error.message });
      } else {
        const guide = deps.service.getProposal(queued.payload.proposal_id);
        const sent = guide
          ? await approveAndExecute(deps.service, guide, deps.approver)
          : { ok: false as const, reason: `proposal ${queued.payload.proposal_id} vanished` };
        steps.push(
          sent.ok
            ? {
                step: "alumni_mail",
                target: queued.payload.email,
                status: "done",
                proposal_id: queued.payload.proposal_id,
              }
            : {
                step: "alumni_mail",
                target: queued.payload.email,
                status: "failed",
                detail: sent.reason,
                proposal_id: queued.payload.proposal_id,
              },
        );
      }
    }
  }

  deps.recordAudit({
    type: "lab_member.member_type_applied",
    actor: deps.actor,
    details: {
      member_id: after.id,
      from: before.member_type ?? "",
      to: after.member_type ?? "",
      privilege_from: before.privilege_level,
      privilege_to: after.privilege_level,
      consequential: hasAccessConsequences(delta),
      steps: steps.map((entry) => `${entry.step}:${entry.status}`),
    },
  });

  return {
    ...(before.member_type === undefined ? {} : { from: before.member_type }),
    ...(after.member_type === undefined ? {} : { to: after.member_type }),
    privilege_level: { from: before.privilege_level, to: after.privilege_level },
    collaborator_subgroup: {
      ...(before.collaborator_subgroup ? { from: before.collaborator_subgroup } : {}),
      ...(after.collaborator_subgroup ? { to: after.collaborator_subgroup } : {}),
    },
    steps,
  };
}

/**
 * Put a member on exactly the standing meetings the admin ticked, and take them off the rest.
 *
 * Like the type change above, the save is the approval: each add or removal is a typed calendar
 * proposal approved by this admin and executed now. Both are silent (`--send-updates none`). An
 * add goes to every live series of the meeting, so a meeting split "this and following" is joined
 * on the split that actually has Mondays ahead.
 */
export async function applyMeetingSelection(
  deps: Pick<MemberTypeChangeDeps, "service" | "approver">,
  member: AdminBotLabMember,
  calendarId: string,
  meetings: readonly AdminBotStandingMeeting[],
  selected: readonly string[],
): Promise<MemberTypeChangeStep[]> {
  const plan = planMeetingMembership(meetings, member, selected);
  const steps: MemberTypeChangeStep[] = [];
  const label = member.name || member.id;
  const address = calendarAddress(member);
  for (const meeting of plan.add) {
    if (!address) {
      steps.push({
        step: "meeting",
        target: meeting.title,
        status: "skipped",
        detail: "no address on file",
      });
      continue;
    }
    for (const eventId of meeting.event_ids) {
      steps.push(
        await runAction(deps, "meeting", meeting.title, {
          type: "calendar.add_attendees",
          summary: `Add ${label} to ${meeting.title}`,
          target: { service: "calendar", channel: "calendar", target: eventId },
          proposed_payload: { calendar_id: calendarId, event_id: eventId, attendees: [address] },
          undo_plan: "Remove the member with calendar.remove_attendees.",
        }),
      );
    }
  }
  for (const meeting of plan.remove) {
    steps.push(
      await runAction(deps, "meeting", meeting.title, {
        type: "calendar.remove_attendees",
        summary: `Remove ${label} from ${meeting.title}`,
        target: { service: "calendar", channel: "calendar", target: meeting.event_ids[0] ?? "" },
        proposed_payload: {
          calendar_id: calendarId,
          event_id: meeting.event_ids[0],
          event_ids: meeting.event_ids,
          meeting_series: meeting.id,
          removed_attendees: memberAddresses(member),
        },
        undo_plan: "Re-invite the member with calendar.add_attendees.",
      }),
    );
  }
  return steps;
}
