/** Readiness for a saved collaborator-chat request; never performs a Slack effect. */
export type ChatParticipant = {
  member_id: string;
  slack_user_id?: string;
  verified_slack_user_id?: string;
};

export function collaboratorChatReadiness(participants: readonly ChatParticipant[]) {
  if (participants.length < 2 || participants.length > 8) {
    return { ready: false as const, reason: "Choose between two and eight participants." };
  }
  if (new Set(participants.map((p) => p.member_id)).size !== participants.length) {
    return { ready: false as const, reason: "Choose each member only once." };
  }
  const waiting = participants.filter(
    (p) =>
      !p.member_id.trim() ||
      !/^[UW][A-Z0-9]+$/u.test(p.slack_user_id ?? "") ||
      p.verified_slack_user_id !== p.slack_user_id,
  );
  if (waiting.length) {
    return {
      ready: false as const,
      reason: "Verify Slack membership for every participant before requesting approval.",
      waiting_member_ids: waiting.map((p) => p.member_id),
    };
  }
  const userIds = participants.map((p) => p.slack_user_id!);
  if (new Set(userIds).size !== userIds.length) {
    return { ready: false as const, reason: "Participants must have distinct Slack identities." };
  }
  return { ready: true as const, slack_user_ids: userIds };
}
