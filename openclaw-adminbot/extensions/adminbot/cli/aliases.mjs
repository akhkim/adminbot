// Human conveniences only. These point at generated operation IDs, contain no
// URLs or schemas, and never implement server business rules.
export const aliases = {
  "auth login": { operation: "post-auth-login" },
  "auth whoami": { operation: "get-auth-session" },
  "auth logout": { operation: "post-auth-logout" },
  "work list": { operation: "get-papers-slot-overview" },
  "work update": {
    operation: "post-papers-by-papers-id-weekly-updates",
    flags: { note: "body", week: "week_start" },
  },
  "work history": { operation: "get-papers-by-papers-id-weekly-updates" },
  "tasks list": { operation: "get-papers-by-papers-id-slots" },
  "tasks update": {
    operation: "put-papers-by-papers-id-slots-by-slots-id",
    flags: { link: "url", value: "value_text", note: "value_note" },
    negativeFlags: { pending: "done" },
  },
  "papers progress": {
    operation: "patch-papers-by-papers-id-progress",
    flags: { step: "current_step" },
  },
  "proposals approve": {
    operation: "post-approvals-by-approvals-id-approve",
    flags: { hash: "payload_hash" },
  },
  "proposals execute": { operation: "post-actions-by-actions-id-execute" },
};
