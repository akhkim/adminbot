// An admin's meeting rows carry a headcount, not a roster: the roster is read per meeting, once,
// when its fold is about to open, and a save patches what is held instead of reading the list again.
//
// Fetch is stubbed rather than a service being started -- what is under test is how many requests
// the controller makes and what it keeps, not the route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import type { MeetingAttendee, MeetingRecord } from "../api/meetings.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import type { AdminBotHost } from "./admin.ts";
import { loadAdminBotMeetingRoster, setAdminBotMeetingAttendance } from "./meetings.ts";

const ADA: MeetingAttendee = {
  member_id: "m-ada",
  display_name: "Ada",
  source: "transcript",
  present: true,
};

function row(id: string, count: number): MeetingRecord {
  return {
    id,
    topic: "Weekly Lab Meeting",
    started_at: "2026-08-12T14:00:00.000Z",
    source: "zoom_email",
    attendee_count: count,
  } as MeetingRecord;
}

function createHost(meetings: MeetingRecord[]) {
  return {
    settings: { adminBotUrl: "https://admin.safe.eu" } as UiSettings,
    adminBotMeetings: meetings,
    adminBotMeetingsSaving: false,
    adminBotMeetingsError: null,
    requestUpdate: vi.fn(),
  } as unknown as AdminBotHost;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("meeting rosters", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "tok", memberId: "grace" } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads a roster once, however many times the fold is pointed at", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json({ ...row("m-once", 1), attendees: [ADA] }));
    const host = createHost([row("m-once", 1)]);
    await Promise.all([
      loadAdminBotMeetingRoster(host, "m-once", { report: false }),
      loadAdminBotMeetingRoster(host, "m-once", { report: true }),
    ]);
    await loadAdminBotMeetingRoster(host, "m-once", { report: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/\/meetings\/m-once$/u);
    expect(host.adminBotMeetingRosters?.["m-once"]).toEqual({ attendees: [ADA] });
    // The list row is left as it came: a headcount, no roster.
    expect(host.adminBotMeetings?.[0]?.attendees).toBeUndefined();
  });

  it("keeps a failed prefetch quiet, and lets the next intent ask again", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "boom" }, 500))
      .mockResolvedValueOnce(json({ ...row("m-retry", 1), attendees: [ADA] }));
    const host = createHost([row("m-retry", 1)]);
    await loadAdminBotMeetingRoster(host, "m-retry", { report: false });
    expect(host.adminBotMeetingsError).toBeNull();
    expect(host.adminBotMeetingRosters?.["m-retry"]).toBeUndefined();
    await loadAdminBotMeetingRoster(host, "m-retry", { report: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(host.adminBotMeetingRosters?.["m-retry"]?.attendees).toEqual([ADA]);
  });

  it("reports a failed read once the fold has been opened", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "boom" }, 500));
    const host = createHost([row("m-fail", 1)]);
    // Prefetch out, then the fold opens before it is back.
    const prefetch = loadAdminBotMeetingRoster(host, "m-fail", { report: false });
    await loadAdminBotMeetingRoster(host, "m-fail", { report: true });
    await prefetch;
    expect(host.adminBotMeetingsError).toBeTruthy();
  });

  it("patches the roster and the headcount from a save, without reading the list", async () => {
    const bo: MeetingAttendee = {
      member_id: "m-bo",
      display_name: "Bo",
      source: "manual",
      present: true,
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ ...row("m-save", 0), attendees: [ADA, bo] }));
    const host = createHost([row("m-other", 3), row("m-save", 1)]);
    host.adminBotMeetingRosters = { "m-save": { attendees: [ADA] } };
    await setAdminBotMeetingAttendance(host, "m-save", bo);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/meetings\/m-save\/attendance$/u);
    expect((init as RequestInit | undefined)?.method).toBe("PUT");
    expect(host.adminBotMeetingRosters?.["m-save"]).toEqual({ attendees: [ADA, bo] });
    expect(host.adminBotMeetings?.map((meeting) => meeting.id)).toEqual(["m-other", "m-save"]);
    expect(host.adminBotMeetings?.[1]?.attendee_count).toBe(2);
    expect(host.adminBotMeetings?.[1]?.attendees).toBeUndefined();
  });
});
