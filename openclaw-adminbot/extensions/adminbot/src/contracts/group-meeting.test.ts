// The twenty-hour window before the Monday meeting, across a timezone that observes DST.
import { describe, expect, it } from "vitest";
import {
  adminBotDefaultGroupMeeting,
  hoursUntilGroupMeeting,
  isGroupMeetingNudgeDue,
} from "./group-meeting.js";

const schedule = adminBotDefaultGroupMeeting; // Monday 10:00 America/Toronto

describe("hoursUntilGroupMeeting", () => {
  it("counts down to Monday morning", () => {
    // Sunday 24 Aug 2026, 18:00 Toronto = 22:00Z. Meeting is 16 hours away.
    expect(hoursUntilGroupMeeting(new Date("2026-08-23T22:00:00Z"), schedule)).toBeCloseTo(16, 1);
  });

  it("looks a week ahead once the meeting has started", () => {
    // Monday 10:30 Toronto: this week's is under way, the next is 167.5 hours out.
    const hours = hoursUntilGroupMeeting(new Date("2026-08-24T14:30:00Z"), schedule);
    expect(hours).toBeGreaterThan(160);
    expect(hours).toBeLessThan(168);
  });

  it("reads the wall clock in the meeting's zone, not the server's", () => {
    // 03:00Z on Monday is 23:00 Sunday in Toronto -- 11 hours before the meeting, not 7.
    expect(hoursUntilGroupMeeting(new Date("2026-08-24T03:00:00Z"), schedule)).toBeCloseTo(11, 1);
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
    // 14:00 Toronto Sunday = 20 hours before Monday 10:00.
    expect(isGroupMeetingNudgeDue(new Date("2026-08-23T18:00:00Z"), schedule)).toBe(true);
    // A minute earlier is outside it.
    expect(isGroupMeetingNudgeDue(new Date("2026-08-23T17:59:00Z"), schedule)).toBe(false);
  });

  it("holds the window in local time across the DST boundary", () => {
    // Toronto leaves DST on 1 Nov 2026. Sunday 18:00Z that week is 13:00 local (EST), 21 hours
    // out -- outside the window, where a fixed offset would have called it 20 and sent early.
    expect(isGroupMeetingNudgeDue(new Date("2026-11-01T18:00:00Z"), schedule)).toBe(false);
    expect(isGroupMeetingNudgeDue(new Date("2026-11-01T19:00:00Z"), schedule)).toBe(true);
  });
});
