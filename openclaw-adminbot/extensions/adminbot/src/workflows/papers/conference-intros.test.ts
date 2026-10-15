import { describe, expect, it } from "vitest";
import type { TravelConferenceSite } from "../members/lab-travel.js";
import {
  buildCityIntroMessage,
  buildConferenceIntroMessage,
  conferenceMapUrl,
  conversationStarter,
  type IntroCandidate,
  pickIntroPartners,
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

describe("pickIntroPartners", () => {
  it("ranks by shared themes and never picks the subject", () => {
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
    expect(picked.map((p) => p.member_id)).toEqual(["dee", "bob"]);
    expect(picked[0].shared_themes).toEqual(["multi_agent", "causal_llm"]);
  });

  it("falls back to a seeded sample that is stable per seed and varies across subjects", () => {
    const pool = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => person(id));
    const run = (subject: string, seed: string) =>
      pickIntroPartners(person(subject), pool, seed).map((p) => p.member_id);
    expect(run("a", "emnlp:2026")).toEqual(run("a", "emnlp:2026"));
    expect(run("a", "emnlp:2026")).toHaveLength(2);
    expect(run("a", "emnlp:2026")).not.toContain("a");
    const distinctPairs = new Set(
      ["a", "b", "c", "d", "e"].map((subject) => run(subject, "emnlp:2026").sort().join()),
    );
    expect(distinctPairs.size).toBeGreaterThan(1);
  });

  it("returns fewer than two when the roster is that small", () => {
    expect(pickIntroPartners(person("a"), [person("a"), person("b")], "x")).toHaveLength(1);
  });
});

describe("buildConferenceIntroMessage", () => {
  it("names everyone and carries when, where with a map link, and the event page", () => {
    const subject = person("ada", ["multi_agent"]);
    const [bob, cy] = pickIntroPartners(
      subject,
      [person("bob", ["multi_agent"]), person("cy", [])],
      "emnlp:2026",
    );
    const text = buildConferenceIntroMessage({
      conference_label: "EMNLP 2026",
      subject,
      partners: [bob, cy],
      sites: [site],
      theme_labels: labels,
      today: "2026-10-15",
    });
    expect(text).toContain("Hi ADA, BOB and CY -- you are all going to EMNLP 2026");
    expect(text).toContain("ADA and BOB both work on Multi-agent.");
    expect(text).toContain("CY is also going (picked at random");
    expect(text).toContain("When: Sat, Oct 24, 2026 - Thu, Oct 29, 2026 (in 9 days)");
    expect(text).toContain(`Where: Budapest, Hungary - ${conferenceMapUrl("Budapest, Hungary")}`);
    expect(text).toContain("Event page: https://2026.emnlp.org/");
  });

  it("says so rather than inventing details for a conference the dataset does not cover", () => {
    const text = buildConferenceIntroMessage({
      conference_label: "COLM 2026",
      subject: person("ada"),
      partners: [
        { ...person("bob"), shared_themes: [] },
        { ...person("cy"), shared_themes: [] },
      ],
      sites: [],
      theme_labels: labels,
      today: "2026-09-01",
    });
    expect(text).toContain("no dates or location on file");
    expect(text).not.toContain("When:");
  });

  it("labels each site of a multi-site conference", () => {
    const text = buildConferenceIntroMessage({
      conference_label: "NeurIPS 2026",
      subject: person("ada"),
      partners: [
        { ...person("bob"), shared_themes: [] },
        { ...person("cy"), shared_themes: [] },
      ],
      sites: [
        {
          ...site,
          label: "NeurIPS 2026 (San Diego)",
          location: "San Diego, USA",
          multi_site: true,
        },
        { ...site, label: "NeurIPS 2026 (Paris)", location: "Paris, France", multi_site: true },
      ],
      theme_labels: labels,
      today: "2026-10-15",
    });
    expect(text).toContain("NeurIPS 2026 (San Diego):");
    expect(text).toContain("Where: Paris, France");
  });

  it("encodes the location into the map query", () => {
    expect(conferenceMapUrl("Hilton Union Square, San Francisco")).toBe(
      "https://www.google.com/maps/search/?api=1&query=Hilton%20Union%20Square%2C%20San%20Francisco",
    );
  });
});

describe("intro text: reason, one idea, one opener, a way out", () => {
  const ada = person("ada", ["multi_agent"]);
  const [bob] = pickIntroPartners(
    ada,
    [{ ...person("bob", ["multi_agent"]), projects: ["  ", "Agents that negotiate"] }],
    "k",
  );

  it("opens with the partner's own project title, else the shared theme, else a generic question", () => {
    expect(conversationStarter(ada, [bob!], labels)).toBe(
      'Opener: ADA, ask BOB how "Agents that negotiate" is going.',
    );
    const [plain] = pickIntroPartners(ada, [person("bob", ["multi_agent"])], "k");
    expect(conversationStarter(ada, [plain!], labels)).toContain("recent Multi-agent result");
    const [none] = pickIntroPartners(ada, [person("cy")], "k");
    expect(conversationStarter(ada, [none!], labels)).toBe(
      "Opener: what are you each working on this term?",
    );
  });

  it("ends every event intro with a suggestion, the opener and the opt-out line", () => {
    const text = buildConferenceIntroMessage({
      conference_label: "EMNLP 2026",
      subject: ada,
      partners: [bob!],
      sites: [site],
      theme_labels: labels,
      today: "2026-10-26",
      in_town: "Budapest",
    });
    expect(text).toContain("you are all around EMNLP 2026 in Budapest this week");
    expect(text).not.toContain("(in ");
    expect(text.split("\n").slice(-3)).toEqual([
      "Idea: grab a coffee between sessions, or walk the posters together.",
      'Opener: ADA, ask BOB how "Agents that negotiate" is going.',
      "Not for you? Turn these intros off or snooze them in AdminBot > Events.",
    ]);
  });

  it("gives the city intro the metro as its reason and says why the member got it", () => {
    const text = buildCityIntroMessage({
      place_label: "San Francisco Bay Area",
      subject: ada,
      partners: [bob!],
      theme_labels: labels,
    });
    expect(text).toContain(
      "Hi ADA and BOB -- you are both around San Francisco Bay Area this week",
    );
    expect(text).toContain("ADA and BOB both work on Multi-agent.");
    expect(text).toContain("Idea: lunch or a coffee somewhere central this week.");
    expect(text).toContain("You get these because you turned on city intros.");
  });
});
