import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  ADMINBOT_LOCATION_CHECKIN_DAYS,
  ADMINBOT_LOCATION_CHECKIN_SNOOZE_DAYS,
  answeredFields,
  checkinAnswerEntry,
  checkinNonAnswerEntry,
  locationCheckin,
  snoozedUntil,
} from "./location-checkin.js";
import { latestBySource } from "./location-history.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

// Synthetic member; no real names.
function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "m_test",
    name: "Test Person",
    privilege_level: "member",
    access: [],
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const signedInFrom = (city: string, region: string, country: string, ago = 1) => ({
  last_login_city: city,
  last_login_region: region,
  last_login_country: country,
  last_login_at: daysAgo(ago),
});

const slack = (zone: string, ago = 1) => ({ slack_tz: zone, slack_tz_observed_at: daysAgo(ago) });

describe("locationCheckin", () => {
  it("uses a 60-day window by default", () => {
    expect(ADMINBOT_LOCATION_CHECKIN_DAYS).toBe(60);
    expect(ADMINBOT_LOCATION_CHECKIN_SNOOZE_DAYS).toBe(7);
  });

  it("does not ask when a fresh sign-in city and the Slack zone agree", () => {
    const result = locationCheckin(
      member({ ...signedInFrom("Toronto", "Ontario", "CA"), ...slack("America/Toronto") }),
      NOW,
    );
    expect(result).toMatchObject({ due: false, reason: "signals_agree" });
    expect(result.suggestion).toEqual({ city: "Toronto", source: "login" });
  });

  it("asks early, with a note, when the stated city and the Slack zone disagree", () => {
    const result = locationCheckin(
      member({ current_city: "Toronto", ...slack("Europe/Berlin") }),
      NOW,
    );
    expect(result.due).toBe(true);
    expect(result.reason).toBe("timezone_mismatch");
    expect(result.note).toContain("Europe/Berlin");
    expect(result.note).toContain("Slack time zone");
  });

  it("asks when the IP city disagrees with the Slack zone, offering the zone's city", () => {
    const result = locationCheckin(
      member({ ...signedInFrom("Toronto", "Ontario", "CA"), ...slack("Europe/Berlin") }),
      NOW,
    );
    expect(result).toMatchObject({ due: true, reason: "ip_suspected_vpn" });
    // The IP city is not offered: it is the thing in doubt.
    expect(result.suggestion).toEqual({ city: "Berlin", source: "slack_tz" });
  });

  it("asks a member on a VPN where they are, guessing from the browser's zone", () => {
    const result = locationCheckin(
      member({
        ...signedInFrom("Toronto", "Ontario", "CA"),
        last_ip_observed_at: daysAgo(0),
        last_ip_suspected_vpn: true,
        last_device_tz: "Europe/Zurich",
        last_device_tz_at: daysAgo(0),
        ...slack("Europe/Zurich"),
      }),
      NOW,
    );
    expect(result).toMatchObject({
      due: true,
      reason: "ip_suspected_vpn",
      suggestion: { city: "Zürich", source: "device_tz" },
    });
  });

  it("does not ask the VPN question once the member answered recently", () => {
    const result = locationCheckin(
      member({
        ...signedInFrom("Toronto", "Ontario", "CA"),
        last_ip_observed_at: daysAgo(0),
        last_ip_suspected_vpn: true,
        location_checkin_at: daysAgo(5),
        location_checkin_city: "Zurich",
      }),
      NOW,
    );
    expect(result).toMatchObject({ due: false, reason: "answered" });
  });

  it("trusts an IP city that agrees with the browser's zone even when Slack disagrees", () => {
    const result = locationCheckin(
      member({
        ...signedInFrom("Toronto", "Ontario", "CA"),
        last_device_tz: "America/Toronto",
        last_device_tz_at: daysAgo(0),
        ...slack("Europe/Berlin"),
      }),
      NOW,
    );
    expect(result).toMatchObject({ due: false, reason: "signals_agree" });
    expect(result.suggestion).toEqual({ city: "Toronto", source: "login" });
  });

  it("asks when nothing places the member, and offers no guess", () => {
    expect(locationCheckin(member(), NOW)).toEqual({ due: true, reason: "no_guess" });
  });

  it("offers the Slack zone's city, then the stored city, for one tap", () => {
    expect(locationCheckin(member({ ...slack("America/Vancouver") }), NOW).suggestion).toEqual({
      city: "Vancouver",
      source: "slack_tz",
    });
    expect(locationCheckin(member({ current_city: "Zurich" }), NOW)).toMatchObject({
      due: true,
      reason: "no_guess",
      suggestion: { city: "Zürich", source: "stored" },
    });
  });

  it("compares a stored city with the Slack zone when there is no fresh sign-in", () => {
    const result = locationCheckin(
      member({ current_city: "Toronto", ...slack("Asia/Tokyo") }),
      NOW,
    );
    expect(result.reason).toBe("timezone_mismatch");
  });

  it("ignores a stale sign-in and a stale Slack zone", () => {
    const result = locationCheckin(
      member({ ...signedInFrom("Toronto", "Ontario", "CA", 30), ...slack("Europe/Berlin", 90) }),
      NOW,
    );
    expect(result).toEqual({ due: true, reason: "no_guess" });
  });

  it("does not use a sign-in city for a member who chose 'stated' on the map", () => {
    const result = locationCheckin(
      member({ map_visibility: "stated", ...signedInFrom("Toronto", "Ontario", "CA") }),
      NOW,
    );
    expect(result).toEqual({ due: true, reason: "no_guess" });
  });

  it("is not asked again within the window after an answer, and is asked once it lapses", () => {
    expect(
      locationCheckin(
        member({ location_checkin_at: daysAgo(59), location_checkin_city: "Toronto" }),
        NOW,
      ),
    ).toMatchObject({ due: false, reason: "answered", last_answered_city: "Toronto" });
    expect(
      locationCheckin(
        member({ location_checkin_at: daysAgo(61), location_checkin_city: "Toronto" }),
        NOW,
      ),
    ).toMatchObject({ due: true, reason: "no_guess", last_answered_city: "Toronto" });
  });

  it("an answer within the window wins even over a mismatch: at most one ask per window", () => {
    const result = locationCheckin(
      member({
        location_checkin_at: daysAgo(10),
        ...signedInFrom("Toronto", "Ontario", "CA"),
        ...slack("Europe/Berlin"),
      }),
      NOW,
    );
    expect(result.reason).toBe("answered");
  });

  it("stays quiet while snoozed, and asks again after", () => {
    const snoozed = member({ location_checkin_snoozed_until: snoozedUntil(new Date(daysAgo(3))) });
    expect(locationCheckin(snoozed, NOW)).toMatchObject({ due: false, reason: "snoozed" });
    const expired = member({ location_checkin_snoozed_until: snoozedUntil(new Date(daysAgo(8))) });
    expect(locationCheckin(expired, NOW).due).toBe(true);
  });

  it("never asks a member who declined, is hidden from the map, or has left", () => {
    expect(
      locationCheckin(member({ location_checkin_declined_at: daysAgo(200) }), NOW).reason,
    ).toBe("declined");
    expect(locationCheckin(member({ map_visibility: "hidden" }), NOW).reason).toBe("hidden");
    expect(locationCheckin(member({ status: "alumni" }), NOW).due).toBe(false);
  });
});

