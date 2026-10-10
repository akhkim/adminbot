import { randomUUID } from "node:crypto";
import {
  protectedCalendarAttendee,
  type CalendarMembershipReader,
} from "../connectors/calendar-membership.js";
import type { AdminBotLabMember, AdminBotStoredProposal } from "../contracts/actions.js";
import { isActiveChannelEligible } from "./service.active-channels.js";
import type { AdminBotService, AdminBotServiceStore } from "./service.js";

function calendarEmails(members: readonly AdminBotLabMember[]) {
  return new Set(
    members
      .flatMap((member) => [member.calendar_email, member.email, member.correspondence_email])
      .filter((email): email is string => Boolean(email?.trim()))
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

export async function syncCalendarMembership(
  service: AdminBotService,
  store: Pick<AdminBotServiceStore, "listLabMembers">,
  calendarId: string,
  read: CalendarMembershipReader,
) {
  if (!calendarId.trim()) {
    throw new Error("Lab calendar is not configured");
  }
  if (!store.listLabMembers().length) {
    throw new Error("Refusing cleanup with an empty member database");
  }
  const events = await read(calendarId);
  const runId = randomUUID();
  const removed: Array<{ event_id: string; emails: string[]; proposal_id: string }> = [];
  const failed: Array<{ event_id: string; reason: string }> = [];
  for (const event of events) {
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
  return { removed, failed };
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
    [
      "calendar.add_attendees",
      "calendar.send_invite",
      "calendar.create_tentative_hold",
      "calendar.reschedule",
    ].includes(proposal.type) &&
    payload.calendar_id === calendarId
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
    (!members.length ||
      (Array.isArray(payload.removed_attendees) &&
        payload.removed_attendees.some(
          (email) => typeof email !== "string" || !ineligible.has(email.trim().toLowerCase()),
        )))
  ) {
    return { status: 409, message: "Calendar membership changed; run the membership sync again" };
  }
  return undefined;
}
