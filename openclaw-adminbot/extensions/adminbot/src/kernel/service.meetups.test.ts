// Meetup intros and the Events tab at the service boundary, on synthetic members only. The Slack
// executor is a mock that records what would have been sent; nothing reaches Slack or IPinfo.
import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember, AdminBotStoredProposal } from "../contracts/actions.js";
import { AdminBotService, type AdminBotServiceStore } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

type Person = {
  id: string;
  topics: string[];
  city?: string;
  country?: string;
  zone?: string;
  prefs?: AdminBotLabMember["meetup_intros"];
  projects?: string[];
};

function lab(start: string) {
  let now = new Date(start);
  const sent: AdminBotStoredProposal[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        sent.push(proposal);
        return { handled: true };
      },
    },
    now: () => now,
  });
  const store = (service as unknown as { store: AdminBotServiceStore }).store;
  const add = (person: Person) => {
    unwrap(
      service.upsertLabMember({
        id: person.id,
        name: `${person.id[0]!.toUpperCase()}${person.id.slice(1)} Example`,
        privilege_level: "member",
        member_type: "full",
        research_topics: person.topics,
        slack_user_id: `U${person.id.toUpperCase()}`,
        ...(person.zone ? { timezone: person.zone } : {}),
        ...(person.projects ? { projects: person.projects } : {}),
      } as never),
    );
    if (person.prefs) {
      store.saveLabMember({ ...store.getLabMember(person.id)!, meetup_intros: person.prefs });
    }
    if (person.city) {
      signIn(person.id, person.city, person.country, person.zone);
    }
  };
  // What the login stamp would write (see auth.ts recordLoginLocation), at the current clock.
  const signIn = (id: string, city: string, country?: string, zone?: string) =>
    store.saveLabMember({
      ...store.getLabMember(id)!,
      last_login_at: now.toISOString(),
      last_login_city: city,
      ...(country ? { last_login_country: country } : {}),
      ...(zone ? { last_login_timezone: zone } : {}),
    });
  const intros = () => sent.filter((proposal) => proposal.type === "slack.conference_intro");
  const members = (proposal: AdminBotStoredProposal) =>
    (proposal.proposed_payload as { member_ids: string[] }).member_ids;
  const message = (proposal: AdminBotStoredProposal) =>
    (proposal.proposed_payload as { message: string }).message;
  return {
    service,
    store,
    add,
    signIn,
    intros,
    members,
    message,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

const LA = "America/Los_Angeles";
const SF = { city: "San Francisco", country: "United States", zone: LA };
const CITY_ON = { city: true };

describe("city meetup intros", () => {
  // 18:00Z is 11:00 in San Francisco in October.
  it("introduces opted-in members in one metro by shared interest, and never names the rest", async () => {
    const { service, add, intros, members, message } = lab("2026-10-15T18:00:00Z");
    add({ id: "ada", topics: ["Multi-agent systems"], ...SF, prefs: CITY_ON, projects: [] });
    add({
      id: "bob",
      topics: ["Multi-agent negotiation"],
      ...SF,
      city: "Mountain View", // same metro, different suburb
      prefs: CITY_ON,
      projects: ["Negotiating agents at scale"],
    });
    add({ id: "cy", topics: ["Sparse autoencoders"], ...SF, city: "Oakland", prefs: CITY_ON });
    // Default settings: city intros are off until somebody says yes.
    add({ id: "dee", topics: ["Multi-agent systems"], ...SF });
    // Opted in, but snoozed through the end of the month.
    add({
      id: "eve",
      topics: ["Multi-agent systems"],
      ...SF,
      prefs: { city: true, snoozed_until: "2026-10-31" },
    });
    // Opted in, signed in from somewhere else.
    add({
      id: "fay",
      topics: ["Multi-agent systems"],
      city: "Boston",
      country: "United States",
      zone: "America/New_York",
      prefs: CITY_ON,
    });

    const result = unwrap(
      await service.introduceCityMeetups({ city: "San Francisco", country: "US" }),
    );
    expect(result).toMatchObject({ introduced: 1, deferred: 0, failed: 0 });
    expect(intros()).toHaveLength(1);
    const [intro] = intros();
    expect(new Set(members(intro!))).toEqual(new Set(["ada", "bob", "cy"]));
    expect(members(intro!)[0]).toBe("ada");
    expect(members(intro!)[1]).toBe("bob"); // the shared theme ranks first
    expect(intro!.idempotency_key).toBe("city-intro:sf-bay-area:ada:2026-10-15");
    const text = message(intro!);
    // The metro is the reason; nobody's own sign-in suburb appears.
    expect(text).toContain("around San Francisco Bay Area this week");
    expect(text).not.toMatch(/Mountain View|Oakland/u);
    expect(text).toContain('ask Bob Example how "Negotiating agents at scale" is going');
    expect(text).toContain("Idea: lunch or a coffee");
    expect(text).toContain("Turn these intros off or snooze them in AdminBot > Events");
    for (const id of ["dee", "eve", "fay"]) {
      expect(intros().flatMap(members)).not.toContain(id);
    }
  });

  it("holds an intro for anybody's night and sends it at their morning", async () => {
    const { service, add, intros, setNow } = lab("2026-10-15T12:00:00Z"); // 05:00 in SF
    add({ id: "ada", topics: ["Causal inference"], ...SF, prefs: CITY_ON });
    add({ id: "bob", topics: ["Causal inference"], ...SF, prefs: CITY_ON });
    const place = { city: "San Francisco" };
    expect(unwrap(await service.introduceCityMeetups(place))).toMatchObject({
      introduced: 0,
      deferred: 2,
    });
    expect(intros()).toHaveLength(0);

    setNow("2026-10-15T17:30:00Z"); // 10:30 in SF -- what the hourly sweep sees
    await service.runMeetupSweep();
    expect(intros()).toHaveLength(1);
    // A pair is enough for a city intro, and it says "both".
    expect((intros()[0]!.proposed_payload as { message: string }).message).toContain(
      "you are both around San Francisco Bay Area",
    );
  });

  it("sends one city intro per member per place per 14 days and never re-pairs people", async () => {
    const { service, add, signIn, intros, members, setNow } = lab("2026-10-01T18:00:00Z");
    add({ id: "ada", topics: ["Causal inference"], ...SF, prefs: CITY_ON });
    add({ id: "bob", topics: ["Causal inference"], ...SF, prefs: CITY_ON });
    add({ id: "cy", topics: ["Causal inference"], ...SF, prefs: CITY_ON });
    const place = { city: "San Francisco" };
    await service.introduceCityMeetups(place);
    expect(intros()).toHaveLength(1);

    // Same day, a week later, a day before the cooldown ends: nothing new.
    await service.introduceCityMeetups(place);
    setNow("2026-10-08T18:00:00Z");
    for (const id of ["ada", "bob", "cy"]) {
      signIn(id, SF.city, SF.country, LA);
    }
    await service.introduceCityMeetups(place);
    setNow("2026-10-14T18:00:00Z");
    for (const id of ["ada", "bob", "cy"]) {
      signIn(id, SF.city, SF.country, LA);
    }
    await service.introduceCityMeetups(place);
    expect(intros()).toHaveLength(1);

    // Past the cooldown the three are free again -- but they have all met, so still nothing.
    setNow("2026-10-16T18:00:00Z");
    for (const id of ["ada", "bob", "cy"]) {
      signIn(id, SF.city, SF.country, LA);
    }
    expect(unwrap(await service.introduceCityMeetups(place)).introduced).toBe(0);
    expect(intros()).toHaveLength(1);

    // Somebody new arrives: they meet one of them, and the two partners are never a spent pair.
    add({ id: "dee", topics: ["Causal inference"], ...SF, prefs: CITY_ON });
    await service.introduceCityMeetups(place);
    expect(intros()).toHaveLength(2);
    const second = members(intros()[1]!);
    expect(second[0]).toBe("ada"); // subjects go in id order; ada has not met dee
    expect(second).toEqual(["ada", "dee"]);
  });
});

describe("event intros", () => {
  it("introduces Travel tab RSVPs (no paper needed) and leaves out whoever turned event intros off", async () => {
    const { service, add, intros, members } = lab("2026-10-15T12:00:00Z");
    add({ id: "ada", topics: ["Causal inference"] });
    add({ id: "bob", topics: ["Causal inference"] });
    add({ id: "cy", topics: ["Sparse autoencoders"] });
    add({ id: "dee", topics: ["Causal inference"], prefs: { events: false } });
    const going = (id: string) =>
      unwrap(
        service.setConferenceTrip({
          conferenceKey: "emnlp:2026",
          memberId: id,
          intent: "going",
          funding: "none",
        }),
      );
    going("dee");
    going("ada");
    going("bob");
    expect(intros()).toHaveLength(0); // ada and bob are only two; dee does not count
    going("cy");
    await vi.waitFor(() => expect(intros()).toHaveLength(1));
    expect(new Set(members(intros()[0]!))).toEqual(new Set(["ada", "bob", "cy"]));
    expect(intros()[0]!.idempotency_key).toBe("conference-intro:emnlp:2026:ada");
    const text = (intros()[0]!.proposed_payload as { message: string }).message;
    expect(text).toContain("you are all going to EMNLP 2026");
    expect(text).toContain("Idea: grab a coffee between sessions");
    expect(text).toContain("AdminBot > Events");
  });

  it("never introduces two people at an event whom a city intro already introduced", async () => {
    const { service, add, intros, members } = lab("2026-10-15T18:00:00Z");
    add({ id: "ada", topics: ["Causal inference"], ...SF, prefs: CITY_ON });
    add({ id: "bob", topics: ["Causal inference"], ...SF, prefs: CITY_ON });
    add({ id: "cy", topics: ["Sparse autoencoders"] });
    add({ id: "dee", topics: ["Sparse autoencoders"] });
    await service.introduceCityMeetups({ city: "San Francisco" });
    expect(members(intros()[0]!)).toEqual(["ada", "bob"]);

    for (const id of ["ada", "bob", "cy", "dee"]) {
      unwrap(
        service.setConferenceTrip({
          conferenceKey: "emnlp:2026",
          memberId: id,
          intent: "going",
          funding: "none",
        }),
      );
    }
    await service.introduceConferenceAttendees("emnlp:2026");
    const events = intros().slice(1);
    expect(events.length).toBeGreaterThan(0);
    // Ada and Bob share the closest interest, but they have met: neither is the other's partner.
    for (const intro of events) {
      const [subject, ...partners] = members(intro);
      const met = subject === "ada" ? "bob" : subject === "bob" ? "ada" : undefined;
      expect(partners).not.toContain(met);
    }
    expect(members(events[0]!)).toEqual(["ada", "cy", "dee"]);
  });

  it("defers an event intro outside daytime for any recipient", async () => {
    // 12:00Z is 05:00 in Los Angeles.
    const { service, add, intros } = lab("2026-10-15T12:00:00Z");
    add({ id: "ada", topics: ["Causal inference"], zone: LA });
    add({ id: "bob", topics: ["Causal inference"], zone: "Europe/Budapest" });
    add({ id: "cy", topics: ["Causal inference"], zone: "Europe/Budapest" });
    for (const id of ["ada", "bob", "cy"]) {
      unwrap(
        service.setConferenceTrip({
          conferenceKey: "emnlp:2026",
          memberId: id,
          intent: "going",
          funding: "none",
        }),
      );
    }
    const result = unwrap(await service.introduceConferenceAttendees("emnlp:2026"));
    expect(result).toMatchObject({ introduced: 0, deferred: 3 });
    expect(intros()).toHaveLength(0);
  });

  it("brings in an opted-in member the sign-in puts in the city during the event, once", async () => {
    // EMNLP 2026 runs Oct 24-29 in Budapest; 09:00Z on the 26th is 10:00 there.
    const { service, add, signIn, intros, members } = lab("2026-10-26T09:00:00Z");
    const BUD = { zone: "Europe/Budapest" };
    add({ id: "ada", topics: ["Causal inference"], ...BUD });
    add({ id: "bob", topics: ["Causal inference"], ...BUD });
    add({ id: "cy", topics: ["Causal inference"], ...BUD, prefs: { city: true } });
    add({ id: "dee", topics: ["Causal inference"], ...BUD }); // city intros off: never pulled in
    for (const id of ["ada", "bob"]) {
      unwrap(
        service.setConferenceTrip({
          conferenceKey: "emnlp:2026",
          memberId: id,
          intent: "going",
          funding: "none",
        }),
      );
    }
    signIn("dee", "Budapest", "Hungary", "Europe/Budapest");
    await service.onLoginLocated("dee");
    expect(intros()).toHaveLength(0);

    signIn("cy", "Budapest", "Hungary", "Europe/Budapest");
    await service.onLoginLocated("cy");
    await service.onLoginLocated("cy"); // a second sign-in the same day
    expect(intros()).toHaveLength(1);
    expect(new Set(members(intros()[0]!))).toEqual(new Set(["ada", "bob", "cy"]));
    expect((intros()[0]!.proposed_payload as { message: string }).message).toContain(
      "around EMNLP 2026 in Budapest this week",
    );
  });
});

describe("the Events tab", () => {
  it("puts the viewer's event first with a Near you badge and asks whether they are attending", async () => {
    const { service, add, signIn } = lab("2026-10-26T09:00:00Z");
    add({ id: "ada", topics: ["Causal inference"] });
    add({ id: "bob", topics: ["Causal inference"], prefs: { city: true } });
    add({ id: "cy", topics: ["Causal inference"], prefs: { city: true } });
    signIn("ada", "Budapest", "Hungary");
    signIn("bob", "Vienna", "Austria");
    unwrap(
      service.setConferenceTrip({
        conferenceKey: "emnlp:2026",
        memberId: "bob",
        intent: "going",
        funding: "none",
      }),
    );

    const view = unwrap(service.meetups().overview("ada"));
    expect(view.viewer_location).toEqual({ label: "Budapest", source: "sign_in" });
    const [first] = view.events;
    expect(first).toMatchObject({
      key: "emnlp:2026",
      status: "happening",
      near_you: true,
      i_am_going: false,
    });
    expect(first!.in_town_prompt).toBe(
      "Looks like you're in Budapest during EMNLP 2026. Are you attending?",
    );
    expect(first!.going.map((p) => p.member_id)).toEqual(["bob"]);
    expect(first!.map_url).toContain("google.com/maps/search/");
    // Ada has city intros off, so she sees nobody's whereabouts -- only that the list exists.
    expect(view.also_nearby).toEqual({ locked: true });
    // Nobody else's sign-in city, and no coordinates, anywhere in the payload.
    const json = JSON.stringify(view);
    expect(json).not.toContain("Vienna");
    expect(json).not.toMatch(/"lat"|"lon"|latitude|longitude/u);

    // Going clears the prompt.
    unwrap(
      service.setConferenceTrip({
        conferenceKey: "emnlp:2026",
        memberId: "ada",
        intent: "going",
        funding: "none",
      }),
    );
    expect(unwrap(service.meetups().overview("ada")).events[0]!.in_town_prompt).toBeUndefined();
  });

  it("lists also-nearby members only between two people who both opted in, by metro", () => {
    const { service, add } = lab("2026-10-15T18:00:00Z");
    add({ id: "ada", topics: [], ...SF, prefs: CITY_ON });
    add({ id: "bob", topics: [], ...SF, city: "Palo Alto", prefs: CITY_ON });
    add({ id: "cy", topics: [], ...SF, city: "Berkeley" }); // not opted in
    const view = unwrap(service.meetups().overview("ada"));
    expect(view.viewer_location).toEqual({ label: "San Francisco", source: "sign_in" });
    expect(view.also_nearby).toEqual({
      locked: false,
      place_label: "San Francisco Bay Area",
      people: [{ member_id: "bob", name: "Bob Example" }],
    });
    expect(JSON.stringify(view)).not.toMatch(/Palo Alto|Berkeley/u);
  });

  it("falls back to the stated city, then nothing, when there is no fresh sign-in", () => {
    const { service, add, store } = lab("2026-10-15T18:00:00Z");
    add({ id: "ada", topics: [] });
    expect(unwrap(service.meetups().overview("ada")).viewer_location).toBeUndefined();
    store.saveLabMember({ ...store.getLabMember("ada")!, current_city: "Toronto, Canada" });
    expect(unwrap(service.meetups().overview("ada")).viewer_location).toEqual({
      label: "Toronto",
      source: "profile",
    });
  });

  it("validates and saves the member's own intro settings", () => {
    const { service, add, store } = lab("2026-10-15T18:00:00Z");
    add({ id: "ada", topics: [] });
    expect(unwrap(service.meetups().overview("ada")).preferences).toEqual({
      events: true,
      city: false,
    });
    expect(service.meetups().setPreferences("ada", { city: "yes" }).ok).toBe(false);
    expect(service.meetups().setPreferences("ada", { snoozed_until: "next week" }).ok).toBe(false);
    expect(
      unwrap(service.meetups().setPreferences("ada", { city: true, snoozed_until: "2026-10-22" })),
    ).toEqual({
      preferences: { events: true, city: true, snoozed_until: "2026-10-22" },
    });
    expect(store.getLabMember("ada")?.meetup_intros).toEqual({
      events: true,
      city: true,
      snoozed_until: "2026-10-22",
    });
    expect(
      unwrap(service.meetups().setPreferences("ada", { snoozed_until: null })).preferences,
    ).toEqual({
      events: true,
      city: true,
    });
  });

  it("is for full lab members only", () => {
    const { service, store, add } = lab("2026-10-15T18:00:00Z");
    add({ id: "ada", topics: [] });
    store.saveLabMember({
      ...store.getLabMember("ada")!,
      privilege_level: "collaborator" as never,
    });
    expect(service.meetups().overview("ada")).toMatchObject({ ok: false, status: 403 });
  });
});
