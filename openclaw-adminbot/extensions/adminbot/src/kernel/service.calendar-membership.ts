import { randomUUID } from "node:crypto";
import {
  protectedCalendarAttendee,
  type CalendarMembershipReader,
  type CalendarAccessReader,
  type CalendarAccessRule,
} from "../connectors/calendar-membership.js";
import type { AdminBotLabMember, AdminBotStoredProposal } from "../contracts/actions.js";
import { groupMeetingSeriesId, resolveGroupMeetingEventId } from "../contracts/group-meeting.js";
import { adminBotCalendarShareEmail } from "../contracts/member-outreach-email.js";
import { isActiveChannelEligible } from "./service.active-channels.js";
import type { AdminBotService, AdminBotServiceStore } from "./service.js";

function calendarEmails(members: readonly AdminBotLabMember[]) {
  return new Set(
    members
      .flatMap((member) => [member.calendar_email, member.email, member.correspondence_email])
      // A hand-filled field can hold two addresses ("a@uni.ca / b@gmail.com"); match each one.
      .flatMap((value) => (value ?? "").split(/[/,;\s]+/u))
      .filter((email) => email.includes("@"))
      .map((email) => email.trim().toLowerCase()),
  );
}

export function ineligibleCalendarEmails(members: readonly AdminBotLabMember[]) {
  const eligible = calendarEmails(members.filter(isActiveChannelEligible));
  // Preserve ambiguous addresses shared with an eligible member, and external guests.
  return new Set(
    [...calendarEmails(members.filter((member) => !isActiveChannelEligible(member)))].filter(
      (email) => !eligible.has(email),
    ),
  );
}

export function isRestrictedCalendarEvent(eventId: unknown, recurringEventId?: string): boolean {
  // Google creates a new series for "this and following" edits to the Monday meeting.
  const base = (id: string) => groupMeetingSeriesId(id).replace(/(?:_R\d{8}T\d{6}Z?)+$/u, "");
  return (
    typeof eventId === "string" &&
    base(recurringEventId || eventId) === base(resolveGroupMeetingEventId())
  );
}

