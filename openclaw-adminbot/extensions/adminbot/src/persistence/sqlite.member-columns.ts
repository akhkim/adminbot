// The member columns a merge repoints and a purge clears, for AdminBotSqliteStore.

/**
 * Every table that names a member, and the column it names them in.
 *
 * Written out rather than discovered from the schema at runtime: a column called `member_id` is
 * not automatically a roster reference, and a merge that repointed the wrong one would be a
 * silent data corruption rather than a failure. Adding a table with a member column means adding
 * it here, which the merge test asserts by counting what moved.
 */
export const MEMBER_REFERENCE_COLUMNS: ReadonlyArray<[string, string]> = [
  ["adminbot_account_registrations", "member_id"],
  ["adminbot_tab_visits", "member_id"],
  ["adminbot_badge_assignments", "member_id"],
  ["adminbot_badge_nominations", "member_id"],
  ["adminbot_cv_changes", "member_id"],
  ["adminbot_logistics_requests", "member_id"],
  ["adminbot_login_events", "member_id"],
  ["adminbot_member_locations", "member_id"],
  ["adminbot_nudge_ledger", "member_id"],
  ["adminbot_opportunities", "submitted_by_member_id"],
  ["adminbot_paper_conference_attendees", "member_id"],
  ["adminbot_paper_reimbursements", "member_id"],
  ["adminbot_paper_social_draft_consents", "member_id"],
  ["adminbot_paper_social_drafts", "generated_by_member_id"],
  ["adminbot_paper_slots", "provided_by_member_id"],
  ["adminbot_paper_slots", "waived_by_member_id"],
  ["adminbot_password_resets", "member_id"],
  // Both member columns on an update event move. `member_id` is who typed, and repointing it is
  // what keeps the merged member's authorship -- and so their adoption rate -- intact.
  // `subject_member_id` is whose record was touched, and a merge that moved one without the
  // other would turn a self-edit into an admin edit, or the reverse.
  ["adminbot_update_events", "member_id"],
  ["adminbot_update_events", "subject_member_id"],
  // The login itself. Moving it is the point of a merge -- one person with two accounts ends up
  // with one account they can still sign in to -- and the collision rule decides which address
  // that is: if the survivor already has a credential, theirs stands and the duplicate's row is
  // dropped, so the retired address stops working. Both outcomes are in the merge's audit line.
  //
  // Live sessions are deliberately NOT in this sweep. They are repointable in principle, but a
  // session is a bearer of someone's identity and a merge is a human judgement that two records
  // are one person; if that judgement is ever wrong, a repointed session hands one person's
  // signed-in browser the other's record. The service revokes the retired member's sessions
  // instead, which costs a sign-in and cannot be wrong.
  ["adminbot_member_credentials", "member_id"],
];

/**
 * Every table a delete must clear, which is the merge list plus the rows a merge keeps.
 *
 * The extras are the rows that only ever meant something as *this* member's: a notification is
 * addressed to them, a feedback entry and a weekly update are authored by them, and a deadline
 * submission key records which of them filed it. A merge leaves those alone because the survivor
 * inherits them; a delete has nobody to inherit, so leaving them would strand rows pointing at
 * an id the roster can no longer resolve -- the dashboard would render a notification for a
 * member who is gone, and `listMemberProfileOverview` would count an author who does not exist.
 *
 * Sessions are still not here. They are revoked through `revokeSessionsForMember` before the
 * purge runs, for the same reason a merge revokes rather than repoints: a session is a bearer of
 * someone's identity, and it should stop working through the path that records that it did.
 */
/**
 * The rows a delete removes outright: they exist only because this member did.
 *
 * The merge list minus the three attribution columns below, plus the rows a merge keeps because
 * a survivor inherits them. A notification is addressed to this member, a feedback entry and a
 * weekly update are authored by them, an attendee row and a reimbursement are about them -- none
 * of it means anything once they are gone, and leaving it strands rows naming an id the roster
 * can no longer resolve.
 *
 * Sessions are not here. They are revoked through `revokeSessionsForMember` before the purge
 * runs, for the reason the merge gives: a session should stop working through the path that
 * records that it did.
 */
export const MEMBER_OWNED_COLUMNS: ReadonlyArray<[string, string]> = [
  ["adminbot_account_registrations", "member_id"],
  ["adminbot_tab_visits", "member_id"],
  ["adminbot_badge_assignments", "member_id"],
  ["adminbot_badge_nominations", "member_id"],
  ["adminbot_cv_changes", "member_id"],
  ["adminbot_logistics_requests", "member_id"],
  ["adminbot_login_events", "member_id"],
  ["adminbot_member_locations", "member_id"],
  ["adminbot_nudge_ledger", "member_id"],
  ["adminbot_paper_conference_attendees", "member_id"],
  ["adminbot_paper_reimbursements", "member_id"],
  ["adminbot_paper_social_draft_consents", "member_id"],
  ["adminbot_password_resets", "member_id"],
  ["adminbot_update_events", "member_id"],
  ["adminbot_update_events", "subject_member_id"],
  ["adminbot_member_credentials", "member_id"],
  ["adminbot_member_notifications", "member_id"],
  ["adminbot_feedback", "member_id"],
  ["adminbot_paper_weekly_updates", "member_id"],
  ["adminbot_deadline_submission_keys", "submitter_member_id"],
];

/**
 * Columns that merely say *who* did something to a record the lab keeps anyway.
 *
 * Cleared rather than deleted, which is the whole difference between this and the list above: a
 * paper slot is the paper's evidence and a social draft is the paper's copy. Deleting them
 * because the person who filed them left would throw away the artifact to erase the signature --
 * the lab would lose an arXiv link because an intern was removed from the roster. The row stays
 * and the attribution goes.
 */
export const MEMBER_ATTRIBUTION_COLUMNS: ReadonlyArray<[string, string]> = [
  ["adminbot_paper_slots", "provided_by_member_id"],
  ["adminbot_paper_slots", "waived_by_member_id"],
  ["adminbot_paper_social_drafts", "generated_by_member_id"],
];
