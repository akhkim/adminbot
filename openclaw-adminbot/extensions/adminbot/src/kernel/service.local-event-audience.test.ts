import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

// recordMemberLocation stamps the observation "now" -- it takes no clock -- so the day the sweep
// answers for has to be the same one, or every entry sorts after it and reads as unknown.
const DAY = new Date().toISOString().slice(0, 10);
const EVENT = "f4d1qkcntmet3g8033kbugn40q_20260914T100000Z";

function labWith(people: Array<{ id: string; place?: string; zone?: string; alumni?: boolean }>) {
  const service = new AdminBotService();
  for (const person of people) {
    unwrap(
      service.upsertLabMember({
        id: person.id,
        name: person.id,
        email: `${person.id}@lab.co`,
        ...(person.alumni ? { member_type: "full, alumni" } : { member_type: "full" }),
      } as never),
    );
    if (person.place) {
      // Through a login row, which is where an IP-derived city actually lands: nothing writes a
      // `login_ip` observation, so the sweep reads the sign-in log for the place half.
      (
        service as never as { store: { appendLoginEvent: (e: unknown) => void } }
      ).store.appendLoginEvent({
        id: `login-${person.id}`,
        member_id: person.id,
        at: new Date().toISOString(),
        city: person.place,
        country: person.place === "Zurich" ? "Switzerland" : "Canada",
      });
    }
    if (person.zone) {
      unwrap(
        service.recordMemberLocation({
          memberId: person.id,
          source: "slack_timezone",
          raw: person.zone,
          timezone: person.zone,
        } as never),
      );
    }
  }
  return service;
}

const sweep = (service: AdminBotService, attendees: string[]) =>
  service.sweepLocalEventAudience(
    {
      eventId: EVENT,
      calendarId: "primary",
      city: "Zurich",
      zone: "Europe/Zurich",
      attendees,
      day: DAY,
    },
    "cron",
  );

describe("refreshing the Zurich lunch guest list", () => {
  it("proposes rather than sends: both attendee actions are admin-approved", () => {
    const service = labWith([{ id: "local", place: "Zurich" }]);
    const out = unwrap(sweep(service, ["someone@lab.co"]));
    expect(out.add.map((r) => r.member_id)).toEqual(["local"]);
    expect(out.proposals).toHaveLength(1);
    const store = (service as never as { store: { listProposalsByType: (t: string) => unknown[] } })
      .store;
    expect(store.listProposalsByType("calendar.add_attendees")).toHaveLength(1);
  });

  // The guard the connector documents: an empty `remaining_attendees` is what a failed read looks
  // like, and rewriting the list to nothing would uninvite the whole lab.
  it("refuses a removal that would empty the guest list", () => {
    const service = labWith([{ id: "moved", place: "Toronto" }]);
    const result = sweep(service, ["moved@lab.co"]);
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("carries a non-roster attendee through a removal untouched", () => {
    const service = labWith([{ id: "moved", place: "Toronto" }]);
    const out = unwrap(sweep(service, ["moved@lab.co", "room@resource.calendar.google.com"]));
    expect(out.remove.map((r) => r.member_id)).toEqual(["moved"]);
    const store = (service as never as { store: { listProposalsByType: (t: string) => unknown[] } })
      .store;
    const [removal] = store.listProposalsByType("calendar.remove_attendees") as Array<{
      proposed_payload: { remaining_attendees: string[] };
    }>;
    expect(removal.proposed_payload.remaining_attendees).toEqual([
      "room@resource.calendar.google.com",
    ]);
  });

  // A settled week is the expected case, and a sweep that proposes nothing is what makes this
  // safe to run weekly.
  it("files nothing when the list already matches", () => {
    const service = labWith([{ id: "local", place: "Zurich" }]);
    const out = unwrap(sweep(service, ["local@lab.co"]));
    expect(out.proposals).toEqual([]);
    expect(out.keep.map((r) => r.member_id)).toEqual(["local"]);
  });

  // The place half is the sign-in log and the zone half is Slack. A member's own typed profile is
  // deliberately not read: a "Zurich" left in a profile from two years ago must not seat somebody
  // at this week's lunch.
  it("ignores a self-reported profile location", () => {
    const service = labWith([{ id: "stale" }]);
    unwrap(
      service.recordMemberLocation({
        memberId: "stale",
        source: "self_reported",
        raw: "Zurich",
      } as never),
    );
    const out = unwrap(sweep(service, ["someone@lab.co"]));
    expect(out.add).toEqual([]);
  });

  it("counts a Slack zone on its own, for somebody who never signs in", () => {
    const service = labWith([{ id: "quiet", zone: "Europe/Zurich" }]);
    const out = unwrap(sweep(service, ["someone@lab.co"]));
    expect(out.add.map((r) => r.member_id)).toEqual(["quiet"]);
  });

  it("leaves alumni out of the audience entirely", () => {
    const service = labWith([{ id: "gone", place: "Zurich", alumni: true }]);
    const out = unwrap(sweep(service, ["someone@lab.co"]));
    expect(out.add).toEqual([]);
  });
});
