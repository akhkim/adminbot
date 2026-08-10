import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  countNeedleHits,
  memberRelevanceNeedles,
  reviewerExemptionReason,
  suggestReviewersForSubmission,
  textMatchesNeedles,
} from "./openreview-matching.js";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "m1",
    name: "Ada Lovelace",
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("memberRelevanceNeedles", () => {
  it("collects name, branch, topics and projects, lowercased and trimmed", () => {
    const needles = memberRelevanceNeedles(
      member({
        name: "  Ada Lovelace ",
        research_branch: "Causality",
        research_topics: ["Interpretability", ""],
        projects: ["Analytical Engine"],
      }),
    );
    expect(needles).toEqual(["ada lovelace", "causality", "interpretability", "analytical engine"]);
  });
});

describe("textMatchesNeedles / countNeedleHits", () => {
  it("matches case-insensitively and counts distinct hits for ranking", () => {
    const needles = ["causality", "interpretability", "robotics"];
    const text = "On CAUSALITY and Interpretability in language models";
    expect(textMatchesNeedles(text, needles)).toBe(true);
    expect(countNeedleHits(text, needles)).toBe(2);
  });

  it("respects word boundaries so short needles don't match inside other words", () => {
    expect(textMatchesNeedles("a study of quality metrics", ["li"])).toBe(false);
    expect(textMatchesNeedles("work by Li and others", ["li"])).toBe(true);
    // Punctuation-heavy needles still match rather than being mangled by the boundary rule.
    expect(textMatchesNeedles("written in C++ throughout", ["c++"])).toBe(true);
  });

  it("never matches on an empty needle set", () => {
    expect(textMatchesNeedles("anything", [])).toBe(false);
    expect(countNeedleHits("anything", [])).toBe(0);
  });
});

