import type { AdminBotMemberNotification } from "../../contracts/actions.js";

/** A notification as GET /notifications sends it: the owner is the caller, so it is not repeated. */
export type AdminBotNotificationFeedItem = Omit<AdminBotMemberNotification, "member_id">;

function rank(notification: AdminBotMemberNotification): number {
  return (notification.escalated_at ? 2 : 0) + (notification.important ? 1 : 0);
}

/**
 * What the dashboard can draw out of a member's notifications, and nothing it cannot.
 *
 * The dashboard collapses each kind to one card -- the highest rank (escalated, then important),
 * newest within it -- and only ever reads the others to pop the unread ones and to mark them read
 * alongside the card. A read sibling is therefore never drawn and never acted on, and a member who
 * has been nudged weekly for a year would otherwise download every one of those sends on each page
 * load. This keeps each kind's card plus every unread notification, in the order given (newest
 * first), so the dashboard's own grouping lands on the same card it would have picked from the
 * full list: the card is in the subset, and nothing that outranks it was dropped.
 */
export function notificationFeed(
  notifications: readonly AdminBotMemberNotification[],
): AdminBotNotificationFeedItem[] {
  const kept = new Map<string, AdminBotMemberNotification>();
  for (const notification of notifications) {
    const held = kept.get(notification.kind);
    // Strictly better only: on a tie the earlier one stays, which is what the dashboard's stable
    // sort over the same order picks.
    if (
      !held ||
      rank(notification) > rank(held) ||
      (rank(notification) === rank(held) && notification.created_at > held.created_at)
    ) {
      kept.set(notification.kind, notification);
    }
  }
  return notifications
    .filter((notification) => !notification.read_at || kept.get(notification.kind) === notification)
    .map(({ member_id: _owner, ...item }) => item);
}
