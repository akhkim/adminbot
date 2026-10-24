import { describe, expect, it, vi } from "vitest";
import type { AdminBotCalendarEvent, CalendarEventsReader } from "../workflows/calendar/events.js";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";
import { inviteLocalLunches, lunchCity } from "./service.local-lunches.js";

const NOW = new Date("2030-01-01T08:00:00Z");
const event = (
  id: string,
  summary = "Zurich: Lunch",
  location?: string,
): AdminBotCalendarEvent => ({
  id,
  summary,
  start: "2030-01-02T11:00:00Z",
  attendees: ["host@example.test"],
  ...(location ? { location } : {}),
});
function lab() {
  const store = new AdminBotMemoryStore();
  const execute = vi.fn(async () => ({ handled: true }));
  const service = new AdminBotService(store, { executor: { execute } });
  for (const [id, location, member_type] of [
    ["alum", "Zurich", "alumni, acquaintance"],
    ["ny", "New York", "acquaintance"],
    ["hidden", "Zurich", "full"],
  ]) {
    service.upsertLabMember({
      id,
      name: id,
      email: `${id}@example.test`,
      location,
      member_type,
      ...(["alum", "hidden"].includes(id) ? { status: "alumni" } : {}),
      ...(id === "hidden" ? { map_visibility: "hidden" } : {}),
    });
  }
  return { service, store, execute };
}

describe("automatic local lunch invitations", () => {
  it("discovers all lunches, matches their cities, includes alumni and audits standing approval", async () => {
    const { service, store, execute } = lab();
    const read = vi.fn(async (_params: Parameters<CalendarEventsReader>[0]) => [
      event("mon", "Zurich: Jinesis Lunch&Meeting@OAT 20th floor"),
      event("thu", "Lunch", "Zeughausstrasse 31, Zürich, Switzerland"),
      event("ny", "New York: Lunch"),
      event("no-city", "Columbia lunch"),
      event("not-lunch", "Zurich: research seminar"),
    ]);
    const result = await inviteLocalLunches(service, store, "lab", read, NOW);
    expect(result.invited.map((x) => [x.event_id, x.member_id])).toEqual([
      ["mon", "alum"],
      ["thu", "alum"],
      ["ny", "ny"],
    ]);
    expect(result.skipped).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[0]?.[0]).not.toHaveProperty("query");
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ calendarId: "lab" }));
    expect(store.listProposalsByType("calendar.remove_attendees")).toHaveLength(0);
    for (const proposal of store.listProposalsByType("calendar.add_attendees")) {
      expect(proposal).toMatchObject({
        status: "executed",
        approvals: [
          { approver_id: "system:local-lunch-policy", payload_hash: proposal.payload_hash },
        ],
      });
    }
  });
  it("shares overlapping scheduled and manual requests", async () => {
    const { service, execute } = lab();
    const read = vi.fn(async () => [
      { ...event("overlap"), start: new Date(Date.now() + 86_400_000).toISOString() },
    ]);
    await Promise.all([
      service.syncLocalLunchInvites("lab", read),
      service.syncLocalLunchInvites("lab", read),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("does not resend on stale reads or reinvite existing aliases", async () => {
    const { service, store, execute } = lab();
    const read = async () => [event("mon")];
    await inviteLocalLunches(service, store, "lab", read, NOW);
    await inviteLocalLunches(service, store, "lab", read, NOW);
    expect(execute).toHaveBeenCalledTimes(1);
    const existing = { ...event("already"), attendees: ["alum@example.test"] };
    expect(
      (await inviteLocalLunches(service, store, "lab", async () => [existing], NOW)).invited,
    ).toEqual([]);
  });
  it("does not replay uncertain failures or claim delivery", async () => {
    const { service, store, execute } = lab();
    execute.mockRejectedValue(new Error("calendar unavailable"));
    const read = async () => [event("mon")];
    const first = await inviteLocalLunches(service, store, "lab", read, NOW);
    const second = await inviteLocalLunches(service, store, "lab", read, NOW);
    expect(first.invited).toEqual([]);
    expect(first.failed).toHaveLength(1);
    expect(second.failed).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("does nothing on failed or truncated reads, conflicting cities, old events or another calendar", async () => {
    const { service, store, execute } = lab();
    await expect(
      inviteLocalLunches(
        service,
        store,
        "lab",
        async () => {
          throw new Error("read failed");
        },
        NOW,
      ),
    ).rejects.toThrow("read failed");
    await expect(
      inviteLocalLunches(
        service,
        store,
        "lab",
        async () => Array.from({ length: 250 }, (_, i) => event(String(i))),
        NOW,
      ),
    ).rejects.toThrow("truncated");
    const result = await inviteLocalLunches(
      service,
      store,
      "lab",
      async () => [
        event("conflict", "Zurich: Lunch", "Toronto"),
        { ...event("past"), start: "2029-01-01T11:00:00Z" },
        { ...event("foreign"), calendar_id: "other" },
      ],
      NOW,
    );
    expect(result.invited).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
  it("reports unknown locations rather than inferring a city from an institution", () => {
    expect(lunchCity(event("unknown", "Columbia Lunch"))).toBeUndefined();
    expect(lunchCity(event("ambiguous", "Lunch in Zurich and Toronto"))).toBeUndefined();
    expect(lunchCity(event("known", "Lunch", "Zeughausstrasse 31, Zürich, Switzerland"))).toBe(
      "zurich",
    );
  });
});
