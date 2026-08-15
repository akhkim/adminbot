import { describe, expect, it, vi } from "vitest";
import { createCalendarEventsReader, parseCalendarEvents } from "./events.js";

const TIMED = {
  id: "evt-1",
  summary: "Lab meeting",
  start: { dateTime: "2026-08-18T13:00:00-04:00" },
  end: { dateTime: "2026-08-18T14:00:00-04:00" },
  location: "DCS lounge",
  htmlLink: "https://calendar.google.com/event?eid=evt-1",
  attendees: [{ email: "ada@cs.toronto.edu" }, { email: "mei@cs.toronto.edu" }],
};

describe("parseCalendarEvents", () => {
  it("reads a bare array", () => {
    const events = parseCalendarEvents(JSON.stringify([TIMED]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "evt-1",
      summary: "Lab meeting",
      start: "2026-08-18T13:00:00-04:00",
      end: "2026-08-18T14:00:00-04:00",
      location: "DCS lounge",
      attendees: ["ada@cs.toronto.edu", "mei@cs.toronto.edu"],
    });
    expect(events[0]?.all_day).toBeUndefined();
  });

  // gog's JSON shape differs by command and version, so both wrappers are accepted rather than
  // pinning to whichever this box prints today.
  it.each([
    ["an events wrapper", JSON.stringify({ events: [TIMED] })],
    ["an items wrapper", JSON.stringify({ items: [TIMED] })],
  ])("reads %s", (_label, payload) => {
    expect(parseCalendarEvents(payload)).toHaveLength(1);
  });

  // A bare date parsed as a timestamp lands at UTC midnight, which is the evening before for
  // everyone west of London. Keep the date as sent and flag it.
  it("keeps an all-day date as a date and flags it", () => {
    const events = parseCalendarEvents(
      JSON.stringify([{ id: "evt-2", summary: "Retreat", start: { date: "2026-09-01" } }]),
    );
    expect(events[0]).toMatchObject({ start: "2026-09-01", all_day: true });
  });

  it("names an untitled event rather than rendering a blank row", () => {
    const events = parseCalendarEvents(
      JSON.stringify([{ id: "evt-3", start: { dateTime: "2026-08-18T13:00:00Z" } }]),
    );
    expect(events[0]?.summary).toBe("(no title)");
  });

  // Without an id there is nothing to invite to; without a start there is nothing to sort by.
  it("drops an event with no id or no start", () => {
    const events = parseCalendarEvents(
      JSON.stringify([
        { summary: "No id", start: { dateTime: "2026-08-18T13:00:00Z" } },
        { id: "evt-4", summary: "No start" },
      ]),
    );
    expect(events).toEqual([]);
  });

  it("treats empty output as no events and bad output as an error", () => {
    expect(parseCalendarEvents("   ")).toEqual([]);
    expect(() => parseCalendarEvents("not json")).toThrow(/did not return JSON/u);
  });

  // gog writes some refusals to stdout and still exits 0, so the text is the whole diagnosis.
  it("carries gog's own words when the output is not JSON", () => {
    expect(() => parseCalendarEvents("missing --account (or set GOG_ACCOUNT...)")).toThrow(
      /missing --account/u,
    );
  });

  // Reporting an unknown shape as an empty calendar draws a blank month that nobody can tell apart
  // from a free one. This is the failure that hid a broken read behind a plausible-looking grid.
  it("refuses a payload whose shape it does not recognise instead of reporting no events", () => {
    expect(() => parseCalendarEvents(JSON.stringify({ calendars: [] }))).toThrow(
      /unexpected shape/u,
    );
    expect(() => parseCalendarEvents(JSON.stringify({ events: "nope" }))).toThrow(
      /unexpected shape/u,
    );
  });

  // An explicit empty list is a real answer and must stay one.
  it.each([
    ["a bare empty array", "[]"],
    ["an empty events wrapper", JSON.stringify({ events: [] })],
    ["an empty items wrapper", JSON.stringify({ items: [] })],
  ])("accepts %s as genuinely no events", (_label, payload) => {
    expect(parseCalendarEvents(payload)).toEqual([]);
  });
});

describe("createCalendarEventsReader", () => {
  it("asks for a forward window in ascending order, as JSON", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify([TIMED]));
    const reader = createCalendarEventsReader({
      run,
      now: () => Date.parse("2026-08-13T00:00:00.000Z"),
    });
    const events = await reader({});
    expect(events).toHaveLength(1);
    const args: string[] = run.mock.calls[0][0];
    expect(args.slice(args.indexOf("calendar"), args.indexOf("calendar") + 3)).toEqual([
      "calendar",
      "events",
      "list",
    ]);
    // A CLI that can prompt hangs a service until the timeout instead of failing.
    expect(args).toContain("--no-input");
    expect(args).toContain("--json");
    expect(args[args.indexOf("--order") + 1]).toBe("asc");
    expect(args[args.indexOf("--from") + 1]).toBe("2026-08-13T00:00:00.000Z");
    // Two months forward by default: enough for the next conference block, not a year of standups.
    expect(args[args.indexOf("--to") + 1]).toBe("2026-10-12T00:00:00.000Z");
  });

  // gog refuses outright ("missing --account") when it cannot tell which stored token to use, so
  // the deployment's answer is passed explicitly rather than left to be inherited.
  it("names the account from the environment", async () => {
    const run = vi.fn().mockResolvedValue("[]");
    await createCalendarEventsReader({
      run,
      env: { GOG_ACCOUNT: "jinesis.adminbot@gmail.com" } as NodeJS.ProcessEnv,
    })({});
    const args: string[] = run.mock.calls[0][0];
    expect(args[args.indexOf("--account") + 1]).toBe("jinesis.adminbot@gmail.com");
  });

  it("passes a named calendar, a window and a search through", async () => {
    const run = vi.fn().mockResolvedValue("[]");
    const reader = createCalendarEventsReader({ run });
    await reader({
      calendarId: "lab@jinesis.ai",
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-30T00:00:00Z",
      max: 5,
      query: "retreat",
    });
    const args: string[] = run.mock.calls[0][0];
    expect(args[args.indexOf("list") + 1]).toBe("lab@jinesis.ai");
    expect(args[args.indexOf("--max") + 1]).toBe("5");
    expect(args[args.indexOf("--query") + 1]).toBe("retreat");
  });
});