describe("check-in log entries", () => {
  it("a one-tap confirm is a self_reported row with the resolved place", () => {
    const entry = checkinAnswerEntry(
      "m_test",
      { text: "Toronto", via: "picker" },
      NOW.toISOString(),
    );
    expect(entry).toMatchObject({
      member_id: "m_test",
      source: "self_reported",
      observed_at: NOW.toISOString(),
      raw: "Toronto",
      place_key: "toronto",
      place_label: "Toronto",
      country: "Canada",
      checkin: "answered",
      checkin_via: "picker",
      observed_at_local: "2026-07-15T08:00:00-04:00",
    });
  });

  it("keeps free text the gazetteer cannot place, verbatim", () => {
    const entry = checkinAnswerEntry(
      "m_test",
      { text: "  Smalltown  ", via: "text" },
      NOW.toISOString(),
    );
    expect(entry?.raw).toBe("Smalltown");
    expect(entry?.place_key).toBeUndefined();
  });

  it("records nothing for an empty answer", () => {
    expect(
      checkinAnswerEntry("m_test", { text: "  ", via: "text" }, NOW.toISOString()),
    ).toBeUndefined();
  });

  it("logs snoozes and declines as rows that place nothing and never count as the latest place", () => {
    const answer = checkinAnswerEntry("m_test", { text: "Toronto", via: "picker" }, daysAgo(2))!;
    const snooze = checkinNonAnswerEntry("m_test", "snoozed", daysAgo(1));
    const decline = checkinNonAnswerEntry("m_test", "declined", NOW.toISOString());
    expect(snooze).toMatchObject({ source: "self_reported", checkin: "snoozed" });
    expect(snooze.place_key).toBeUndefined();
    expect(decline).toMatchObject({ checkin: "declined", raw: "Prefer not to say" });
    expect(latestBySource([answer, snooze, decline]).get("self_reported")?.id).toBe(answer.id);
  });

  it("an answer stamps when and what, and ends a snooze", () => {
    expect(answeredFields({ text: " Berlin " }, NOW.toISOString())).toEqual({
      location_checkin_at: NOW.toISOString(),
      location_checkin_city: "Berlin",
      location_checkin_snoozed_until: undefined,
    });
  });
});
