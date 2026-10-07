// The inference gate's escalation, as the service proposes and records it.
//
// Kept beside kernel/service.ts rather than inside it so that grandfathered file does not grow; the
// service keeps the two calls that need its private state (who the admins are, the audit log).
import type {
  AdminBotActionProposal,
  AdminBotAuditEvent,
  AdminBotLabMember,
  AdminBotStoredProposal,
} from "../contracts/actions.js";

export type InferenceEscalation = {
  trigger: string;
  summary: string;
  details: Record<string, unknown>;
  firedAt: string;
};

export const NO_INFERENCE_ESCALATION_RECIPIENT =
  "no administrator with a Slack id is configured to receive an inference escalation";

/**
 * Ask the lab's administrators for help with the GPU, through the approval gate.
 *
 * Called by the inference gate when a threshold trips (inference/gate.ts). A proposal rather than
 * a send, like every other external effect: the escalation DM leaves the box, so somebody has to
 * say yes first. Recipients are the same people an admin notice goes to, minus anyone without a
 * Slack id -- there is no point proposing a DM the connector cannot deliver. Undefined when no
 * such recipient exists.
 *
 * Keyed on the trigger, so a threshold that stays tripped across several sweeps collapses onto one
 * pending card rather than one per sweep. A trigger that clears and trips again is a new key.
 */
export function inferenceEscalationProposal(
  escalation: InferenceEscalation,
  admins: Array<AdminBotLabMember | undefined>,
): AdminBotActionProposal | undefined {
  const recipients = admins.filter((member): member is AdminBotLabMember =>
    Boolean(member?.slack_user_id),
  );
  if (recipients.length === 0) {
    return undefined;
  }
  const message = [
    `AdminBot: the local model needs attention (${escalation.trigger}).`,
    escalation.summary,
    "",
    "Requests that are waiting will keep waiting; anything shed has told its member to try later.",
    "Check the vLLM unit on Aurora, or raise ADMINBOT_INFERENCE_CAPACITY if the server was given more sequences.",
  ].join("\n");
  return {
    type: "inference.escalate",
    summary: `Tell the lab admins the GPU needs attention: ${escalation.summary}`,
    target: {
      service: "slack",
      channel: "slack",
      recipientMemberIds: recipients.map((member) => member.id),
    },
    proposed_payload: {
      channel: "slack",
      user_ids: recipients.map((member) => member.slack_user_id as string),
      message,
      trigger: escalation.trigger,
      details: escalation.details,
    },
    rationale: escalation.summary,
    undo_plan: "Reply in the same DM once the server is back.",
    idempotency_key: `inference-escalation:${escalation.trigger}:${escalation.firedAt}`,
  };
}

/**
 * The `inference.escalated` audit row for an executed proposal, or undefined for any other type.
 *
 * Only recorded once a connector has delivered it. The gate records `escalation_proposed` when it
 * asks; recording `escalated` at that point would say the lab was told when nobody was.
 */
export function inferenceEscalatedAudit(
  proposal: AdminBotStoredProposal,
  actionId: string,
): Omit<AdminBotAuditEvent, "id" | "timestamp"> | undefined {
  if (proposal.type !== "inference.escalate") {
    return undefined;
  }
  const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
  return {
    type: "inference.escalated",
    action_id: actionId,
    details: {
      trigger: payload.trigger,
      recipients: Array.isArray(payload.user_ids) ? payload.user_ids.length : 0,
    },
  };
}
