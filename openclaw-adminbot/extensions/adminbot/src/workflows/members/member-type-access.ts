/**
 * What changes about somebody's access when their Member Type changes.
 *
 * `member_type` is the lab's own statement of what a person is, and almost everything downstream
 * reads it: who stays on the lab calendar and the Monday meeting (`surface-membership.ts`), who may
 * sign in to the portal (`adminBotHasPortalAccess`), and which row of the External Collab Access
 * Design matrix they are graded against (`collaborator-subgroups.ts`). Changing the column is
 * therefore an access decision, and until now nothing said out loud what it decided -- the effects
 * appeared one sweep at a time, hours apart, with no single place that could answer "what does
 * moving this person from `full` to `alumni` actually do to them".
 *
 * This is that place. It is a *diff*, not an actuator: it reports what somebody gains and loses, and
 * the service turns the losses into proposals an admin approves. Nothing here writes anything.
 *
 * Every answer is computed from the existing predicates rather than restated, deliberately. A
 * second copy of "who belongs on the calendar" would drift from the one that sends the invites, and
 * the drift would be invisible -- both would keep answering, just differently.
 */
import {
  adminBotHasPortalAccess,
  type AdminBotExternalCollaboratorSubgroup,
  type AdminBotLabMember,
} from "../../contracts/actions.js";
import {
  ADMINBOT_ACTIVE_CHANNELS,
  ADMINBOT_FRIENDS_CHANNELS,
  resolveSubgroup,
} from "./access-audit.js";
import {
  collaboratorSubgroupAccess,
  type AdminBotCollaboratorAccessItemId,
  type AdminBotCollaboratorGrant,
} from "./collaborator-subgroups.js";
import { belongsOnSurface, type AdminBotInviteSurface } from "./surface-membership.js";

/**
 * The access items that correspond to a standing Slack room, and which rooms.
 *
 * Only these two rows of the matrix name a channel somebody can be added to or taken out of. The
 * rest are documents, mailing lists, spreadsheet rows and human courtesies -- real access, but not
 * anything a `conversations.kick` can revoke, so a sync that pretended otherwise would file
 * proposals that cannot execute.
 */
const CHANNELS_BY_ACCESS_ITEM: Partial<
  Record<AdminBotCollaboratorAccessItemId, readonly string[]>
> = {
  slack_connect_friends_channel: ADMINBOT_FRIENDS_CHANNELS,
  active_channels: ADMINBOT_ACTIVE_CHANNELS,
};

/** Whether a surface or a grant is newly held, newly gone, or the same as it was. */
export type AccessTransition = "gained" | "lost" | "unchanged";

/**
 * The portal has a third answer, and it is not a shade of the other two.
 *
 * `adminBotHasPortalAccess` returns `undefined` for a member type it has never been told about, and
 * 94 of the roster's 200 rows carry no type at all. Collapsing that to "lost" would revoke sign-in
 * from everybody whose row is blank; collapsing it to "unchanged" would hide a real revocation
 * behind a typo in the spreadsheet. So an unknown answer stays unknown and a person resolves it.
 */
export type PortalTransition = AccessTransition | "unknown";

export type MemberTypeAccessProfile = {
  member_type?: string;
  subgroup?: AdminBotExternalCollaboratorSubgroup;
  /** How the subgroup was arrived at; `full_member` and `unknown` carry no subgroup. */
  subgroup_source: "record" | "member_type" | "full_member" | "unknown";
  /** `undefined` when the roster cannot say -- see PortalTransition. */
  portal?: boolean;
  lab_calendar: boolean;
  group_meeting: boolean;
  /** Matrix rows this person is entitled to, in matrix order. Empty for a full member. */
  grants: AdminBotCollaboratorGrant[];
};

/**
 * Everything this member's type entitles them to right now.
 *
 * `memberType` overrides the stored value so the same function answers for the type somebody has
 * and the type the spreadsheet is about to give them; that is the whole mechanism behind the diff
 * below, and it is why the surface predicates are asked about a *hypothetical* member record rather
 * than about the stored one.
 *
 * A full member gets no matrix grants, and that is not a gap. The External Collab Access Design
 * describes external collaborators; a full member is entitled to more than any row of it, not less,
 * which is why `subgroup_source` reports `full_member` rather than leaving the caller to infer the
 * empty list means "nothing".
 */
export function memberTypeAccessProfile(
  member: AdminBotLabMember,
  memberType: string | undefined = member.member_type,
): MemberTypeAccessProfile {
  // The type is the only field varied. Everything else -- privilege level, status, subgroup --
  // stays as stored, because this answers "what does the column change", not "what if this were a
  // different person".
  const hypothetical: AdminBotLabMember = {
    ...member,
    ...(memberType === undefined ? {} : { member_type: memberType }),
  };
  const resolved = resolveSubgroup(hypothetical);
  return {
    ...(memberType === undefined ? {} : { member_type: memberType }),
    ...(resolved.subgroup ? { subgroup: resolved.subgroup } : {}),
    subgroup_source: resolved.source,
    ...(adminBotHasPortalAccess(memberType) === undefined
      ? {}
      : { portal: adminBotHasPortalAccess(memberType) }),
    lab_calendar: belongsOnSurface(hypothetical, "lab_calendar"),
    group_meeting: belongsOnSurface(hypothetical, "group_meeting"),
    grants: resolved.subgroup ? collaboratorSubgroupAccess(resolved.subgroup) : [],
  };
}

