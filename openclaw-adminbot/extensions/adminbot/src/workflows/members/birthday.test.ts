import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  BIRTHDAY_EVENT_TIMEZONE,
  birthdayEventPayload,
  nextOccurrence,
  parseBirthday,
  validateBirthday,
} from "./birthday.js";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "m-ada",
    name: "Ada Attendee",
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseBirthday", () => {
  it("accepts a zero-padded month and day", () => {
    expect(parseBirthday("03-14")).toEqual({ month: 3, day: 14 });
    expect(parseBirthday(" 12-31 ")).toEqual({ month: 12, day: 31 });
  });

  it("accepts 29 February, which has no year to be judged against", () => {
    expect(parseBirthday("02-29")).toEqual({ month: 2, day: 29 });
  });

  it("rejects impossible dates, unpadded input, and anything carrying a year", () => {
    for (const value of ["00-10", "13-01", "02-30", "04-31", "3-14", "1990-03-14", "", "march"]) {
      expect(parseBirthday(value)).toBeUndefined();
    }
  });
});

describe("validateBirthday", () => {
  it("treats blank as no answer rather than a bad one", () => {
    expect(validateBirthday("")).toBeUndefined();
    expect(validateBirthday("   ")).toBeUndefined();
  });

  it("names the shape it wants, and says no year", () => {
    expect(validateBirthday("1990-03-14")).toContain("MM-DD");
    expect(validateBirthday("1990-03-14")).toContain("no year");
    expect(validateBirthday(42)).toBe("member birthday must be a string");
  });
});

describe("nextOccurrence", () => {
  it("uses this year when the date is still ahead, including today itself", () => {
    expect(nextOccurrence({ month: 12, day: 25 }, new Date("2026-09-07T00:00:00Z")).year).toBe(
      2026,
    );
    expect(nextOccurrence({ month: 9, day: 7 }, new Date("2026-09-07T18:00:00Z")).year).toBe(2026);
  });

  it("rolls to next year once the date has passed", () => {
    // A member joining in November must not acquire a retroactive event for the March just gone.
    expect(nextOccurrence({ month: 3, day: 14 }, new Date("2026-11-02T00:00:00Z")).year).toBe(2027);
  });
});

describe("birthdayEventPayload", () => {
  it("builds a yearly all-day event anchored on the next occurrence", () => {
    const payload = birthdayEventPayload(
      member({ birthday: "03-14" }),
      "lab@example.com",
      new Date("2026-09-07T00:00:00Z"),
    );
    expect(payload).toMatchObject({
      calendar_id: "lab@example.com",
      summary: "🎂 Ada Attendee's birthday",
      from: "2027-03-14",
      // Google's all-day end is exclusive, so a one-day event ends the following day.
      to: "2027-03-15",
      all_day: true,
      timezone: BIRTHDAY_EVENT_TIMEZONE,
      rrule: "RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14",
    });
    // Nobody is invited: 199 people do not need an invitation to each other's birthdays.
    expect(payload?.attendees).toBeUndefined();
  });

  it("prefers the preferred name", () => {
    const payload = birthdayEventPayload(
      member({ birthday: "03-14", preferred_name: "Ada" }),
      "lab@example.com",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(payload?.summary).toBe("🎂 Ada's birthday");
  });

  it("rolls the exclusive end into the next month and the next year", () => {
    const endOfMonth = birthdayEventPayload(
      member({ birthday: "04-30" }),
      "lab@example.com",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(endOfMonth).toMatchObject({ from: "2026-04-30", to: "2026-05-01" });

    const newYearsEve = birthdayEventPayload(
      member({ birthday: "12-31" }),
      "lab@example.com",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(newYearsEve).toMatchObject({ from: "2026-12-31", to: "2027-01-01" });
  });

  it("keeps 29 February on the 29th rather than silently moving it", () => {
    const payload = birthdayEventPayload(
      member({ birthday: "02-29" }),
      "lab@example.com",
      new Date("2026-01-01T00:00:00Z"),
    );
    // The recurrence only fires in leap years, which is what the date actually means. Substituting
    // the 28th or the 1st would put a day on the calendar that is not this person's birthday.
    expect(payload).toMatchObject({
      from: "2026-02-29",
      to: "2026-03-01",
      rrule: "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
    });
  });

  it("proposes nothing for a member with no birthday or an unparseable one", () => {
    const today = new Date("2026-01-01T00:00:00Z");
    expect(birthdayEventPayload(member(), "lab@example.com", today)).toBeUndefined();
    expect(
      birthdayEventPayload(member({ birthday: "  " }), "lab@example.com", today),
    ).toBeUndefined();
    expect(
      birthdayEventPayload(member({ birthday: "1990-03-14" }), "lab@example.com", today),
    ).toBeUndefined();
  });
});
