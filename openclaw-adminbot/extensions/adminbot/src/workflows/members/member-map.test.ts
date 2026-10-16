import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  buildMemberMap,
  memberMapVisibility,
  isHiddenFromMemberMap,
  memberMapMemo,
  resolveCountry,
  resolveLoginCity,
  resolvePlace,
  toPrivilegedMemberMap,
} from "./member-map.js";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "m1",
    name: "Member One",
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolvePlace", () => {
  it("resolves a bare city, and a city with its country", () => {
    expect(resolvePlace("Toronto")?.label).toBe("Toronto");
    expect(resolvePlace("Kigali, Rwanda")?.label).toBe("Kigali");
    expect(resolvePlace("Pittsburgh, US")?.label).toBe("Pittsburgh");
  });

  it("resolves the institutions people write instead of a city", () => {
    expect(resolvePlace("ETH")?.label).toBe("Zürich");
    expect(resolvePlace("CMU")?.label).toBe("Pittsburgh");
    expect(resolvePlace("Mila")?.label).toBe("Montréal");
  });

  it("ignores accents and spelling variants", () => {
    expect(resolvePlace("Zürich")?.key).toBe("zurich");
    expect(resolvePlace("Tübingen")?.key).toBe("tuebingen");
    expect(resolvePlace("Tuebingen")?.key).toBe("tuebingen");
    expect(resolvePlace("Bangalore")?.key).toBe("bengaluru");
  });

  it("takes the first of several places, since the rest are travel or a second base", () => {
    expect(resolvePlace("Zurich/Tuebingen/Toronto")?.label).toBe("Zürich");
    expect(resolvePlace("Toronto/London")?.label).toBe("Toronto");
    expect(resolvePlace("Warsaw, Poland; Alicante, Spain (starting November)")?.label).toBe(
      "Warsaw",
    );
  });

  it("strips parentheticals and leading hedges", () => {
    expect(resolvePlace("Mainly Montreal (can visit Toronto too, whenever is needed)")?.key).toBe(
      "montreal",
    );
    expect(resolvePlace("currently Berlin")?.label).toBe("Berlin");
  });

  it("reads the city out of an IANA timezone", () => {
    expect(resolvePlace("America/Toronto")?.label).toBe("Toronto");
    expect(resolvePlace("Europe/Zurich")?.label).toBe("Zürich");
    // A three-segment zone reads its last segment, and a city the gazetteer lacks stays unplaced.
    expect(resolvePlace("America/Argentina/Buenos_Aires")?.label).toBe("Buenos Aires");
    expect(resolvePlace("America/Argentina/Ushuaia")).toBeUndefined();
  });

  it("does not mistake two slash-separated cities for a timezone", () => {
    // "Toronto/London" is two places, not Region/City — reading it as a timezone would
    // silently place the person in the last one.
    expect(resolvePlace("Toronto/London")?.label).toBe("Toronto");
    expect(resolvePlace("Toronto/Zurich/Global")?.label).toBe("Toronto");
  });

  it("returns nothing for text it cannot place, rather than guessing", () => {
    expect(resolvePlace("Global")).toBeUndefined();
    expect(resolvePlace("remote")).toBeUndefined();
    expect(resolvePlace("")).toBeUndefined();
    expect(resolvePlace(undefined)).toBeUndefined();
  });
});

describe("resolveCountry", () => {
  it("resolves a known country name, case- and accent-insensitively", () => {
    expect(resolveCountry("Switzerland")?.label).toBe("Switzerland");
    expect(resolveCountry("switzerland")?.key).toBe("country:switzerland");
    expect(resolveCountry("SWITZERLAND")?.key).toBe("country:switzerland");
  });

  it("resolves the ISO codes IPinfo's core endpoint answers with, under the canonical name", () => {
    // The core lookup (the one that also returns a city) stores "CH", not "Switzerland".
    expect(resolveCountry("CH")).toEqual(resolveCountry("Switzerland"));
    expect(resolveCountry("CH")?.label).toBe("Switzerland");
    expect(resolveCountry("us")?.key).toBe("country:united states");
    expect(resolveCountry("GB")?.label).toBe("United Kingdom");
    expect(resolveCountry("IN")?.label).toBe("India");
  });

  it("folds alternate spellings into one place", () => {
    expect(resolveCountry("Czech Republic")?.key).toBe(resolveCountry("Czechia")?.key);
    expect(resolveCountry("Türkiye")?.label).toBe("Turkey");
    expect(resolveCountry("UK")?.label).toBe("United Kingdom");
  });

  it("returns nothing for a country not in the table, rather than guessing", () => {
    expect(resolveCountry("Narnia")).toBeUndefined();
    expect(resolveCountry("XX")).toBeUndefined();
    expect(resolveCountry("")).toBeUndefined();
    expect(resolveCountry(undefined)).toBeUndefined();
  });
});

