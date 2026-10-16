// Meetup intros and the Events tab at the service boundary, on synthetic members only. The Slack
// executor is a mock that records what would have been sent; nothing reaches Slack or IPinfo.
import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember, AdminBotStoredProposal } from "../contracts/actions.js";
import { DEADLINE_VENUES } from "../workflows/deadlines/generated/dataset.js";
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

/** `extraEvents` are synthetic dataset records appended to the bundled ones. */
function lab(start: string, extraEvents: readonly unknown[] = []) {
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
    ...(extraEvents.length ? { deadlineDataset: () => [...DEADLINE_VENUES, ...extraEvents] } : {}),
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
  // What the live IP check would write (see auth.ts recordLoginLocation), at the current clock,
  // plus a same-day check-in answer naming the same city: an IP city alone never starts an intro
  // (meetupPlace), so these fixtures carry the corroboration a real member would have. `ipOnly`
  // leaves it out. The zone is also the device's, as a request carrying the device headers would
  // record it: an IP reading with no reference zone to check it against never starts an intro.
  const signIn = (
    id: string,
    city: string,
    country?: string,
    zone?: string,
    { ipOnly = false }: { ipOnly?: boolean } = {},
  ) =>
    store.saveLabMember({
      ...store.getLabMember(id)!,
      last_ip_observed_at: now.toISOString(),
      last_login_city: city,
      ...(country ? { last_login_country: country } : {}),
      ...(zone
        ? { last_login_timezone: zone, last_device_tz: zone, last_device_tz_at: now.toISOString() }
        : {}),
      ...(ipOnly ? {} : { location_checkin_city: city, location_checkin_at: now.toISOString() }),
    });
  const intros = () => sent.filter((proposal) => proposal.type === "slack.conference_intro");
  const members = (proposal: AdminBotStoredProposal) =>
    (proposal.proposed_payload as { member_ids: string[] }).member_ids;
  const message = (proposal: AdminBotStoredProposal) =>
    (proposal.proposed_payload as { message: string }).message;
  const blocks = (proposal: AdminBotStoredProposal) =>
    (proposal.proposed_payload as { blocks?: { type: string }[] }).blocks ?? [];
  return {
    service,
    store,
    add,
    signIn,
    intros,
    members,
    message,
    blocks,
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
    // Turned city intros off.
    add({ id: "dee", topics: ["Multi-agent systems"], ...SF, prefs: { city: false } });
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
    expect(members(intro!)[2]).toBe("cy"); // and the rest of the pool is the wildcard
    expect(intro!.idempotency_key).toBe("city-intro:sf-bay-area:ada:2026-10-15");
    const text = message(intro!);
    // The metro is the reason; nobody's own sign-in suburb appears.
    expect(text.split("\n")[0]).toBe("☕ You're all in San Francisco Bay Area this week");
    expect(text).not.toMatch(/Mountain View|Oakland/u);
    expect(text).toContain("Bob Example also works on Multi-agent");
    expect(text).toContain("Cy Example is this round's wildcard");
    expect(text).toContain("Idea: Lunch or a coffee somewhere central this week?");
    expect(text).toContain("Pause or turn off in AdminBot > Events: https://");
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
      "You're both in San Francisco Bay Area this week",
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
    expect(text).toContain("You're all going to EMNLP 2026");
    expect(text).toContain("Idea: Grab a coffee between sessions");
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
    add({ id: "cy", topics: ["Causal inference"], ...BUD });
    add({ id: "dee", topics: ["Causal inference"], ...BUD, prefs: { city: false } }); // never pulled in
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
      "You're all around EMNLP 2026 in Budapest this week",
    );
  });
});

