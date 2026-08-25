// Who a city channel is for, when a city gets one, and why nobody is ever added twice.
import { describe, expect, it } from "vitest";
import {
  adminBotCityChannelMinimumMembers,
  buildCityChannelMessage,
  cityChannelName,
  cityChannelPlan,
  type CityChannelMember,
} from "./city-channels.js";
import { resolvePlace } from "./member-map.js";

function member(fields: Partial<CityChannelMember> & { id: string }): CityChannelMember {
  return {
    name: `Member ${fields.id}`,
    status: "active",
    slack_user_id: `U-${fields.id.toUpperCase()}`,
    current_city: "Toronto",
    ...fields,
  };
}

const inCity = (count: number, city: string, prefix = city.slice(0, 2)) =>
  Array.from({ length: count }, (_, index) =>
    member({ id: `${prefix}${index}`, current_city: city }),
  );

describe("cityChannelPlan", () => {
  it("opens a channel at four and not at three", () => {
    expect(adminBotCityChannelMinimumMembers).toBe(4);
    expect(cityChannelPlan(inCity(3, "Toronto")).groups).toEqual([]);
    const plan = cityChannelPlan(inCity(4, "Toronto"));
    expect(plan.groups.map((group) => group.channel)).toEqual(["group-toronto"]);
    expect(plan.invites).toHaveLength(4);
  });

  it("counts the ways people write a city as one city", () => {
    // The same resolver the member map uses, so somebody who appears in Zürich on the map is
    // invited to the Zürich channel rather than to nothing.
    const plan = cityChannelPlan([
      member({ id: "a", current_city: "Zürich" }),
      member({ id: "b", current_city: "zurich" }),
      member({ id: "c", current_city: "currently Zurich" }),
      member({ id: "d", current_city: "", timezone: "Europe/Zurich" }),
    ]);
    expect(plan.groups.map((group) => group.channel)).toEqual(["group-zurich"]);
    expect(plan.invites).toHaveLength(4);
  });

  it("names the channel after the gazetteer key, not the accented label", () => {
    // Slack channel names are lowercase ASCII; "#group-zürich" is not a channel anyone can have.
    expect(cityChannelName(resolvePlace("Zürich")!)).toBe("group-zurich");
    expect(cityChannelName(resolvePlace("Tübingen")!)).toBe("group-tuebingen");
  });

  it("links the guidebook section for the three cities that have one", () => {
    for (const [city, expected] of [
      ["Toronto", "Working from Toronto"],
      ["Zurich", "Working from Zürich"],
      ["Tuebingen", "Working from Tübingen"],
    ] as const) {
      const [group] = cityChannelPlan(inCity(4, city)).groups;
      expect(group?.guidebookSection).toBe(expected);
    }
    // A city with no section still gets its channel; a link to a section that does not exist is
    // worse than no link.
    const [london] = cityChannelPlan(inCity(4, "London")).groups;
    expect(london?.channel).toBe("group-london");
    expect(london?.guidebookSection).toBeUndefined();
  });

  it("never invites the same person twice", () => {
    // The stamp is the entire opt-out: somebody added and gone has to stay gone.
    const people = inCity(4, "Toronto");
    people[0] = { ...people[0], city_channel_invited_at: "2026-01-01" } as CityChannelMember;
    const plan = cityChannelPlan(people);
    expect(plan.invites.map((invite) => invite.member_id)).not.toContain(people[0]?.id);
    expect(plan.invites).toHaveLength(3);
    // ...and they still count toward the city having a channel at all.
    expect(plan.groups).toHaveLength(1);
  });

  it("leaves alumni and external collaborators out of the count and the invites", () => {
    const plan = cityChannelPlan([
      ...inCity(3, "Toronto"),
      member({ id: "gone", status: "alumni" }),
      member({ id: "guest", status: "external" }),
    ]);
    // Three current members is not a city channel, whoever else used to be there.
    expect(plan.groups).toEqual([]);
  });

  it("reports somebody with no Slack account rather than silently passing over them", () => {
    const people = inCity(4, "Toronto");
    people[1] = { ...people[1], slack_user_id: undefined } as CityChannelMember;
    const plan = cityChannelPlan(people);
    expect(plan.invites).toHaveLength(3);
    expect(plan.skipped).toEqual([
      { member_id: people[1]?.id, reason: "member has no slack_user_id" },
    ]);
  });

  it("places nobody it cannot place", () => {
    expect(cityChannelPlan(inCity(6, "somewhere nobody has heard of")).groups).toEqual([]);
  });
});

describe("buildCityChannelMessage", () => {
  it("says where, why, and how to leave — with leaving not buried", () => {
    const message = buildCityChannelMessage({
      member_id: "mei",
      member_name: "Mei Chen",
      slack_user_id: "U-MEI",
      channel: "group-zurich",
      place_label: "Zürich",
      guidebookSection: "Working from Zürich",
    });
    expect(message).toContain("#group-zurich");
    expect(message).toContain("Zürich group coordinates");
    expect(message).toContain("Working from Zürich");
    // They did not ask for this, so the message announcing it has to make undoing it obvious.
    expect(message).toContain("just leave the channel");
    expect(message).toContain("I will not add you back");
  });

  it("drops the guidebook line for a city with no section", () => {
    const message = buildCityChannelMessage({
      member_id: "mei",
      member_name: "Mei Chen",
      slack_user_id: "U-MEI",
      channel: "group-london",
      place_label: "London",
    });
    expect(message).not.toContain("guidebook");
    expect(message).toContain("just leave the channel");
  });
});
