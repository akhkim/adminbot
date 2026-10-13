// Subscription and Monday meeting access share the full/major membership policy.
// Unknown guest addresses remain untouched; automatic cleanup is separately audited.
import { adminBotIsFullMemberType, type AdminBotLabMember } from "../../contracts/actions.js";
import { subgroupForMemberType } from "./collaborator-subgroups.js";

/** The standing invites this sweep knows how to reconcile. */
export type AdminBotInviteSurface = "lab_calendar" | "group_meeting";

export type AdminBotSurfaceRemoval = {
  /** The address as it appears on the invite, so the caller can match it back exactly. */
  email: string;
  member_id: string;
  member_name: string;
  /** Why they no longer belong, in the words the approval card shows. */
  reason: string;
};

export type AdminBotSurfaceMembershipPlan = {
  /** Every address that stays, including the ones no roster row explains. */
  keep: string[];
  remove: AdminBotSurfaceRemoval[];
  /**
   * Addresses on the invite that match nobody on the roster.
   *
   * Kept, never removed, and reported instead. An unrecognized address is far more likely to be a
   * guest speaker, a room resource, or somebody whose calendar address differs from the one on
   * file than it is to be a mistake — and the cost of guessing wrong is uninviting a real person
   * from a real meeting. Somebody reads this list; nothing acts on it.
   */
  unrecognized: string[];
};

const normalize = (email: string): string => email.trim().toLowerCase();

/** Every address the roster knows for a member. A calendar invite may carry any of them. */
function addressesOf(member: AdminBotLabMember): string[] {
  return [member.email, member.calendar_email, member.correspondence_email]
    .map((email) => (email ? normalize(email) : ""))
    .filter(Boolean);
}

function removalReason(_member: AdminBotLabMember): string {
  return "is not a full member or major coauthor";
}

export function belongsOnSurface(
  member: AdminBotLabMember,
  _surface: AdminBotInviteSurface,
): boolean {
  if (member.collaborator_subgroup) {
    return member.collaborator_subgroup === "coauthor_major";
  }
  return (
    adminBotIsFullMemberType(member.member_type) ||
    subgroupForMemberType(member.member_type) === "coauthor_major"
  );
}

/**
 * Reconcile one standing invite against the roster.
 *
 * Takes the addresses currently on the invite and returns what should remain, who should come off,
 * and what could not be explained. It never invents attendees: somebody who belongs but is missing
 * is not this function's problem, because adding people to a meeting and removing them are
 * different decisions with different blast radii.
 *
 * `keep` is returned in full rather than as a diff because `gog calendar update` has no
 * remove-attendee flag — the only way to drop somebody is to write the whole attendee list back.
 * A proposal therefore has to carry the exact list it intends to leave behind, which is also the
 * list an approver should be reading before they say yes.
 */
export function surfaceMembershipPlan(params: {
  members: readonly AdminBotLabMember[];
  attendees: readonly string[];
  surface: AdminBotInviteSurface;
}): AdminBotSurfaceMembershipPlan {
  const { members, attendees, surface } = params;
  const byAddress = new Map<string, AdminBotLabMember>();
  for (const member of members) {
    for (const address of addressesOf(member)) {
      // A shared address stays if any matching member is eligible.
      if (!byAddress.has(address) || belongsOnSurface(member, surface)) {
        byAddress.set(address, member);
      }
    }
  }

  const keep: string[] = [];
  const remove: AdminBotSurfaceRemoval[] = [];
  const unrecognized: string[] = [];
  const seen = new Set<string>();

  for (const raw of attendees) {
    const email = raw.trim();
    if (!email) {
      continue;
    }
    const key = normalize(email);
    // An invite listing the same person twice must not produce two removals of one address.
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const member = byAddress.get(key);
    if (!member) {
      unrecognized.push(email);
      keep.push(email);
      continue;
    }
    if (belongsOnSurface(member, surface)) {
      keep.push(email);
      continue;
    }
    remove.push({
      email,
      member_id: member.id,
      member_name: member.name,
      reason: removalReason(member),
    });
  }

  return { keep, remove, unrecognized };
}
