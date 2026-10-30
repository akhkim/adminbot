export function readCollaboratorChatPayload(value: unknown) {
  const body = value as {
    participants?: { member_id: string; slack_user_id: string }[];
    message?: string;
  };
  if (
    !body ||
    !Array.isArray(body.participants) ||
    body.participants.length < 2 ||
    body.participants.length > 8 ||
    typeof body.message !== "string" ||
    !body.message.trim() ||
    body.message.length > 2000 ||
    body.participants.some(
      (p) =>
        !p ||
        typeof p.member_id !== "string" ||
        !p.member_id.trim() ||
        !/^[UW][A-Z0-9]+$/u.test(p.slack_user_id),
    ) ||
    new Set(body.participants.map((p) => p.member_id)).size !== body.participants.length ||
    new Set(body.participants.map((p) => p.slack_user_id)).size !== body.participants.length
  ) {
    throw new Error("Invalid collaborator-chat participants or message.");
  }
  return { participants: body.participants, message: body.message };
}
