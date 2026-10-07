// Who belongs on a standing invite, and who is on it but should not be.
//
// Two surfaces, one rule set, because they differ in exactly one place: the lab calendar is for
// the lab, and the Monday group meeting additionally seats the external collaborators the lab
// treats as part of the group. Writing them as two functions would let that single difference
// drift into two different answers about the same person.
//
// Pure, like the rest of workflows/: this decides, the service proposes, an admin approves. Taking
// somebody off a calendar is visible to them and is not a thing a cron job should do on its own.
import {
  adminBotIsAlumniType,
  adminBotIsFullMemberType,
  type AdminBotLabMember,
} from "../../contracts/actions.js";
import { subgroupForMemberType, subgroupHoldsAccessItem } from "./collaborator-subgroups.js";

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

/**
 * Is this person one of the lab's own?
 *
 * Having left is checked first and wins outright. `privilege_level` says what somebody is allowed
 * to do and `status` says whether they are still here, and the spreadsheet keeps the former after
 * the latter changes — an alumnus keeps `member` forever. `member_type` carries a third, free-text
 * answer the onboarding sheet fills in, and its `alumni` token is read the same way.
 *
 * Past that gate the remaining signals are unioned rather than intersected; see below.
 */
function isFullMember(member: AdminBotLabMember): boolean {
  if (member.status === "alumni" || member.status === "external") {
    return false;
  }
  if (adminBotIsAlumniType(member.member_type)) {
    return false;
  }
  // Either signal is enough, deliberately. `meetingAudience` reads the `full` token from
  // `member_type` and the roster reads `privilege_level`; the two disagree on real rows, and the
  // union is the safe direction for a decision whose failure mode is uninviting somebody who
  // belongs. A person the two disagree about stays on the invite and someone fixes the roster.
  return (
    member.privilege_level === "member" ||
    member.privilege_level === "admin" ||
    adminBotIsFullMemberType(member.member_type)
  );
}

/**
 * Is this external collaborator one the access design seats on the standing invites?
 *
 * Read from the matrix's "Lab calendar and Monday Group Meeting" row
 * (workflows/members/collaborator-subgroups.ts) rather than from a list kept here, so the sheet's
 * answer -- own-pace advisees and major coauthors today -- is the only one. The subgroup comes from
 * the record when an admin set it and from the Member Type otherwise, the same precedence the
 * access audit grades with.
 */
function holdsStandingInvites(member: AdminBotLabMember): boolean {
  if (member.privilege_level !== "external_collaborator" || member.status === "alumni") {
    return false;
  }
  const subgroup = member.collaborator_subgroup ?? subgroupForMemberType(member.member_type);
  return subgroup !== undefined && subgroupHoldsAccessItem(subgroup, "lab_calendar_group_meeting");
}

/** Why this member does not belong here, phrased for the approval card. */
function removalReason(member: AdminBotLabMember): string {
  if (member.status === "alumni" || adminBotIsAlumniType(member.member_type)) {
    return "has left the lab";
  }
  if (member.status === "external") {
    return "is marked external";
  }
  if (member.privilege_level === "external_collaborator") {
    return `is an external collaborator (${member.collaborator_subgroup ?? "no subgroup"}), not an own-pace advisee or major coauthor`;
  }
  if (member.privilege_level === "trial") {
    return "is a trial member, not a full member";
  }
  return "is not a full member";
}

/**
 * Does this member belong on this surface at all?
 *
 * The two surfaces are one row of the access design, so the answer no longer depends on which one
 * is asked about. The parameter stays because every caller names the invite it is reconciling, and
 * a future row that splits them again should not have to change every call site.
 */
export function belongsOnSurface(
  member: AdminBotLabMember,
  _surface: AdminBotInviteSurface,
): boolean {
  return isFullMember(member) || holdsStandingInvites(member);
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
      // First writer wins: two roster rows sharing an address is a duplicate to resolve on the
      // roster, and picking arbitrarily here would make the plan depend on roster ordering.
      if (!byAddress.has(address)) {
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
