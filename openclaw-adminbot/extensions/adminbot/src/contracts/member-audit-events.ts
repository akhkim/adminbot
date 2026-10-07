// Audit event types for changes to who is on the roster: merges, id changes, deletions, and
// requests to add somebody. Part of `AdminBotAuditEvent["type"]` in actions.ts, kept here so that
// union can grow without growing actions.ts.
export type AdminBotLabMemberRecordAuditType =
  // Carries the whole retired record in `details`, because a merge has no undo.
  | "lab_member.merged"
  // An admin re-keying one member; `details` names both ids and what moved per table.
  | "lab_member.id_changed"
  | "lab_member.deleted"
  | "lab_members.purged_without_email"
  | "lab_member_request.submitted"
  | "lab_member_request.edited"
  | "lab_member_request.approved"
  | "lab_member_request.rejected"
  | "lab_member_request.withdrawn";
