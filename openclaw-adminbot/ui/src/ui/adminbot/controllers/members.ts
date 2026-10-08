// The lab roster: own profile and schedule writes, administrator edits, requests, overviews.
//
// Controller for this zone: loads through api/members.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import {
  deleteLabMemberAsAdmin,
  fetchMembersWithoutEmail,
  type MemberProfileUpdate,
  type MemberScheduleUpdate,
  mergeLabMembersAsAdmin,
  purgeMembersWithoutEmailAsAdmin,
  updateOwnProfile,
  updateOwnSchedule,
  upsertLabMemberAsAdmin,
} from "../api/members.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import { describeMemberTypeChange } from "../data/member-type-change.ts";
import {
  ADMINBOT_SERVICE_UNREACHABLE_MESSAGE,
  type AdminBotExternalCollaboratorSubgroup,
  type AdminBotHost,
  type AdminBotLabMember,
  type AdminBotMemberStatus,
  type AdminBotPrivilegeLevel,
  formatAdminBotToolError,
  invokeAdminBotTool,
  loadAdminBot,
  loadAdminBotStandingMeetings,
  onboardSavedMember,
  serializeMemberSave,
} from "./admin.ts";

export type AdminBotLabMemberSaveInput = {
  id: string;
  // Optional so an emptied name box saves the rest of the form: omitted, the service keeps the
  // stored name on an existing record instead of rejecting the whole save.
  name?: string;
  email?: string;
  slackUserId?: string;
  privilegeLevel?: AdminBotPrivilegeLevel;
  collaboratorSubgroup?: AdminBotExternalCollaboratorSubgroup;
  notes?: string;
  status?: AdminBotMemberStatus;
  /**
   * What the roster spreadsheet says this person is ("full", "alumni, coauthor-major").
   *
   * Governance, like privilege and status -- only an admin session may write it -- and the field
   * onboarding routes on: `templateForMemberType` picks the guide from the most-committed token
   * here, so a record saved without one has no onboarding mail to send.
   */
  memberType?: string;
  /**
   * Standing meetings to be on, by id, from the Meetings checkboxes. Undefined when the list did
   * not load -- which must send nothing, since an empty list means "take them off every meeting".
   */
  meetings?: string[];
  /**
   * Whether AdminBot may send this person anything at all.
   *
   * Governance, and spelled out here rather than carried in the profile bag for the same reason
   * privilege and status are: it is not a fact about the person, it is a decision the lab made
   * about them, and only an admin session may write it.
   */
  receivesNudges?: boolean;
  /**
   * Every profile field the roster editor collected, already in the service's wire shape.
   *
   * One bag rather than a camelCase key per field, and this is the change that keeps the Lab
   * Members editor and the Profile page in step: both render from the shared member field
   * registry (ui/src/ui/adminbot/member-fields.ts), whose keys *are* the wire names, so a new
   * field needs no entry here and no line in `adminMemberUpdatePayload`. The previous shape
   * named fifteen fields in camelCase and mapped each one back by hand, which is how the editor
   * came to be missing eleven of the fields the profile page already had.
   *
   * Governance stays above, spelled out: privilege, status, email and the collaborator subgroup
   * are not profile facts, only an admin session may write them, and they should be visible in
   * this type rather than hidden inside a generic bag.
   *
   * No `availability` in here either way. The stored schedule is a list of rows the service
   * validates as one (validateAvailability in extensions/adminbot/src/kernel/service.ts), written
   * from the Time Availability tab; this form has no schedule control at all. It used to carry a
   * free-text `availability` string, which every save sent as "" and the service rejected with
   * 400 "member availability must be a list" — the whole edit lost to a field nobody could see.
   */
  profile?: Record<string, unknown>;
};

