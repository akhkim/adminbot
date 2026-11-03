import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { readCollaboratorChatPayload } from "../contracts/collaborator-chat.js";
import type { AdminBotServiceStore } from "./service.js";

/** Claim a durable no-replay receipt after approval, before any provider call. */
export function beginCollaboratorChatExecution(
  store: AdminBotServiceStore,
  proposal: AdminBotStoredProposal,
  hasExecutor: boolean,
) {
  const effects = store.collaboratorChatRequestStore?.();
  const fail = (status: number, message: string) => ({ ok: false as const, status, message });
  if (!effects) {
    return fail(503, "Collaborator-chat receipts are unavailable.");
  }
  const key = `request:${String(proposal.target?.request_id ?? "")}`;
  try {
    const payload = readCollaboratorChatPayload(proposal.proposed_payload);
    const saved = effects
      .list(String(proposal.target?.owner_id ?? ""))
      .find((r) => r.id === proposal.target?.request_id);
    if (
      !saved ||
      payload.message !== saved.context ||
      JSON.stringify(payload.participants.map((p) => p.member_id).toSorted()) !==
        JSON.stringify([...saved.participant_ids].toSorted())
    ) {
      return fail(409, "Approved action does not match the saved request.");
    }
    if (
      payload.participants.some(
        (p) => store.getLabMember(p.member_id)?.slack_user_id !== p.slack_user_id,
      )
    ) {
      return fail(409, "Participant identities changed; prepare a new approval.");
    }
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : "Invalid chat payload.");
  }
  if (effects.getEffect(key)) {
    return fail(409, "Previous chat outcome requires reconciliation; automatic retry refused.");
  }
  if (!hasExecutor) {
    return fail(503, "No live connector is configured.");
  }
  if (!effects.claimEffect(key)) {
    return fail(409, "Chat execution is already recorded; reconcile it.");
  }
  return { ok: true as const, effects, key };
}
