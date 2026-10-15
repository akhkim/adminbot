import { describe, expect, it } from "vitest";
import type { TravelConferenceSite } from "../members/lab-travel.js";
import {
  buildCityIntroMessage,
  buildConferenceIntroMessage,
  buildSayHiMessage,
  conferenceMapUrl,
  type IntroCandidate,
  type IntroMessage,
  pickIntroPartners,
  pickOpener,
  withWildcard,
} from "./conference-intros.js";

const person = (id: string, themes: IntroCandidate["themes"] = []): IntroCandidate => ({
  member_id: id,
  name: id.toUpperCase(),
  slack_user_id: `U${id.toUpperCase()}`,
  themes,
});

const labels = new Map([
  ["multi_agent", "Multi-agent"],
  ["causal_llm", "Causal LLM"],
]);

const site: TravelConferenceSite = {
  key: "emnlp:2026",
  group_key: "emnlp:2026",
  label: "EMNLP 2026",
  conference_label: "EMNLP 2026",
  family: "EMNLP",
  year: 2026,
  multi_site: false,
  location: "Budapest, Hungary",
  starts: "2026-10-24",
  ends: "2026-10-29",
  homepage_url: "https://2026.emnlp.org/",
};

const EVENTS_URL = "https://adminbot.test/events";

/** Every mrkdwn string in the blocks, for asserting on what people actually see. */
const shown = (message: IntroMessage) => JSON.stringify(message.blocks);

describe("pickIntroPartners", () => {
  it("puts the closest research match first and never picks the subject", () => {
    const subject = person("ada", ["multi_agent", "causal_llm"]);
    const picked = pickIntroPartners(
      subject,
      [
        subject,
        person("bob", ["multi_agent"]),
        person("cy", []),
        person("dee", ["multi_agent", "causal_llm"]),
      ],
      "emnlp:2026",
    );
    expect(picked[0]).toMatchObject({ member_id: "dee", shared_themes: ["multi_agent", "causal_llm"] });
    expect(picked[0]?.wildcard).toBeUndefined();
    expect(picked.map((p) => p.member_id)).not.toContain("ada");
  });

  it("adds one seeded wildcard from the rest: stable per seed, varied across seeds", () => {
    const subject = person("a", ["multi_agent"]);
    const pool = [person("best", ["multi_agent"]), ..."bcdefgh".split("").map((id) => person(id))];
    const run = (seed: string) => pickIntroPartners(subject, pool, seed);
    expect(run("emnlp:2026")).toEqual(run("emnlp:2026"));
    const [best, wildcard] = run("emnlp:2026");
    expect(best?.member_id).toBe("best");
    expect(wildcard?.wildcard).toBe(true);
    const wildcards = new Set(
      ["s1", "s2", "s3", "s4", "s5", "s6"].map((seed) => run(seed)[1]?.member_id),
    );
    expect(wildcards.size).toBeGreaterThan(1);
    expect(wildcards.has("best")).toBe(false);
  });

  it("draws the wildcard only from the list it is given, so a spent pair cannot come back", () => {
    const ranked = ["b", "c", "d"].map((id) => Object.assign(person(id), { shared_themes: [] }));
    for (const seed of ["x", "y", "z"]) {
      const picked = withWildcard(person("a"), ranked, seed);
      expect(picked.map((p) => p.member_id).every((id) => ["b", "c", "d"].includes(id))).toBe(true);
    }
    expect(withWildcard(person("a"), [], "x")).toEqual([]);
  });

  it("returns fewer than two when the roster is that small", () => {
    expect(pickIntroPartners(person("a"), [person("a"), person("b")], "x")).toHaveLength(1);
  });
});

describe("pickOpener", () => {
  it("is a pure function of the seed, and rotates across intros", () => {
    expect(pickOpener("event", "conference-intro:emnlp:ada")).toBe(
      pickOpener("event", "conference-intro:emnlp:ada"),
    );
    const openers = new Set(
      Array.from({ length: 24 }, (_, i) => pickOpener("event", `conference-intro:x:${i}`)),
    );
    expect(openers.size).toBeGreaterThan(2);
    for (const opener of openers) {
      expect(opener).toMatch(/\?$/u);
    }
  });
});

