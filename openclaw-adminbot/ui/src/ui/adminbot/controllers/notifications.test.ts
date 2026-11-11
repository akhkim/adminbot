import { afterEach, expect, it, vi } from "vitest";
import type { ToastOptions } from "../../toast.ts";

const showToast = vi.fn<(options: ToastOptions) => () => void>(() => () => {});
const markNotificationsRead = vi.fn(async () => ({ ok: true as const, value: undefined }));

vi.mock("../../toast.ts", () => ({ showToast }));
vi.mock("../auth/session.ts", () => ({
  loadStoredMemberSession: () => ({ sessionToken: "synthetic-session" }),
  resolveAdminBotBaseUrl: () => "http://127.0.0.1:8765",
}));
vi.mock("../api/workspace.ts", () => ({
  fetchNotifications: async () => ({
    ok: true,
    value: [
      {
        id: "n-1",
        kind: "nudge",
        title: "Synthetic reminder",
        body: "Please update your paper.",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  }),
  markNotificationsRead,
}));

const {
  NOTIFICATION_TOAST_DURATION_MS,
  loadAdminBotNotifications,
  markAdminBotNotificationsRead,
  resetNotificationPopups,
} = await import("./notifications.ts");

afterEach(() => {
  resetNotificationPopups();
  vi.clearAllMocks();
});

async function popOne(): Promise<ToastOptions> {
  const host = { settings: {} } as unknown as Parameters<typeof loadAdminBotNotifications>[0];
  await loadAdminBotNotifications(host);
  expect(showToast).toHaveBeenCalledOnce();
  return showToast.mock.calls[0]![0];
}

it("lets a notification popup time out instead of sitting over the page", async () => {
  const options = await popOne();
  expect(options.duration).toBe(NOTIFICATION_TOAST_DURATION_MS);
  expect(options.duration).toBeGreaterThan(0);
});

it("leaves a timed-out notification unread, but marks it read when the member closes it", async () => {
  const options = await popOne();
  options.onDismiss?.("timeout");
  expect(markNotificationsRead).not.toHaveBeenCalled();

  options.onDismiss?.("closed");
  await vi.waitFor(() => expect(markNotificationsRead).toHaveBeenCalledOnce());
  expect(markNotificationsRead).toHaveBeenCalledWith("synthetic-session", "http://127.0.0.1:8765", [
    "n-1",
  ]);
});

it("keeps a dismissed notification read when a poll that started earlier answers unread", async () => {
  type Host = Parameters<typeof loadAdminBotNotifications>[0];
  const host = { settings: {} } as unknown as Host & {
    adminBotNotifications?: Array<{ id: string; read_at?: string }>;
  };
  await loadAdminBotNotifications(host);
  await markAdminBotNotificationsRead(host, ["n-1"]);
  expect(host.adminBotNotifications?.[0]?.read_at).toBeTruthy();

  // The mocked service still answers with the row unread: the poll that raced the mark.
  await loadAdminBotNotifications(host);
  expect(host.adminBotNotifications?.[0]?.read_at).toBeTruthy();
  // And it is not popped again either.
  expect(showToast).toHaveBeenCalledOnce();
});

it("forgets what was acknowledged on sign-out", async () => {
  type Host = Parameters<typeof loadAdminBotNotifications>[0];
  const host = { settings: {} } as unknown as Host & {
    adminBotNotifications?: Array<{ id: string; read_at?: string }>;
  };
  await loadAdminBotNotifications(host);
  await markAdminBotNotificationsRead(host, ["n-1"]);
  resetNotificationPopups();
  await loadAdminBotNotifications(host);
  expect(host.adminBotNotifications?.[0]?.read_at).toBeUndefined();
});
