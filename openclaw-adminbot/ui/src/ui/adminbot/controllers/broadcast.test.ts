import { beforeEach, describe, expect, it, vi } from "vitest";

const publishLabBroadcast = vi.fn();
const fetchLabBroadcasts = vi.fn();

vi.mock("../auth/session.ts", () => ({
  publishLabBroadcast: (...args: unknown[]) => publishLabBroadcast(...args),
  fetchLabBroadcasts: (...args: unknown[]) => fetchLabBroadcasts(...args),
  fetchNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
  loadStoredMemberSession: () => ({ sessionToken: "token" }),
  resolveAdminBotBaseUrl: () => "http://localhost",
}));
vi.mock("../../toast.ts", () => ({ showToast: vi.fn() }));

const { publishAdminBotBroadcast, defaultBroadcastExpiry } = await import("./notifications.ts");

type Host = Parameters<typeof publishAdminBotBroadcast>[0];
const host = (overrides: Partial<Host> = {}): Host => ({ settings: {}, ...overrides }) as Host;

beforeEach(() => {
  vi.clearAllMocks();
  publishLabBroadcast.mockResolvedValue({
    ok: true,
    value: { status: { message: "posted" }, history: [{ message: "posted" }] },
  });
});

describe("publishAdminBotBroadcast", () => {
  // "Until the 26th" means through the 26th, not up to midnight as it began.
  it("reads the end date as the end of that day, in the composer's own timezone", async () => {
    const app = host();
    await publishAdminBotBroadcast(app, {
      message: "Travelling",
      availability: "away",
      expiresOn: "2099-09-26",
    });
    const [body] = publishLabBroadcast.mock.calls[0] as [{ expires_at: string; message: string }];
    expect(new Date(body.expires_at).getTime()).toBe(new Date("2099-09-26T23:59:59").getTime());
    expect(body.message).toBe("Travelling");
  });

  it("refuses an empty message and a date already past, without calling the service", async () => {
    const blank = host();
    await publishAdminBotBroadcast(blank, {
      message: "   ",
      availability: "away",
      expiresOn: "2099-01-01",
    });
    expect(blank.adminBotBroadcastNotice?.kind).toBe("error");

    const stale = host();
    await publishAdminBotBroadcast(stale, {
      message: "Travelling",
      availability: "away",
      expiresOn: "2020-01-01",
    });
    expect(stale.adminBotBroadcastNotice?.kind).toBe("error");
    expect(publishLabBroadcast).not.toHaveBeenCalled();
  });

  // Loud on failure, unlike the read: somebody pressed a button and is owed an answer. A broadcast
  // that silently failed is worse than none, because she thinks the lab has been told.
  it("says so when the post fails, and leaves the draft alone", async () => {
    publishLabBroadcast.mockResolvedValue({ ok: false, kind: "unreachable", message: "Offline" });
    const app = host({ adminBotBroadcastDraft: "half typed" });
    await publishAdminBotBroadcast(app, {
      message: "half typed",
      availability: "away",
      expiresOn: "2099-09-26",
    });
    expect(app.adminBotBroadcastNotice).toEqual({ kind: "error", text: "Offline" });
    expect(app.adminBotBroadcastDraft).toBe("half typed");
    expect(app.adminBotBroadcastBusy).toBe(false);
  });

  it("sends null to take a broadcast down, and empties the box", async () => {
    publishLabBroadcast.mockResolvedValue({ ok: true, value: { status: null, history: [] } });
    const app = host({ adminBotBroadcastDraft: "was live" });
    await publishAdminBotBroadcast(app, null);
    expect(publishLabBroadcast.mock.calls[0]?.[0]).toBeNull();
    expect(app.adminBotBroadcast).toBeNull();
    expect(app.adminBotBroadcastDraft).toBe("");
  });

  it("will not fire twice while one post is still in flight", async () => {
    const app = host({ adminBotBroadcastBusy: true });
    await publishAdminBotBroadcast(app, {
      message: "Travelling",
      availability: "away",
      expiresOn: "2099-09-26",
    });
    expect(publishLabBroadcast).not.toHaveBeenCalled();
  });

  it("defaults the end date a week out", () => {
    expect(defaultBroadcastExpiry(new Date("2026-09-11T00:00:00Z"))).toBe("2026-09-18");
  });
});
