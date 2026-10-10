import { describe, expect, it, vi } from "vitest";
import { calendarMembershipReader } from "../connectors/calendar-membership.js";
import { createGogAdminBotExecutor } from "../connectors/gog.js";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

const CALENDAR = "lab@example.org";
function lab() {
  const events = [
    {
      id: "series",
      organizer: { email: CALENDAR },
      attendees: [
        { email: CALENDAR, organizer: true },
        { email: "full-calendar@example.org", responseStatus: "accepted", optional: true },
        { email: "major@example.org" },
        { email: "alumni@example.org" },
        { email: "minor@example.org" },
        { email: "unknown@example.org" },
        { email: "room@example.org", resource: true },
      ],
    },
  ];
  const capture = vi.fn(async (args: string[]) => {
    const method = args.find((arg) => arg.startsWith("calendar.events."));
    return JSON.stringify(
      method === "calendar.events.list" ? { kind: "calendar#events", items: events } : events[0],
    );
  });
  const run = vi.fn(async (args: string[]) => {
    events[0].attendees = JSON.parse(args[args.indexOf("--body") + 1]).attendees;
  });
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(store, {
    executor: createGogAdminBotExecutor({ capture, run }),
  });
  for (const [id, member_type] of [
    ["full", "full"],
    ["major", "coauthor-major"],
    ["alumni", "full, alumni"],
    ["minor", "coauthor-minor"],
  ]) {
    const result = service.upsertLabMember({
      id,
      name: id,
      email: `${id}@example.org`,
      member_type,
      privilege_level: "member",
      ...(id === "full" ? { calendar_email: "full-calendar@example.org" } : {}),
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }
  return { events, capture, run, store, service, read: calendarMembershipReader(capture) };
}
describe("Sunday lab calendar membership", () => {
  it("removes only known ineligible guests, preserving external speakers, eligible alumni, organizer, rooms and RSVPs", async () => {
    const { service, read, run, events, store } = lab();
    const result = await service.syncLabCalendarMembership(CALENDAR, read);
    expect(result.failed).toEqual([]);
    expect(result.removed[0].emails).toEqual(["minor@example.org"]);
    expect(events[0].attendees.map((a) => a.email)).toEqual([
      CALENDAR,
      "full-calendar@example.org",
      "major@example.org",
      "alumni@example.org",
      "unknown@example.org",
      "room@example.org",
    ]);
    expect(events[0].attendees[1]).toMatchObject({ responseStatus: "accepted", optional: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(run.mock.calls[0][0][run.mock.calls[0][0].indexOf("--params") + 1]).sendUpdates,
    ).toBe("none");
    expect(store.listProposalsByType("calendar.remove_attendees")[0]).toMatchObject({
      status: "executed",
      risk_tier: "T3",
      approvals: [{ approver_id: "system:weekly-calendar-membership-policy" }],
    });
    await service.syncLabCalendarMembership(CALENDAR, read);
    expect(run).toHaveBeenCalledTimes(1);
    // Being re-added later must be corrected even within the same week.
    events[0].attendees.push({ email: "minor@example.org" });
    await service.syncLabCalendarMembership(CALENDAR, read);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("fails closed on a failed inventory or empty member database", async () => {
    const { service, run, read } = lab();
    await expect(
      service.syncLabCalendarMembership(CALENDAR, async () => {
        throw new Error("no Google access");
      }),
    ).rejects.toThrow("no Google access");
    await expect(new AdminBotService().syncLabCalendarMembership(CALENDAR, read)).rejects.toThrow(
      "empty member database",
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("reports failed writes without recording execution", async () => {
    const { service, run, read, store } = lab();
    run.mockRejectedValue(new Error("permission denied"));
    const result = await service.syncLabCalendarMembership(CALENDAR, read);
    expect(result.failed).toHaveLength(1);
    expect(result.removed).toEqual([]);
    expect(store.listProposalsByType("calendar.remove_attendees")[0].status).not.toBe("executed");
  });
  it("shares concurrent passes", async () => {
    const { service, read, run } = lab();
    await Promise.all([
      service.syncLabCalendarMembership(CALENDAR, read),
      service.syncLabCalendarMembership(CALENDAR, read),
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(["full@example.org", "outside@example.org"])(
    "refuses cleanup of eligible or unmatched address %s",
    async (email) => {
      const { service, run } = lab();
      const proposal = service.createProposal({
        type: "calendar.remove_attendees",
        summary: "Stale cleanup",
        proposed_payload: {
          calendar_id: CALENDAR,
          event_id: "series",
          removed_attendees: [email],
          membership_filter: true,
        },
      });
      if (!proposal.ok) {
        throw new Error(proposal.error.message);
      }
      service.approve(proposal.payload.id, {
        payload_hash: proposal.payload.payload_hash,
        approver_id: "admin",
        approver_role: "admin",
      });
      expect(await service.execute(proposal.payload.id, { dry_run: false })).toMatchObject({
        ok: false,
        status: 409,
      });
      expect(run).not.toHaveBeenCalled();
    },
  );
  it.each(["full", "coauthor-major", "own-pace-advisee", "coauthor-minor", "", "external-guest"])(
    "enforces calendar invitations for %s",
    async (member_type) => {
      vi.stubEnv("ADMINBOT_LAB_CALENDAR_ID", CALENDAR);
      try {
        const execute = vi.fn(async () => ({ handled: true }));
        const service = new AdminBotService(undefined, { executor: { execute } });
        service.upsertLabMember({
          id: "person",
          name: "Person",
          member_type,
          email: member_type === "external-guest" ? "other@example.org" : "person@example.org",
          privilege_level: "member",
        });
        const proposal = service.createProposal({
          type: "calendar.add_attendees",
          summary: "Invite",
          proposed_payload: {
            calendar_id: CALENDAR,
            event_id: "event",
            attendees: ["person@example.org"],
          },
        });
        if (!proposal.ok) {
          throw new Error(proposal.error.message);
        }
        service.approve(proposal.payload.id, {
          payload_hash: proposal.payload.payload_hash,
          approver_id: "admin",
          approver_role: "admin",
        });
        const result = await service.execute(proposal.payload.id, { dry_run: false });
        expect(result.ok).toBe(["full", "coauthor-major", "external-guest"].includes(member_type));
        expect(execute).toHaveBeenCalledTimes(result.ok ? 1 : 0);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

describe("calendar invitation batch filtering", () => {
  it.each([CALENDAR, "other@example.org"])(
    "filters themed-channel candidates only on the lab calendar (%s)",
    async (calendarId) => {
      vi.stubEnv("ADMINBOT_LAB_CALENDAR_ID", CALENDAR);
      try {
        const execute = vi.fn(async () => ({ handled: true }));
        const store = new AdminBotMemoryStore();
        const service = new AdminBotService(store, { executor: { execute } });
        for (const type of ["full", "coauthor-minor"]) {
          service.upsertLabMember({
            id: type,
            name: type,
            member_type: type,
            slack_user_id: type,
            email: `${type}@example.org`,
          });
        }
        const result = await service.syncThemedMeetingInvites("test", {
          calendarId,
          meetings: [{ event_id: "event", summary: "Theme: Causal Inference" }],
          channels: [
            { channel: "meeting-causal-inference", slack_user_ids: ["full", "coauthor-minor"] },
          ],
        });
        expect(result.ok).toBe(true);
        const proposal = store.listProposalsByType("calendar.add_attendees")[0];
        expect(proposal.proposed_payload).toMatchObject({
          attendees:
            calendarId === CALENDAR
              ? ["full@example.org"]
              : ["coauthor-minor@example.org", "full@example.org"],
        });
        service.approve(proposal.id, {
          payload_hash: proposal.payload_hash,
          approver_id: "admin",
          approver_role: "admin",
        });
        expect((await service.execute(proposal.id, { dry_run: false })).ok).toBe(true);
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("does not let an existing ineligible guest block a research-theme invitation", async () => {
    vi.stubEnv("ADMINBOT_LAB_CALENDAR_ID", CALENDAR);
    try {
      const execute = vi.fn(async () => ({ handled: true }));
      const store = new AdminBotMemoryStore();
      const service = new AdminBotService(store, { executor: { execute } });
      for (const type of ["full", "coauthor-minor"]) {
        service.upsertLabMember({
          id: type,
          name: type,
          member_type: type,
          email: `${type}@example.org`,
          research_topics: ["Multi-Agent Systems"],
        });
      }
      service.sweepResearchThemeInvites(
        {
          calendarId: CALENDAR,
          meetings: [
            {
              event_id: "event",
              summary: "Theme: Multi-Agent Weekly",
              attendees: ["coauthor-minor@example.org", "speaker@example.org"],
            },
          ],
        },
        "test",
      );
      const proposal = store.listProposalsByType("calendar.add_attendees")[0];
      expect(proposal.proposed_payload).toMatchObject({
        attendees: ["full@example.org", "speaker@example.org"],
      });
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_id: "admin",
        approver_role: "admin",
      });
      expect((await service.execute(proposal.id, { dry_run: false })).ok).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
