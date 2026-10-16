import { describe, expect, it } from "vitest";
import {
  cityIntroKey,
  introPairs,
  isAtHome,
  isIntroSendTime,
  localHour,
  meetupIntrosAllowed,
  meetupPreferences,
  memberZone,
  metroFor,
  nearEachOther,
  onCityCooldown,
  pairKey,
  placeKey,
  placeLabel,
  viewerLocation,
} from "./meetups.js";
import { liveIpPlace } from "./member-map.js";

const NOW = new Date("2026-10-15T18:00:00Z");

describe("near", () => {
  it("joins a metro's suburbs that the 50 km radius misses", () => {
    expect(metroFor({ city: "San Jose" })?.key).toBe("sf-bay-area");
    expect(nearEachOther({ city: "San Francisco" }, { city: "San Jose" })).toBe(true);
    expect(nearEachOther({ city: "Mountain View, CA" }, { city: "Oakland" })).toBe(true);
  });

  it("keeps same-named cities in different countries apart", () => {
    expect(metroFor({ city: "Cambridge", country: "US" })?.key).toBe("boston");
    expect(metroFor({ city: "Cambridge, MA" })?.key).toBe("boston");
    expect(metroFor({ city: "Cambridge", country: "United Kingdom" })).toBeUndefined();
    expect(
      nearEachOther({ city: "Cambridge", country: "United Kingdom" }, { city: "Boston" }),
    ).toBe(false);
  });

  it("falls back to distance or the typed name outside the table", () => {
    expect(nearEachOther({ city: "Budapest" }, { city: "Budapest, Hungary" })).toBe(true);
    expect(nearEachOther({ city: "Budapest" }, { city: "Vienna" })).toBe(false);
    expect(nearEachOther({ city: "Hengqin" }, { city: "hengqin" })).toBe(true);
  });

  it("labels and keys a place by its metro, never the suburb", () => {
    expect(placeLabel({ city: "Palo Alto" })).toBe("San Francisco Bay Area");
    expect(placeKey({ city: "Palo Alto" })).toBe("sf-bay-area");
    expect(placeLabel({ city: "Budapest" })).toBe("Budapest");
  });
});

describe("where a member is", () => {
  const member = {
    last_ip_observed_at: "2026-10-14T09:00:00Z",
    last_login_city: "Mountain View",
    last_login_country: "United States",
  };

  it("trusts a live IP city for three days, a meetup window for seven", () => {
    expect(liveIpPlace(member, NOW, 3)).toEqual({
      city: "Mountain View",
      country: "United States",
      observed_at: "2026-10-14T09:00:00Z",
    });
    const later = new Date("2026-10-19T18:00:00Z");
    expect(liveIpPlace(member, later, 3)).toBeUndefined();
    expect(liveIpPlace(member, later, 7)).toBeDefined();
  });

  it("never places anybody by the sign-in time alone", () => {
    const signedInOnly = {
      last_login_at: "2026-10-15T09:00:00Z",
      last_login_city: "Toronto",
      last_login_country: "Canada",
    };
    expect(liveIpPlace(signedInOnly, NOW)).toBeUndefined();
    expect(viewerLocation({ id: "a", name: "A", ...signedInOnly } as never, NOW)).toBeUndefined();
  });

  it("shows the viewer their own city, then their stated one, then their country", () => {
    expect(viewerLocation({ id: "a", name: "A", ...member } as never, NOW)).toMatchObject({
      label: "Mountain View",
      source: "ip",
    });
    expect(
      viewerLocation({ id: "a", name: "A", current_city: "Toronto" } as never, NOW),
    ).toMatchObject({ label: "Toronto", source: "profile" });
    expect(
      viewerLocation({ id: "a", name: "A", slack_location: "Zurich" } as never, NOW),
    ).toMatchObject({ label: "Zürich", source: "slack" });
    expect(
      viewerLocation(
        {
          id: "a",
          name: "A",
          last_ip_observed_at: member.last_ip_observed_at,
          last_login_country: "Canada",
        } as never,
        NOW,
      ),
    ).toEqual({ label: "Canada", source: "ip" });
  });
});

