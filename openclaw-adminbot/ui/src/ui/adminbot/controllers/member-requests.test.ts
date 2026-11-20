import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  peek: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../auth/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session.ts")>()),
  loadStoredMemberSession: () => ({ sessionToken: "token" }),
  resolveAdminBotBaseUrl: () => "https://service.test",
  peekAuthedRead: session.peek,
  fetchMemberRequests: session.fetch,
}));

import {
  createEmptyAdminBotMemberRequests,
  loadAdminBotMemberRequests,
  type AdminBotMemberRequestsHost,
} from "./member-requests.ts";

const request = (id: string) => ({ id, status: "pending" }) as never;

function host(): AdminBotMemberRequestsHost {
  return {
    settings: {} as AdminBotMemberRequestsHost["settings"],
    adminBotNotice: null,
    adminBotMemberRequests: createEmptyAdminBotMemberRequests(),
  };
}

describe("loadAdminBotMemberRequests", () => {
  beforeEach(() => {
    session.peek.mockReset();
    session.fetch.mockReset();
  });

  it("draws the last-seen requests while the read revalidates, then the fresh answer", async () => {
    session.peek.mockReturnValue({ requests: [request("seen")] });
    let resolve!: (value: unknown) => void;
    session.fetch.mockReturnValue(new Promise((r) => (resolve = r)));
    const target = host();
    const load = loadAdminBotMemberRequests(target);
    expect(session.peek).toHaveBeenCalledWith(
      "https://service.test",
      "/lab/members/requests",
      "token",
    );
    expect(target.adminBotMemberRequests.requests.map((r) => r.id)).toEqual(["seen"]);
    expect(target.adminBotMemberRequests.loading).toBe(true);
    resolve({ ok: true, value: [request("fresh")] });
    await load;
    expect(target.adminBotMemberRequests.requests.map((r) => r.id)).toEqual(["fresh"]);
    expect(target.adminBotMemberRequests.loading).toBe(false);
  });

  it("does not replace a list it already loaded with the remembered one", async () => {
    session.fetch.mockResolvedValue({ ok: true, value: [] });
    const target = host();
    target.adminBotMemberRequests = {
      ...target.adminBotMemberRequests,
      requests: [request("current")],
      loadedAt: 1,
    };
    const load = loadAdminBotMemberRequests(target);
    expect(session.peek).not.toHaveBeenCalled();
    expect(target.adminBotMemberRequests.requests.map((r) => r.id)).toEqual(["current"]);
    await load;
  });
});