export async function syncCalendarMembership(
  service: AdminBotService,
  store: Pick<AdminBotServiceStore, "listLabMembers">,
  calendarId: string,
  read: CalendarMembershipReader,
  readAccess: CalendarAccessReader,
) {
  if (!calendarId.trim()) {
    throw new Error("Lab calendar is not configured");
  }
  if (!store.listLabMembers().length) {
    throw new Error("Refusing cleanup with an empty member database");
  }
  const [events, access] = await Promise.all([read(calendarId), readAccess(calendarId)]);
  const runId = randomUUID();
  const removed: Array<{ event_id: string; emails: string[]; proposal_id: string }> = [];
  const failed: Array<{ event_id: string; reason: string }> = [];
  for (const event of events.filter((candidate) =>
    isRestrictedCalendarEvent(candidate.id, candidate.recurringEventId),
  )) {
    const members = store.listLabMembers();
    if (!members.length) {
      throw new Error("Refusing cleanup with an empty member database");
    }
    const ineligible = ineligibleCalendarEmails(members);
    const emails = [
      ...new Set(
        event.attendees
          .filter(
            (attendee) =>
              !protectedCalendarAttendee(event, attendee, calendarId) &&
              ineligible.has(attendee.email.trim().toLowerCase()),
          )
          .map((attendee) => attendee.email),
      ),
    ];
    if (!emails.length) {
      continue;
    }
    const key = `calendar-membership:${runId}:${calendarId}:${event.id}`;
    const proposed = service.createProposal({
      type: "calendar.remove_attendees",
      summary: `Remove ineligible attendees from lab calendar event ${event.id}`,
      target: { service: "calendar", target: event.id },
      proposed_payload: {
        calendar_id: calendarId,
        event_id: event.id,
        ...(event.recurringEventId ? { meeting_series: event.recurringEventId } : {}),
        removed_attendees: emails,
        membership_filter: true,
      },
      idempotency_key: key,
      undo_plan: "Re-invite the removed attendees.",
    });
    if (!proposed.ok) {
      throw new Error(proposed.error.message);
    }
    const approved = service.approve(proposed.payload.id, {
      payload_hash: proposed.payload.payload_hash,
      approver_role: "admin",
      approver_id: "system:weekly-calendar-membership-policy",
      note: "Standing policy: remove known members other than full members and major coauthors. Preserve eligible alumni, unmatched external guests, organizers and resources.",
    });
    const result = approved.ok
      ? await service.execute(proposed.payload.id, { dry_run: false, idempotency_key: key })
      : approved;
    if (!result.ok) {
      failed.push({ event_id: event.id, reason: result.error.message });
    } else if (result.payload.status !== "executed") {
      failed.push({ event_id: event.id, reason: "Removal was not delivered" });
    } else {
      removed.push({ event_id: event.id, emails, proposal_id: proposed.payload.id });
    }
  }
  const revoked: Array<{ rule_id: string; email: string; proposal_id: string }> = [];
  for (const rule of access) {
    if (
      rule.role === "owner" ||
      rule.role === "none" ||
      rule.scope.type !== "user" ||
      !rule.scope.value ||
      rule.scope.value.toLowerCase() === calendarId.toLowerCase() ||
      !ineligibleCalendarEmails(store.listLabMembers()).has(rule.scope.value.trim().toLowerCase())
    ) {
      continue;
    }
    const proposed = service.createProposal({
      type: "calendar.revoke_lab_calendar",
      summary: "Remove known ineligible member's lab calendar subscription access",
      target: { service: "calendar", target: rule.id },
      proposed_payload: { calendar_id: calendarId, rule_id: rule.id, email: rule.scope.value },
      idempotency_key: `calendar-access:${runId}:${rule.id}`,
      undo_plan: "Restore the member's calendar sharing access after approval.",
    });
    if (!proposed.ok) {
      throw new Error(proposed.error.message);
    }
    const approved = service.approve(proposed.payload.id, {
      payload_hash: proposed.payload.payload_hash,
      approver_role: "admin",
      approver_id: "system:weekly-calendar-membership-policy",
      note: "Remove known ineligible members' direct calendar access; preserve owners and unmatched accounts.",
    });
    const result = approved.ok
      ? await service.execute(proposed.payload.id, { dry_run: false })
      : approved;
    if (!result.ok || result.payload.status !== "executed") {
      failed.push({
        event_id: `acl:${rule.id}`,
        reason: result.ok ? "Revocation was not delivered" : result.error.message,
      });
    } else {
      revoked.push({ rule_id: rule.id, email: rule.scope.value, proposal_id: proposed.payload.id });
    }
  }
  // The other half: every eligible member's Google account on the calendar's sharing list. Read
  // from the ACL itself rather than the audit trail, so a grant that went to an address the member
  // cannot open, or a Calendar email changed since, is repaired instead of counted as done.
  const granted: Array<{ member_id: string; email: string; proposal_id: string }> = [];
  const needsGmail: Array<{ member_id: string; name: string }> = [];
  for (const member of store.listLabMembers().filter(isActiveChannelEligible)) {
    const email = adminBotCalendarShareEmail(member);
    if (!email) {
      needsGmail.push({ member_id: member.id, name: member.name });
      continue;
    }
    if (hasLabCalendarAccess(access, email)) {
      continue;
    }
    const result = await grantLabCalendarAccess(
      service,
      member,
      email,
      `calendar-share:${runId}:${member.id}`,
    );
    if (result.ok) {
      granted.push({ member_id: member.id, email, proposal_id: result.proposal_id });
    } else {
      failed.push({ event_id: `acl-grant:${member.id}`, reason: result.reason });
    }
  }
  return { removed, revoked, granted, needs_gmail: needsGmail, failed };
}

/** Whether the sharing list already lets this address read the calendar's events. */
export function hasLabCalendarAccess(access: readonly CalendarAccessRule[], email: string) {
  const address = email.trim().toLowerCase();
  return access.some(
    (rule) =>
      // A writer without private access still reads every non-private event, so no grant is due.
      ["reader", "writerWithoutPrivateAccess", "writer", "owner"].includes(rule.role) &&
      (rule.scope.type === "default" ||
        (rule.scope.type === "user" && rule.scope.value?.trim().toLowerCase() === address)),
  );
}