export type MemberTypeAccessDelta = {
  before: MemberTypeAccessProfile;
  after: MemberTypeAccessProfile;
  lab_calendar: AccessTransition;
  group_meeting: AccessTransition;
  portal: PortalTransition;
  /**
   * The record names a subgroup outright, so the matrix rows do not follow `member_type`.
   *
   * `resolveSubgroup` reads `collaborator_subgroup` first and falls back to the member-type token
   * only when the record has none -- an admin who set the field explicitly outranks a spreadsheet
   * column, which is the right precedence and not something this sync should change. But it means a
   * type change on such a member moves no matrix row, and a summary that just reported "no
   * consequences" would read as "nothing to do" when the truth is "the answer came from somewhere
   * else". Flagged so a person can decide whether the pinned subgroup is still right.
   */
  subgroup_pinned: boolean;
  /** Matrix rows they are entitled to now and were not before. */
  granted: AdminBotCollaboratorGrant[];
  /** Matrix rows they were entitled to and no longer are. These are what get revoked. */
  revoked: AdminBotCollaboratorGrant[];
  /**
   * Standing Slack rooms the revoked rows cover, deduplicated.
   *
   * A room is only listed when *no* surviving grant still covers it: `slack_connect_friends_channel`
   * and `active_channels` can both be lost while another row the person keeps names the same room,
   * and removing them from it would then be wrong. Checked against what they keep rather than
   * against what they lose, which is the direction that fails safe.
   */
  slack_channels_to_remove: string[];
  /** Rooms a newly granted row covers and no previous row did. Never acted on automatically. */
  slack_channels_to_add: string[];
};

function transition(before: boolean, after: boolean): AccessTransition {
  if (before === after) {
    return "unchanged";
  }
  return after ? "gained" : "lost";
}

function portalTransition(
  before: boolean | undefined,
  after: boolean | undefined,
): PortalTransition {
  if (before === undefined || after === undefined) {
    return "unknown";
  }
  return transition(before, after);
}

function channelsFor(grants: readonly AdminBotCollaboratorGrant[]): Set<string> {
  const channels = new Set<string>();
  for (const grant of grants) {
    for (const channel of CHANNELS_BY_ACCESS_ITEM[grant.item] ?? []) {
      channels.add(channel);
    }
  }
  return channels;
}

/**
 * What one member-type change does to one person.
 *
 * The two profiles are computed the same way, from the same predicates, so a change that touches
 * nothing reports nothing -- which is the common case and the reason this can run over the whole
 * roster every night without producing a wall of proposals. "alumni, coauthor-minor" to
 * "coauthor-minor" is a real revocation; "full" to "full, coauthor-major" mostly is not.
 */
export function memberTypeAccessDelta(
  member: AdminBotLabMember,
  nextMemberType: string | undefined,
): MemberTypeAccessDelta {
  const before = memberTypeAccessProfile(member);
  const after = memberTypeAccessProfile(member, nextMemberType);
  const heldBefore = new Set(before.grants.map((grant) => grant.item));
  const heldAfter = new Set(after.grants.map((grant) => grant.item));
  const granted = after.grants.filter((grant) => !heldBefore.has(grant.item));
  const revoked = before.grants.filter((grant) => !heldAfter.has(grant.item));

  const kept = channelsFor(after.grants);
  const had = channelsFor(before.grants);
  return {
    before,
    after,
    lab_calendar: transition(before.lab_calendar, after.lab_calendar),
    group_meeting: transition(before.group_meeting, after.group_meeting),
    portal: portalTransition(before.portal, after.portal),
    subgroup_pinned: before.subgroup_source === "record",
    granted,
    revoked,
    slack_channels_to_remove: [...channelsFor(revoked)].filter((channel) => !kept.has(channel)),
    slack_channels_to_add: [...channelsFor(granted)].filter((channel) => !had.has(channel)),
  };
}

/** Whether a delta is worth telling anybody about. */
export function hasAccessConsequences(delta: MemberTypeAccessDelta): boolean {
  return (
    delta.lab_calendar !== "unchanged" ||
    delta.group_meeting !== "unchanged" ||
    (delta.portal !== "unchanged" && delta.portal !== "unknown") ||
    delta.granted.length > 0 ||
    delta.revoked.length > 0
  );
}

/** The surfaces a member has lost, named for an approval card or a sweep summary. */
export function lostSurfaces(delta: MemberTypeAccessDelta): AdminBotInviteSurface[] {
  const surfaces: AdminBotInviteSurface[] = [];
  if (delta.lab_calendar === "lost") {
    surfaces.push("lab_calendar");
  }
  if (delta.group_meeting === "lost") {
    surfaces.push("group_meeting");
  }
  return surfaces;
}