function adminMemberUpdatePayload(member: AdminBotLabMemberSaveInput) {
  return {
    ...(member.name ? { name: member.name } : {}),
    ...(member.email ? { email: member.email } : {}),
    ...(member.slackUserId ? { slack_user_id: member.slackUserId } : {}),
    ...(member.privilegeLevel ? { privilege_level: member.privilegeLevel } : {}),
    ...(member.collaboratorSubgroup ? { collaborator_subgroup: member.collaboratorSubgroup } : {}),
    ...(member.notes ? { notes: member.notes } : {}),
    ...(member.status ? { status: member.status } : {}),
    ...(member.memberType ? { member_type: member.memberType } : {}),
    // `!== undefined`, not truthiness: [] is "on no meetings", which is an answer.
    ...(member.meetings !== undefined ? { meetings: member.meetings } : {}),
    // `!== undefined`, not truthiness: `false` is how somebody is taken *off* the list, and a
    // truthiness check would silently turn every removal into a no-op.
    ...(member.receivesNudges !== undefined ? { receives_nudges: member.receivesNudges } : {}),
    // Last, so a governance field can never be overwritten by a profile key of the same name.
    // The service re-checks every key against its own whitelist regardless.
    ...member.profile,
  };
}

/**
 * The registry fields the break-glass gateway tool can carry, renamed to its camelCase parameters.
 *
 * Narrower than the HTTP path on purpose, and narrower than it looks: `adminbot_upsert_lab_member`
 * declares a fixed parameter object (extensions/adminbot/index.ts), so a key it does not name is
 * rejected rather than ignored. Fields outside this map are simply not settable over the legacy
 * token path -- which is the same restriction that path already had, now stated in one place
 * instead of being implied by which lines somebody remembered to write.
 */
const TOOL_PROFILE_PARAMS: Record<string, string> = {
  role: "role",
  research_branch: "researchBranch",
  research_topics: "researchTopics",
  projects: "projects",
  hours_per_week: "hoursPerWeek",
  location: "location",
  affiliation: "affiliation",
  timezone: "timezone",
  personal_website: "personalWebsite",
  openreview_id: "openreviewId",
};

function toolProfileParams(profile: Record<string, unknown> | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile ?? {})) {
    const param = TOOL_PROFILE_PARAMS[key];
    if (param !== undefined) {
      params[param] = value;
    }
  }
  return params;
}

// Saves a member from the Lab Members admin editor. Governance fields (privilege_level,
// status, email) can only ever be set by a genuine admin *member Bearer session* — the
// gateway-RPC tool path (adminbot_upsert_lab_member) always authenticates as the shared
// service principal regardless of who is signed in, and that principal is deliberately
// restricted to the same whitelist as a plain self-edit (the fix that closed the
// chat-based privilege-escalation hole). So a signed-in admin's edits here go straight to
// the AdminBot HTTP service with their own session token, bypassing the gateway tool
// entirely. Falls back to the gateway tool only when there's no stored member session at
// all (legacy break-glass access via the bare gateway token, predating member auth) —
// that path keeps today's already-restricted behavior rather than losing the save entirely.
/**
 * Saves a roster record, and -- when the form asked for it -- puts the member through onboarding.
 *
 * Onboarding runs after the save rather than with it, and only on the Add-member form, because it
 * is a different question: the record is a fact about the roster, the guide is a mail to a person.
 * The service files it as an approval-gated `onboarding.send_guide` proposal, so what happens here
 * is queueing, not sending.
 *
 * A refused guide never fails the save -- the member is on the roster either way -- but it is
 * reported as an error notice, because the admin ticked a box for something that did not happen
 * and the reason (no address, a Member Type that sends no mail, a guide already queued) is usually
 * a thing they can fix.
 */
