// Action and audit vocabulary added by the shared-GPU work (inference/gate.ts, tasks/runtime.ts).
// Kept beside contracts/actions.ts rather than inside it so that grandfathered file does not grow;
// actions.ts spreads and unions these back in, so callers still see one list and one event type.

export const adminBotInferenceActionTypes = [
  // The inference gate asking an administrator for help: the GPU line is too long, too old, or the
  // model server has stopped answering. Its own type because it is the one message in the system
  // that is *about* the system, and "when did AdminBot last say the GPU was in trouble" is a
  // question the audit trail should answer without reading every Slack DM. It reaches nobody until
  // an admin approves it -- see inference/gate.ts for the operator alert that fires meanwhile.
  "inference.escalate",
] as const;

// The inference gate (inference/gate.ts). One request to the local model is one row in
// `adminbot_inference_queue`, and these are the row's life: `admitted` when it takes a GPU slot,
// `queued` when it joins the line, `shed` when it is turned away with its body kept, `waited`
// when a shed request is converted to a queued one at the member's request. Exactly one of
// `completed`, `failed`, `expired` closes every row -- the load simulation reconciles on that.
// `refused` is a request the queue declined to store at all (over the size caps), so no row
// exists for it and the event is the only record. `escalation_proposed` is the gate asking an
// administrator for help through the approval gate; `escalated` is recorded only once a
// connector has actually delivered that ask, because a proposal nobody approved reached nobody.
// The `task.*` events are the task runner's (tasks/runtime.ts) lifecycle for one submitted task.
export type InferenceAuditEventType =
  | "inference.control_changed"
  | "inference.admitted"
  | "inference.queued"
  | "inference.shed"
  | "inference.waited"
  | "inference.completed"
  | "inference.failed"
  | "inference.expired"
  | "inference.refused"
  | "inference.escalation_proposed"
  | "inference.escalated"
  | "task.accepted"
  | "task.shed"
  | "task.queued"
  | "task.running"
  | "task.completed"
  | "task.failed"
  | "task.needs_retry"
  | "task.cancelled"
  | "task.expired"
  | "task.step.running"
  | "task.step.completed";
