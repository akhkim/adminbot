import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import type { AdminBotCalendarEvent } from "./events.js";
import { planMeetingMembership, standingMeetings } from "./standing-meetings.js";

const GROUP = "groupseries";
const event = (overrides: Partial<AdminBotCalendarEvent>): AdminBotCalendarEvent => ({
  id: "x",
  summary: "",
  start: "2026-10-05T13:30:00Z",
  ...overrides,
});

const events: AdminBotCalendarEvent[] = [
  event({
    id: `${GROUP}_20261005T133000Z`,
    summary: "Group meeting",
    attendees: ["Ada@lab.test"],
  }),
  // A later split of the same Monday meeting is the same meeting, with a second write target.
  event({
    id: `${GROUP}_20261012T133000Z`,
    recurring_event_id: `${GROUP}_R20261012T133000`,
    summary: "Group meeting",
    attendees: ["bo@lab.test"],
  }),
  event({
    id: "theme1_20261007T160000Z",
    recurring_event_id: "theme1",
    summary: "Theme: Causal Inference",
  }),
  event({ id: "proj1_20261008T150000Z", recurring_event_id: "proj1", summary: "Proj: Law" }),
  // Recurring, but not a meeting anybody is on.
  event({ id: "bday_20261009", recurring_event_id: "bday", summary: "Ada's birthday" }),
  // A one-off titled like a theme meeting is not a standing meeting.
  event({ id: "oneoff", summary: "Theme: Special session" }),
];

describe("standingMeetings", () => {
  it("lists the group, theme and project meetings, splits merged, nothing else", () => {
    const meetings = standingMeetings(events, GROUP);

    expect(meetings.map((meeting) => [meeting.id, meeting.kind])).toEqual([
      [GROUP, "group"],
      ["theme1", "theme"],
      ["proj1", "project"],
    ]);
    expect(meetings[0]?.event_ids).toEqual([
      `${GROUP}_20261005T133000Z`,
      `${GROUP}_R20261012T133000`,
    ]);
    expect(meetings[0]?.attendees).toEqual(["ada@lab.test", "bo@lab.test"]);
  });
});

describe("planMeetingMembership", () => {
  const ada = {
    id: "ada",
    name: "Ada",
    email: "ADA@lab.test",
    privilege_level: "member",
  } as AdminBotLabMember;

  it("adds the newly ticked, removes the unticked, ignores ids the calendar lost", () => {
    const meetings = standingMeetings(events, GROUP);

    const plan = planMeetingMembership(meetings, ada, ["theme1", "gone"]);

    expect(plan.add.map((meeting) => meeting.id)).toEqual(["theme1"]);
    expect(plan.remove.map((meeting) => meeting.id)).toEqual([GROUP]);
  });

  it("does nothing when the ticks match the calendar", () => {
    const plan = planMeetingMembership(standingMeetings(events, GROUP), ada, [GROUP]);

    expect(plan).toEqual({ add: [], remove: [] });
  });
});
