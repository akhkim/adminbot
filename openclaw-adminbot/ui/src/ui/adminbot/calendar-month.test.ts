import { describe, expect, it } from "vitest";
import {
  dayKeyInZone,
  eventDayKey,
  eventTimeLabel,
  eventsByDay,
  monthGrid,
  monthLabel,
  monthStartKey,
  monthWindow,
  shiftMonth,
} from "./calendar-month.ts";

describe("monthGrid", () => {
  it("starts every row on Sunday and pads to whole weeks", () => {
    const weeks = monthGrid("2026-09-01", "2026-09-15");
    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }
    // 1 Sep 2026 is a Tuesday, so the row opens with two days of August.
    expect(weeks[0]?.[0]).toMatchObject({ key: "2026-08-30", inMonth: false });
    expect(weeks[0]?.[2]).toMatchObject({ key: "2026-09-01", day: 1, inMonth: true });
  });

  it("marks today, and only today", () => {
    const days = monthGrid("2026-09-01", "2026-09-15").flat();
    expect(days.filter((day) => day.isToday).map((day) => day.key)).toEqual(["2026-09-15"]);
  });

  // A trailing row belonging entirely to the next month is a row of nothing.
  it("uses as many rows as the month needs and no more", () => {
    // February 2026 starts on a Sunday and has 28 days: exactly four rows.
    expect(monthGrid("2026-02-01", "2026-02-10")).toHaveLength(4);
    // August 2026 starts on a Saturday and runs 31 days, which needs six.
    expect(monthGrid("2026-08-01", "2026-08-10")).toHaveLength(6);
  });

  it("covers every day of the month exactly once", () => {
    const inMonth = monthGrid("2026-09-01", "2026-09-15")
      .flat()
      .filter((day) => day.inMonth)
      .map((day) => day.day);
    expect(inMonth).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
  });
});

describe("bucketing events into days", () => {
  // The whole reason this module exists: a late-evening Toronto event belongs to the Toronto day,
  // whatever zone the browser is in. Bucketing on the ISO string would move it to the next day.
  it("buckets an instant into the calendar's day, not UTC's", () => {
    const late = { start: "2026-09-15T21:30:00-04:00" };
    expect(eventDayKey(late, "America/Toronto")).toBe("2026-09-15");
    expect(dayKeyInZone(Date.parse(late.start), "UTC")).toBe("2026-09-16");
  });

  // Parsing a bare date makes it UTC midnight, which is the evening before west of London — the
  // classic off-by-one that puts a holiday on the wrong square.
  it("keeps an all-day date on its own square", () => {
    expect(eventDayKey({ start: "2026-09-01", all_day: true }, "America/Toronto")).toBe(
      "2026-09-01",
    );
    expect(eventDayKey({ start: "2026-09-01" }, "America/Toronto")).toBe("2026-09-01");
  });

  it("groups by day and orders each day by start", () => {
    const byDay = eventsByDay(
      [
        { id: "b", start: "2026-09-15T16:00:00-04:00" },
        { id: "a", start: "2026-09-15T09:00:00-04:00" },
        { id: "c", start: "2026-09-16T09:00:00-04:00" },
      ],
      "America/Toronto",
    );
    expect(byDay.get("2026-09-15")?.map((event) => event.id)).toEqual(["a", "b"]);
    expect(byDay.get("2026-09-16")?.map((event) => event.id)).toEqual(["c"]);
  });

  it("survives an unparseable start rather than dropping the grid", () => {
    expect(eventDayKey({ start: "not a date" }, "America/Toronto")).toBe("not a date");
    expect(dayKeyInZone(Date.now(), "Not/AZone")).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});

describe("eventTimeLabel", () => {
  it("prints the clock time in the calendar's zone", () => {
    expect(eventTimeLabel({ start: "2026-09-15T13:00:00-04:00" }, "America/Toronto", "en-US")).toBe(
      "1:00 PM",
    );
  });

  it("says so for an all-day event", () => {
    expect(eventTimeLabel({ start: "2026-09-01", all_day: true }, "America/Toronto")).toBe(
      "All day",
    );
  });
});

describe("month navigation", () => {
  it("steps months and wraps the year in both directions", () => {
    expect(shiftMonth("2026-09-01", 1)).toBe("2026-10-01");
    expect(shiftMonth("2026-12-01", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(shiftMonth("2026-09-01", -13)).toBe("2025-08-01");
  });

  it("snaps any day to the first of its month", () => {
    expect(monthStartKey("2026-09-15")).toBe("2026-09-01");
  });

  it("names the month", () => {
    expect(monthLabel("2026-09-01", "en-US")).toBe("September 2026");
  });

  // Navigating to a month has to actually fetch that month, or the grid is empty past the window
  // the first load happened to cover.
  it("asks for exactly the month it is showing", () => {
    expect(monthWindow("2026-09-01")).toEqual({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });
    expect(monthWindow("2026-12-01").to).toBe("2027-01-01T00:00:00.000Z");
  });
});
