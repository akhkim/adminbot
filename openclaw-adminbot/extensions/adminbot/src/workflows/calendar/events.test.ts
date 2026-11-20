import { describe, expect, it, vi } from "vitest";
import {
  calendarMonthWindow,
  createCachedCalendarEventsReader,
  createCalendarEventsReader,
  parseCalendarEvents,
} from "./events.js";

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
  it("excludes cancelled lunches and refuses omitted attendee lists", () => {
    expect(parseCalendarEvents(JSON.stringify([{ ...TIMED, status: "cancelled" }]))).toEqual([]);
    expect(() =>
      parseCalendarEvents(JSON.stringify([{ ...TIMED, attendeesOmitted: true }])),
    ).toThrow("omitted");
  });
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

describe("createCachedCalendarEventsReader", () => {
  function counted() {
    let clock = 0;
    const calls: Array<Record<string, unknown>> = [];
    const cached = createCachedCalendarEventsReader(
      async (params) => {
        calls.push(params);
        return [{ id: `evt-${calls.length}`, summary: "Lab meeting", start: "2026-08-18" }];
      },
      { now: () => clock },
    );
    return {
      cached,
      calls,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("answers a repeat of the same parameters from the kept read", async () => {
    const { cached, calls, advance } = counted();
    const first = await cached.read({ calendarId: "lab", max: 250 });
    advance(59_000);
    expect(await cached.read({ calendarId: "lab", max: 250 })).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it("keeps each parameter set apart", async () => {
    const { cached, calls } = counted();
    await cached.read({ calendarId: "lab", max: 250 });
    await cached.read({ calendarId: "lab", max: 50 });
    await cached.read({ calendarId: "other", max: 250 });
    expect(calls).toHaveLength(3);
  });

  it("serves a stale read while it refreshes, and waits once that is too old", async () => {
    const { cached, calls, advance } = counted();
    await cached.read({ calendarId: "lab" });
    advance(2 * 60_000);
    expect((await cached.read({ calendarId: "lab" }))[0]?.id).toBe("evt-1");
    expect(calls).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    advance(10 * 60_000);
    expect((await cached.read({ calendarId: "lab" }))[0]?.id).toBe("evt-3");
  });

  it("asks Google again after invalidate", async () => {
    const { cached, calls } = counted();
    await cached.read({ calendarId: "lab" });
    await cached.read({ calendarId: "other" });
    cached.invalidate();
    expect((await cached.read({ calendarId: "lab" }))[0]?.id).toBe("evt-3");
    expect(calls).toHaveLength(3);
  });

  it("does not keep a failed read", async () => {
    let fail = true;
    const cached = createCachedCalendarEventsReader(async () => {
      if (fail) {
        throw new Error("keyring locked");
      }
      return [];
    });
    await expect(cached.read({})).rejects.toThrow("keyring locked");
    fail = false;
    await expect(cached.read({})).resolves.toEqual([]);
  });

  it("keeps seeded and recently asked reads warm, and re-reads them right after a write", async () => {
    vi.useFakeTimers();
    try {
      const calls: Array<Record<string, unknown>> = [];
      const cached = createCachedCalendarEventsReader(async (params) => {
        calls.push(params);
        return [];
      });
      const stop = cached.keepWarm(50_000, [{ calendarId: "lab", max: 250 }]);
      expect(calls).toEqual([{ calendarId: "lab", max: 250 }]);
      await vi.advanceTimersByTimeAsync(0);
      // The page's own read is handed the warmed answer.
      await cached.read({ calendarId: "lab", max: 250 });
      expect(calls).toHaveLength(1);
      await cached.read({ calendarId: "lab", from: "2026-11-20" });
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(calls).toHaveLength(4);
      cached.invalidate();
      expect(calls).toHaveLength(6);
      // An hour on, only the seed is still read; the page's range was not asked for again.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(50_000);
      expect(calls.length - before).toBe(1);
      stop();
      await vi.advanceTimersByTimeAsync(500_000);
      expect(calls.length - before).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("calendarMonthWindow", () => {
  it("is the month in the lab's zone, as whole UTC days, the way the Calendar tab asks", () => {
    expect(calendarMonthWindow("UTC", Date.parse("2026-11-20T12:00:00Z"))).toEqual({
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-12-01T00:00:00.000Z",
    });
    expect(calendarMonthWindow("UTC", Date.parse("2026-12-31T23:00:00Z"))).toEqual({
      from: "2026-12-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    });
    // Still October in Toronto, though November in UTC.
    expect(calendarMonthWindow("America/Toronto", Date.parse("2026-11-01T02:00:00Z")).from).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(calendarMonthWindow("Not/AZone", Date.parse("2026-11-20T12:00:00Z")).from).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  it("lets seeds move with the clock, so a new month is warmed and the old one dropped", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const reader = createCachedCalendarEventsReader(async (params) => {
        calls.push(params.from ?? "");
        return [];
      });
      let month = "2026-11-01T00:00:00.000Z";
      const stop = reader.keepWarm(50_000, () => [{ from: month, max: 250 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["2026-11-01T00:00:00.000Z"]);
      month = "2026-12-01T00:00:00.000Z";
      await vi.advanceTimersByTimeAsync(50_000);
      expect(calls).toEqual(["2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