export async function saveAdminBotMember(
  host: AdminBotHost,
  member: AdminBotLabMemberSaveInput,
  options: {
    onboard?: boolean;
    background?: boolean;
    create?: boolean;
    slackChannels?: string[];
  } = {},
): Promise<boolean> {
  if (!options.background) host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (stored) {
    const result = await upsertLabMemberAsAdmin(
      member.id,
      adminMemberUpdatePayload(member),
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
      options.create,
    );
    if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
      return false;
    }
    if (!result.ok) {
      const message =
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : result.kind === "rate-limited"
              ? "Too many attempts. Wait a moment and try again."
              : // A validation refusal names the value it rejected ("member role must be one of:
                // ..."); the generic line below cannot, and the whole record is sent on every save,
                // so without the service's own sentence one bad field reads as the editor being
                // broken. Same reasoning as saveAdminBotOwnProfile.
                (result.message ?? "Couldn't save this member. Check the values and try again.");
      host.adminBotNotice = { kind: "error", text: message };
      return false;
    }
    if (options.background) return true;
    const savedId = result.value.id || member.id;
    // A Member Type change is applied on the spot -- access level, sheet, rooms, meeting -- and the
    // notice says what each of those did rather than a bare "saved".
    const typeChange = result.value.member_type_change;
    const meetingChanges = result.value.meeting_changes;
    let notice = options.onboard
      ? await onboardSavedMember(host, savedId, stored.sessionToken, options.slackChannels)
      : typeChange || meetingChanges?.length
        ? describeMemberTypeChange(savedId, typeChange, meetingChanges)
        : { kind: "success" as const, text: `Saved member ${savedId}.` };
    if (options.onboard && (typeChange || meetingChanges?.length)) {
      const changes = describeMemberTypeChange(savedId, typeChange, meetingChanges);
      notice = {
        kind: changes.kind === "error" ? "error" : notice.kind,
        text: `${notice.text} ${changes.text}`,
      };
    }
    if (meetingChanges?.length) {
      // The calendar moved; the checkboxes must be re-read from it rather than from the last load.
      void loadAdminBotStandingMeetings(host).finally(() => host.requestUpdate?.());
    }
    if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
      return false;
    }
    host.adminBotNotice = notice;
    await loadAdminBot(host);
    return true;
  }
  if (options.create) {
    host.adminBotNotice = { kind: "error", text: "Sign in with an admin account to add a member." };
    return false;
  }
  const startingClient = host.client;
  const gatewaySaveIsCurrent = () =>
    loadStoredMemberSession() === null && host.client === startingClient;
  try {
    await invokeAdminBotTool(host, "adminbot_upsert_lab_member", {
      id: member.id,
      ...(member.name ? { name: member.name } : {}),
      ...(member.email ? { email: member.email } : {}),
      ...(member.slackUserId ? { slackUserId: member.slackUserId } : {}),
      ...(member.privilegeLevel ? { privilegeLevel: member.privilegeLevel } : {}),
      ...(member.collaboratorSubgroup ? { collaboratorSubgroup: member.collaboratorSubgroup } : {}),
      ...(member.notes ? { notes: member.notes } : {}),
      ...(member.status ? { status: member.status } : {}),
      ...toolProfileParams(member.profile),
    });
    if (!gatewaySaveIsCurrent()) return false;
    if (options.background) return true;
    // The break-glass path cannot onboard: queueing a guide needs an admin member session, and
    // this one is the shared service principal, which the route refuses. Said out loud rather
    // than dropped, so a tick nobody acted on is not mistaken for one that worked.
    host.adminBotNotice = options.onboard
      ? {
          kind: "error",
          text: `Saved member ${member.id}, but onboarding needs an admin sign-in — sign in with your admin account and start it from their row.`,
        }
      : { kind: "success", text: `Saved member ${member.id}.` };
    await loadAdminBot(host);
    return true;
  } catch (err) {
    if (gatewaySaveIsCurrent()) {
      host.adminBotNotice = {
        kind: "error",
        text: formatAdminBotToolError(err),
      };
    }
  }
  return false;
}

/**
 * Folds one roster row into another and retires it.
 *
 * Member session only, and no gateway-tool fallback: unlike a save, there is no narrower version
 * of this that the shared service principal could safely perform, and the service refuses it to
 * that principal anyway. Break-glass access simply does not offer the affordance.
 *
 * The notice names what the merge could not decide. A conflict is not an error -- the survivor's
 * answer stands, which is what the admin asked for by choosing which record survives -- but it is
 * the one thing about a merge nobody can see afterwards, so it is said out loud once.
 */
