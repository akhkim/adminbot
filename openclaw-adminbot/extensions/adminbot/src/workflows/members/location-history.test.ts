import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotMemberLocationEntry } from "../../contracts/actions.js";
import {
  detectLocationDrift,
  isNewObservation,
  latestBySource,
  observationFor,
  profileCountry,
  selfReportedChange,
} from "./location-history.js";

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

function login(day: string, country: string): AdminBotMemberLocationEntry {
  return {
    id: `loc-${day}-${country}`,
    member_id: "m-ada",
    observed_at: `2026-08-${day}T09:00:00.000Z`,
    source: "login_ip",
    raw: country,
    country,
  };
}

describe("observationFor", () => {
  it("resolves a login country and a profile city through different resolvers", () => {
    const fromLogin = observationFor({
      memberId: "m-ada",
      source: "login_ip",
      raw: "Germany",
      observedAt: "2026-08-12T09:00:00.000Z",
    });
    expect(fromLogin).toMatchObject({ country: "Germany", source: "login_ip" });

    const fromProfile = observationFor({
      memberId: "m-ada",
      source: "self_reported",
      raw: "Toronto, Canada",
      observedAt: "2026-08-12T09:00:00.000Z",
    });
    expect(fromProfile).toMatchObject({ place_key: "toronto", country: "Canada" });
  });

  // An unplaceable string is the entry that tells an admin to extend the gazetteer, so it must not
  // be silently dropped.
  it("records text the gazetteer cannot place", () => {
    const entry = observationFor({
      memberId: "m-ada",
      source: "self_reported",
      raw: "somewhere with wifi",
      observedAt: "2026-08-12T09:00:00.000Z",
    });
    expect(entry?.raw).toBe("somewhere with wifi");
    expect(entry?.place_key).toBeUndefined();
  });

  it("records nothing for empty text", () => {
    expect(
      observationFor({
        memberId: "m-ada",
        source: "self_reported",
        raw: "   ",
        observedAt: "2026-08-12T09:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  // A timezone is a different claim from a country, and countries with several zones would make an
  // inferred one a guess presented as fact.
  it("keeps a timezone only on a self-report", () => {
    const inferred = observationFor({
      memberId: "m-ada",
      source: "login_ip",
      raw: "Germany",
      observedAt: "2026-08-12T09:00:00.000Z",
      timezone: "Europe/Berlin",
    });
    expect(inferred?.timezone).toBeUndefined();
    const stated = observationFor({
      memberId: "m-ada",
      source: "self_reported",
      raw: "Berlin",
      observedAt: "2026-08-12T09:00:00.000Z",
      timezone: "Europe/Berlin",
    });
    expect(stated?.timezone).toBe("Europe/Berlin");
  });
});

describe("isNewObservation", () => {
  const at = (raw: string, placeKey?: string): AdminBotMemberLocationEntry => ({
    id: raw,
    member_id: "m-ada",
    observed_at: "2026-08-12T09:00:00.000Z",
    source: "self_reported",
    raw,
    ...(placeKey ? { place_key: placeKey } : {}),
  });

  // Otherwise a member who signs in twice a day writes 700 identical rows a year and the timeline
  // stops being a change log.
  it("is false for a restatement of the same place", () => {
    expect(isNewObservation(at("Toronto", "toronto"), at("Toronto, Canada", "toronto"))).toBe(false);
  });

  it("is true for a different place", () => {
    expect(isNewObservation(at("Toronto", "toronto"), at("Berlin", "berlin"))).toBe(true);
  });

  it("compares unplaceable text as text", () => {
    expect(isNewObservation(at("the boat"), at("The Boat "))).toBe(false);
    expect(isNewObservation(at("the boat"), at("a different boat"))).toBe(true);
  });

  it("is true for the first observation of all", () => {
    expect(isNewObservation(undefined, at("Toronto", "toronto"))).toBe(true);
  });
});

describe("detectLocationDrift", () => {
  const ada = member({ location: "Toronto" });

  it("asks once the sign-ins have disagreed for long enough", () => {
    const drift = detectLocationDrift(
      ada,
      [login("01", "Canada"), login("10", "Germany"), login("14", "Germany")],
      new Date("2026-08-14T12:00:00.000Z"),
    );
    expect(drift).toMatchObject({
      observed_country: "Germany",
      profile_country: "Canada",
      profile_location: "Toronto",
      since: "2026-08-10T09:00:00.000Z",
      observation_count: 2,
    });
  });

  // A conference is one or two days from one place; asking about it is noise.
  it("stays quiet for a trip too short to be a move", () => {
    expect(
      detectLocationDrift(
        ada,
        [login("12", "Germany"), login("13", "Germany")],
        new Date("2026-08-13T12:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  it("stays quiet on a single sign-in from somewhere else", () => {
    expect(
      detectLocationDrift(ada, [login("14", "Germany")], new Date("2026-08-14T12:00:00.000Z")),
    ).toBeUndefined();
  });

  // Canada -> Germany -> Canada -> Germany is not a month in Germany, and counting every German
  // row would claim it was.
  it("counts only the unbroken run of the current country", () => {
    expect(
      detectLocationDrift(
        ada,
        [login("01", "Germany"), login("05", "Canada"), login("14", "Germany")],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  it("stays quiet when the profile already agrees", () => {
    expect(
      detectLocationDrift(
        member({ location: "Toronto", current_city: "Berlin" }),
        [login("10", "Germany"), login("14", "Germany")],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  it("stays quiet when the profile says nothing to disagree with", () => {
    expect(
      detectLocationDrift(
        member(),
        [login("10", "Germany"), login("14", "Germany")],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  // "No, still Toronto" has to settle it, or the prompt becomes something people learn to ignore.
  it("does not re-ask about a country the member already answered on", () => {
    expect(
      detectLocationDrift(
        member({
          location: "Toronto",
          location_prompt_answered_at: "2026-08-11T00:00:00.000Z",
          location_prompt_answered_country: "Germany",
        }),
        [login("10", "Germany"), login("14", "Germany")],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  it("asks again when they turn up somewhere new", () => {
    expect(
      detectLocationDrift(
        member({
          location: "Toronto",
          location_prompt_answered_at: "2026-08-11T00:00:00.000Z",
          location_prompt_answered_country: "Germany",
        }),
        [login("10", "Japan"), login("14", "Japan")],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).toMatchObject({ observed_country: "Japan" });
  });

  // A dismissal from before the trip started cannot settle a trip that had not happened yet.
  it("asks again when the dismissal predates this divergence", () => {
    expect(
      detectLocationDrift(
        member({
          location: "Toronto",
          location_prompt_answered_at: "2026-07-01T00:00:00.000Z",
          location_prompt_answered_country: "Germany",
        }),
        [login("10", "Germany"), login("14", "Germany")],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).toMatchObject({ observed_country: "Germany" });
  });
});

describe("latestBySource", () => {
  it("keeps the newest entry per source", () => {
    const latest = latestBySource([
      login("01", "Canada"),
      login("14", "Germany"),
      {
        id: "self",
        member_id: "m-ada",
        observed_at: "2026-08-02T00:00:00.000Z",
        source: "self_reported",
        raw: "Toronto",
      },
    ]);
    expect(latest.get("login_ip")?.country).toBe("Germany");
    expect(latest.get("self_reported")?.raw).toBe("Toronto");
    expect(latest.get("slack_profile")).toBeUndefined();
  });
});

describe("profileCountry", () => {
  it("prefers where they are now over where they live", () => {
    expect(profileCountry(member({ location: "Toronto", current_city: "Berlin" }))).toBe("Germany");
    expect(profileCountry(member({ location: "Toronto" }))).toBe("Canada");
    expect(profileCountry(member())).toBeUndefined();
  });

  it("lets a logged trip override both, for days it covers", () => {
    const traveller = member({
      location: "Toronto",
      trips: [{ start: "2026-09-01", end: "2026-09-30", city: "Berlin" }],
    });
    expect(profileCountry(traveller, "2026-09-15")).toBe("Germany");
    expect(profileCountry(traveller, "2026-10-15")).toBe("Canada");
  });
});

describe("trips and the drift prompt", () => {
  // A member who wrote down "Berlin, 1-30 September" has already answered the question. Asking it
  // anyway is how a system teaches people that filling things in changes nothing.
  it("does not ask about a country the member already logged a trip to", () => {
    expect(
      detectLocationDrift(
        member({
          location: "Toronto",
          trips: [{ start: "2026-08-01", end: "2026-08-31", city: "Berlin" }],
        }),
        [login("10", "Germany"), login("14", "Germany")],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  it("still asks once the trip is over", () => {
    expect(
      detectLocationDrift(
        member({
          location: "Toronto",
          trips: [{ start: "2026-07-01", end: "2026-07-31", city: "Berlin" }],
        }),
        [login("10", "Germany"), login("14", "Germany")],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).toMatchObject({ observed_country: "Germany" });
  });

  it("asks when the sign-ins disagree with the trip too", () => {
    expect(
      detectLocationDrift(
        member({
          location: "Toronto",
          trips: [{ start: "2026-08-01", end: "2026-08-31", city: "Berlin" }],
        }),
        [login("10", "Japan"), login("14", "Japan")],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).toMatchObject({ observed_country: "Japan", profile_location: "Berlin" });
  });
});

describe("selfReportedChange", () => {
  it("is silent when an edit did not touch where the member is", () => {
    const before = member({ location: "Toronto", role: "PhD Student" });
    expect(selfReportedChange(before, { ...before, role: "Postdoc" })).toBeUndefined();
  });

  it("reports a move, with the timezone the member stated alongside it", () => {
    const before = member({ location: "Toronto" });
    expect(
      selfReportedChange(before, {
        ...before,
        current_city: "Berlin",
        timezone: "Europe/Berlin",
      }),
    ).toEqual({ raw: "Berlin", timezone: "Europe/Berlin" });
  });

  it("treats a restatement as no change", () => {
    const before = member({ location: "Toronto" });
    expect(selfReportedChange(before, { ...before, location: " toronto " })).toBeUndefined();
  });
});
