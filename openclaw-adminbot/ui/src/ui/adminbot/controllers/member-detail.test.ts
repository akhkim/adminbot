// The shared roster's rows are list cells; the views that need a whole record read it here. Fetch
// is stubbed: what is under test is how often the controller asks and what it lays over the rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { clearStoredMemberSession, saveStoredMemberSession } from "../auth/session.ts";
import type { AdminBotHost, AdminBotLabMember } from "./admin.ts";
import {
  adminBotDuplicatePairs,
  loadAdminBotMemberDetail,
  withMemberDetails,
} from "./member-detail.ts";

const ROW = { id: "ada", name: "Ada" } as AdminBotLabMember;
const WHOLE = { ...ROW, hours_per_week: 20, availability: [{ start: "2026-09-01" }] };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function createHost() {
  return {
    settings: { adminBotUrl: "https://admin.safe.eu" } as UiSettings,
    adminBotError: null,
    requestUpdate: vi.fn(),
  } as unknown as AdminBotHost;
}

describe("member detail", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "tok", memberId: "grace" } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads a member once and lays the record over their row", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json({ member: WHOLE }));
    const host = createHost();
    await Promise.all([
      loadAdminBotMemberDetail(host, "ada", { report: false }),
      loadAdminBotMemberDetail(host, "ada", { report: true }),
    ]);
    await loadAdminBotMemberDetail(host, "ada", { report: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/lab/members/ada/detail");
    expect(withMemberDetails(host, [ROW])).toEqual([WHOLE]);
  });

  it("reports a failed open but not a failed prefetch, and asks again only on a pick", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json({ error: { message: "down" } }, 500));
    const host = createHost();
    await loadAdminBotMemberDetail(host, "ada", { report: false });
    expect(host.adminBotError).toBeNull();
    await loadAdminBotMemberDetail(host, "ada", { report: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
    await loadAdminBotMemberDetail(host, "ada", { report: true, retry: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(host.adminBotError).toContain("Could not load this member's schedule");
    expect(withMemberDetails(host, [ROW])).toEqual([ROW]);
  });

  it("leaves rows alone after the session that read them is gone", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ member: WHOLE }));
    const host = createHost();
    await loadAdminBotMemberDetail(host, "ada", { report: true });
    clearStoredMemberSession();
    expect(withMemberDetails(host, [ROW])).toEqual([ROW]);
  });

  it("reads duplicate pairs once per roster load, and not at all without a session", async () => {
    const pairs = [{ left: WHOLE, right: ROW, reasons: ["same_name"], confidence: "high" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ pairs }));
    const host = createHost();
    host.adminBotRosterLoadedAt = 1;
    const loaded = vi.fn();
    expect(adminBotDuplicatePairs(host, loaded)).toBeNull();
    expect(adminBotDuplicatePairs(host, loaded)).toBeNull();
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledOnce());
    expect(adminBotDuplicatePairs(host, loaded)).toEqual(pairs);
    expect(fetchSpy).toHaveBeenCalledOnce();
    host.adminBotRosterLoadedAt = 2;
    expect(adminBotDuplicatePairs(host, loaded)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    clearStoredMemberSession();
    expect(adminBotDuplicatePairs(host, loaded)).toBeUndefined();
  });
});
