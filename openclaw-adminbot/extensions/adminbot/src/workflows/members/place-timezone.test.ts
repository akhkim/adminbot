import { describe, expect, it } from "vitest";
import { gazetteerPlaces, resolvePlace } from "./member-map.js";
import { placeTimezone, timezoneMismatch, zoneOffsetMinutes } from "./place-timezone.js";

const place = (name: string) => {
  const found = resolvePlace(name);
  if (!found) {
    throw new Error(`gazetteer has no ${name}`);
  }
  return found;
};

describe("placeTimezone", () => {
  it("knows a zone Intl accepts for every city in the gazetteer", () => {
    const missing = gazetteerPlaces().filter((entry) => {
      const zone = placeTimezone(entry);
      return !zone || zoneOffsetMinutes(zone, new Date("2026-01-15T12:00:00Z")) === undefined;
    });
    expect(missing.map((entry) => entry.key)).toEqual([]);
  });

  it("splits the multi-zone countries by where the city is", () => {
    expect(placeTimezone(place("Toronto"))).toBe("America/Toronto");
    expect(placeTimezone(place("Vancouver"))).toBe("America/Vancouver");
    expect(placeTimezone(place("Calgary"))).toBe("America/Edmonton");
    expect(placeTimezone(place("Halifax"))).toBe("America/Halifax");
    expect(placeTimezone(place("Regina"))).toBe("America/Regina");
    expect(placeTimezone(place("Boston"))).toBe("America/New_York");
    expect(placeTimezone(place("Chicago"))).toBe("America/Chicago");
    expect(placeTimezone(place("Denver"))).toBe("America/Denver");
    expect(placeTimezone(place("Phoenix"))).toBe("America/Phoenix");
    expect(placeTimezone(place("Seattle"))).toBe("America/Los_Angeles");
    expect(placeTimezone(place("Honolulu"))).toBe("Pacific/Honolulu");
    expect(placeTimezone(place("Perth"))).toBe("Australia/Perth");
    expect(placeTimezone(place("Adelaide"))).toBe("Australia/Adelaide");
    expect(placeTimezone(place("Brisbane"))).toBe("Australia/Brisbane");
    expect(placeTimezone(place("Melbourne"))).toBe("Australia/Sydney");
  });
});

describe("timezoneMismatch", () => {
  const winter = new Date("2026-01-15T12:00:00Z");
  const summer = new Date("2026-07-15T12:00:00Z");

  it("agrees when the Slack zone is the city's own, or a neighbour's", () => {
    expect(timezoneMismatch(place("Toronto"), "America/Toronto", winter)).toBeUndefined();
    expect(timezoneMismatch(place("Montréal"), "America/Toronto", winter)).toBeUndefined();
    // Chicago is one hour behind Toronto: inside the tolerance.
    expect(timezoneMismatch(place("Toronto"), "America/Chicago", winter)).toBeUndefined();
  });

  it("flags a clock more than two hours away", () => {
    expect(timezoneMismatch(place("Toronto"), "Europe/Berlin", winter)).toEqual({
      slack_tz: "Europe/Berlin",
      place_tz: "America/Toronto",
      hours: 6,
    });
    expect(timezoneMismatch(place("Vancouver"), "America/Toronto", winter)?.hours).toBe(3);
  });

  it("follows daylight saving: Reykjavík and Helsinki are 2h apart in winter and 3h in summer", () => {
    // Iceland keeps UTC all year; Finland is UTC+2, and UTC+3 in summer.
    expect(timezoneMismatch(place("Reykjavík"), "Europe/Helsinki", winter)).toBeUndefined();
    expect(timezoneMismatch(place("Reykjavík"), "Europe/Helsinki", summer)?.hours).toBe(3);
  });

  it("is decided at the instant, across the week North America and Europe change clocks apart", () => {
    // 2026-03-08 the US springs forward; Europe follows on 2026-03-29. In between, Boston is four
    // hours from London instead of five -- still a mismatch, and measured as four.
    expect(
      timezoneMismatch(place("London"), "America/New_York", new Date("2026-03-15T12:00:00Z"))
        ?.hours,
    ).toBe(4);
    expect(
      timezoneMismatch(place("London"), "America/New_York", new Date("2026-04-15T12:00:00Z"))
        ?.hours,
    ).toBe(5);
  });

  it("treats a missing or unknown zone as no evidence", () => {
    expect(timezoneMismatch(place("Toronto"), undefined, winter)).toBeUndefined();
    expect(timezoneMismatch(place("Toronto"), "Not/AZone", winter)).toBeUndefined();
  });

  it("handles half-hour zones", () => {
    expect(zoneOffsetMinutes("Asia/Kolkata", winter)).toBe(330);
    expect(timezoneMismatch(place("Bangalore"), "Asia/Kolkata", winter)).toBeUndefined();
  });
});
