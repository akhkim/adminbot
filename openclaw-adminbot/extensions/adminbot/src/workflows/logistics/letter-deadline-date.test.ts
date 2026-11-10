import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequestInput } from "../../contracts/actions.js";
import { parseMonthDay, resolveYearlessDate } from "./letter-deadline-date.js";
import { deadlineInstant, requestDeadline, requestDeadlineDetails } from "./requests.js";

const NOW = new Date("2026-11-10T12:00:00Z");
const endOfDay = (iso: string) => deadlineInstant(iso);

function letter(...deadlines: string[]): AdminBotLogisticsRequestInput {
  return {
    kind: "recommendation_letters",
    schools: deadlines.map((letter_deadline, index) => ({
      school: `Example University ${index + 1}`,
      letter_deadline,
    })),
  };
}

describe("parseMonthDay", () => {
  it.each([
    ["12-15", { month: 12, day: 15 }],
    ["--12-15", { month: 12, day: 15 }],
    ["12/15", { month: 12, day: 15 }],
    ["15/12", { month: 12, day: 15 }],
    ["Dec 15", { month: 12, day: 15 }],
    ["Dec. 15th", { month: 12, day: 15 }],
    ["December 1", { month: 12, day: 1 }],
    ["15 December", { month: 12, day: 15 }],
    ["1st of Jan", { month: 1, day: 1 }],
    ["Sept 30", { month: 9, day: 30 }],
    ["feb 29", { month: 2, day: 29 }],
  ])("reads %s", (raw, expected) => {
    expect(parseMonthDay(raw)).toEqual(expected);
  });

  it.each(["", "2026-12-15", "Dec 15 2026", "12/15/2026", "Feb 30", "13-40", "soon", "Smarch 3"])(
    "rejects %s",
    (raw) => {
      expect(parseMonthDay(raw)).toBeUndefined();
    },
  );
});

describe("resolveYearlessDate", () => {
  it("takes this year's date while it is still ahead", () => {
    expect(resolveYearlessDate({ month: 12, day: 15 }, endOfDay, NOW)).toBe("2026-12-15");
  });

  it("rolls a date that already passed this year into next year", () => {
    expect(resolveYearlessDate({ month: 1, day: 5 }, endOfDay, NOW)).toBe("2027-01-05");
    expect(resolveYearlessDate({ month: 6, day: 1 }, endOfDay, NOW)).toBe("2027-06-01");
  });

  it("keeps a date that passed within the grace window as overdue rather than a year away", () => {
    expect(resolveYearlessDate({ month: 11, day: 1 }, endOfDay, NOW)).toBe("2026-11-01");
  });

  it("finds the next leap year for Feb 29", () => {
    expect(resolveYearlessDate({ month: 2, day: 29 }, endOfDay, NOW)).toBe("2028-02-29");
  });

  it("looks back to last year when now sits just after New Year", () => {
    const january = new Date("2027-01-03T12:00:00Z");
    expect(resolveYearlessDate({ month: 12, day: 20 }, endOfDay, january)).toBe("2026-12-20");
  });
});

describe("requestDeadlineDetails with year-less legacy dates", () => {
  it("resolves a year-less letter deadline and marks the year as inferred", () => {
    expect(requestDeadlineDetails(letter("Dec 15"), { now: NOW })).toEqual({
      at: deadlineInstant("2026-12-15"),
      date: "2026-12-15",
      time: "23:59",
      timezone: "AoE",
      year_inferred: true,
    });
  });

  it("orders a year-less date against typed ones by its resolved instant", () => {
    const details = requestDeadlineDetails(letter("2027-03-01", "Jan 5"), { now: NOW });
    expect(details?.date).toBe("2027-01-05");
    expect(details?.year_inferred).toBe(true);
  });

  it("leaves a typed ISO date alone and unmarked", () => {
    const details = requestDeadlineDetails(letter("2026-12-15"), { now: NOW });
    expect(details?.date).toBe("2026-12-15");
    expect(details).not.toHaveProperty("year_inferred");
  });

  it("does not infer a year when the caller opts out", () => {
    expect(
      requestDeadlineDetails(letter("Dec 15"), { now: NOW, inferYear: false }),
    ).toBeUndefined();
    expect(requestDeadline(letter("Dec 15"), { now: NOW, inferYear: false })).toBeUndefined();
  });

  it("keeps text that is not a date undated", () => {
    expect(requestDeadlineDetails(letter("rolling"), { now: NOW })).toBeUndefined();
  });
});
