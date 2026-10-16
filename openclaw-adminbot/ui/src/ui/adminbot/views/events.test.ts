/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventCard, EventsOverview } from "../data/events.ts";
import {
  countdownLabel,
  renderEvents,
  renderMeetupToggle,
  renderNearbyNow,
  type EventsProps,
} from "./events.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

// Synthetic: a made-up conference in San Francisco and one in Budapest.
const SYNTH: EventCard = {
  key: "synthconf:2026",
  group_key: "synthconf:2026",
  label: "SynthConf 2026",
  starts: "2026-10-14",
  ends: "2026-10-17",
  location: "San Francisco, USA",
  map_url: "https://www.openstreetmap.org/search?query=San%20Francisco%2C%20USA",
  homepage_url: "https://synthconf.example/",
  status: "happening",
  going: [
    { member_id: "bob", name: "Bob Member" },
    { member_id: "cy", name: "Cy Member", avatar_url: "https://avatars.example/cy.png" },
  ],
  on_paper: true,
  i_am_going: false,
  can_rsvp: true,
  near_you: true,
  in_town_prompt: "Looks like you're in San Francisco during SynthConf 2026. Are you attending?",
  can_say_hi: true,
  said_hi: false,
};

const FAR: EventCard = {
  key: "farconf:2026",
  group_key: "farconf:2026",
  label: "FarConf 2026",
  starts: "2026-10-24",
  ends: "2026-10-29",
  location: "Budapest, Hungary",
  status: "upcoming",
  days_until: 9,
  going: [],
  on_paper: false,
  i_am_going: true,
  my_rsvp: {
    member_id: "ada",
    conference_key: "farconf:2026",
    intent: "going",
    funding: "full",
    needs_lodging: true,
    needs_visa_letter: false,
  } as EventCard["my_rsvp"],
  can_rsvp: true,
  near_you: false,
};

const OVERVIEW: EventsOverview = {
  today: "2026-10-15",
  viewer_location: { label: "San Francisco", source: "ip" },
  preferences: { events: true, city: false },
  events: [SYNTH, FAR],
  past: [{ ...FAR, key: "oldconf:2025", label: "OldConf 2025", status: "past", can_rsvp: false }],
  also_nearby: { locked: true },
};

