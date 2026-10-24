/**
 * Applies a Slack roster sync plan (workflows/members/slack-roster-sync.ts) to the store.
 *
 * Record changes go through upsertLabMember as an `import`, so provenance and the after-write hooks
 * run exactly as for any other write. Removals are never performed here: each one is filed as a
 * `lab_member.remove` proposal and left pending for an admin. Do-not-contact records are not
 * written at all.
 */
import type {
  AdminBotActionProposal,
  AdminBotAuditEvent,
  AdminBotLabMember,
  AdminBotLabMemberInput,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import {
  planSlackRosterSync,
  slackRosterSyncRefusal,
  type SlackDirectoryReader,
  type SlackRosterRemoval,
  type SlackRosterSyncPlan,
} from "../workflows/members/slack-roster-sync.js";
import type { AdminBotWriteOrigin } from "../workflows/members/adoption.js";
import type { AdminBotServiceResponse } from "./service.js";

export type SlackRosterSyncPorts = {
  listLabMembers(): AdminBotLabMember[];
  listProposalsByType(type: "lab_member.remove"): AdminBotStoredProposal[];
  upsertLabMember(
    member: AdminBotLabMemberInput,
    origin: AdminBotWriteOrigin,
  ): AdminBotServiceResponse<AdminBotLabMember>;
  createProposal(proposal: AdminBotActionProposal): AdminBotServiceResponse<AdminBotStoredProposal>;
  recordAudit(event: Omit<AdminBotAuditEvent, "id" | "timestamp">): void;
};

export type SlackRosterSyncOptions = {
  actor: string;
  dryRun?: boolean;
  /** Apply a plan that tripped the size guard. For an admin who has looked at the Slack read. */
  force?: boolean;
  placeholderIds?: ReadonlySet<string>;
  now?: Date;
};

export type SlackRosterSyncReport = SlackRosterSyncPlan & {
  applied: { created: number; updated: number; deactivated: number; reactivated: number };
  proposals: { member_id: string; proposal_id: string; status: string }[];
  failed: { member_id: string; reason: string }[];
  slack_users: number;
  roster_size: number;
  dry_run: boolean;
  refused?: string;
  synced_at: string;
};

export function slackRosterRemovalKey(removal: SlackRosterRemoval): string {
  return `slack-roster-placeholder:${removal.member_id}:${removal.slack_user_id || "none"}`;
}

export async function runSlackRosterSync(
  ports: SlackRosterSyncPorts,
  read: SlackDirectoryReader,
  options: SlackRosterSyncOptions,
): Promise<AdminBotServiceResponse<SlackRosterSyncReport>> {
  const members = ports.listLabMembers();
  // Every Slack read finishes before anything is written; a partial workspace is not people leaving.
  const users = await read();
  if (users.length === 0) {
    return {
      ok: false,
      status: 422,
      error: {
        message:
          "Slack users.list returned no accounts -- refusing to sync the roster against an empty read",
      },
    };
  }
  const now = (options.now ?? new Date()).toISOString();
  const plan = planSlackRosterSync({
    users,
    members,
    ...(options.placeholderIds ? { placeholderIds: options.placeholderIds } : {}),
    now,
  });
  const refused = options.force ? undefined : slackRosterSyncRefusal(plan, members.length);
  const applied = { created: 0, updated: 0, deactivated: 0, reactivated: 0 };
  const proposals: SlackRosterSyncReport["proposals"] = [];
  const failed: SlackRosterSyncReport["failed"] = [];
  const origin: AdminBotWriteOrigin = { source: "import", actor: options.actor };
  const write = (memberId: string, patch: AdminBotLabMemberInput) => {
    const saved = ports.upsertLabMember(patch, origin);
    if (!saved.ok) {
      failed.push({ member_id: memberId, reason: saved.error.message });
    }
    return saved.ok;
  };
  const byId = new Map(members.map((member) => [member.id, member]));

  if (!refused && !options.dryRun) {
    for (const create of plan.creates) {
      if (write(create.member.id, create.member)) {
        applied.created += 1;
      }
    }
    const reactivated = new Set(plan.reactivations.map((row) => row.member_id));
    for (const update of plan.updates) {
      const existing = byId.get(update.member_id);
      if (!existing) {
        failed.push({ member_id: update.member_id, reason: "member not found" });
        continue;
      }
      // A patch: `name` is resent from the stored record (it is required by the input type) unless
      // this update is the one changing it, so a sync of avatars cannot rename anybody.
      const patch: AdminBotLabMemberInput = { id: existing.id, name: existing.name };
      for (const change of update.changes) {
        patch[change.field] = change.to;
      }
      if (reactivated.delete(existing.id)) {
        patch.slack_deactivated_at = "";
        applied.reactivated += 1;
      }
      if (write(existing.id, patch)) {
        applied.updated += 1;
      }
    }
    for (const memberId of reactivated) {
      const existing = byId.get(memberId);
      if (existing && write(memberId, { id: memberId, name: existing.name, slack_deactivated_at: "" })) {
        applied.reactivated += 1;
      }
    }
    for (const row of plan.deactivations) {
      const existing = byId.get(row.member_id);
      if (
        existing &&
        write(row.member_id, { id: row.member_id, name: existing.name, slack_deactivated_at: now })
      ) {
        applied.deactivated += 1;
      }
    }
    for (const removal of plan.removals) {
      const filed = proposeRemoval(ports, removal);
      if ("error" in filed) {
        failed.push({ member_id: removal.member_id, reason: filed.error });
      } else {
        proposals.push({ member_id: removal.member_id, ...filed });
      }
    }
  }

  ports.recordAudit({
    type: "slack_roster_sync.completed",
    actor: options.actor,
    details: {
      slack_users: users.length,
      roster_size: members.length,
      creates: plan.creates.length,
      updates: plan.updates.length,
      deactivations: plan.deactivations.length,
      reactivations: plan.reactivations.length,
      removals_proposed: plan.removals.length,
      opted_out: plan.opted_out.length,
      skipped: plan.skipped.length,
      conflicts: plan.conflicts.length,
      unchanged: plan.unchanged,
      failed: failed.length,
      dry_run: options.dryRun === true,
      ...(refused ? { refused } : {}),
    },
  });

  return {
    ok: true,
    status: 200,
    payload: {
      ...plan,
      applied,
      proposals,
      failed,
      slack_users: users.length,
      roster_size: members.length,
      dry_run: options.dryRun === true,
      ...(refused ? { refused } : {}),
      synced_at: now,
    },
  };
}

/**
 * Files one removal, once. A pending, approved, executed or rejected proposal under the same key
 * means this record was already put to an admin, so a daily re-run adds nothing -- and a rejection
 * stays a rejection rather than coming back every morning.
 */
function proposeRemoval(
  ports: SlackRosterSyncPorts,
  removal: SlackRosterRemoval,
): { proposal_id: string; status: string } | { error: string } {
  const key = slackRosterRemovalKey(removal);
  const previous = ports
    .listProposalsByType("lab_member.remove")
    .find((proposal) => proposal.idempotency_key === key);
  if (previous) {
    return { proposal_id: previous.id, status: previous.status };
  }
  const created = ports.createProposal({
    type: "lab_member.remove",
    summary: `Remove placeholder roster record ${removal.member_name} (${removal.member_id}): ${removal.reason}`,
    target: {
      service: "adminbot",
      channel: "adminbot",
      target: removal.member_id,
      member_id: removal.member_id,
    },
    proposed_payload: {
      member_id: removal.member_id,
      slack_user_id: removal.slack_user_id,
      reason: removal.reason,
    },
    rationale:
      "The Slack roster sync found this record to be a placeholder or test account. Approving deletes it through the Members delete path; rejecting keeps it and the sync will not ask again.",
    idempotency_key: key,
    undo_plan:
      "None in place: the deleted record is kept whole in the lab_member.deleted audit row and can be re-entered from it.",
  });
  if (!created.ok) {
    return { error: created.error.message };
  }
  return { proposal_id: created.payload.id, status: created.payload.status };
}
