// The twenty-hour window before the Monday meeting, across a timezone that observes DST.
import { describe, expect, it } from "vitest";
import {
  adminBotDefaultGroupMeeting,
  hoursUntilGroupMeeting,
  isGroupMeetingNudgeDue,
  DEFAULT_GROUP_MEETING_EVENT_ID,
  groupMeetingSeriesId,
  resolveGroupMeetingEventId,
} from "./group-meeting.js";

const schedule = adminBotDefaultGroupMeeting; // Monday 09:30 America/Toronto

describe("hoursUntilGroupMeeting", () => {
  it("counts down to Monday morning", () => {
    // Sunday 23 Aug 2026, 18:00 Toronto = 22:00Z. The 09:30 meeting is 15.5 hours away.
    expect(hoursUntilGroupMeeting(new Date("2026-08-23T22:00:00Z"), schedule)).toBeCloseTo(15.5, 1);
  });

  it("looks a week ahead once the meeting has started", () => {
    // Monday 10:30 Toronto: this week's finished an hour ago, the next is a week out.
    const hours = hoursUntilGroupMeeting(new Date("2026-08-24T14:30:00Z"), schedule);
    expect(hours).toBeGreaterThan(160);
    expect(hours).toBeLessThan(168);
  });

  it("reads the wall clock in the meeting's zone, not the server's", () => {
    // 03:00Z on Monday is 23:00 Sunday in Toronto -- 10.5 hours before the meeting, not 6.5.
    expect(hoursUntilGroupMeeting(new Date("2026-08-24T03:00:00Z"), schedule)).toBeCloseTo(10.5, 1);
  });
});

describe("isGroupMeetingNudgeDue", () => {
  it("is due in the run-up and quiet the rest of the week", () => {
    // Sunday afternoon: inside the window.
    expect(isGroupMeetingNudgeDue(new Date("2026-08-23T22:00:00Z"), schedule)).toBe(true);
    // Thursday: nowhere near.
    expect(isGroupMeetingNudgeDue(new Date("2026-08-20T15:00:00Z"), schedule)).toBe(false);
    // Just after the meeting starts: not due again until next week's window.
    expect(isGroupMeetingNudgeDue(new Date("2026-08-24T14:30:00Z"), schedule)).toBe(false);
  });

  it("opens exactly twenty hours out", () => {
    // 13:30 Toronto Sunday = 20 hours before Monday 09:30.
    expect(isGroupMeetingNudgeDue(new Date("2026-08-23T17:30:00Z"), schedule)).toBe(true);
    // A minute earlier is outside it.
    expect(isGroupMeetingNudgeDue(new Date("2026-08-23T17:29:00Z"), schedule)).toBe(false);
  });

  it("holds the window in local time across the DST boundary", () => {
    // Toronto leaves DST on 1 Nov 2026. Sunday 17:00Z that week is 12:00 local (EST), 21.5 hours
    // out -- outside the window, where a fixed offset would have called it inside and sent early.
    expect(isGroupMeetingNudgeDue(new Date("2026-11-01T17:00:00Z"), schedule)).toBe(false);
    expect(isGroupMeetingNudgeDue(new Date("2026-11-01T19:00:00Z"), schedule)).toBe(true);
  });
});

// The lab's edit link named one Monday, not the series. Editing attendees against that id would
// have changed a single occurrence and left every other week untouched.
describe("group meeting event id", () => {
  it("reduces a recurring occurrence to its series", () => {
    expect(groupMeetingSeriesId("1qrj9v886kpnj58fdviqugk4g6_20260824T133000Z")).toBe(
      "1qrj9v886kpnj58fdviqugk4g6",
    );
    expect(DEFAULT_GROUP_MEETING_EVENT_ID).toBe("1qrj9v886kpnj58fdviqugk4g6");
  });

  it("leaves a base id alone, underscores included", () => {
    expect(groupMeetingSeriesId("abc123")).toBe("abc123");
    // Not an instance suffix, so not stripped: a base id is opaque.
    expect(groupMeetingSeriesId("abc_def")).toBe("abc_def");
    expect(groupMeetingSeriesId("abc_2026")).toBe("abc_2026");
  });

  it("honours the env override and reduces that too", () => {
    expect(
      resolveGroupMeetingEventId({ ADMINBOT_GROUP_MEETING_EVENT_ID: "other_20270101T090000Z" }),
    ).toBe("other");
    expect(resolveGroupMeetingEventId({})).toBe(DEFAULT_GROUP_MEETING_EVENT_ID);
  });
});
