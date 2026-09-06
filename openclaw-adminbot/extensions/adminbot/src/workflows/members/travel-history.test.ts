import { describe, expect, it } from "vitest";
import type { AdminBotLoginEvent } from "../../contracts/activity-log.js";
import { buildTravelHistory, tripsFrom } from "./travel-history.js";

let seq = 0;
function login(
  at: string,
  location: Partial<Pick<AdminBotLoginEvent, "city" | "country" | "continent" | "timezone">> = {},
): AdminBotLoginEvent {
  return { id: `e${(seq += 1)}`, member_id: "zhijing", at, ...location };
}

const TORONTO = { city: "Toronto", country: "CA", continent: "NA", timezone: "America/Toronto" };
const SINGAPORE = { city: "Singapore", country: "SG", continent: "AS", timezone: "Asia/Singapore" };

describe("buildTravelHistory", () => {
  it("collapses a run of sign-ins from one city into a single stay", () => {
    const history = buildTravelHistory(
      [
        login("2026-03-01T09:00:00.000Z", TORONTO),
        login("2026-03-02T09:00:00.000Z", TORONTO),
        login("2026-03-05T18:00:00.000Z", TORONTO),
      ],
      { memberId: "zhijing" },
    );
    expect(history.stays).toHaveLength(1);
    expect(history.stays[0]).toMatchObject({
      city: "Toronto",
      first_seen: "2026-03-01T09:00:00.000Z",
      last_seen: "2026-03-05T18:00:00.000Z",
      login_count: 3,
      observed_days: 4,
    });
  });

  it("accepts events newest-first, the order the store hands them back", () => {
    const stays = buildTravelHistory(
      [login("2026-03-05T09:00:00.000Z", SINGAPORE), login("2026-03-01T09:00:00.000Z", TORONTO)],
      { memberId: "zhijing" },
    ).stays;
    // Newest first on the way out, whatever order came in.
    expect(stays.map((stay) => stay.city)).toEqual(["Singapore", "Toronto"]);
  });

  it("returns to a city as a second stay rather than reopening the first", () => {
    const history = buildTravelHistory(
      [
        login("2026-03-01T09:00:00.000Z", TORONTO),
        login("2026-03-10T09:00:00.000Z", SINGAPORE),
        login("2026-03-20T09:00:00.000Z", TORONTO),
      ],
      { memberId: "zhijing" },
    );
    expect(history.stays.map((stay) => stay.city)).toEqual(["Toronto", "Singapore", "Toronto"]);
    // Two stays in one city still need distinct list keys.
    expect(new Set(history.stays.map((stay) => stay.id)).size).toBe(3);
  });

  it("calls the place with the most observed days home, not the most recent one", () => {
    // The trip is the last thing that happened and out-logins the desk; reading recency would
    // invert every row on the page for the week after a conference.
    const history = buildTravelHistory(
      [
        login("2026-01-05T09:00:00.000Z", TORONTO),
        login("2026-02-20T09:00:00.000Z", TORONTO),
        login("2026-03-01T09:00:00.000Z", SINGAPORE),
        login("2026-03-02T09:00:00.000Z", SINGAPORE),
        login("2026-03-03T09:00:00.000Z", SINGAPORE),
      ],
      { memberId: "zhijing" },
    );
    expect(history.home_city).toBe("Toronto");
    expect(history.stays.find((stay) => stay.city === "Singapore")?.away).toBe(true);
    expect(history.stays.find((stay) => stay.city === "Toronto")?.away).toBe(false);
  });

  it("claims no home base when only one place has ever been seen", () => {
    const history = buildTravelHistory(
      [login("2026-03-01T09:00:00.000Z", TORONTO), login("2026-03-02T09:00:00.000Z", TORONTO)],
      { memberId: "zhijing" },
    );
    expect(history.home_city).toBeUndefined();
    expect(history.stays[0]?.away).toBe(false);
  });

  it("counts sign-ins the provider could not place instead of dropping them", () => {
    const history = buildTravelHistory(
      [
        login("2026-03-01T09:00:00.000Z", TORONTO),
        login("2026-03-02T09:00:00.000Z"),
        login("2026-03-03T09:00:00.000Z"),
      ],
      { memberId: "zhijing" },
    );
    expect(history.login_count).toBe(3);
    expect(history.unlocated_login_count).toBe(2);
    // The two unplaced logins must not break the Toronto run into three.
    expect(history.stays).toHaveLength(1);
  });

  it("keeps a country-only stay rather than guessing a city for it", () => {
    const history = buildTravelHistory(
      [login("2026-03-01T09:00:00.000Z", { country: "CH", continent: "EU" })],
      { memberId: "zhijing" },
    );
    expect(history.stays[0]).toMatchObject({ country: "CH" });
    expect(history.stays[0]).not.toHaveProperty("city");
  });
});

describe("tripsFrom", () => {
  it("keeps stays away from home that were seen on more than one day", () => {
    const history = buildTravelHistory(
      [
        login("2026-01-05T09:00:00.000Z", TORONTO),
        login("2026-02-20T09:00:00.000Z", TORONTO),
        login("2026-03-01T09:00:00.000Z", SINGAPORE),
        login("2026-03-04T09:00:00.000Z", SINGAPORE),
      ],
      { memberId: "zhijing" },
    );
    expect(tripsFrom(history).map((trip) => trip.city)).toEqual(["Singapore"]);
  });

  it("drops a single sign-in from a layover, which is an observation and not a trip", () => {
    const history = buildTravelHistory(
      [
        login("2026-01-05T09:00:00.000Z", TORONTO),
        login("2026-02-20T09:00:00.000Z", TORONTO),
        login("2026-02-25T09:00:00.000Z", { city: "Dubai", country: "AE" }),
        login("2026-02-26T09:00:00.000Z", TORONTO),
      ],
      { memberId: "zhijing" },
    );
    expect(tripsFrom(history)).toEqual([]);
  });
});
