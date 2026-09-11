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
  fetchLabBroadcasts,
  publishLabBroadcast,
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


/**
 * The lab-wide broadcast, for the top of the dashboard.
 *
 * Silent on failure for the same reason notifications are: a broadcast is something the lab is
 * telling the member, and a service that is briefly unreachable must not put an error where the
 * message goes. An empty state reads as "nothing being broadcast", which is the honest answer when
 * we cannot tell.
 */
export async function loadAdminBotBroadcast(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const result = await fetchLabBroadcasts(
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  // Set even on failure, so the lazy loader in app-render does not retry on every render.
  host.adminBotBroadcast = result.ok ? result.value.status : null;
  host.adminBotBroadcastHistory = result.ok ? result.value.history : [];
}

/** A week, which is the span "broadcast from Zhijing for this week" actually means. */
export const ADMINBOT_BROADCAST_DEFAULT_DAYS = 7;

/** The default expiry as a `yyyy-mm-dd`, for the date input to start on. */
export function defaultBroadcastExpiry(now = new Date()): string {
  const end = new Date(now.getTime() + ADMINBOT_BROADCAST_DEFAULT_DAYS * 86_400_000);
  return end.toISOString().slice(0, 10);
}

/**
 * Post what is in the box, or take the current broadcast down.
 *
 * Loud about its failures, unlike the read above: somebody pressed a button and is owed an answer.
 * A broadcast that silently failed to post is worse than one that never existed, because she thinks
 * the lab has been told.
 *
 * The date is read as the *end* of that day in the composer's own timezone -- "until the 26th"
 * means through the 26th, not up to midnight as it began.
 */
export async function publishAdminBotBroadcast(
  host: AdminBotHost,
  draft: { message: string; availability: string; expiresOn: string } | null,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored || host.adminBotBroadcastBusy) {
    return;
  }
  let body: Parameters<typeof publishLabBroadcast>[0] = null;
  if (draft) {
    const message = draft.message.trim();
    if (!message) {
      host.adminBotBroadcastNotice = { kind: "error", text: "Write something to broadcast first." };
      return;
    }
    const endOfDay = new Date(`${draft.expiresOn}T23:59:59`);
    if (!Number.isFinite(endOfDay.getTime()) || endOfDay.getTime() <= Date.now()) {
      host.adminBotBroadcastNotice = { kind: "error", text: "Pick an end date in the future." };
      return;
    }
    body = {
      availability: (draft.availability || "unknown") as "available" | "busy" | "away" | "unknown",
      message,
      expires_at: endOfDay.toISOString(),
    };
  }

  host.adminBotBroadcastBusy = true;
  host.adminBotBroadcastNotice = null;
  try {
    const result = await publishLabBroadcast(
      body,
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.adminBotBroadcastNotice = {
        kind: "error",
        text: result.message ?? "Could not post that broadcast.",
      };
      return;
    }
    host.adminBotBroadcast = result.value.status;
    host.adminBotBroadcastHistory = result.value.history;
    // The box follows what is live, so a post leaves it showing what was posted rather than a
    // stale draft, and a clear empties it.
    host.adminBotBroadcastDraft = result.value.status?.message ?? "";
    host.adminBotBroadcastNotice = {
      kind: "success",
      text: body ? "Posted to the lab." : "Broadcast taken down.",
    };
  } finally {
    host.adminBotBroadcastBusy = false;
  }
}