export async function mergeAdminBotMembers(
  host: AdminBotHost,
  survivorId: string,
  duplicateId: string,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your admin account to merge roster records.",
    };
    return;
  }
  const result = await mergeLabMembersAsAdmin(
    survivorId,
    duplicateId,
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (!result.ok) {
    host.adminBotNotice = {
      kind: "error",
      text:
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : (result.message ?? "Couldn't merge those records."),
    };
    return;
  }
  const conflicts = result.value.conflicts ?? [];
  host.adminBotNotice = {
    kind: "success",
    text: conflicts.length
      ? `Merged ${duplicateId} into ${survivorId}. Kept ${survivorId}'s answer for ${conflicts
          .map((conflict) => conflict.field)
          .join(", ")}.`
      : `Merged ${duplicateId} into ${survivorId}.`,
  };
  await loadAdminBot(host);
}

/**
 * Deletes one roster row outright.
 *
 * Member session only and no gateway-tool fallback, for the reason the merge gives -- with the
 * difference that this keeps nothing, so the confirmation is the caller's job before it gets here.
 *
 * A 409 is surfaced as itself rather than retried with `force`. The service refuses an account
 * somebody can still sign in to, and the whole value of that refusal is that clearing it is a
 * second human decision; a UI that resent the call with force would have made the guard
 * decorative.
 */
export async function deleteAdminBotMember(
  host: AdminBotHost,
  memberId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your admin account to delete roster records.",
    };
    return;
  }
  const result = await deleteLabMemberAsAdmin(
    memberId,
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
    options,
  );
  if (!result.ok) {
    host.adminBotNotice = {
      kind: "error",
      text:
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : (result.message ?? "Couldn't delete that record."),
    };
    return;
  }
  const removed = Object.values(result.value.removed ?? {}).reduce(
    (total, count) => total + count,
    0,
  );
  host.adminBotNotice = {
    kind: "success",
    text: removed
      ? `Deleted ${result.value.deleted_name}, and ${removed} row${removed === 1 ? "" : "s"} that named them.`
      : `Deleted ${result.value.deleted_name}.`,
  };
  await loadAdminBot(host);
}

/**
 * Loads the address-less roster rows so the page can show them before anything is deleted.
 *
 * Kept separate from the purge so the preview is a plain read: an admin looking at this list has
 * not yet asked for anything to happen, and a preview that mutated to tell you what it would do
 * is the thing this whole flow is built to avoid.
 */
export async function loadAdminBotMembersWithoutEmail(host: AdminBotHost): Promise<{
  deletable: Array<{ id: string; name: string; attached_rows: number }>;
  blocked: Array<{ id: string; name: string; reason: string }>;
} | null> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your admin account to review roster records.",
    };
    return null;
  }
  const result = await fetchMembersWithoutEmail(
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (!result.ok) {
    host.adminBotNotice = {
      kind: "error",
      text:
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : (result.message ?? "Couldn't read the roster."),
    };
    return null;
  }
  return result.value;
}

/**
 * Deletes every member the lab holds no address for.
 *
 * `dryRun` is the default at all three layers -- here, in the client and in the service -- so the
 * press that deletes is always the one that said so.
 *
 * The notice names the blocked rows rather than only the deleted ones. On this roster the row with
 * no address and a working credential is the shared `admin` login, and an admin who is told "37
 * deleted" without being told "1 kept, it can still sign in" has been given the wrong picture of
 * what their roster now is.
 */
export async function purgeAdminBotMembersWithoutEmail(
  host: AdminBotHost,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your admin account to delete roster records.",
    };
    return;
  }
  const dryRun = options.dryRun !== false;
  const result = await purgeMembersWithoutEmailAsAdmin(
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
    { dryRun },
  );
  if (!result.ok) {
    host.adminBotNotice = {
      kind: "error",
      text:
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : (result.message ?? "Couldn't delete those records."),
    };
    return;
  }
  const { deleted, blocked } = result.value;
  const kept = blocked.length
    ? ` ${blocked.length} kept: ${blocked.map((row) => `${row.name} (${row.reason})`).join("; ")}.`
    : "";
  host.adminBotNotice = {
    kind: "success",
    text: dryRun
      ? `${deleted.length} member${deleted.length === 1 ? "" : "s"} have no email on file and would be deleted.${kept}`
      : `Deleted ${deleted.length} member${deleted.length === 1 ? "" : "s"} with no email on file.${kept}`,
  };
  if (!dryRun) {
    await loadAdminBot(host);
  }
}