describe("buildMemberMap", () => {
  it("falls back to last-login country when Slack has nothing and roster is empty", () => {
    const map = buildMemberMap([
      member({ id: "a", name: "Ada", last_login_country: "Switzerland" }),
    ]);
    expect(map.places[0]?.label).toBe("Switzerland");
    expect(map.places[0]?.members).toEqual([
      { member_id: "a", name: "Ada", source: "login", precision: "country" },
    ]);
  });

  it("carries avatar_url and last_login_at through when present, and omits them when absent", () => {
    const map = buildMemberMap([
      member({
        id: "a",
        name: "Ada",
        last_login_country: "Switzerland",
        avatar_url: "https://example.com/ada.png",
        last_login_at: "2026-01-05T00:00:00.000Z",
      }),
      member({ id: "b", name: "Bo", last_login_country: "Switzerland" }),
    ]);
    expect(map.places[0]?.members).toEqual([
      {
        member_id: "a",
        name: "Ada",
        source: "login",
        precision: "country",
        avatar_url: "https://example.com/ada.png",
        last_login_at: "2026-01-05T00:00:00.000Z",
        // The map row is dated by the observation that placed it: here, the sign-in.
        located_at: "2026-01-05T00:00:00.000Z",
      },
      { member_id: "b", name: "Bo", source: "login", precision: "country" },
    ]);
  });

  it("orders by specificity: a stated city, then a timezone's city, then a country", () => {
    const map = buildMemberMap(
      [
        // A stated roster city beats the city Slack's timezone is named for: "Europe/Zurich" is
        // also what somebody in Basel or Bern reports.
        member({
          id: "a",
          name: "Ada",
          slack_user_id: "U1",
          last_login_country: "Germany",
          location: "Toronto",
        }),
        // No stated city: the timezone's city beats a login country.
        member({ id: "d", name: "Di", slack_user_id: "U4", last_login_country: "Germany" }),
        // Slack has nothing at all: the stated roster location wins over an inferred login.
        member({ id: "b", name: "Bo", last_login_country: "India", location: "Toronto" }),
        // Slack has unresolvable text ("remote") and the roster is empty: falls to last-login.
        member({ id: "c", name: "Cy", slack_user_id: "U3", last_login_country: "Japan" }),
      ],
      new Map([
        ["U1", "Europe/Zurich"],
        ["U3", "remote"],
        ["U4", "Europe/Zurich"],
      ]),
    );
    const byMemberId = new Map(
      map.places.flatMap((place) => place.members.map((m) => [m.member_id, { place, member: m }])),
    );
    expect(byMemberId.get("a")?.place.label).toBe("Toronto");
    expect(byMemberId.get("a")?.member).toMatchObject({ source: "roster", precision: "city" });
    expect(byMemberId.get("d")?.place.label).toBe("Zürich");
    expect(byMemberId.get("d")?.member).toMatchObject({ source: "slack", precision: "timezone" });
    expect(byMemberId.get("b")?.place.label).toBe("Toronto");
    expect(byMemberId.get("b")?.member.source).toBe("roster");
    expect(byMemberId.get("c")?.place.label).toBe("Japan");
    expect(byMemberId.get("c")?.member.source).toBe("login");
  });

  it("falls through to last-login when Slack and the roster both fail to resolve", () => {
    const map = buildMemberMap(
      [
        member({
          id: "a",
          name: "Ada",
          slack_user_id: "U1",
          last_login_country: "CA",
          location: "somewhere nice",
        }),
      ],
      new Map([["U1", "remote"]]),
    );
    expect(map.places[0]?.label).toBe("Canada");
    expect(map.places[0]?.key).toBe("country:canada");
    expect(map.places[0]?.members).toEqual([
      { member_id: "a", name: "Ada", source: "login", precision: "country" },
    ]);
  });

  describe("login city", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const traveller = (overrides: Partial<AdminBotLabMember> = {}) =>
      member({
        id: "t",
        name: "Tess",
        last_login_country: "FR",
        last_login_city: "Lyon",
        last_login_at: "2026-10-14T08:00:00.000Z",
        ...overrides,
      });

    it("places a member at a fresh login city when the caller may read it", () => {
      const map = buildMemberMap([traveller()], new Map(), { loginCity: true, now });
      expect(map.places[0]).toMatchObject({ key: "lyon", label: "Lyon", country: "France" });
      expect(map.places[0]?.members[0]?.source).toBe("login");
    });

    it("never uses the city for a caller who may not read it -- the country instead", () => {
      // The default is off, so a caller that forgets to pass the flag cannot leak a city.
      for (const options of [{ now }, { loginCity: false, now }]) {
        const map = buildMemberMap([traveller()], new Map(), options);
        expect(map.places[0]?.key).toBe("country:france");
        expect(JSON.stringify(map)).not.toContain("Lyon");
      }
    });

    it("drops a stale or undated city back to the country", () => {
      for (const last_login_at of ["2026-10-01T08:00:00.000Z", "not a date", undefined]) {
        const map = buildMemberMap([traveller({ last_login_at })], new Map(), {
          loginCity: true,
          now,
        });
        expect(map.places[0]?.key).toBe("country:france");
      }
    });

    it("falls back to the country for a city the gazetteer does not know", () => {
      const map = buildMemberMap(
        [traveller({ last_login_city: "Villeurbanne-sur-Mer" })],
        new Map(),
        {
          loginCity: true,
          now,
        },
      );
      expect(map.places[0]?.key).toBe("country:france");
    });

    it("pins a login city at the city, and a country-only login at the country", () => {
      const map = buildMemberMap(
        [
          traveller({
            id: "c",
            name: "City",
            last_login_country: "CA",
            last_login_city: "Toronto",
          }),
          traveller({ id: "n", name: "Nation", last_login_country: "CA", last_login_city: "" }),
        ],
        new Map(),
        { loginCity: true, now },
      );
      const byKey = new Map(map.places.map((place) => [place.key, place]));
      expect(byKey.get("toronto")?.members).toMatchObject([
        { member_id: "c", source: "login", precision: "city" },
      ]);
      expect(byKey.get("country:canada")?.members).toMatchObject([
        { member_id: "n", source: "login", precision: "country" },
      ]);
    });

    it("uses the region to tell London, ON from London, England", () => {
      const map = buildMemberMap(
        [
          traveller({
            last_login_country: "CA",
            last_login_city: "London",
            last_login_region: "Ontario",
          }),
        ],
        new Map(),
        { loginCity: true, now },
      );
      expect(map.places[0]).toMatchObject({ key: "london-on", country: "Canada" });
    });

    it("never lets a country-only sign-in beat a stated or timezone city", () => {
      const map = buildMemberMap(
        [
          member({ id: "s", name: "Sa", slack_user_id: "U1", last_login_country: "DE" }),
          member({ id: "r", name: "Ro", current_city: "San Francisco", last_login_country: "DE" }),
        ],
        new Map([["U1", "America/Toronto"]]),
        { loginCity: true, now },
      );
      expect(map.places.map((place) => place.key).toSorted()).toEqual(["san-francisco", "toronto"]);
      expect(map.places.some((place) => place.key === "country:germany")).toBe(false);
    });

    it("outranks every stated city while it is fresh", () => {
      const map = buildMemberMap(
        [traveller({ location: "Toronto", current_city: "Berlin", slack_user_id: "U1" })],
        new Map([["U1", "Paris"]]),
        { loginCity: true, now },
      );
      expect(map.places[0]?.label).toBe("Lyon");
      expect(map.places[0]?.members[0]).toMatchObject({
        source: "login",
        precision: "city",
        last_login_at: "2026-10-14T08:00:00.000Z",
      });
    });

    it("counts a sign-in as fresh for 14 days, then falls back to what the member stated", () => {
      const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
      const place = (last_login_at: string) =>
        buildMemberMap([traveller({ current_city: "Toronto", last_login_at })], new Map(), {
          loginCity: true,
          now,
        }).places[0];
      expect(place(at(13.9))?.key).toBe("lyon");
      const stale = place(at(14.1));
      expect(stale?.key).toBe("toronto");
      // The sign-in time is only sent when a sign-in placed the member.
      expect(stale?.members[0]).toEqual({
        member_id: "t",
        name: "Tess",
        source: "roster",
        precision: "city",
      });
    });

    it("respects the member's own map_visibility", () => {
      const stated = buildMemberMap(
        [traveller({ current_city: "Toronto", map_visibility: "stated" })],
        new Map(),
        { loginCity: true, now },
      );
      expect(stated.places[0]).toMatchObject({ key: "toronto" });
      expect(JSON.stringify(stated)).not.toContain("Lyon");
      // With nothing stated, "stated" does not quietly fall back to the sign-in country either.
      const nothingStated = buildMemberMap([traveller({ map_visibility: "stated" })], new Map(), {
        loginCity: true,
        now,
      });
      expect(nothingStated.places).toEqual([]);
      expect(nothingStated.counts.unknown).toBe(1);

      const hidden = buildMemberMap(
        [traveller({ current_city: "Toronto", map_visibility: "hidden" })],
        new Map(),
        { loginCity: true, now },
      );
      expect(hidden).toEqual({
        places: [],
        unplaced: [],
        counts: { placed: 0, unplaced: 0, unknown: 0 },
      });

      // Absent or unrecognised is "auto".
      expect(memberMapVisibility({})).toBe("auto");
      expect(memberMapVisibility({ map_visibility: "nonsense" as never })).toBe("auto");
    });
  });

  it("reports the highest-priority source with text when nothing resolves at all", () => {
    const map = buildMemberMap(
      [member({ id: "a", name: "Ada", slack_user_id: "U1", last_login_country: "Narnia" })],
      new Map([["U1", "remote"]]),
    );
    expect(map.unplaced).toEqual([{ member_id: "a", name: "Ada", raw: "remote", source: "slack" }]);
  });

  it("prefers current_city, then the roster location, then the Slack profile city", () => {
    const map = buildMemberMap(
      [
        member({ id: "a", name: "Ada", slack_user_id: "U1" }),
        member({ id: "b", name: "Bo", slack_user_id: "U2", location: "Toronto" }),
        member({ id: "c", name: "Cy", location: "Berlin", current_city: "Paris" }),
      ],
      // A profile location field is free text the member typed, so it ranks with the roster.
      new Map([["U1", "Zurich, Switzerland"]]),
    );

    const byLabel = new Map(map.places.map((place) => [place.label, place]));
    expect(byLabel.get("Zürich")?.members).toEqual([
      { member_id: "a", name: "Ada", source: "slack", precision: "city" },
    ]);
    // Bo has a Slack id but no Slack location, so the roster is used.
    expect(byLabel.get("Toronto")?.members).toEqual([
      { member_id: "b", name: "Bo", source: "roster", precision: "city" },
    ]);
    // Where somebody is right now beats where they live.
    expect(byLabel.get("Paris")?.members).toEqual([
      { member_id: "c", name: "Cy", source: "roster", precision: "city" },
    ]);
    expect(byLabel.has("Berlin")).toBe(false);
  });

  it("treats a blank Slack location as no location at all", () => {
    const map = buildMemberMap(
      [member({ id: "a", name: "Ada", slack_user_id: "U1", location: "Toronto" })],
      new Map([["U1", "   "]]),
    );
    expect(map.places[0]?.members[0]?.source).toBe("roster");
  });

  it("groups members by place, biggest first", () => {
    const map = buildMemberMap([
      member({ id: "a", name: "Ada", location: "Toronto" }),
      member({ id: "b", name: "Bo", location: "ETH" }),
      member({ id: "c", name: "Cy", location: "Toronto" }),
    ]);
    expect(map.places.map((place) => [place.label, place.members.length])).toEqual([
      ["Toronto", 2],
      ["Zürich", 1],
    ]);
    expect(map.places[0]?.members.map((m) => m.name)).toEqual(["Ada", "Cy"]);
  });

  it("reports unplaceable text with what the member wrote, and counts it apart from no location at all", () => {
    const map = buildMemberMap([
      member({ id: "a", name: "Ada", location: "Toronto" }),
      member({ id: "b", name: "Bo", location: "somewhere nice" }),
      member({ id: "c", name: "Cy" }),
    ]);
    expect(map.counts).toEqual({ placed: 1, unplaced: 1, unknown: 1 });
    expect(map.unplaced).toEqual([
      { member_id: "b", name: "Bo", raw: "somewhere nice", source: "roster" },
      { member_id: "c", name: "Cy" },
    ]);
  });

  it("places a member by the roster timezone when nothing else is written", () => {
    const map = buildMemberMap([member({ id: "a", name: "Ada", timezone: "Europe/London" })]);
    expect(map.places[0]).toMatchObject({ key: "london" });
    expect(map.places[0]?.members[0]).toMatchObject({ source: "roster", precision: "timezone" });
  });

  it("pins a written country at the country, never at a guessed city", () => {
    const map = buildMemberMap([member({ id: "a", name: "Ada", location: "Germany" })]);
    expect(map.places[0]?.key).toBe("country:germany");
    expect(map.places[0]?.members[0]?.precision).toBe("country");
  });

  it("keeps alumni and opted-out members off the map even with a login city", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const login = {
      last_login_country: "CA",
      last_login_city: "Toronto",
      last_login_at: "2026-10-14T08:00:00.000Z",
    };
    const map = buildMemberMap(
      [
        member({ id: "z", name: "Zed", status: "alumni", ...login }),
        member({ id: "n", name: "Null,do not contact", ...login }),
      ],
      new Map(),
      { loginCity: true, now },
    );
    expect(map.places).toEqual([]);
    expect(map.unplaced).toEqual([]);
  });

  it("leaves alumni off the map", () => {
    const map = buildMemberMap([
      member({ id: "a", name: "Ada", location: "Toronto" }),
      member({ id: "z", name: "Zed", location: "Toronto", status: "alumni" }),
    ]);
    expect(map.places[0]?.members.map((m) => m.name)).toEqual(["Ada"]);
    expect(map.counts.placed).toBe(1);
  });
});