describe("buildConferenceIntroMessage", () => {
  const event = (partners: IntroCandidate[], extra: Partial<Parameters<typeof buildConferenceIntroMessage>[0]> = {}) =>
    buildConferenceIntroMessage({
      conference_label: "EMNLP 2026",
      subject: person("ada", ["multi_agent"]),
      partners: pickIntroPartners(person("ada", ["multi_agent"]), partners, "emnlp:2026"),
      sites: [site],
      theme_labels: labels,
      today: "2026-10-15",
      seed: "conference-intro:emnlp:2026:ada",
      events_url: EVENTS_URL,
      ...extra,
    });

  it("says who and why, with when, where (map link) and the event page", () => {
    const { text } = event([person("bob", ["multi_agent"]), person("cy", [])]);
    expect(text.split("\n")[0]).toBe("☕ You're all going to EMNLP 2026");
    expect(text).toContain("ADA, meet BOB and CY.");
    expect(text).toContain("BOB also works on Multi-agent.");
    expect(text).toContain("CY is this round's wildcard: picked at random");
    expect(text).toContain("When: Sat, Oct 24 - Thu, Oct 29 (in 9 days)");
    expect(text).toContain(`Where: Budapest, Hungary - ${conferenceMapUrl("Budapest, Hungary")}`);
    expect(text).toContain("Event page: https://2026.emnlp.org/");
  });

  it("is a header, who, details, one idea and one opener, and a quiet footer", () => {
    const message = event([person("bob", ["multi_agent"])]);
    expect(message.blocks.map((block) => block.type)).toEqual([
      "header",
      "section",
      "section",
      "section",
      "context",
    ]);
    expect(message.blocks[0]).toMatchObject({
      text: { type: "plain_text", text: "☕ You're both going to EMNLP 2026" },
    });
    const opener = pickOpener("event", "conference-intro:emnlp:2026:ada");
    expect(message.text.split("\n").slice(-3)).toEqual([
      "Idea: Grab a coffee between sessions, or walk the posters together.",
      `Opener: ${opener}`,
      `You're getting this because you're both going to EMNLP 2026. Pause or turn off in AdminBot > Events: ${EVENTS_URL}`,
    ]);
    expect(shown(message)).toContain(`<${EVENTS_URL}|Pause or turn off in AdminBot › Events>`);
  });

  it("says so rather than inventing details for a conference the dataset does not cover", () => {
    const { text } = event([person("bob")], { conference_label: "COLM 2026", sites: [] });
    expect(text).toContain("No dates or location on file yet");
    expect(text).not.toContain("When:");
  });

  it("labels each site of a multi-site conference", () => {
    const { text } = event([person("bob")], {
      sites: [
        { ...site, label: "NeurIPS 2026 (San Diego)", location: "San Diego, USA", multi_site: true },
        { ...site, label: "NeurIPS 2026 (Paris)", location: "Paris, France", multi_site: true },
      ],
    });
    expect(text).toContain("NeurIPS 2026 (San Diego):");
    expect(text).toContain("Where: Paris, France");
  });

  it("says 'around X in P this week' for somebody who is there without having said Going", () => {
    const { text } = event([person("bob")], { today: "2026-10-26", in_town: "Budapest" });
    expect(text.split("\n")[0]).toBe("☕ You're both around EMNLP 2026 in Budapest this week");
    expect(text).not.toContain("(in ");
  });

  it("cannot be restyled or linked by a name", () => {
    const message = event([{ ...person("bob"), name: "*Bob* <!channel>" }]);
    expect(shown(message)).not.toContain("<!channel>");
    expect(shown(message)).toContain("&lt;!channel&gt;");
  });

  it("encodes the location into the map query", () => {
    expect(conferenceMapUrl("Hilton Union Square, San Francisco")).toBe(
      "https://www.google.com/maps/search/?api=1&query=Hilton%20Union%20Square%2C%20San%20Francisco",
    );
  });
});

describe("buildCityIntroMessage", () => {
  const city = (partners: IntroCandidate[]) =>
    buildCityIntroMessage({
      place_label: "Boston",
      subject: person("ada", ["multi_agent"]),
      partners: pickIntroPartners(person("ada", ["multi_agent"]), partners, "k"),
      theme_labels: labels,
      seed: "city-intro:boston:ada:2026-10-15",
      events_url: EVENTS_URL,
    });

  it("gives the metro as the reason and suggests lunch when they share research", () => {
    const { text, blocks } = city([person("bob", ["multi_agent"])]);
    expect(text.split("\n")[0]).toBe("☕ You're both in Boston this week");
    expect(text).toContain("BOB also works on Multi-agent.");
    expect(text).toContain("Idea: Lunch or a coffee somewhere central this week?");
    expect(text).toContain("You're getting this because you're both around Boston this week.");
    expect(blocks.map((block) => block.type)).toEqual(["header", "section", "section", "context"]);
  });

  it("is plain serendipity when nobody shares research: grab a coffee", () => {
    const { text } = city([person("bob")]);
    expect(text).toContain("BOB is in town too.");
    expect(text).toContain("Idea: Grab a coffee. No agenda needed.");
  });
});

describe("buildSayHiMessage", () => {
  it("comes from the member who tapped, never labels a wildcard, and carries the event", () => {
    const sender = person("ada", ["multi_agent"]);
    const partners = pickIntroPartners(sender, [person("bob", ["multi_agent"]), person("cy")], "k");
    expect(partners[1]?.wildcard).toBe(true);
    const message = buildSayHiMessage({
      sender,
      partners,
      theme_labels: labels,
      event: { conference_label: "EMNLP 2026", sites: [site], today: "2026-10-15", sender_going: true },
      seed: "say-hi:event:emnlp:2026:ada",
      events_url: EVENTS_URL,
    });
    expect(message.text.split("\n")[0]).toBe("👋 ADA says hi");
    expect(message.text).toContain("ADA saw you're all going to EMNLP 2026 too and started this chat.");
    expect(message.text).not.toContain("wildcard");
    expect(message.text).toContain("You're getting this because ADA tapped Say hi in AdminBot.");
  });

  it("names the place for a Nearby now hello", () => {
    const { text } = buildSayHiMessage({
      sender: person("ada"),
      partners: [{ ...person("bob"), shared_themes: [] }],
      theme_labels: labels,
      place_label: "Boston",
      seed: "say-hi:city:ada:bob",
      events_url: EVENTS_URL,
    });
    expect(text).toContain("ADA saw you're around Boston this week and started this chat.");
    expect(text).toContain("Idea: Grab a coffee. No agenda needed.");
  });
});
