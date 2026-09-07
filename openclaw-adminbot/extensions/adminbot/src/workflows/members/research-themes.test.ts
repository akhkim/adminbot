import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  classifyMemberThemes,
  memberThemeIds,
  normalizeThemeText,
  RESEARCH_THEME_IDS,
  RESEARCH_THEMES,
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
