import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "./contracts.js";
import { buildMemberMap, resolvePlace } from "./member-map.js";

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
    expect(resolvePlace("America/Argentina/Buenos_Aires")).toBeUndefined();
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

describe("buildMemberMap", () => {
  it("prefers Slack and falls back to the roster only when Slack has nothing", () => {
    const map = buildMemberMap(
      [
        member({ id: "a", name: "Ada", slack_user_id: "U1", location: "Toronto" }),
        member({ id: "b", name: "Bo", slack_user_id: "U2", location: "Toronto" }),
        member({ id: "c", name: "Cy", location: "Berlin" }),
      ],
      new Map([["U1", "Europe/Zurich"]]),
    );

    const byLabel = new Map(map.places.map((place) => [place.label, place]));
    // Ada's Slack timezone wins over her roster entry.
    expect(byLabel.get("Zürich")?.members).toEqual([
      { member_id: "a", name: "Ada", source: "slack" },
    ]);
    // Bo has a Slack id but no Slack location, so the roster is used.
    expect(byLabel.get("Toronto")?.members).toEqual([
      { member_id: "b", name: "Bo", source: "roster" },
    ]);
    expect(byLabel.get("Berlin")?.members).toEqual([
      { member_id: "c", name: "Cy", source: "roster" },
    ]);
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

  it("leaves alumni off the map", () => {
    const map = buildMemberMap([
      member({ id: "a", name: "Ada", location: "Toronto" }),
      member({ id: "z", name: "Zed", location: "Toronto", status: "alumni" }),
    ]);
    expect(map.places[0]?.members.map((m) => m.name)).toEqual(["Ada"]);
    expect(map.counts.placed).toBe(1);
  });
});
