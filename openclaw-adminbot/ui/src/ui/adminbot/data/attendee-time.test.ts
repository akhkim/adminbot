import { describe, expect, it } from "vitest";
import { attendeeHourVerdict, localTimeAt, resolveAttendeeZone } from "./attendee-time.ts";

describe("resolveAttendeeZone", () => {
  it("prefers what the member stated over what can be inferred", () => {
    expect(
      resolveAttendeeZone({
        timezone: "Europe/Berlin",
        current_city: "Toronto",
        location: "Toronto",
      }),
    ).toEqual({ zone: "Europe/Berlin", source: "timezone", from: "Europe/Berlin" });
  });

  it("falls back to where they are now, then to where they live", () => {
    expect(resolveAttendeeZone({ current_city: "Berlin", location: "Toronto" })).toEqual({
      zone: "Europe/Berlin",
      source: "current_city",
      from: "Berlin",
    });
    expect(resolveAttendeeZone({ location: "Toronto" })).toEqual({
      zone: "America/Toronto",
      source: "location",
      from: "Toronto",
    });
  });

  // Showing a made-up clock face is worse than showing none: a reader cannot tell a guess from a
  // fact once it looks like a time.
  it("is undefined when nothing on the record resolves", () => {
    expect(resolveAttendeeZone({})).toBeUndefined();
    expect(resolveAttendeeZone({ location: "a boat" })).toBeUndefined();
  });

  it("skips an unresolvable current city rather than giving up on the location", () => {
    expect(resolveAttendeeZone({ current_city: "a boat", location: "Toronto" })?.source).toBe(
      "location",
    );
  });
});

describe("localTimeAt", () => {
  it("reads the instant in the attendee's own zone", () => {
    // 14:00Z on a summer Wednesday: 10am in Toronto, 4pm in Berlin. Matched loosely because the
    // format follows the reader's locale, and a 12- or 24-hour clock is equally correct here.
    expect(localTimeAt("America/Toronto", "2026-08-12T14:00:00.000Z")).toMatch(/10:00/u);
    expect(localTimeAt("Europe/Berlin", "2026-08-12T14:00:00.000Z")).toMatch(/(?:16|4):00/u);
  });

  // A member can type anything into the timezone field, so this arrives invalid as a matter of
  // course and must not throw inside a render.
  it("is undefined for a zone or an instant it cannot read", () => {
    expect(localTimeAt("Mars/Olympus", "2026-08-12T14:00:00.000Z")).toBeUndefined();
    expect(localTimeAt("Europe/Berlin", "not a date")).toBeUndefined();
  });
});

describe("attendeeHourVerdict", () => {
  it("flags the early and late ends of the day", () => {
    // 11:00Z is 07:00 in Toronto and 13:00 in Berlin.
    expect(attendeeHourVerdict("America/Toronto", "2026-08-12T11:00:00.000Z")).toBe("early");
    expect(attendeeHourVerdict("Europe/Berlin", "2026-08-12T11:00:00.000Z")).toBe("fine");
    // 14:00Z is 23:00 in Tokyo.
    expect(attendeeHourVerdict("Asia/Tokyo", "2026-08-12T14:00:00.000Z")).toBe("late");
  });

  it("treats the boundaries as inside the day", () => {
    expect(attendeeHourVerdict("UTC", "2026-08-12T08:00:00.000Z")).toBe("fine");
    expect(attendeeHourVerdict("UTC", "2026-08-12T20:59:00.000Z")).toBe("fine");
    expect(attendeeHourVerdict("UTC", "2026-08-12T21:00:00.000Z")).toBe("late");
  });

  it("is undefined rather than wrong for a zone it cannot read", () => {
    expect(attendeeHourVerdict("Mars/Olympus", "2026-08-12T14:00:00.000Z")).toBeUndefined();
  });
});
