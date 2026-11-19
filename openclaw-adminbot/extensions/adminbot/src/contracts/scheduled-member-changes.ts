// Scheduled member changes: a Member Type change an admin has decided on but that should not
// happen yet -- "give them a week, then move them to acquaintance".
//
// Until this existed the grace period lived in somebody's head or a Slack thread, and the change
// happened whenever that person next remembered. A record here is the decision; the daily sweep
// (scripts/adminbot-scheduled-member-changes-cron.sh) is what carries it out on the day.
//
// Kept out of actions.ts, which is at its size ratchet. The audit event types stay there, in the
// one union every audit line belongs to.

export const adminBotScheduledMemberChangeStatuses = [
  "pending",
  "done",
  "cancelled",
  "failed",
] as const;

export type AdminBotScheduledMemberChangeStatus =
  (typeof adminBotScheduledMemberChangeStatuses)[number];

/** The longest a change may be put off. Past a year it is a plan, not a grace period. */
export const adminBotScheduledMemberChangeMaxDays = 365;

export type AdminBotScheduledMemberChange = {
  id: string;
  member_id: string;
  /** The Member Type the record is given on the day, as the Edit member form would save it. */
  member_type: string;
  /** YYYY-MM-DD (UTC). The first sweep on or after this day makes the change. */
  due_on: string;
  /**
   * No guide email when the change is made. On unless the admin turns it off: a mail that goes out
   * from a cron job a week later, with nobody watching, should be something somebody asked for.
   * A move into alumni is the exception and always sends the alumni welcome (routes/members.ts).
   */
  silent: boolean;
  /** Admin-only context: why, and where it was agreed. */
  reason?: string;
  /**
   * The heads-up AdminBot sent the member when the change was scheduled, for a change that takes
   * them out of the active channels. Absent when no notice was due (the change keeps their access)
   * or the admin asked for none (`notify: false`). `pending` while the Slack send is in flight.
   */
  notice?: AdminBotScheduledMemberChangeNotice;
  status: AdminBotScheduledMemberChangeStatus;
  /** The admin who scheduled it. The change is made in their name, so they must still be one. */
  created_by: string;
  created_at: string;
  /** When it left `pending`, and what happened: the steps taken, or why it could not be made. */
  settled_at?: string;
  outcome?: string;
};

export type AdminBotScheduledMemberChangeNotice = {
  status: "pending" | "sent" | "failed";
  at: string;
  /** Why it failed, or the nudge proposal that carried it. */
  detail?: string;
};

/** The store's share: every change, or those in one status, soonest due first. */
export type ScheduledMemberChangeStore = {
  saveScheduledMemberChange(change: AdminBotScheduledMemberChange): void;
  listScheduledMemberChanges(
    status?: AdminBotScheduledMemberChangeStatus,
  ): AdminBotScheduledMemberChange[];
};