describe("resolveLoginCity", () => {
  it("only accepts a place in the reported country", () => {
    expect(resolveLoginCity("London", "Ontario", "CA")?.key).toBe("london-on");
    expect(resolveLoginCity("London", undefined, "CA")?.key).toBe("london-on");
    expect(resolveLoginCity("London", "England", "GB")?.key).toBe("london");
    expect(resolveLoginCity("Toronto", "Ontario", "FR")).toBeUndefined();
    expect(resolveLoginCity("", "Ontario", "CA")).toBeUndefined();
  });
});

describe("isHiddenFromMemberMap", () => {
  it.each([
    "",
    "   ",
    "null",
    "Null",
    " NULL ",
    "undefined",
    "N/A",
    "Test",
    "test  user",
    "Placeholder",
  ])("hides the nameless row %j", (name) => {
    expect(isHiddenFromMemberMap({ name })).toBe(true);
  });

  it("hides a missing name, as an import can leave one", () => {
    expect(isHiddenFromMemberMap({ name: undefined as unknown as string })).toBe(true);
    expect(isHiddenFromMemberMap({ name: null as unknown as string })).toBe(true);
  });

  it("hides a member who opted out by name", () => {
    expect(isHiddenFromMemberMap({ name: "Null,do not contact" })).toBe(true);
  });

  it.each(["Ada Lovelace", "Nullah Ahmed", "Testa Rossi", "Nan Li"])("keeps %j", (name) => {
    expect(isHiddenFromMemberMap({ name })).toBe(false);
  });

  // Slack outranks every other source, so if the filter ran any later than the alumni skip, an
  // opted-out member's Slack location would still place a pin with the roster location cleared.
  it("keeps an opted-out member with only a Slack location out of places, unplaced and counts", () => {
    const map = buildMemberMap(
      [
        member({ id: "real", name: "Ada", location: "Toronto" }),
        member({ id: "optout", name: "Null,do not contact", slack_user_id: "U_OPTOUT" }),
        member({ id: "optout2", name: "Do Not Contact", slack_user_id: "U_OPTOUT2" }),
      ],
      new Map([
        ["U_OPTOUT", "London"],
        ["U_OPTOUT2", "somewhere the gazetteer does not know"],
      ]),
    );
    expect(map.places.map((place) => place.key)).toEqual(["toronto"]);
    expect(map.unplaced).toEqual([]);
    expect(map.counts).toEqual({ placed: 1, unplaced: 0, unknown: 0 });
  });

  it("keeps hidden rows out of places and unplaced, so the API never returns them", () => {
    const map = buildMemberMap(
      [
        member({ id: "real", name: "Ada", location: "Toronto" }),
        // The shape of the real opt-out: active, with a stated location and a login country, so
        // nothing but the name keeps them off the map.
        member({
          id: "optout",
          name: "Null,do not contact",
          status: "active",
          location: "London",
          last_login_country: "GB",
        }),
        member({ id: "blank", name: "" }),
      ],
      new Map(),
    );
    expect(map.places.flatMap((place) => place.members.map((entry) => entry.member_id))).toEqual([
      "real",
    ]);
    expect(map.unplaced).toEqual([]);
    expect(map.counts).toEqual({ placed: 1, unplaced: 0, unknown: 0 });
    expect(JSON.stringify(map)).not.toMatch(/optout|do not contact|London/i);
  });
});

