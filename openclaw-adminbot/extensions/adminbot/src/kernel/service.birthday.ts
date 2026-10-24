// Birthday calendar reconciliation, cut from service.ts so it stays under its file-size ratchet.
// The service still owns every write: proposals go through its createProposal/removePending, so
// the approval gate and the audit trail are unchanged.
import type {
  AdminBotActionProposal,
  AdminBotLabMember,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import { resolveLabCalendar } from "../workflows/calendar/lab-calendar.js";
import { birthdayEventPayload } from "../workflows/members/birthday.js";
import { isThemeMeetingEligible } from "../workflows/members/research-themes.js";
import type { AdminBotServiceStore } from "./service.js";

type BirthdayDeps = {
  store: Pick<AdminBotServiceStore, "listProposalsByType" | "getExecutionResult" | "getLabMember">;
  removePending: (actionId: string, request: { note: string }) => unknown;
  createProposal: (proposal: AdminBotActionProposal) => unknown;
};

/** Reconcile calendar proposals; external writes still require approval. */
export function reconcileBirthdayEvent(
  deps: BirthdayDeps,
  member: AdminBotLabMember,
  removed = false,
): void {
  const eligible = !removed && isThemeMeetingEligible(member) && Boolean(member.birthday?.trim());
  let current = false;
  for (const proposal of deps.store.listProposalsByType("calendar.create_birthday")) {
    if (proposal.target?.member_id !== member.id) {
      continue;
    }
    const cancellations = deps.store
      .listProposalsByType("calendar.cancel")
      .filter((cancel) => cancel.target?.birthday_action_id === proposal.id);
    if (
      eligible &&
      proposal.target?.birthday === member.birthday?.trim() &&
      proposal.status !== "rejected" &&
      !cancellations.some((cancel) => cancel.status !== "rejected")
    ) {
      current = true;
      continue;
    }
    if (proposal.status === "pending" || proposal.status === "approved") {
      deps.removePending(proposal.id, { note: "Birthday or membership changed." });
    }
    const execution = deps.store.getExecutionResult(proposal.id);
    const eventId = execution?.artifacts?.event_id;
    if (execution?.status === "executed" && eventId && cancellations.length === 0) {
      const payload = proposal.proposed_payload as Record<string, unknown>;
      deps.createProposal({
        type: "calendar.cancel",
        summary: `Remove ${member.name}'s previous birthday event`,
        target: { member_id: member.id, birthday_action_id: proposal.id },
        proposed_payload: {
          calendar_id: payload.calendar_id,
          event_id: eventId,
          ...(payload.account ? { account: payload.account } : {}),
        },
        rationale: "The birthday changed, was cleared, or the member is no longer eligible.",
        idempotency_key: `birthday-remove:${proposal.id}`,
      });
    }
  }
  if (!eligible || current) {
    return;
  }
  const payload = birthdayEventPayload(member, resolveLabCalendar().id, new Date());
  if (!payload) {
    return;
  }
  const name = member.preferred_name?.trim() || member.name.trim();
  deps.createProposal({
    type: "calendar.create_birthday",
    summary: `Add ${name}'s birthday to the lab calendar`,
    target: { member_id: member.id, birthday: member.birthday?.trim() ?? "" },
    proposed_payload: payload,
    rationale: "A full or major coauthor member supplied their optional birthday.",
    undo_plan: "Delete the recurring event from the lab calendar.",
  });
}

/**
 * Whether a proposal may still execute: anything but a birthday event may; a birthday event only
 * while it matches an eligible member's current birthday.
 */
export function birthdayProposalStillCurrent(
  store: Pick<AdminBotServiceStore, "getLabMember">,
  proposal: AdminBotStoredProposal,
): boolean {
  if (proposal.type !== "calendar.create_birthday") {
    return true;
  }
  const member = store.getLabMember(String(proposal.target?.member_id ?? ""));
  return Boolean(
    member &&
    isThemeMeetingEligible(member) &&
    member.birthday?.trim() &&
    member.birthday.trim() === proposal.target?.birthday,
  );
}

/**
 * After a birthday event executes, re-run reconciliation so a member who changed or left while it
 * was in flight gets the matching cancellation. A member already gone is stood in by a stub.
 */
export function reconcileExecutedBirthday(
  deps: BirthdayDeps,
  proposal: AdminBotStoredProposal,
  now: string,
): void {
  if (proposal.type !== "calendar.create_birthday") {
    return;
  }
  const memberId = String(proposal.target?.member_id ?? "");
  const member = deps.store.getLabMember(memberId);
  reconcileBirthdayEvent(
    deps,
    member ?? {
      id: memberId,
      name: memberId,
      privilege_level: "external_collaborator",
      access: [],
      created_at: now,
      updated_at: now,
    },
    !member,
  );
}