describe("the Events tab", () => {
  it("puts the viewer's event first with a Near you badge and asks whether they are attending", async () => {
    const { service, add, signIn } = lab("2026-10-26T09:00:00Z");
    add({ id: "ada", topics: ["Causal inference"], prefs: { city: false } });
    add({ id: "bob", topics: ["Causal inference"] });
    add({ id: "cy", topics: ["Causal inference"] });
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
    expect(view.viewer_location).toEqual({ label: "Budapest", source: "ip" });
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
    // Ada turned city intros off, so she sees nobody's whereabouts -- only that the list exists.
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

  it("lists also-nearby members by metro, leaving out whoever turned city intros off", () => {
    const { service, add } = lab("2026-10-15T18:00:00Z");
    add({ id: "ada", topics: [], ...SF });
    add({ id: "bob", topics: [], ...SF, city: "Palo Alto" });
    add({ id: "cy", topics: [], ...SF, city: "Berkeley", prefs: { city: false } });
    const view = unwrap(service.meetups().overview("ada"));
    expect(view.viewer_location).toEqual({ label: "San Francisco", source: "ip" });
    expect(view.also_nearby).toEqual({
      locked: false,
      place_label: "San Francisco Bay Area",
      people: [{ member_id: "bob", name: "Bob Example" }],
      can_say_hi: true,
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
      city: true,
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

// --- zero setup, serendipity and Say hi ------------------------------------------------------------

const NY = "America/New_York";
const BOSTON = { city: "Boston", country: "United States", zone: NY };
const going = (service: AdminBotService, id: string, conferenceKey = "emnlp:2026") =>
  unwrap(
    service.setConferenceTrip({ conferenceKey, memberId: id, intent: "going", funding: "none" }),
  );

/** A made-up conference in San Francisco, Oct 14-16 2026: the bundled dataset has none there. */
const SYNTHCONF = {
  id: "synthconf_2026",
  name: "SynthConf 2026",
  venue_type: "conference",
  venue_group: "SynthConf 2026",
  venue_family: "SynthConf",
  conference_location: "San Francisco, USA",
  homepage_url: "https://synthconf.test/",
  schedule: [
    { milestone: "conference", label: "Main conference", starts: "2026-10-14", ends: "2026-10-16" },
  ],
};

describe("zero setup, serendipity and Say hi", () => {
  it("introduces two visitors in Boston with no event on default settings: grab a coffee", async () => {
    // 15:00Z is 11:00 in Boston. Nobody has touched a setting; their research does not overlap.
    const { service, add, intros, members, message, blocks } = lab("2026-10-15T15:00:00Z");
    add({ id: "ada", topics: ["Causal inference"], ...BOSTON });
    add({ id: "bob", topics: ["Sparse autoencoders"], ...BOSTON });
    expect(unwrap(await service.introduceCityMeetups({ city: "Boston" })).introduced).toBe(1);
    const [intro] = intros();
    expect(members(intro!)).toEqual(["ada", "bob"]);
    expect(intro!.risk_tier).toBe("T1");
    const text = message(intro!);
    expect(text.split("\n")[0]).toBe("☕ You're both in Boston this week");
    expect(text).toContain("Bob Example is in town too.");
    expect(text).toContain("Idea: Grab a coffee. No agenda needed.");
    expect(text).toMatch(/Opener: .+\?/u);
    expect(blocks(intro!).map((block) => block.type)).toEqual([
      "header",
      "section",
      "section",
      "context",
    ]);
    expect(JSON.stringify(blocks(intro!))).toContain("Pause or turn off in AdminBot › Events>");
  });

  it("never introduces two locals at home to each other, but does introduce a visitor", async () => {
    const { service, store, add, intros, members } = lab("2026-10-15T15:00:00Z");
    add({ id: "ada", topics: ["Causal inference"], ...BOSTON });
    add({ id: "bob", topics: ["Causal inference"], ...BOSTON });
    for (const id of ["ada", "bob"]) {
      store.saveLabMember({ ...store.getLabMember(id)!, current_city: "Cambridge, MA" });
    }
    expect(unwrap(await service.introduceCityMeetups({ city: "Boston" })).introduced).toBe(0);
    expect(service.meetups().sweepWork().cities).toEqual([]);

    add({ id: "cy", topics: ["Causal inference"], ...BOSTON }); // no stated home: visiting
    await service.introduceCityMeetups({ city: "Boston" });
    expect(intros().length).toBeGreaterThan(0);
    for (const intro of intros()) {
      expect(members(intro)).toContain("cy");
    }
  });

  it("picks the same wildcard on every run and labels it as one", async () => {
    const run = async () => {
      const { service, add, intros, members, message } = lab("2026-10-15T18:00:00Z");
      add({ id: "ada", topics: ["Causal inference"], ...SF });
      add({ id: "bob", topics: ["Causal inference"], ...SF });
      for (const id of ["cy", "dee", "eve", "fay"]) {
        add({ id, topics: ["Sparse autoencoders"], ...SF });
      }
      await service.introduceCityMeetups({ city: "San Francisco" });
      return { picks: intros().map(members), first: message(intros()[0]!) };
    };
    const [one, two] = [await run(), await run()];
    expect(one.picks).toEqual(two.picks);
    expect(one.picks[0]!.slice(0, 2)).toEqual(["ada", "bob"]);
    expect(one.first).toContain("is this round's wildcard: picked at random");
  });

  it("says hi right away even at night, once per event, and counts it as an introduction", async () => {
    // 12:00Z is 05:00 in Los Angeles: automatic intros wait for the morning; Say hi does not.
    const { service, add, intros, members, message, setNow } = lab("2026-10-15T12:00:00Z");
    for (const id of ["ada", "bob", "cy"]) {
      add({ id, topics: ["Causal inference"], zone: LA });
      going(service, id);
    }
    expect(unwrap(await service.introduceConferenceAttendees("emnlp:2026")).deferred).toBe(3);
    expect(intros()).toHaveLength(0);

    const sent = unwrap(await service.sayHi("ada", { event_key: "emnlp:2026" }));
    expect(sent.status).toBe("sent");
    expect(sent.with.map((p) => p.member_id).toSorted()).toEqual(["bob", "cy"]);
    expect(intros()).toHaveLength(1);
    expect(intros()[0]!.idempotency_key).toBe("say-hi:event:emnlp:2026:ada");
    expect(members(intros()[0]!)[0]).toBe("ada");
    const text = message(intros()[0]!);
    expect(text.split("\n")[0]).toBe("👋 Ada Example says hi");
    expect(text).toContain(
      "Ada Example saw you're all going to EMNLP 2026 too and started this chat.",
    );
    expect(text).not.toContain("wildcard");

    // A second tap answers instead of sending again, and the card says so.
    const again = unwrap(await service.sayHi("ada", { event_key: "emnlp:2026" }));
    expect(again.status).toBe("already_said_hi");
    expect(again.with.map((p) => p.member_id).toSorted()).toEqual(["bob", "cy"]);
    expect(intros()).toHaveLength(1);
    const card = unwrap(service.meetups().overview("ada")).events.find(
      (event) => event.group_key === "emnlp:2026",
    );
    expect(card).toMatchObject({ said_hi: true });

    // Morning: the automatic intro finds every pair already introduced.
    setNow("2026-10-15T17:30:00Z");
    expect(unwrap(await service.introduceConferenceAttendees("emnlp:2026")).introduced).toBe(0);
    expect(intros()).toHaveLength(1);
  });

  it("Nearby now: says hi to one face, once per pair, from either side", async () => {
    const { service, add, intros, members } = lab("2026-10-15T18:00:00Z");
    add({ id: "ada", topics: [], ...SF });
    add({ id: "bob", topics: [], ...SF, city: "Palo Alto" });
    expect(unwrap(service.meetups().overview("ada")).also_nearby).toMatchObject({
      can_say_hi: true,
      people: [{ member_id: "bob" }],
    });
    expect(unwrap(await service.sayHi("ada", { member_id: "bob" })).status).toBe("sent");
    expect(members(intros()[0]!)).toEqual(["ada", "bob"]);
    expect(intros()[0]!.idempotency_key).toBe("say-hi:city:ada|bob");
    expect(unwrap(await service.sayHi("bob", { member_id: "ada" })).status).toBe("already_said_hi");
    expect(unwrap(service.meetups().overview("ada")).also_nearby).toMatchObject({
      people: [{ member_id: "bob", said_hi: true }],
    });
    // The pair has met: no automatic city intro for them either.
    expect(unwrap(await service.introduceCityMeetups({ city: "San Francisco" })).introduced).toBe(
      0,
    );
    expect(intros()).toHaveLength(1);
    expect((await service.sayHi("ada", {})).ok).toBe(false);
  });

  it("never names, introduces or says hi to a do-not-contact member, who cannot lift it", async () => {
    const { service, store, add, intros, members } = lab("2026-10-15T18:00:00Z");
    add({ id: "ada", topics: ["Causal inference"], ...SF });
    add({ id: "bob", topics: ["Causal inference"], ...SF });
    add({ id: "dee", topics: ["Causal inference"], ...SF });
    store.saveLabMember({ ...store.getLabMember("dee")!, do_not_contact: true });

    await service.introduceCityMeetups({ city: "San Francisco" });
    expect(intros()).toHaveLength(1);
    expect(intros().flatMap(members)).not.toContain("dee");
    expect(JSON.stringify(unwrap(service.meetups().overview("ada")).also_nearby)).not.toContain(
      "dee",
    );
    expect(await service.sayHi("ada", { member_id: "dee" })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(unwrap(service.meetups().overview("dee")).also_nearby).toBeUndefined();
    expect(await service.sayHi("dee", { member_id: "ada" })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(service.updateOwnProfile("dee", { do_not_contact: false }).ok).toBe(false);
    expect(
      service.upsertLabMember({ ...store.getLabMember("ada")!, do_not_contact: "yes" } as never).ok,
    ).toBe(false);
  });

  it("an SF viewer during an SF event: Near you, the in-town question, and Say hi", async () => {
    // 18:00Z on Oct 15 is 11:00 in San Francisco, mid-SynthConf.
    const { service, add, signIn, intros, message } = lab("2026-10-15T18:00:00Z", [SYNTHCONF]);
    add({ id: "ada", topics: ["Causal inference"], zone: LA });
    add({ id: "bob", topics: ["Causal inference"], zone: LA });
    const before = unwrap(service.meetups().overview("ada")).events.find(
      (event) => event.label === "SynthConf 2026",
    );
    expect(before).toBeDefined();
    // One lab-mate going: two people are never an automatic intro, so Say hi is the way to meet.
    going(service, "bob", before!.key);
    signIn("ada", SF.city, SF.country, LA);

    const card = unwrap(service.meetups().overview("ada")).events[0]!;
    expect(card).toMatchObject({
      label: "SynthConf 2026",
      status: "happening",
      near_you: true,
      i_am_going: false,
      can_say_hi: true,
      said_hi: false,
      in_town_prompt:
        "Looks like you're in San Francisco during SynthConf 2026. Are you attending?",
    });
    expect(card.going.map((p) => p.member_id)).toEqual(["bob"]);

    expect(unwrap(await service.sayHi("ada", { event_key: card.key })).status).toBe("sent");
    expect(intros()).toHaveLength(1);
    const text = message(intros()[0]!);
    expect(text).toContain("Ada Example saw you're going to SynthConf 2026 and started this chat.");
    expect(text).toContain("Where: San Francisco, USA");
    expect(unwrap(service.meetups().overview("ada")).events[0]).toMatchObject({ said_hi: true });
  });
});

describe("intros never trust a likely VPN exit", () => {
  // 15:00Z is 11:00 in Toronto in October. Both members' IP readings say Toronto; the question is
  // whether a reading the map would set aside can still say "you're both in Toronto".
  const TORONTO = { city: "Toronto", country: "Canada", zone: "America/Toronto" };
  const AT = "2026-10-15T15:00:00Z";

  it("introduces two members whose Toronto readings are trusted", async () => {
    const { service, add, intros } = lab(AT);
    add({ id: "ada", topics: ["Causal inference"], ...TORONTO });
    add({ id: "bob", topics: ["Sparse autoencoders"], ...TORONTO });
    expect(unwrap(await service.introduceCityMeetups({ city: "Toronto" })).introduced).toBe(1);
    expect(intros()).toHaveLength(1);
  });

  it("never starts an intro from IP-only placements: the IP needs a witness within 30 days", async () => {
    const { service, store, signIn, add, intros } = lab(AT);
    add({ id: "ada", topics: ["Causal inference"], zone: TORONTO.zone });
    add({ id: "bob", topics: ["Sparse autoencoders"], zone: TORONTO.zone });
    signIn("ada", TORONTO.city, TORONTO.country, TORONTO.zone, { ipOnly: true });
    signIn("bob", TORONTO.city, TORONTO.country, TORONTO.zone, { ipOnly: true });
    await service.onLoginLocated("ada");
    await service.onLoginLocated("bob");
    await service.runMeetupSweep();
    expect(unwrap(await service.introduceCityMeetups({ city: "Toronto" })).introduced).toBe(0);
    // A witness older than 30 days does not count either.
    for (const id of ["ada", "bob"]) {
      store.saveLabMember({
        ...store.getLabMember(id)!,
        location_checkin_city: "Toronto",
        location_checkin_at: "2026-09-01T00:00:00Z",
      });
    }
    expect(unwrap(await service.introduceCityMeetups({ city: "Toronto" })).introduced).toBe(0);
    expect(intros()).toHaveLength(0);
    // A fresh device city is a witness of its own: one intro.
    for (const id of ["ada", "bob"]) {
      store.saveLabMember({
        ...store.getLabMember(id)!,
        device_city: "Toronto",
        device_region: "Ontario",
        device_country: "CA",
        device_located_at: AT,
      });
    }
    expect(unwrap(await service.introduceCityMeetups({ city: "Toronto" })).introduced).toBe(1);
  });

  it("places an intro by the device city when the IP says another city", async () => {
    const { service, store, signIn, add, intros, members } = lab("2026-10-15T09:00:00Z");
    add({ id: "ada", topics: ["Causal inference"], zone: "Europe/Rome" });
    add({ id: "bob", topics: ["Sparse autoencoders"], zone: "Europe/Rome" });
    // Both connect through a Rome exit; ada's browser says Reggio Emilia.
    signIn("ada", "Rome", "Italy", "Europe/Rome", { ipOnly: true });
    signIn("bob", "Rome", "Italy", "Europe/Rome");
    store.saveLabMember({
      ...store.getLabMember("ada")!,
      device_city: "Reggio Emilia",
      device_region: "Emilia-Romagna",
      device_country: "IT",
      device_located_at: "2026-10-15T08:00:00Z",
    });
    expect(unwrap(await service.introduceCityMeetups({ city: "Rome" })).introduced).toBe(0);
    expect(intros().flatMap(members)).not.toContain("ada");
  });

  it("sends no city intro when one reading was flagged suspected_vpn, from the hook or the sweep", async () => {
    const { service, store, add, intros } = lab(AT);
    add({ id: "ada", topics: ["Causal inference"], ...TORONTO });
    add({ id: "bob", topics: ["Sparse autoencoders"], ...TORONTO });
    // A VPN exit in Toronto: the flag is what recordLoginLocation writes for such a reading.
    store.saveLabMember({ ...store.getLabMember("bob")!, last_ip_suspected_vpn: true });
    await service.onLoginLocated("bob");
    await service.onLoginLocated("ada");
    await service.runMeetupSweep();
    expect(unwrap(await service.introduceCityMeetups({ city: "Toronto" })).introduced).toBe(0);
    expect(intros()).toHaveLength(0);
  });

  it("sends no city intro when an unflagged reading disagrees with the device or Slack zone", async () => {
    const { service, store, add, intros } = lab(AT);
    add({ id: "ada", topics: ["Causal inference"], ...TORONTO });
    add({ id: "bob", topics: ["Sparse autoencoders"], ...TORONTO });
    add({ id: "cy", topics: ["Program synthesis"], ...TORONTO });
    // Taken before the zone was known, so never flagged; the browser now reports Zurich.
    store.saveLabMember({
      ...store.getLabMember("bob")!,
      last_device_tz: "Europe/Zurich",
      last_device_tz_at: AT,
    });
    // No browser zone, but Slack says Tokyo.
    store.saveLabMember({
      ...store.getLabMember("cy")!,
      last_device_tz: undefined,
      last_device_tz_at: undefined,
      slack_tz: "Asia/Tokyo",
      slack_tz_observed_at: AT,
    });
    await service.onLoginLocated("bob");
    await service.onLoginLocated("cy");
    await service.runMeetupSweep();
    expect(unwrap(await service.introduceCityMeetups({ city: "Toronto" })).introduced).toBe(0);
    expect(intros()).toHaveLength(0);
  });
});
