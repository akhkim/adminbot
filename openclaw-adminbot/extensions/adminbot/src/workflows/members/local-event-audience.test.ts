import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotMemberLocationEntry } from "../../contracts/actions.js";
import { localEventAudience, remainingAttendees } from "./local-event-audience.js";

const DAY = "2026-09-14";

function member(id: string, extra: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return { id, name: id, email: `${id}@lab.co`, ...extra } as AdminBotLabMember;
}

function seen(
  memberId: string,
  observedAt: string,
  fields: Partial<AdminBotMemberLocationEntry>,
): AdminBotMemberLocationEntry {
  return {
    id: `${memberId}-${observedAt}`,
    member_id: memberId,
    observed_at: observedAt,
    source: "login_ip",
    raw: "x",
    ...fields,
  } as AdminBotMemberLocationEntry;
}

function run(
  members: AdminBotLabMember[],
  history: Record<string, AdminBotMemberLocationEntry[]>,
  attendees: string[] = [],
) {
  return localEventAudience({
    members,
    historyFor: (id) => history[id] ?? [],
    city: "Zurich",
    zone: "Europe/Zurich",
    attendees,
    day: DAY,
  });
}

describe("who belongs on a standing local event", () => {
  // Rule 1. The two signals answer different failure modes -- somebody who lives in the desktop
  // app barely produces sign-ins, somebody who never touched their Slack profile has a stale zone
  // -- so either one is enough to be counted local.
  it("counts either an IP in the city or a Slack zone of the city", () => {
    const out = run([member("ip"), member("tz"), member("both"), member("neither")], {
      ip: [seen("ip", `${DAY}T08:00:00Z`, { place_label: "Zurich", country: "Switzerland" })],
      tz: [seen("tz", `${DAY}T08:00:00Z`, { source: "slack_timezone", timezone: "Europe/Zurich" })],
      both: [
        seen("both", `${DAY}T08:00:00Z`, { place_label: "Zurich" }),
        seen("both", `${DAY}T08:00:00Z`, { source: "slack_timezone", timezone: "Europe/Zurich" }),
      ],
      neither: [seen("neither", `${DAY}T08:00:00Z`, { place_label: "Toronto" })],
    });
    expect(out.add.map((r) => r.member_id).sort()).toEqual(["both", "ip", "tz"]);
    expect(out.add.find((r) => r.member_id === "both")?.reason).toContain("and Slack says");
  });

  // Rule 2, and the one that matters most: a quiet fortnight is not a departure.
  it("never removes somebody on stale evidence", () => {
    const stale = `2026-09-01T08:00:00Z`; // 13 days before DAY: carried, not yet expired
    const out = run(
      [member("quiet"), member("silent")],
      { quiet: [seen("quiet", stale, { place_label: "Toronto" })], silent: [] },
      ["quiet@lab.co", "silent@lab.co"],
    );
    expect(out.remove).toEqual([]);
    expect(out.held.map((r) => r.member_id).sort()).toEqual(["quiet", "silent"]);
    expect(out.held.find((r) => r.member_id === "silent")?.reason).toBe("no location on file");
    expect(out.held.find((r) => r.member_id === "quiet")?.reason).toContain("day(s) ago");
  });

  it("removes only on a fresh observation placing them elsewhere", () => {
    const out = run(
      [member("moved")],
      { moved: [seen("moved", `${DAY}T09:00:00Z`, { place_label: "Toronto" })] },
      ["moved@lab.co"],
    );
    expect(out.remove.map((r) => r.member_id)).toEqual(["moved"]);
    expect(out.remove[0]?.reason).toContain("Toronto");
  });

  // The OR cuts both ways: a fresh IP elsewhere does not uninvite somebody whose Slack still says
  // Zurich, because that zone is enough to be local under rule 1.
  it("keeps somebody travelling whose Slack zone is still the city's", () => {
    const out = run(
      [member("trip")],
      {
        trip: [
          seen("trip", `${DAY}T09:00:00Z`, { place_label: "Toronto" }),
          seen("trip", `${DAY}T09:00:00Z`, { source: "slack_timezone", timezone: "Europe/Zurich" }),
        ],
      },
      ["trip@lab.co"],
    );
    expect(out.remove).toEqual([]);
    expect(out.keep.map((r) => r.member_id)).toEqual(["trip"]);
  });

  // Rule 3. calendar.remove_attendees replaces the list wholesale, so an address the roster cannot
  // name -- the room, an external guest, the organiser -- must never be judged by this sweep.
  it("never touches an attendee the roster cannot name", () => {
    const out = run(
      [member("local")],
      { local: [seen("local", `${DAY}T08:00:00Z`, { place_label: "Zurich" })] },
      ["local@lab.co", "room-4b@resource.calendar.google.com", "guest@elsewhere.org"],
    );
    expect(out.remove).toEqual([]);
    expect(out.unknown_attendees).toEqual([
      "guest@elsewhere.org",
      "room-4b@resource.calendar.google.com",
    ]);
  });

  it("invites the address Google knows, which is calendar_email when set", () => {
    const out = run([member("cal", { calendar_email: "Personal@Gmail.com" })], {
      cal: [seen("cal", `${DAY}T08:00:00Z`, { place_label: "Zurich" })],
    });
    expect(out.add[0]?.email).toBe("personal@gmail.com");
  });

  it("leaves somebody with no address out of the diff entirely", () => {
    const out = run([member("noaddr", { email: undefined, calendar_email: undefined })], {
      noaddr: [seen("noaddr", `${DAY}T08:00:00Z`, { place_label: "Zurich" })],
    });
    expect(out.add).toEqual([]);
    expect(out.keep).toEqual([]);
  });

  // A country-only observation cannot contradict a city: "Switzerland" is not "not Zurich".
  it("does not remove on an observation that names only a country", () => {
    const out = run(
      [member("coarse")],
      { coarse: [seen("coarse", `${DAY}T09:00:00Z`, { country: "Switzerland" })] },
      ["coarse@lab.co"],
    );
    expect(out.remove).toEqual([]);
    expect(out.held.map((r) => r.member_id)).toEqual(["coarse"]);
  });
});

describe("the absolute guest list a removal sends", () => {
  // The connector replaces rather than subtracts, so this list is what survives. Built from the
  // event's own attendees so externals and the room are carried through.
  it("keeps every address except the ones being dropped", () => {
    const remaining = remainingAttendees(
      ["Local@lab.co", "moved@lab.co", "room@resource.calendar.google.com"],
      [{ member_id: "moved", name: "moved", email: "moved@lab.co", reason: "" }],
    );
    expect(remaining).toEqual(["Local@lab.co", "room@resource.calendar.google.com"]);
  });
});