function draw(overrides: Partial<EventsProps> = {}) {
  const props: EventsProps = {
    overview: OVERVIEW,
    loading: false,
    error: null,
    notice: null,
    busy: null,
    onRetry: vi.fn(),
    onToggleGoing: vi.fn(),
    onPreferences: vi.fn(),
    onSayHi: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  render(renderEvents(props), container);
  return props;
}

describe("renderEvents", () => {
  it("shows the viewer their own place, with where it came from", () => {
    draw();
    const where = document.querySelector('[data-testid="events-where"]')?.textContent ?? "";
    expect(where).toContain("You're in San Francisco");
    expect(where).toContain("based on your current IP address");
  });

  it("marks the nearby event, prompts in town, and answers the prompt with Going", () => {
    const props = draw();
    const near = document.querySelector('[data-event="synthconf:2026"]');
    expect(near?.classList.contains("events__card--near")).toBe(true);
    expect(near?.textContent).toContain("Near you");
    expect(near?.textContent).toContain("Happening now");
    expect(near?.querySelector('a[href^="https://www.openstreetmap.org"]')).not.toBeNull();
    expect(near?.textContent).toContain("Bob Member, Cy Member");
    expect(document.querySelector('[data-event="farconf:2026"]')?.textContent).not.toContain(
      "Near you",
    );
    const prompt = document.querySelector('[data-testid="events-prompt"]');
    expect(prompt?.textContent).toContain(
      "Looks like you're in San Francisco during SynthConf 2026. Are you attending?",
    );
    prompt?.querySelector("button")?.click();
    expect(props.onToggleGoing).toHaveBeenCalledWith(SYNTH, true);
  });

  it("toggles Going and Not going in one tap", () => {
    const props = draw();
    const far = document.querySelector('[data-event="farconf:2026"]');
    const [going, notGoing] = Array.from(far?.querySelectorAll(".events__toggle button") ?? []);
    expect(going?.getAttribute("aria-pressed")).toBe("true");
    expect((going as HTMLButtonElement).disabled).toBe(true);
    (notGoing as HTMLButtonElement).click();
    expect(props.onToggleGoing).toHaveBeenCalledWith(FAR, false);
  });

  it("keeps past events in a collapsed section with no toggle", () => {
    draw();
    const past = document.querySelector("details.events__past");
    expect(past?.hasAttribute("open")).toBe(false);
    expect(past?.querySelector("summary")?.textContent).toContain("Past events (1)");
    expect(past?.querySelector(".events__toggle")).toBeNull();
  });

  it("names nobody nearby until city intros are on", () => {
    draw();
    expect(document.querySelector('[data-testid="events-nearby"]')).toBeNull();
    expect(document.body.textContent).toContain("City intros are off");
    draw({
      overview: {
        ...OVERVIEW,
        preferences: { events: true, city: true },
        also_nearby: {
          locked: false,
          place_label: "San Francisco Bay Area",
          people: [{ member_id: "dee", name: "Dee Member" }],
          can_say_hi: true,
        },
      },
    });
    const nearby = document.querySelector('[data-testid="events-nearby"]')?.textContent ?? "";
    expect(nearby).toContain("Also nearby in San Francisco Bay Area");
    expect(nearby).toContain("Dee Member");
  });

  it("says hi from an event card in one tap, then shows Hi sent", () => {
    const props = draw();
    const near = document.querySelector('[data-event="synthconf:2026"]');
    const button = near?.querySelector<HTMLButtonElement>(".events__say-hi");
    expect(button?.textContent).toContain("Say hi");
    expect(button?.getAttribute("aria-label")).toBe("Say hi to lab-mates going to SynthConf 2026");
    button!.click();
    expect(props.onSayHi).toHaveBeenCalledWith({ event_key: "synthconf:2026" });
    // Nobody reachable going: no button at all.
    expect(document.querySelector('[data-event="farconf:2026"] .events__say-hi')).toBeNull();

    draw({ overview: { ...OVERVIEW, events: [{ ...SYNTH, said_hi: true }, FAR] } });
    const sent = document.querySelector('[data-event="synthconf:2026"]');
    expect(sent?.querySelector(".events__say-hi")).toBeNull();
    expect(sent?.querySelector(".events__said-hi")?.textContent).toContain("Hi sent");

    draw({ busy: "hi:event:synthconf:2026" });
    expect(
      document.querySelector<HTMLButtonElement>('[data-event="synthconf:2026"] .events__say-hi')
        ?.disabled,
    ).toBe(true);
  });

  it("says hi to one nearby face at a time", () => {
    const props = draw({
      overview: {
        ...OVERVIEW,
        also_nearby: {
          locked: false,
          place_label: "Boston",
          people: [
            { member_id: "dee", name: "Dee Member" },
            { member_id: "eve", name: "Eve Member", said_hi: true },
          ],
          can_say_hi: true,
        },
      },
    });
    const faces = document.querySelectorAll('[data-testid="events-nearby"] .events__face');
    expect(faces).toHaveLength(2);
    faces[0]!.querySelector<HTMLButtonElement>(".events__say-hi")!.click();
    expect(props.onSayHi).toHaveBeenCalledWith({ member_id: "dee" });
    expect(faces[1]!.querySelector(".events__said-hi")).not.toBeNull();
  });

  it("has an empty state", () => {
    draw({ overview: { ...OVERVIEW, events: [], past: [] } });
    expect(document.querySelector('[data-testid="events-empty"]')).not.toBeNull();
    expect(document.querySelector("details.events__past")).toBeNull();
  });

  it("saves the opt-ins and the snooze", () => {
    const props = draw();
    const [events, city] = Array.from(
      document.querySelectorAll<HTMLInputElement>(".events__check input"),
    );
    expect(events?.checked).toBe(true);
    expect(city?.checked).toBe(false);
    city!.checked = true;
    city!.dispatchEvent(new Event("change"));
    expect(props.onPreferences).toHaveBeenCalledWith({ city: true });
    document.querySelector<HTMLButtonElement>(".events__snooze button")?.click();
    expect(props.onPreferences).toHaveBeenCalledWith({ snoozed_until: "2026-10-29" });
  });
});

describe("countdownLabel", () => {
  it("counts down to the first day", () => {
    expect(countdownLabel({ ...FAR, days_until: 0 })).toBe("Starts today");
    expect(countdownLabel({ ...FAR, days_until: 1 })).toBe("Tomorrow");
    expect(countdownLabel(FAR)).toBe("In 9 days");
    expect(countdownLabel({ ...FAR, status: "past" })).toBeNull();
  });
});

describe("renderNearbyNow", () => {
  const nearby = {
    locked: false as const,
    place_label: "Boston",
    people: [{ member_id: "dee", name: "Dee Member" }],
    can_say_hi: true,
  };
  const drawStrip = (props: Partial<Parameters<typeof renderNearbyNow>[0]> = {}) => {
    const onSayHi = vi.fn();
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    render(renderNearbyNow({ nearby, busy: null, notice: null, onSayHi, ...props }), container);
    return onSayHi;
  };

  it("draws the faces around the viewer with a Say hi each", () => {
    const onSayHi = drawStrip();
    const strip = document.querySelector('[data-testid="nearby-now"]');
    expect(strip?.textContent).toContain("Nearby now");
    expect(strip?.textContent).toContain("Lab-mates around Boston this week");
    strip!.querySelector<HTMLButtonElement>(".events__say-hi")!.click();
    expect(onSayHi).toHaveBeenCalledWith({ member_id: "dee" });
  });

  it("draws nothing when nobody is around, when locked, or with no Slack link to say hi from", () => {
    drawStrip({ nearby: { ...nearby, people: [] } });
    expect(document.querySelector('[data-testid="nearby-now"]')).toBeNull();
    drawStrip({ nearby: { locked: true } });
    expect(document.querySelector('[data-testid="nearby-now"]')).toBeNull();
    drawStrip({ nearby: undefined });
    expect(document.querySelector('[data-testid="nearby-now"]')).toBeNull();
    drawStrip({ nearby: { ...nearby, can_say_hi: false } });
    expect(document.querySelector('[data-testid="nearby-now"] .events__say-hi')).toBeNull();
  });
});

describe("renderMeetupToggle", () => {
  it("is one switch for both kinds of intro, with a way to the finer controls", () => {
    const onToggle = vi.fn();
    const onManage = vi.fn();
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    render(
      renderMeetupToggle({
        preferences: { events: true, city: true },
        busy: false,
        onToggle,
        onManage,
      }),
      container,
    );
    const input = document.querySelector<HTMLInputElement>('[data-testid="meetup-toggle"] input');
    expect(input?.checked).toBe(true);
    expect(input?.getAttribute("role")).toBe("switch");
    input!.checked = false;
    input!.dispatchEvent(new Event("change"));
    expect(onToggle).toHaveBeenCalledWith(false);
    document.querySelector<HTMLButtonElement>(".events__manage")!.click();
    expect(onManage).toHaveBeenCalled();

    render(
      renderMeetupToggle({
        preferences: { events: true, city: false },
        busy: false,
        onToggle,
        onManage,
      }),
      container,
    );
    expect(
      document.querySelector<HTMLInputElement>('[data-testid="meetup-toggle"] input')?.checked,
    ).toBe(false);
  });
});