describe("suggestReviewersForSubmission", () => {
  const submission = {
    number: 12,
    title: "Causal Probing of Language Models",
    abstract: "We study interpretability of causal circuits.",
    keywords: ["causality", "interpretability"],
  };

  it("ranks members by how many of their topics the submission hits", () => {
    const suggestions = suggestReviewersForSubmission(
      [
        member({ id: "one", name: "One", research_topics: ["causality"], openreview_id: "~One1" }),
        member({
          id: "two",
          name: "Two",
          research_topics: ["causality", "interpretability"],
          openreview_id: "~Two1",
        }),
        member({ id: "three", name: "Three", research_topics: ["robotics"] }),
      ],
      submission,
    );
    expect(suggestions.map((s) => s.member_id)).toEqual(["two", "one"]);
    expect(suggestions[0]?.score).toBe(2);
    expect(suggestions[0]?.matched_on).toEqual(["causality", "interpretability"]);
  });

  it("flags an apparent author rather than suggesting them as a reviewer", () => {
    const [suggestion] = suggestReviewersForSubmission(
      [
        member({
          id: "author",
          name: "Causal Probing",
          research_topics: ["causality"],
          openreview_id: "~Causal_Probing1",
        }),
      ],
      submission,
    );
    expect(suggestion?.blocked_reason).toContain("author");
    // The name hit is authorship evidence, not expertise, so it must not inflate the score.
    expect(suggestion?.score).toBe(1);
  });

  it("flags members already assigned, on leave, or with no openreview_id", () => {
    const suggestions = suggestReviewersForSubmission(
      [
        member({ id: "assigned", name: "A", research_topics: ["causality"], openreview_id: "~A1" }),
        member({
          id: "away",
          name: "B",
          research_topics: ["causality"],
          openreview_id: "~B1",
          status: "on_leave",
        }),
        member({ id: "unmapped", name: "C", research_topics: ["causality"] }),
      ],
      { ...submission, assigned_reviewers: ["~A1"] },
    );
    const byId = new Map(suggestions.map((s) => [s.member_id, s.blocked_reason]));
    expect(byId.get("assigned")).toContain("already assigned");
    expect(byId.get("away")).toContain("on_leave");
    expect(byId.get("unmapped")).toContain("openreview_id");
  });

  it("sorts assignable candidates above blocked ones and honours the limit", () => {
    const suggestions = suggestReviewersForSubmission(
      [
        member({
          id: "blocked",
          name: "B",
          research_topics: ["causality", "interpretability"],
          openreview_id: "~B1",
          status: "alumni",
        }),
        member({ id: "ok", name: "O", research_topics: ["causality"], openreview_id: "~O1" }),
      ],
      submission,
    );
    expect(suggestions.map((s) => s.member_id)).toEqual(["ok", "blocked"]);
    expect(suggestReviewersForSubmission([], submission, { limit: 1 })).toEqual([]);
  });

  it("never proposes a member with a standing reviewer exemption", () => {
    const [suggestion] = suggestReviewersForSubmission(
      [
        member({
          id: "bernhard",
          name: "Bernhard Example",
          research_topics: ["causality"],
          openreview_id: "~Bernhard_Example1",
          reviewer_exempt: true,
        }),
      ],
      submission,
    );
    expect(suggestion?.blocked_reason).toBe("exempt from reviewer assignment");
  });

  it("never proposes the profile chairing the venue as one of its reviewers", () => {
    const [suggestion] = suggestReviewersForSubmission(
      [
        member({
          id: "zhijing",
          name: "Zhijing Example",
          research_topics: ["causality"],
          openreview_id: "~Zhijing_Example1",
        }),
      ],
      submission,
      { operatorOpenReviewId: "~Zhijing_Example1" },
    );
    expect(suggestion?.blocked_reason).toBe("is the profile chairing this venue");
  });

  it("keeps an exemption ahead of every other reason, so the real cause is the one shown", () => {
    // An exempt member who is also on leave must read as exempt: one is a standing
    // decision, the other is a temporary state that would imply they return to the pool.
    const [suggestion] = suggestReviewersForSubmission(
      [
        member({
          id: "both",
          name: "Both Reasons",
          research_topics: ["causality"],
          openreview_id: "~Both_Reasons1",
          reviewer_exempt: true,
          status: "on_leave",
        }),
      ],
      submission,
    );
    expect(suggestion?.blocked_reason).toBe("exempt from reviewer assignment");
  });

  it("does not propose someone who is away from the lab for the whole current period", () => {
    const [suggestion] = suggestReviewersForSubmission(
      [
        member({
          id: "away",
          name: "Away Person",
          research_topics: ["causality"],
          openreview_id: "~Away_Person1",
          time_off: [
            {
              start: "2026-08-01",
              end: "2026-12-31",
              kind: "internship" as const,
              availability: "none" as const,
              note: "internship",
            },
          ],
        }),
      ],
      submission,
      { todayIso: "2026-08-06" },
    );
    expect(suggestion?.blocked_reason).toBe("away from the lab (internship)");
  });

  it("still proposes someone only partly away — they are around, just with less time", () => {
    const [suggestion] = suggestReviewersForSubmission(
      [
        member({
          id: "busy",
          name: "Busy Person",
          research_topics: ["causality"],
          openreview_id: "~Busy_Person1",
          availability: [
            {
              until: "2026-12-31",
              allocations: [{ activity: "Thesis", percent: 20 }],
              away: { percent: 80, reason: "busy semester" },
            },
          ],
        }),
      ],
      submission,
      { todayIso: "2026-08-06" },
    );
    expect(suggestion?.blocked_reason).toBeUndefined();
  });

  it("omits members with no topical overlap at all", () => {
    const suggestions = suggestReviewersForSubmission(
      [member({ id: "unrelated", name: "U", research_topics: ["fluid dynamics"] })],
      submission,
    );
    expect(suggestions).toEqual([]);
  });
});

describe("reviewerExemptionReason", () => {
  it("reports the standing exemption and the operator's own profile, and nothing else", () => {
    expect(reviewerExemptionReason(member({ reviewer_exempt: true }))).toBe(
      "exempt from reviewer assignment",
    );
    expect(reviewerExemptionReason(member({ openreview_id: "~Me1" }), "~Me1")).toBe(
      "is the profile chairing this venue",
    );
    expect(reviewerExemptionReason(member({ openreview_id: "~Other1" }), "~Me1")).toBeUndefined();
    expect(reviewerExemptionReason(member({ status: "on_leave" }))).toBeUndefined();
  });
});
