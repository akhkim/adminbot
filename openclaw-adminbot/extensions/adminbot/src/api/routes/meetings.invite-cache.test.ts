import { afterEach, describe, expect, it, vi } from "vitest";
import { adminBotDefaultGroupMeeting } from "../../contracts/group-meeting.js";
import type {
  AdminBotCalendarEvent,
  CalendarEventsReader,
} from "../../workflows/calendar/events.js";
import type { AdminBotRouteContext } from "./context.js";
import { readGroupMeetingInvite } from "./meetings.js";

// Monday 23 November 2026, 09:30 in Toronto.
const MONDAY_MEETING: AdminBotCalendarEvent = {
  id: "group_20261123T143000Z",
  summary: "Group meeting",
  start: "2026-11-23T09:30:00-05:00",
  attendees: ["Ada@cs.toronto.edu", "grace@cs.toronto.edu"],
};

function contextWith(reader: CalendarEventsReader): AdminBotRouteContext {
  return {
    readCalendarEvents: reader,
    labCalendar: { id: "lab@group.calendar.google.com" },
  } as unknown as AdminBotRouteContext;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readGroupMeetingInvite", () => {
  it("asks the calendar once, then answers from the kept list without waiting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
    const params: Parameters<CalendarEventsReader>[0][] = [];
    let release: (() => void) | undefined;
    const reader: CalendarEventsReader = (asked) => {
      params.push(asked);
      if (params.length === 1) {
        return Promise.resolve([MONDAY_MEETING]);
      }
      // Every later read hangs until released: a caller that waited on it would time out.
      return new Promise((resolve) => {
        release = () => resolve([MONDAY_MEETING]);
      });
    };
    const ctx = contextWith(reader);

    const first = await readGroupMeetingInvite(ctx, adminBotDefaultGroupMeeting);
    expect(first).toEqual(["ada@cs.toronto.edu", "grace@cs.toronto.edu"]);

    // Still fresh: no second read at all.
    vi.setSystemTime(new Date("2026-11-20T15:00:30Z"));
    expect(await readGroupMeetingInvite(ctx, adminBotDefaultGroupMeeting)).toEqual(first);
    expect(params).toHaveLength(1);

    // Hours later the kept list is served at once and the refresh runs behind it.
    vi.setSystemTime(new Date("2026-11-20T19:00:00Z"));
    expect(await readGroupMeetingInvite(ctx, adminBotDefaultGroupMeeting)).toEqual(first);
    expect(params).toHaveLength(2);
    release?.();

    // The window starts at midnight UTC, so the shared calendar cache sees one key all day.
    expect(params[0]).toEqual(params[1]);
    expect(params[0]).toMatchObject({
      calendarId: "lab@group.calendar.google.com",
      from: "2026-11-20T00:00:00.000Z",
      to: "2026-12-05T00:00:00.000Z",
      max: 50,
    });
  });

  it("answers an empty list when the calendar cannot be read, and asks again next time", async () => {
    let calls = 0;
    const reader: CalendarEventsReader = async () => {
      calls += 1;
      throw new Error("gog is not installed");
    };
    const ctx = contextWith(reader);
    expect(await readGroupMeetingInvite(ctx, adminBotDefaultGroupMeeting)).toEqual([]);
    expect(await readGroupMeetingInvite(ctx, adminBotDefaultGroupMeeting)).toEqual([]);
    expect(calls).toBe(2);
  });
});
