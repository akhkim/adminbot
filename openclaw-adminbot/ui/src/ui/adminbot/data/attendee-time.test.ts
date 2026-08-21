import { describe, expect, it } from "vitest";
import {
  LOGIN_CITY_FRESH_DAYS,
  attendeeHourVerdict,
  localTimeAt,
  resolveAttendeeZone,
  resolveAttendeeZoneAt,
} from "./attendee-time.ts";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function agoDays(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe("resolveAttendeeZone: a recent sign-in", () => {
  it("outranks the profile while it is fresh, because it is the only signal about today", () => {
    expect(
      resolveAttendeeZone(
        {
          timezone: "America/Toronto",
          location: "Toronto",
          last_login_city: "Zurich",
          last_login_timezone: "Europe/Zurich",
          last_login_at: agoDays(1),
        },
        NOW,
      ),
    ).toEqual({ zone: "Europe/Zurich", source: "login_city", from: "Zurich" });
  });

  it("stops counting once it is older than the freshness window", () => {
    expect(
      resolveAttendeeZone(
        {
          timezone: "America/Toronto",
          last_login_city: "Zurich",
          last_login_timezone: "Europe/Zurich",
          last_login_at: agoDays(LOGIN_CITY_FRESH_DAYS + 1),
        },
        NOW,
      ),
    ).toEqual({ zone: "America/Toronto", source: "timezone", from: "America/Toronto" });
  });

  it("still counts right at the edge of the window", () => {
    const zone = resolveAttendeeZone(
      {
        timezone: "America/Toronto",
        last_login_city: "Zurich",
        last_login_timezone: "Europe/Zurich",
        last_login_at: agoDays(LOGIN_CITY_FRESH_DAYS),
      },
      NOW,
    );
    expect(zone?.source).toBe("login_city");
  });

  // A city with no timestamp says nothing about when they were there.
  it("is ignored without a sign-in time", () => {
    expect(
      resolveAttendeeZone({ timezone: "America/Toronto", last_login_city: "Zurich" }, NOW),
    ).toEqual({ zone: "America/Toronto", source: "timezone", from: "America/Toronto" });
  });

  it("guesses the zone from the city when the provider gave no zone", () => {
    expect(
      resolveAttendeeZone({ last_login_city: "Berlin", last_login_at: agoDays(1) }, NOW),
    ).toEqual({ zone: "Europe/Berlin", source: "login_city", from: "Berlin" });
  });

  // A city the gazetteer has never heard of resolves to nothing, and must fall through rather
  // than report a member as being in an undefined zone.
  it("falls through when neither the provider nor the gazetteer knows the zone", () => {
    expect(
      resolveAttendeeZone(
        {
          timezone: "America/Toronto",
          last_login_city: "Nowheresville",
          last_login_at: agoDays(1),
        },
        NOW,
      ),
    ).toEqual({ zone: "America/Toronto", source: "timezone", from: "America/Toronto" });
  });

  // Clock skew puts a sign-in slightly ahead of "now" routinely; a month ahead is a broken record.
  it("tolerates small clock skew but discards a sign-in from the future", () => {
    const skewed = resolveAttendeeZone(
      { last_login_city: "Berlin", last_login_at: new Date(NOW.getTime() + 60_000).toISOString() },
      NOW,
    );
    expect(skewed?.source).toBe("login_city");

    const absurd = resolveAttendeeZone(
      {
        timezone: "America/Toronto",
        last_login_city: "Berlin",
        last_login_at: agoDays(-30),
      },
      NOW,
    );
    expect(absurd?.source).toBe("timezone");
  });

  // A logged trip is a statement about a specific date; a sign-in is only about right now.
  it("loses to a trip covering the day of the event", () => {
    expect(
      resolveAttendeeZoneAt(
        {
          trips: [{ start: "2026-09-01", end: "2026-09-30", city: "Berlin" }],
          last_login_city: "Zurich",
          last_login_timezone: "Europe/Zurich",
          last_login_at: agoDays(1),
        },
        "2026-09-15T10:00:00.000Z",
        NOW,
      ),
    ).toMatchObject({ source: "trip", from: "Berlin" });
  });
});

describe("resolveAttendeeZone: the Slack profile location", () => {
  it("is the last resort, below where they live", () => {
    expect(
      resolveAttendeeZone({ location: "Toronto", slack_location: "Berlin" }, NOW),
    ).toMatchObject({ source: "location" });
    expect(resolveAttendeeZone({ slack_location: "Berlin" }, NOW)).toEqual({
      zone: "Europe/Berlin",
      source: "slack_location",
      from: "Berlin",
    });
  });

  // Slack profile locations are free text and frequently are not places at all.
  it("resolves to nothing when the Slack text is not a place", () => {
    expect(resolveAttendeeZone({ slack_location: "the moon" }, NOW)).toBeUndefined();
  });
});

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

describe("resolveAttendeeZoneAt", () => {
  const traveller = {
    location: "Toronto",
    trips: [{ start: "2026-09-01", end: "2026-09-30", city: "Berlin", timezone: "Europe/Berlin" }],
  };

  // The point of logging a trip: September invites read in Berlin time and October invites back in
  // home time, without the member touching their profile twice.
  it("uses a logged trip for days it covers, and home time outside it", () => {
    expect(resolveAttendeeZoneAt(traveller, "2026-09-15T14:00:00.000Z")).toEqual({
      zone: "Europe/Berlin",
      source: "trip",
      from: "Berlin",
    });
    expect(resolveAttendeeZoneAt(traveller, "2026-10-15T14:00:00.000Z")?.zone).toBe(
      "America/Toronto",
    );
  });

  it("guesses the zone from the trip's city when the row carries none", () => {
    expect(
      resolveAttendeeZoneAt(
        {
          location: "Toronto",
          trips: [{ start: "2026-09-01", end: "2026-09-30", city: "Berlin" }],
        },
        "2026-09-15T14:00:00.000Z",
      ),
    ).toMatchObject({ zone: "Europe/Berlin", source: "trip" });
  });

  // A trip beats an explicit profile timezone: it is the more specific and more recent statement.
  it("outranks the profile timezone", () => {
    expect(
      resolveAttendeeZoneAt(
        { ...traveller, timezone: "America/Toronto" },
        "2026-09-15T14:00:00.000Z",
      )?.source,
    ).toBe("trip");
  });

  it("ignores a trip whose city resolves to nothing rather than losing the zone entirely", () => {
    expect(
      resolveAttendeeZoneAt(
        {
          location: "Toronto",
          trips: [{ start: "2026-09-01", end: "2026-09-30", city: "a boat" }],
        },
        "2026-09-15T14:00:00.000Z",
      ),
    ).toMatchObject({ zone: "America/Toronto", source: "location" });
  });

  it("falls back to the profile for an unreadable instant", () => {
    expect(resolveAttendeeZoneAt(traveller, "not a date")?.source).toBe("location");
  });
});