describe("memberMapMemo", () => {
  it("rebuilds only when the roster version moves, and every call without one", () => {
    let version: number | undefined = 1;
    const reads = { count: 0 };
    const store = {
      labMemberVersion: () => version!,
      listLabMembers: () => {
        reads.count += 1;
        return [member({ location: "Toronto" })];
      },
    };
    const memo = memberMapMemo();
    const first = memo(store);
    expect(memo(store)).toBe(first);
    expect(reads.count).toBe(1);
    version = 2;
    expect(memo(store)).not.toBe(first);
    expect(reads.count).toBe(2);

    const unversioned = memberMapMemo();
    const plain = { listLabMembers: store.listLabMembers };
    unversioned(plain);
    unversioned(plain);
    expect(reads.count).toBe(4);
  });

  it("keeps the anonymous map and the signed-in one apart", () => {
    const fresh = new Date().toISOString();
    const store = {
      labMemberVersion: () => 1,
      listLabMembers: () => [
        member({
          location: "Toronto",
          last_login_city: "Zurich",
          last_login_country: "CH",
          last_login_at: fresh,
        }),
      ],
    };
    const memo = memberMapMemo();
    const signedIn = memo(store, { loginCity: true });
    const anonymous = memo(store, { loginCity: false });
    expect(signedIn.places.map((place) => place.key)).toEqual(["zurich"]);
    expect(anonymous.places.map((place) => place.key)).toEqual(["toronto"]);
    // Each entitlement keeps its own entry rather than evicting the other's.
    expect(memo(store, { loginCity: true })).toBe(signedIn);
    expect(memo(store)).toBe(anonymous);
  });

  it("rebuilds on the hour, so a sign-in city ages out without a roster write", () => {
    let reads = 0;
    const store = {
      labMemberVersion: () => 1,
      listLabMembers: () => {
        reads += 1;
        return [member({ location: "Toronto" })];
      },
    };
    const memo = memberMapMemo();
    const now = new Date("2026-10-15T10:05:00Z");
    memo(store, { now });
    memo(store, { now: new Date("2026-10-15T10:55:00Z") });
    expect(reads).toBe(1);
    memo(store, { now: new Date("2026-10-15T11:00:00Z") });
    expect(reads).toBe(2);
  });
});

