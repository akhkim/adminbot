import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  classifyMemberThemes,
  isThemeMeetingEligible,
  memberThemeIds,
  normalizeThemeText,
  RESEARCH_THEME_IDS,
  RESEARCH_THEMES,
  themeMeetings,
} from "./research-themes.js";

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

describe("normalizeThemeText", () => {
  it("collapses punctuation and case onto one spelling", () => {
    expect(normalizeThemeText("Multi-Agent")).toBe("multi agent");
    expect(normalizeThemeText("Multi-Agent/Game Theory")).toBe("multi agent game theory");
    expect(normalizeThemeText("  LLM   Post-training ")).toBe("llm post training");
  });
});

describe("classifyMemberThemes", () => {
  it("places the roster's four spellings of multi-agent on the same theme", () => {
    // These are verbatim from the production roster. The variety is spelling, not meaning.
    for (const topic of [
      "Multi-Agent",
      "multi-agent systems",
      "Multi Agent LLM systems",
      "Multiagent LLMs",
      "Multi Agent Systems",
    ]) {
      expect(memberThemeIds(member({ research_topics: [topic] }))).toContain("multi_agent");
    }
  });

  it("reads both research topics and projects", () => {
    expect(memberThemeIds(member({ research_topics: ["Causality"] }))).toEqual(["causal_llm"]);
    // Several members list only projects; a classifier reading one field misses them.
    expect(memberThemeIds(member({ projects: ["UKA Clinical Post-Training"] }))).toEqual([
      "post_training",
    ]);
    expect(memberThemeIds(member({ projects: ["Open Source Game Theory"] }))).toEqual([
      "multi_agent",
    ]);
  });

  it("assigns every theme a member's words support, not just the first", () => {
    const themes = memberThemeIds(
      member({
        research_topics: [
          "AI Safety",
          "Adversarial Defense",
          "LLM Jailbreaking",
          "LLM Post-training",
          "Causal Inference",
        ],
      }),
    );
    expect(themes).toEqual(
      expect.arrayContaining(["adversarial_defense", "post_training", "causal_llm"]),
    );
  });

  it("names the phrase and the member's own words for every match", () => {
    const [match] = classifyMemberThemes(
      member({ research_topics: ["Causal Inference and LLMs"] }),
    );
    expect(match?.theme).toBe("causal_llm");
    expect(match?.evidence).toContainEqual({
      pattern: "causal inference",
      source: "Causal Inference and LLMs",
    });
  });

  it("does not repeat one pattern because two topics contain it", () => {
    const [match] = classifyMemberThemes(member({ research_topics: ["Causal LLM", "Causal LLM"] }));
    const causal = match?.evidence.filter((item) => item.pattern === "causal") ?? [];
    expect(causal).toHaveLength(1);
  });

  it("matches whole phrases, so a substring does not claim somebody", () => {
    // "control" inside "controlled" and "sae" inside "saesthetics" are the failure this guards.
    expect(memberThemeIds(member({ research_topics: ["controlled experiments"] }))).toEqual([]);
    expect(memberThemeIds(member({ research_topics: ["saesthetics"] }))).toEqual([]);
    // But the real phrases still land.
    expect(
      memberThemeIds(member({ research_topics: ["CoT monitoring and AI control"] })),
    ).toContain("loss_of_control");
    expect(memberThemeIds(member({ research_topics: ["SAE probing"] }))).toContain("mech_interp");
  });

  it("catches the phrasings a first pass over the real roster missed", () => {
    // Each of these is a production profile that went unclassified until its pattern was added.
    // They are here so a later tidy-up of the table cannot quietly drop them again.
    expect(
      memberThemeIds(member({ research_topics: ["Agentic and multi agentic Safety"] })),
    ).toContain("multi_agent");
    expect(memberThemeIds(member({ research_topics: ["Influence function"] }))).toContain(
      "mech_interp",
    );
    expect(memberThemeIds(member({ research_topics: ["LLM Deception"] }))).toContain(
      "loss_of_control",
    );
  });

  it("returns nothing for a member who has written nothing matching", () => {
    // A real answer rather than a failure: an unfilled profile cannot be classified, and guessing
    // from a name or a channel is the inference this module exists to avoid.
    expect(classifyMemberThemes(member())).toEqual([]);
    expect(classifyMemberThemes(member({ research_topics: [], projects: [] }))).toEqual([]);
    expect(classifyMemberThemes(member({ research_topics: ["Reasoning", "LLMs"] }))).toEqual([]);
  });

  it("classifies the abbreviations members actually use", () => {
    expect(memberThemeIds(member({ research_topics: ["Interp"] }))).toContain("mech_interp");
    expect(memberThemeIds(member({ research_topics: ["RLHF"] }))).toContain("post_training");
    expect(memberThemeIds(member({ research_topics: ["DPO and SFT"] }))).toContain("post_training");
  });
});