// Saves the signed-in member's own roster row from the Lab Members table. Uses the
// self-edit endpoint (PUT /lab/members/:id with a member Bearer session), whose server-side
// whitelist drops governance fields — so a plain member editing their own row can never
// reach the admin write path. Requires a real member session; break-glass gateway-token-only
// access has no signed-in member and never renders this affordance.
export async function saveAdminBotOwnProfile(
  host: AdminBotHost,
  memberId: string,
  fields: MemberProfileUpdate,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your member account to edit your profile.",
    };
    return;
  }
  return serializeMemberSave(
    host,
    JSON.stringify(["profile", stored.sessionToken, memberId]),
    async () => {
      if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
        return;
      }
      host.adminBotNotice = null;
      const result = await updateOwnProfile(
        memberId,
        fields,
        stored.sessionToken,
        resolveAdminBotBaseUrl(host.settings),
      );
      if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
        return;
      }
      if (!result.ok) {
        const message =
          result.kind === "unreachable"
            ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
            : result.kind === "rate-limited"
              ? "Too many attempts. Wait a moment and try again."
              : (result.message ??
                "Couldn't save your profile. Sign in again, check the values, and retry.");
        host.adminBotNotice = { kind: "error", text: message };
        return;
      }
      host.adminBotNotice = { kind: "success", text: "Saved your profile." };
      const updated = result.value as AdminBotLabMember;
      host.adminBotData = {
        ...host.adminBotData,
        members: host.adminBotData.members.map((member) =>
          member.id === memberId ? { ...member, ...updated } : member,
        ),
      };
      if (host.adminBotMemberList) {
        host.adminBotMemberList = {
          ...host.adminBotMemberList,
          rows: host.adminBotMemberList.rows.map((member) =>
            member.id === memberId ? { ...member, ...updated } : member,
          ),
        };
      }
    },
  );
}

/**
 * Replaces the signed-in member's own schedule lists with `patch`.
 *
 * Whole lists are sent, not deltas: each stored field is a list the service validates as one, so
 * add and remove are both "write the list you want". The caller composes them. An omitted list is
 * left untouched.
 *
 * Writing another member's schedule is not possible: the service routes a self session to its own
 * record only. Same posture as saveAdminBotOwnProfile — the UI never offers the editor on anyone
 * else's row, and a 403 folds into the generic failure below because reaching it means a stale
 * session rather than a case worth its own copy.
 */
export async function saveAdminBotOwnSchedule(
  host: AdminBotHost,
  memberId: string,
  patch: MemberScheduleUpdate,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your member account to edit your schedule.",
    };
    return;
  }
  const result = await updateOwnSchedule(
    memberId,
    patch,
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (!result.ok) {
    const message =
      result.kind === "unreachable"
        ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
        : result.kind === "rate-limited"
          ? "Too many attempts. Wait a moment and try again."
          : // The service rejects an out-of-range date or an hours value outside 0–168 with a 400;
            // the form validates the same things first, so reaching here means a stale session or
            // a rule the form does not know about yet.
            "Couldn't save your schedule. Check the dates and hours, then retry.";
    host.adminBotNotice = { kind: "error", text: message };
    return;
  }
  host.adminBotNotice = { kind: "success", text: "Saved your schedule." };
  // No paper read, whichever scope (lab or own) this session has loaded: a schedule is
  // availability, time off, milestones, trips and dismissed deadlines on the member record, and
  // GET /papers is drawn from the paper store alone, so nothing it returns can have changed. The
  // papers already on screen stay as they are -- loadAdminBot leaves them and their stamps alone
  // when it is told not to include them.
  await loadAdminBot(host, "admin", false);
}