/**
 * Share the lab calendar with one eligible member, under the standing access policy.
 *
 * The same typed `calendar.grant_lab_calendar` action an admin approves by hand, approved by the
 * policy actor because "full members and major coauthors can read the lab calendar" is already the
 * rule -- and `calendarMembershipWriteError` re-checks eligibility at execute time regardless.
 */
export async function grantLabCalendarAccess(
  service: AdminBotService,
  member: AdminBotLabMember,
  email: string,
  idempotencyKey: string,
): Promise<{ ok: true; proposal_id: string } | { ok: false; reason: string }> {
  const proposed = service.createProposal({
    type: "calendar.grant_lab_calendar",
    summary: `Give ${member.name || member.id} view access to the lab calendar`,
    target: { service: "calendar", channel: "calendar", target: email },
    proposed_payload: { email, member_id: member.id },
    idempotency_key: idempotencyKey,
    undo_plan: "Remove the address in the lab calendar's sharing settings.",
  });
  if (!proposed.ok) {
    return { ok: false, reason: proposed.error.message };
  }
  const approved = service.approve(proposed.payload.id, {
    payload_hash: proposed.payload.payload_hash,
    approver_role: "admin",
    approver_id: "system:lab-calendar-access-policy",
    note: "Standing policy: full members and major coauthors can read the lab calendar with their Google account.",
  });
  const result = approved.ok
    ? await service.execute(proposed.payload.id, {
        dry_run: false,
        idempotency_key: idempotencyKey,
      })
    : approved;
  if (!result.ok) {
    return { ok: false, reason: result.error.message };
  }
  return result.payload.status === "executed"
    ? { ok: true, proposal_id: proposed.payload.id }
    : { ok: false, reason: "Calendar access was not granted" };
}

export function calendarMembershipWriteError(
  proposal: AdminBotStoredProposal,
  members: readonly AdminBotLabMember[],
  calendarId: string,
): { status: number; message: string } | undefined {
  const payload = proposal.proposed_payload as Record<string, unknown> | undefined;
  if (!payload) {
    return undefined;
  }
  const ineligible = ineligibleCalendarEmails(members);
  if (
    proposal.type === "calendar.grant_lab_calendar" &&
    (typeof payload.email !== "string" ||
      !calendarEmails(members.filter(isActiveChannelEligible)).has(
        payload.email.trim().toLowerCase(),
      ) ||
      ineligible.has(payload.email.trim().toLowerCase()))
  ) {
    return {
      status: 403,
      message: "Calendar subscription requires a full member or major coauthor",
    };
  }
  if (
    proposal.type === "calendar.revoke_lab_calendar" &&
    (payload.calendar_id !== calendarId ||
      typeof payload.email !== "string" ||
      !ineligible.has(payload.email.trim().toLowerCase()))
  ) {
    return { status: 409, message: "Calendar membership changed; run the membership sync again" };
  }
  if (
    [
      "calendar.add_attendees",
      "calendar.send_invite",
      "calendar.create_tentative_hold",
      "calendar.reschedule",
    ].includes(proposal.type) &&
    payload.calendar_id === calendarId &&
    isRestrictedCalendarEvent(payload.event_id)
  ) {
    ineligible.delete(calendarId.trim().toLowerCase());
    const attendees = Array.isArray(payload.attendees)
      ? payload.attendees
      : typeof payload.attendees === "string"
        ? payload.attendees.split(",")
        : [];
    if (
      attendees.some(
        (email) => typeof email !== "string" || ineligible.has(email.trim().toLowerCase()),
      )
    ) {
      return {
        status: 403,
        message:
          "Known lab members invited to the lab calendar must be full members or major coauthors",
      };
    }
  }
  if (
    proposal.type === "calendar.remove_attendees" &&
    payload.membership_filter === true &&
    (!isRestrictedCalendarEvent(
      payload.event_id,
      typeof payload.meeting_series === "string" ? payload.meeting_series : undefined,
    ) ||
      payload.calendar_id !== calendarId ||
      !members.length ||
      (Array.isArray(payload.removed_attendees) &&
        payload.removed_attendees.some(
          (email) => typeof email !== "string" || !ineligible.has(email.trim().toLowerCase()),
        )))
  ) {
    return { status: 409, message: "Calendar membership changed; run the membership sync again" };
  }
  return undefined;
}
