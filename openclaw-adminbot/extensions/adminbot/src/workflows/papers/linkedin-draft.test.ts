import { describe, expect, it } from "vitest";
import {
  buildLinkedInDraftPrompt,
  extractHashtags,
  JINESIS_LINKEDIN_SYSTEM_PROMPT,
  normalizePersonName,
  pickDirectives,
  reviewLinkedInDraft,
  stripMarkdown,
  toFirstLast,
  verifyAuthorsAgainstMembers,
} from "./linkedin-draft.js";
import type { AdminBotLabMember } from "../../contracts/actions.js";

const base = {
  privilege_level: "member" as const,
  access: [],
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-01T00:00:00.000Z",
};

function member(id: string, name: string, extra: Partial<AdminBotLabMember> = {}) {
  return { ...base, id, name, ...extra } as AdminBotLabMember;
}

describe("author verification against the roster", () => {
  it("matches through diacritics, because rosters and author lists disagree about them", () => {
    expect(normalizePersonName("Bernhard Schölkopf")).toBe("bernhard scholkopf");
    const [author] = verifyAuthorsAgainstMembers(
      ["Bernhard Scholkopf"],
      [member("bs", "Bernhard Schölkopf")],
    );
    expect(author).toMatchObject({ matched: true, match: "exact", displayName: "Bernhard Schölkopf" });
  });

  it("flips 'Last, First' before matching", () => {
    expect(toFirstLast("Jin, Zhijing")).toBe("Zhijing Jin");
    const [author] = verifyAuthorsAgainstMembers(["Jin, Zhijing"], [member("zj", "Zhijing Jin")]);
    expect(author?.matched).toBe(true);
  });

  it("falls back to surname plus first initial, and reports it as the weaker match", () => {
    const [author] = verifyAuthorsAgainstMembers(["Z. Jin"], [member("zj", "Zhijing Jin")]);
    expect(author).toMatchObject({ matched: true, match: "initial", displayName: "Zhijing Jin" });
  });

  it("refuses to guess between two people who share a surname and initial", () => {
    const [author] = verifyAuthorsAgainstMembers(
      ["A. Doe"],
      [member("a1", "Alice Doe"), member("a2", "Andrew Doe")],
    );
    // Naming the wrong person in a public post is the failure this exists to prevent.
    expect(author).toMatchObject({ matched: false, match: "none", displayName: "A. Doe" });
  });

  it("keeps unknown authors, spelled the way the paper spells them", () => {
    const authors = verifyAuthorsAgainstMembers(["Zhijing Jin", "Outside Collaborator"], [
      member("zj", "Zhijing Jin"),
    ]);
    expect(authors.map((a) => a.displayName)).toEqual(["Zhijing Jin", "Outside Collaborator"]);
    expect(authors[1]?.matched).toBe(false);
  });

  it("carries the fields a real @mention needs", () => {
    const [author] = verifyAuthorsAgainstMembers(
      ["Zhijing Jin"],
      [member("zj", "Zhijing Jin", { linkedin_urn: "urn:li:person:abc", linkedin_url: "u" })],
    );
    expect(author).toMatchObject({ linkedin_urn: "urn:li:person:abc", member_id: "zj" });
  });
});

describe("prompt assembly", () => {
  const paper = {
    title: "Localizing LLM Failures",
    authors: ["Joeun Yook"],
    abstract: "We study where sequential decision making breaks down.",
    url: "https://arxiv.org/abs/2601.00001",
  };

  it("marks verified authors and preserves paper order", () => {
    const authorsVerified = verifyAuthorsAgainstMembers(
      ["Joeun Yook", "Someone Else"],
      [member("jy", "Joeun Yook")],
    );
    const { system, user } = buildLinkedInDraftPrompt({ paper, authorsVerified });
    expect(system).toBe(JINESIS_LINKEDIN_SYSTEM_PROMPT);
    expect(user).toContain("- Joeun Yook (verified lab member)");
    expect(user).toContain("- Someone Else\n");
    expect(user.indexOf("Joeun Yook")).toBeLessThan(user.indexOf("Someone Else"));
  });

  it("tells the model to stay silent about a venue it was not given", () => {
    const { user } = buildLinkedInDraftPrompt({ paper, authorsVerified: [] });
    expect(user).toContain("do NOT mention any venue");
  });

  it("passes venue details through when they exist", () => {
    const { user } = buildLinkedInDraftPrompt({
      paper,
      authorsVerified: [],
      venue: "ICML 2026, poster Wed Jul 8 Hall A #3015",
    });
    expect(user).toContain("Hall A #3015");
    expect(user).not.toContain("do NOT mention any venue");
  });

  it("omits the link line rather than inventing a link", () => {
    const { user } = buildLinkedInDraftPrompt({
      paper: { ...paper, url: undefined },
      authorsVerified: [],
    });
    expect(user).toContain("OMIT the paper-link line entirely");
  });

  it("varies structure across runs", () => {
    const lowest = pickDirectives(() => 0);
    const highest = pickDirectives(() => 0.999);
    expect(lowest).not.toBe(highest);
    // A random() returning exactly 1 must not index past the end of the array.
    expect(pickDirectives(() => 1)).toContain("Credit authors as:");
  });
});

describe("draft review", () => {
  const long = (tags: string) => `${"a word ".repeat(200)}\n${tags}`;
  const fiveTags = "#AISafety #LLM #NLP #ICML2026 #AIResearch";

  it("counts hashtags, deduplicating case-insensitively", () => {
    expect(extractHashtags("#AISafety #aisafety #LLM")).toEqual(["#AISafety", "#LLM"]);
  });

  it("accepts a well-formed post", () => {
    expect(reviewLinkedInDraft(long(fiveTags))).toEqual([]);
  });

  it("flags a post that is too short", () => {
    expect(reviewLinkedInDraft(`short ${fiveTags}`).join(" ")).toContain("short of the 900 minimum");
  });

  it("flags too few hashtags", () => {
    expect(reviewLinkedInDraft(long("#OnlyOne")).join(" ")).toContain("only 1 hashtags");
  });

  it("flags markdown, which LinkedIn ships as literal characters", () => {
    expect(reviewLinkedInDraft(long(`**bold** ${fiveTags}`)).join(" ")).toContain("contains markdown");
  });

  it("flags a dropped author, the failure the prompt works hardest to prevent", () => {
    const authors = verifyAuthorsAgainstMembers(["Zhijing Jin"], [member("zj", "Zhijing Jin")]);
    expect(reviewLinkedInDraft(long(fiveTags), authors).join(" ")).toContain(
      "author(s) missing from the post: Zhijing Jin",
    );
  });

  it("strips emphasis without touching hashtags or emoji", () => {
    expect(stripMarkdown("**Excited** to share *this* 🎉 #AISafety")).toBe(
      "Excited to share this 🎉 #AISafety",
    );
  });
});