describe("toPrivilegedMemberMap", () => {
  const map = buildMemberMap([
    member({ id: "a", name: "Ada", location: "Toronto" }),
    member({ id: "z", name: "Zed", location: "nowhere-in-particular" }),
    member({ id: "y", name: "Yan" }),
  ]);

  it("sends a count of the unplaced, and the names only when asked", () => {
    const counted = toPrivilegedMemberMap(map, { listUnplaced: false });
    expect(counted).not.toHaveProperty("unplaced");
    expect(counted.unplaced_count).toBe(2);
    expect(counted.places).toBe(map.places);
    const listed = toPrivilegedMemberMap(map, { listUnplaced: true });
    expect(listed.unplaced?.map((entry) => entry.name)).toEqual(["Yan", "Zed"]);
  });
});

describe("member map precedence with the check-in and the Slack zone", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const placeOf = (overrides: Partial<AdminBotLabMember>) => {
    const map = buildMemberMap([member(overrides)], new Map(), { loginCity: true, now });
    const place = map.places[0];
    return place ? { label: place.label, ...place.members[0] } : undefined;
  };

  it("1. a fresh sign-in city beats a recent check-in answer", () => {
    const placed = placeOf({
      last_login_city: "Berlin",
      last_login_country: "DE",
      last_login_at: ago(2),
      current_city: "Toronto",
      location_checkin_city: "Toronto",
      location_checkin_at: ago(1),
    });
    expect(placed).toMatchObject({ label: "Berlin", source: "login", located_at: ago(2) });
  });

  it("2. a recent check-in answer beats the roster and Slack, and is dated", () => {
    const placed = placeOf({
      current_city: "Toronto",
      location: "Zurich",
      location_checkin_city: "Toronto",
      location_checkin_at: ago(3),
      last_login_city: "Berlin",
      last_login_at: ago(30),
    });
    expect(placed).toMatchObject({ label: "Toronto", source: "checkin", located_at: ago(3) });
  });

  it("a check-in answer stops counting once it lapses or the profile says somewhere else", () => {
    expect(
      placeOf({
        current_city: "Toronto",
        location_checkin_city: "Toronto",
        location_checkin_at: ago(90),
      })?.source,
    ).toBe("roster");
    expect(
      placeOf({
        current_city: "Zurich",
        location_checkin_city: "Toronto",
        location_checkin_at: ago(3),
      }),
    ).toMatchObject({ label: "Zürich", source: "roster" });
  });

  it("4. a fresh Slack zone beats the roster timezone, and a stale one does not", () => {
    expect(
      placeOf({
        timezone: "America/Toronto",
        slack_tz: "America/Vancouver",
        slack_tz_observed_at: ago(2),
      }),
    ).toMatchObject({ label: "Vancouver", source: "slack", precision: "timezone" });
    expect(
      placeOf({
        timezone: "America/Toronto",
        slack_tz: "America/Vancouver",
        slack_tz_observed_at: ago(60),
      }),
    ).toMatchObject({ label: "Toronto", source: "roster" });
  });

  it("flags a Slack zone over two hours off, and never moves a fresh sign-in city for it", () => {
    const placed = placeOf({
      last_login_city: "Toronto",
      last_login_region: "Ontario",
      last_login_country: "CA",
      last_login_at: ago(1),
      slack_tz: "Europe/Berlin",
      slack_tz_observed_at: ago(1),
    });
    expect(placed?.label).toBe("Toronto");
    expect(placed?.tz_mismatch).toMatchObject({ slack_tz: "Europe/Berlin", hours: 6 });
  });

  it("does not flag a neighbouring zone or a country-level pin", () => {
    expect(
      placeOf({
        current_city: "Montreal",
        slack_tz: "America/Toronto",
        slack_tz_observed_at: ago(1),
      })?.tz_mismatch,
    ).toBeUndefined();
    expect(
      placeOf({
        current_city: "Germany",
        slack_tz: "America/Toronto",
        slack_tz_observed_at: ago(1),
      })?.tz_mismatch,
    ).toBeUndefined();
  });
});
