// Who a roster row is: folding two rows into one person, and re-keying one person under a new id.
//
// Both rewrite every row that names a member, so they share the store surface below. Kept apart
// from service.ts, which delegates to these, so that file can stay under its size ratchet.
import type { AdminBotAuditEvent, AdminBotLabMember } from "../contracts/actions.js";
import { type MemberMergeConflict, planMemberMerge } from "../contracts/member-duplicates.js";
import type { AdminBotServiceResponse, AdminBotServiceStore } from "./service.js";

export type AdminBotMemberRenameStore = {
  /**
   * Re-keys one member under a new id everywhere the database names them, returning what changed
   * per `table.column`.
   *
   * Not `reassignMemberReferences` with a fresh row: that list is the rows a *merge* should move,
   * and it leaves papers, settings, requests and every JSON payload naming the old id alone. A
   * rename that did the same would detach the person from their own papers. Throws -- and changes
   * nothing -- if any row would collide with one already keyed on the new id.
   */
  renameMemberId(fromMemberId: string, toMemberId: string): Record<string, number>;
};

type MemberIdentityStore = Pick<
  AdminBotServiceStore,
  | "getLabMember"
  | "saveLabMember"
  | "reassignMemberReferences"
  | "revokeSessionsForMember"
  | "deleteLabMember"
  | "renameMemberId"
>;

type RecordAudit = (event: Omit<AdminBotAuditEvent, "id" | "timestamp">) => void;

export type MemberMergeParams = { survivorId: string; duplicateId: string; actorId: string };

export type MemberRenameParams = { memberId: string; newId: string; actorId: string };

// What an admin may rename a member *to*. Narrower than the ids already on the roster on purpose:
// the id is spliced into URLs and matched as a JSON string by the rename sweep, so it stays plain.
// `mem_` ids from self-signup still pass, so a rename is never forced to be a "tidy" one.
const MEMBER_ID_PATTERN = /^(?=.{1,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*$/u;

function serviceError<T>(status: number, message: string): AdminBotServiceResponse<T> {
  return { ok: false, status, error: { message } };
}

/**
 * Fold one roster row into another and retire it.
 *
 * The lab's two ingestion paths -- the Quick-Start survey and the Slack member export -- write
 * different halves of the same person under different ids, so "Terry Jingchen Zhang" holds the
 * career detail and "Terry Zhang" holds the Slack id and the address. Neither page shows the
 * whole person, and every count that walks the roster counts them twice.
 *
 * Three things happen, in this order, and the order matters:
 *
 *   1. the survivor gains everything only the duplicate knew (planMemberMerge; a disagreement
 *      is kept as the survivor's answer and reported, never silently resolved)
 *   2. every row that named the duplicate is repointed at the survivor, including the login
 *      credential -- if the survivor has none of their own
 *   3. the duplicate's sessions are revoked and the row is deleted
 *
 * Reversible only from the audit line, which is why that line carries the whole retired record
 * rather than its id: undoing a merge means re-creating it, and a merge is easy to regret when
 * two people really do share a name.
 */
export function mergeLabMembersIn(
  store: MemberIdentityStore,
  recordAudit: RecordAudit,
  params: MemberMergeParams,
): AdminBotServiceResponse<{
  member: AdminBotLabMember;
  conflicts: MemberMergeConflict[];
  moved: Record<string, number>;
}> {
  if (params.survivorId === params.duplicateId) {
    return serviceError(400, "a member cannot be merged into themselves");
  }
  const survivor = store.getLabMember(params.survivorId);
  if (!survivor) {
    return serviceError(404, "member not found");
  }
  const duplicate = store.getLabMember(params.duplicateId);
  if (!duplicate) {
    return serviceError(404, "duplicate member not found");
  }
  const now = new Date().toISOString();
  const { patch, conflicts } = planMemberMerge(
    survivor as unknown as Record<string, unknown>,
    duplicate as unknown as Record<string, unknown>,
  );
  const merged: AdminBotLabMember = {
    ...survivor,
    ...(patch as Partial<AdminBotLabMember>),
    id: survivor.id,
    updated_at: now,
  };
  store.saveLabMember(merged);
  const moved = store.reassignMemberReferences(params.duplicateId, params.survivorId);
  store.revokeSessionsForMember(params.duplicateId, now);
  store.deleteLabMember(params.duplicateId);
  recordAudit({
    type: "lab_member.merged",
    actor: params.actorId,
    details: {
      survivor_id: params.survivorId,
      duplicate_id: params.duplicateId,
      moved,
      conflicts,
      // The whole retired record: a merge has no undo, and an id alone would not be enough to
      // put back what was folded in.
      retired_record: duplicate,
    },
  });
  return { ok: true, status: 200, payload: { member: merged, conflicts, moved } };
}

/**
 * Give one member a new id, carrying everything that named the old one.
 *
 * The id is the key papers, sessions, credentials and settings hold, which is why the editor
 * keeps it read-only -- and also why a bad one (a generated `mem_<uuid>`, a typo from an import)
 * is worth fixing once rather than living with. Sessions move with it rather than being revoked
 * as a merge's are: a merge judges that two records are one person and can be wrong, a rename
 * is the same person under a new key, so signing them out would cost a login and buy nothing.
 */
export function renameLabMemberIn(
  store: MemberIdentityStore,
  recordAudit: RecordAudit,
  params: MemberRenameParams,
): AdminBotServiceResponse<{ member: AdminBotLabMember; changed: Record<string, number> }> {
  const newId = params.newId.trim();
  if (!MEMBER_ID_PATTERN.test(newId)) {
    return serviceError(
      400,
      "a member id is lowercase letters and digits, joined by single hyphens or underscores (at most 64 characters)",
    );
  }
  if (newId === params.memberId) {
    return serviceError(400, "that is already this member's id");
  }
  const member = store.getLabMember(params.memberId);
  if (!member) {
    return serviceError(404, "member not found");
  }
  if (store.getLabMember(newId)) {
    return serviceError(409, `member id "${newId}" is already taken`);
  }
  let changed: Record<string, number>;
  try {
    changed = store.renameMemberId(params.memberId, newId);
  } catch (error) {
    // A constraint failure means some table already holds a row keyed on the new id -- a leftover
    // from a deleted or merged member. The store rolled back, so nothing moved.
    return serviceError(
      409,
      `could not move every record to "${newId}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const renamed = store.getLabMember(newId);
  if (!renamed) {
    // The sweep re-keys the roster row like any other; reaching here means it did not.
    return serviceError(500, "the member record did not move to the new id");
  }
  recordAudit({
    type: "lab_member.id_changed",
    actor: params.actorId,
    details: { from_id: params.memberId, to_id: newId, name: member.name, changed },
  });
  return { ok: true, status: 200, payload: { member: renamed, changed } };
}
