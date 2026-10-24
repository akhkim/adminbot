/** Daily active-channel enforcement; every removal retains its T3 approval and audit trail. */
import { adminBotMemberTypeTokens, type AdminBotLabMember } from "../contracts/actions.js";
import { ADMINBOT_ACTIVE_CHANNELS } from "../workflows/members/access-audit.js";
import { memberTypeAccessProfile } from "../workflows/members/member-type-access.js";
import type { AdminBotService, AdminBotServiceStore } from "./service.js";

export type ActiveChannelSnapshot = { channel: string; userIds: string[] };
export type ActiveChannelReader = () => Promise<ActiveChannelSnapshot[]>;

/** A channel member the roster cannot judge, reported for a person instead of removed. */
export type ActiveChannelReview = {
  channel: string;
  user_id: string;
  reason: "no_roster_row" | "blank_member_type";
};

export function isActiveChannelEligible(member: AdminBotLabMember): boolean {
  const access = memberTypeAccessProfile(member);
  return access.subgroup_source === "full_member" || access.subgroup === "coauthor_major";
}

/**
 * Keep, remove, or ask a person.
 *
 * Only a roster row that positively names a non-eligible Member Type is a removal. A Slack account
 * no row claims is usually a gap in the roster -- many rows carry no Slack id, Slack Connect
 * collaborators among them -- and a blank Member Type is a question nobody has
 * answered yet. Removing either on a daily timer would take the room away from people the lab never
 * decided about, with no undo but a re-invite.
 */
function channelVerdict(
  members: readonly AdminBotLabMember[],
  userId: string,
): "keep" | "remove" | ActiveChannelReview["reason"] {
  const matched = members.filter((member) => member.slack_user_id?.trim() === userId);
  if (matched.some(isActiveChannelEligible)) {
    return "keep";
  }
  if (matched.length === 0) {
    return "no_roster_row";
  }
  // The tokenizer returns `[""]` for a blank column, so "has a type" means a non-empty token.
  if (
    matched.some(
      (member) => !adminBotMemberTypeTokens(member.member_type).some((token) => token.length > 0),
    )
  ) {
    return "blank_member_type";
  }
  return "remove";
}

export async function enforceActiveChannels(
  service: AdminBotService,
  store: Pick<AdminBotServiceStore, "listLabMembers" | "listProposalsByType">,
  read: ActiveChannelReader,
  now = new Date(),
) {
  const members = () => {
    const result = store.listLabMembers();
    if (!result.length) {
      throw new Error("Refusing cleanup with an empty member database");
    }
    return result;
  };
  members();
  // Finish all reads before any removal: a partial Slack response is not an empty channel.
  const snapshot = await read();
  if (
    snapshot.length !== ADMINBOT_ACTIVE_CHANNELS.length ||
    ADMINBOT_ACTIVE_CHANNELS.some(
      (channel) => snapshot.filter((row) => row.channel === channel).length !== 1,
    ) ||
    snapshot.some((row) => row.userIds.some((id) => !/^[UW][A-Z0-9]+$/u.test(id)))
  ) {
    throw new Error("Incomplete or invalid active-channel snapshot");
  }
  // One pass per UTC day: a re-run the same day is a no-op, and the next day checks again.
  const dayKey = now.toISOString().slice(0, 10);
  const removed: Array<{ channel: string; user_id: string; proposal_id: string }> = [];
  const failed: Array<{ channel: string; user_id: string; reason: string }> = [];
  const needs_review: ActiveChannelReview[] = [];
  for (const { channel, userIds } of snapshot) {
    for (const userId of new Set(userIds)) {
      // Re-read after each asynchronous execution; a promotion during a sweep must be honored.
      const verdict = channelVerdict(members(), userId);
      if (verdict === "keep") {
        continue;
      }
      if (verdict !== "remove") {
        needs_review.push({ channel, user_id: userId, reason: verdict });
        continue;
      }
      const key = `active-channel-cleanup:${dayKey}:${channel}:${userId}`;
      const previous = store
        .listProposalsByType("slack.remove_from_channel")
        .find((p) => p.idempotency_key === key);
      if (previous) {
        const payload = previous.proposed_payload as Record<string, unknown> | undefined;
        if (
          payload?.channel !== channel ||
          payload?.user_id !== userId ||
          previous.target?.target !== channel ||
          previous.target?.service !== "slack"
        ) {
          failed.push({ channel, user_id: userId, reason: "Conflicting cleanup proposal" });
          continue;
        }
      }
      if (previous?.status === "executed" || previous?.status === "rejected") {
        continue;
      }
      const proposed = previous
        ? { ok: true as const, payload: previous }
        : service.createProposal({
            type: "slack.remove_from_channel",
            summary: `Remove ${userId} from #${channel}: not full or coauthor-major`,
            target: { service: "slack", channel: "slack", target: channel },
            proposed_payload: { channel, user_id: userId },
            idempotency_key: key,
            undo_plan: "Invite this account back to the channel.",
          });
      if (!proposed.ok) {
        throw new Error(proposed.error.message);
      }
      // Standing authorization for this fixed policy only. Never approve caller-supplied proposals
      // or disguise this as a human decision; the system identity is recorded in the audit log.
      const approved = service.approve(proposed.payload.id, {
        payload_hash: proposed.payload.payload_hash,
        approver_role: "admin",
        approver_id: "system:daily-active-channel-policy",
        note: "Standing policy: only full and coauthor-major accounts remain in active channels, including alumni. Accounts with no roster row or a blank Member Type are reported, not removed.",
      });
      const result = approved.ok
        ? await service.execute(proposed.payload.id, { dry_run: false, idempotency_key: key })
        : approved;
      if (!result.ok) {
        failed.push({ channel, user_id: userId, reason: result.error.message });
      } else if (result.payload.status !== "executed") {
        failed.push({ channel, user_id: userId, reason: "Removal was not delivered" });
      } else {
        removed.push({ channel, user_id: userId, proposal_id: proposed.payload.id });
      }
    }
  }
  return { removed, failed, needs_review };
}
