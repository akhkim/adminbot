import { showToast } from "../../toast.ts";
// What the lab has told this member, and how they find out about it.
//
// A notification reaches a member three ways and this file is two of them. The Slack DM is sent
// service-side; here, the same sentence is read back onto the dashboard (a card that stays until
// it is dealt with) and popped in the top-right corner (a toast, so somebody already looking at
// another tab notices it arriving). The third copy is the audit row, which nobody reads on a
// screen.
//
// The popup fires once per notification per session, tracked in `popped` below. Firing on unread
// alone would re-pop everything on the next poll and every reload, which turns a reminder into
// something the member learns to close without reading; firing once and leaving the dashboard card
// behind is the version that still says the thing tomorrow without saying it every minute.
import {
  fetchNotifications,
  loadStoredMemberSession,
  markNotificationsRead,
  resolveAdminBotBaseUrl,
  type MemberNotification,
} from "../auth/session.ts";
import type { AdminBotHost } from "./admin.ts";

/** Notification ids already popped in this session. Cleared on sign-out via `resetNotificationPopups`. */
const popped = new Set<string>();

/**
 * Read the member's notifications, and pop the ones they have not seen.
 *
 * Silent about its own failures beyond the stored error: notifications are something extra the
 * lab is doing for the member, so a service that is briefly unreachable must not put an error
 * banner over a dashboard that is otherwise working.
 */
export async function loadAdminBotNotifications(
  host: AdminBotHost,
  options: { onOpen?: (tab: string) => void } = {},
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  const result = await fetchNotifications(stored.sessionToken, baseUrl);
  if (!result.ok) {
    host.adminBotNotificationsError =
      result.kind === "unreachable" ? null : (result.message ?? null);
    return;
  }
  host.adminBotNotificationsError = null;
  host.adminBotNotifications = result.value;
  for (const notification of result.value) {
    popNotification(host, notification, options.onOpen);
  }
}

function popNotification(
  host: AdminBotHost,
  notification: MemberNotification,
  onOpen?: (tab: string) => void,
): void {
  if (notification.read_at || popped.has(notification.id)) {
    return;
  }
  popped.add(notification.id);
  const tab = notification.tab;
  showToast({
    key: notification.id,
    title: notification.title,
    body: notification.body,
    tone: "warn",
    // No timeout: this is a thing the member is being asked to do, and one that vanished while
    // they were reading it would have been better not sent.
    duration: 0,
    ...(tab && onOpen
      ? {
          action: {
            label: "Open",
            onClick: () => {
              void markAdminBotNotificationsRead(host, [notification.id]);
              onOpen(tab);
            },
          },
        }
      : {}),
    // Closing the popup is an acknowledgement, so it marks the notification read. The dashboard
    // card stays either way -- read is "you have seen this", not "you have done it".
    onDismiss: () => {
      void markAdminBotNotificationsRead(host, [notification.id]);
    },
  });
}

/** Mark notifications read. No ids means every unread one this member has. */
export async function markAdminBotNotificationsRead(
  host: AdminBotHost,
  notificationIds?: readonly string[],
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  const result = await markNotificationsRead(stored.sessionToken, baseUrl, notificationIds);
  if (!result.ok) {
    return;
  }
  // Patched locally rather than re-fetched: the only field that changed is one this call decided,
  // and a re-read would race the poll that is already running.
  const readAt = new Date().toISOString();
  const wanted = notificationIds?.length ? new Set(notificationIds) : undefined;
  const patched: MemberNotification[] = [];
  for (const notification of host.adminBotNotifications ?? []) {
    if (notification.read_at || (wanted && !wanted.has(notification.id))) {
      patched.push(notification);
      continue;
    }
    patched.push(Object.assign({}, notification, { read_at: readAt }));
  }
  // A new array, not a mutated one: lit only re-renders a @state() array when the reference changes.
  host.adminBotNotifications = patched;
}

/** Forget which popups have fired. Called on sign-out: the next member starts with a clean corner. */
export function resetNotificationPopups(): void {
  popped.clear();
}