describe("opt-in", () => {
  it("defaults both kinds on: zero setup", () => {
    expect(meetupPreferences({})).toEqual({ events: true, city: true });
    expect(meetupIntrosAllowed({}, "event", "2026-10-15")).toBe(true);
    expect(meetupIntrosAllowed({}, "city", "2026-10-15")).toBe(true);
  });

  it("never allows an intro for a do-not-contact member, whatever they chose", () => {
    const member = { do_not_contact: true, meetup_intros: { events: true, city: true } };
    expect(meetupIntrosAllowed(member, "event", "2026-10-15")).toBe(false);
    expect(meetupIntrosAllowed(member, "city", "2026-10-15")).toBe(false);
  });

  it("respects an opt-out and a snooze, through its last day", () => {
    expect(meetupIntrosAllowed({ meetup_intros: { events: false } }, "event", "2026-10-15")).toBe(
      false,
    );
    const snoozed = { meetup_intros: { city: true, snoozed_until: "2026-10-20" } };
    expect(meetupIntrosAllowed(snoozed, "city", "2026-10-20")).toBe(false);
    expect(meetupIntrosAllowed(snoozed, "event", "2026-10-15")).toBe(false);
    expect(meetupIntrosAllowed(snoozed, "city", "2026-10-21")).toBe(true);
  });
});

describe("quiet hours", () => {
  it("reads the hour in a zone", () => {
    expect(localHour("America/Los_Angeles", NOW)).toBe(11);
    expect(localHour("Not/AZone", NOW)).toBeUndefined();
  });

  it("sends only when it is 10:00-20:00 for everybody it knows", () => {
    expect(isIntroSendTime(["America/Los_Angeles", "America/New_York"], NOW)).toBe(true);
    // 03:00 in Tokyo.
    expect(isIntroSendTime(["America/Los_Angeles", "Asia/Tokyo"], NOW)).toBe(false);
    expect(isIntroSendTime([undefined, "America/Los_Angeles"], NOW)).toBe(true);
    expect(isIntroSendTime(["America/Los_Angeles"], new Date("2026-10-15T16:59:00Z"))).toBe(false);
    expect(isIntroSendTime(["America/Los_Angeles"], new Date("2026-10-16T03:00:00Z"))).toBe(false);
  });

  it("uses a fresh live IP zone over the stated one", () => {
    const traveller = {
      timezone: "America/Toronto",
      last_login_timezone: "Europe/Budapest",
      last_ip_observed_at: "2026-10-15T08:00:00Z",
    };
    expect(memberZone(traveller, NOW)).toBe("Europe/Budapest");
    expect(memberZone(traveller, new Date("2026-10-30T00:00:00Z"))).toBe("America/Toronto");
    expect(memberZone({ timezone: "Mars/Olympus" }, NOW)).toBeUndefined();
  });
});

describe("history", () => {
  const intro = (key: string, ids: string[], status = "executed") => ({
    status,
    idempotency_key: key,
    proposed_payload: { member_ids: ids },
  });

  it("spends every pair in an executed intro, event or city, and nothing else", () => {
    const pairs = introPairs([
      intro("conference-intro:emnlp:2026:ada", ["ada", "bob", "cy"]),
      intro(cityIntroKey("sf-bay-area", "dee", "2026-10-01"), ["dee", "eve"], "rejected"),
    ]);
    expect(pairs).toEqual(
      new Set([pairKey("ada", "bob"), pairKey("ada", "cy"), pairKey("bob", "cy")]),
    );
    expect(pairKey("cy", "ada")).toBe(pairKey("ada", "cy"));
  });

  it("holds a member for 14 days per place after a city intro", () => {
    const history = [intro(cityIntroKey("sf-bay-area", "ada", "2026-10-01"), ["ada", "bob"])];
    expect(onCityCooldown(history, "sf-bay-area", "bob", "2026-10-14")).toBe(true);
    expect(onCityCooldown(history, "sf-bay-area", "bob", "2026-10-15")).toBe(false);
    expect(onCityCooldown(history, "new-york", "bob", "2026-10-05")).toBe(false);
    expect(onCityCooldown(history, "sf-bay-area", "cy", "2026-10-05")).toBe(false);
  });
});

describe("isAtHome", () => {
  const boston = { city: "Boston" };
  it("reads the stated home: current city, else location, else Slack's", () => {
    expect(isAtHome({ current_city: "Cambridge, MA" }, boston)).toBe(true);
    expect(isAtHome({ location: "Somerville" }, boston)).toBe(true);
    expect(isAtHome({ slack_location: "Boston, MA" }, boston)).toBe(true);
    expect(isAtHome({ current_city: "Toronto", location: "Boston" }, boston)).toBe(false);
  });

  it("counts somebody with no stated home as visiting", () => {
    expect(isAtHome({}, boston)).toBe(false);
    expect(isAtHome({ current_city: "  " }, boston)).toBe(false);
  });
});