describe("isThemeMeetingEligible", () => {
  it("admits full members and major coauthors", () => {
    expect(isThemeMeetingEligible(member({ member_type: "full" }))).toBe(true);
    expect(isThemeMeetingEligible(member({ member_type: "coauthor-major" }))).toBe(true);
    // The roster stores several types in one string, which is how the live sheet spells it.
    expect(
      isThemeMeetingEligible(member({ member_type: "full, adminbot-admin, adminbot-developer" })),
    ).toBe(true);
  });

  it("excludes everybody else, including the other kinds of coauthor", () => {
    for (const type of [
      "coauthor-minor",
      "disappearing-coauthor",
      "interviewee",
      "mailing-list",
      "external-prof",
      "acquaintance",
      undefined,
    ]) {
      expect(isThemeMeetingEligible(member({ member_type: type }))).toBe(false);
    }
  });

  it("excludes alumni even when the type still says full", () => {
    // The roster keeps the old type after somebody leaves; 22 of 24 alumni carry no status at all.
    expect(isThemeMeetingEligible(member({ member_type: "full, alumni" }))).toBe(false);
    expect(isThemeMeetingEligible(member({ member_type: "full", status: "alumni" }))).toBe(false);
  });
});

describe("themeMeetings", () => {
  const wednesday = [
    { event_id: "e1", summary: "Theme: Loss of Control/Power Concentration" },
    { event_id: "e2", summary: "Theme: Multi-Agent Weekly" },
    { event_id: "e3", summary: "Theme: Mech-Interp Weekly" },
    { event_id: "e4", summary: "Theme: Causal LLM Meeting" },
    { event_id: "e5", summary: "Theme: Jinesis Post-Training" },
    { event_id: "e6", summary: "Theme: Adversarial Defense" },
    { event_id: "e7", summary: "Proj: Law-to-Bench Meeting" },
    { event_id: "e8", summary: "Zurich: Jinesis Lunch@OAT" },
  ];

  it("finds the meeting for each of the six themes", () => {
    const found = RESEARCH_THEME_IDS.map((id) =>
      themeMeetings(id, wednesday).map((m) => m.event_id),
    );
    expect(found).toEqual([["e1"], ["e2"], ["e3"], ["e4"], ["e5"], ["e6"]]);
  });

  it("ignores events that are not themed meetings", () => {
    // "Proj:" and the lunch share the calendar and must never be claimed by a theme.
    const claimed = RESEARCH_THEME_IDS.flatMap((id) =>
      themeMeetings(id, wednesday).map((m) => m.event_id),
    );
    expect(claimed).not.toContain("e7");
    expect(claimed).not.toContain("e8");
  });

  it("returns both when two events answer to one theme", () => {
    // The live calendar has two "Theme: Causal LLM" entries in the same hour. The caller is meant
    // to see that rather than have one picked for it.
    const doubled = [...wednesday, { event_id: "e9", summary: "Theme: Causal LLM Meeting" }];
    expect(themeMeetings("causal_llm", doubled).map((m) => m.event_id)).toEqual(["e4", "e9"]);
  });
});

describe("the theme table", () => {
  it("covers every declared theme id exactly once", () => {
    expect(RESEARCH_THEMES.map((theme) => theme.id)).toEqual([...RESEARCH_THEME_IDS]);
  });

  it("stores patterns already normalised, or they could never match", () => {
    // A pattern with a capital or a hyphen is dead code: matching happens against normalised text.
    for (const theme of RESEARCH_THEMES) {
      for (const pattern of theme.patterns) {
        expect(pattern).toBe(normalizeThemeText(pattern));
      }
    }
  });
});
