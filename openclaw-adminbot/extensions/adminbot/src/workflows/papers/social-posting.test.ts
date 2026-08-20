import { describe, expect, it } from "vitest";
import {
  assertSocialPayloadReady,
  buildLinkedInCommentary,
  buildPaperSocialPayload,
  escapeLittleText,
  splitForX,
} from "./social-posting.js";

describe("AdminBot social posting helpers", () => {
  it("resolves author tags from member notes and splits long X posts", () => {
    const payload = buildPaperSocialPayload({
      paperId: "paper-1",
      title: "Causal Garden Planning",
      summary:
        "A long paper announcement about causal planning, evaluation, ablations, and collaboration that needs to fit into X without crossing the platform character boundary.",
      url: "https://example.test/paper",
      authors: ["alice", "bob"],
      hashtags: ["AI", "CausalInference"],
      members: [
        {
          id: "alice",
          name: "Alice Doe",
          email: "alice@example.test",
          privilege_level: "member",
          access: [],
          notes: "X: @alice_ai\nLinkedIn: @alice-doe",
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "bob",
          name: "Bob Doe",
          privilege_level: "member",
          access: [],
          notes: "Twitter: bob_lab\nLinkedIn URN: urn:li:person:abc123",
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    expect(payload.tags.missing).toEqual([]);
    expect(payload.tags.resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ member_id: "alice", x_handle: "@alice_ai" }),
        expect.objectContaining({ member_id: "bob", x_handle: "@bob_lab" }),
      ]),
    );
    expect(payload.linkedin?.text).toContain("@alice-doe");
    expect(payload.x?.posts.every((post) => [...post].length <= 280)).toBe(true);
    expect(() => assertSocialPayloadReady(payload)).not.toThrow();
  });

  it("records missing platform tags so approval can pause for roster updates", () => {
    const payload = buildPaperSocialPayload({
      title: "Paper",
      summary: "Summary",
      authors: ["Pat"],
      members: [
        {
          id: "pat",
          name: "Pat",
          privilege_level: "member",
          access: [],
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    expect(payload.tags.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Pat", platform: "linkedin" }),
        expect.objectContaining({ name: "Pat", platform: "x" }),
      ]),
    );
    expect(() => assertSocialPayloadReady(payload)).toThrow(/missing required tags/u);
  });

  it("keeps split X posts within the hard character limit", () => {
    const posts = splitForX(Array.from({ length: 120 }, (_, index) => `word${index}`).join(" "));

    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((post) => [...post].length <= 280)).toBe(true);
    expect(posts[0]).toMatch(/\(1\/\d+\)$/u);
  });
});

describe("author tags from first-class profile fields", () => {
  const base = {
    privilege_level: "member" as const,
    access: [],
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
  };

  it("reads profile URLs, and parses a handle out of an X profile URL", () => {
    // Regression: the handle parser was unanchored, so any profile URL resolved to "@https".
    const payload = buildPaperSocialPayload({
      title: "Paper",
      summary: "Summary",
      authors: ["Alice Doe", "Bob Doe"],
      members: [
        {
          ...base,
          id: "alice",
          name: "Alice Doe",
          twitter_url: "https://x.com/alice_ai",
          linkedin_url: "https://www.linkedin.com/in/alice-doe/",
        },
        {
          ...base,
          id: "bob",
          name: "Bob Doe",
          twitter_url: "https://twitter.com/bob_lab",
          linkedin_urn: "urn:li:person:abc123",
        },
      ],
    });

    expect(payload.tags.missing).toEqual([]);
    expect(payload.tags.resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          member_id: "alice",
          x_handle: "@alice_ai",
          linkedin_url: "https://www.linkedin.com/in/alice-doe/",
        }),
        expect.objectContaining({ member_id: "bob", x_handle: "@bob_lab" }),
      ]),
    );
    // A URL is identification, not a tag: it must never be substituted into the post text.
    expect(payload.linkedin?.text).not.toContain("linkedin.com/in/alice-doe");
  });

  it("prefers the profile field over a stale notes line", () => {
    const payload = buildPaperSocialPayload({
      title: "Paper",
      summary: "Summary",
      authors: ["Alice Doe"],
      members: [
        {
          ...base,
          id: "alice",
          name: "Alice Doe",
          twitter_url: "https://x.com/alice_new",
          linkedin_urn: "urn:li:person:new",
          notes: "X: @alice_old\nLinkedIn URN: urn:li:person:old",
        },
      ],
    });

    expect(payload.tags.resolved[0]).toMatchObject({
      x_handle: "@alice_new",
      linkedin_urn: "urn:li:person:new",
    });
  });

  it("uses a generated draft verbatim instead of the assembled template", () => {
    const drafted = "🚨 Can LLMs plan causally?\n\nExcited to share our new paper.\n\n#AISafety";
    const payload = buildPaperSocialPayload({
      title: "Paper",
      summary: "Summary",
      authors: [],
      members: [],
      linkedinText: drafted,
    });

    expect(payload.linkedin?.text).toBe(drafted);
    // The X thread is built independently and is unaffected by the LinkedIn draft.
    expect(payload.x?.posts[0]).toContain("New paper: Paper");
  });
});

describe("LinkedIn commentary: escaping and mentions", () => {
  it("escapes Little Text reserved characters but leaves hashtags live", () => {
    // Unescaped, these silently truncate or corrupt the post rather than erroring.
    const out = escapeLittleText("Excited (really!) to share @work [v2] 50% *now* #AISafety");
    expect(out).toContain("\\(really!\\)");
    expect(out).toContain("\\@work");
    expect(out).toContain("\\[v2\\]");
    expect(out).toContain("\\*now\\*");
    expect(out).toContain("#AISafety");
    expect(out).not.toContain("\\#");
  });

  it("leaves emoji untouched", () => {
    expect(escapeLittleText("🚨 New paper 🎉")).toBe("🚨 New paper 🎉");
  });

  it("mentions an author who has a URN", () => {
    const out = buildLinkedInCommentary("Joint work by Zhijing Jin!", [
      { name: "Zhijing Jin", linkedin_urn: "urn:li:person:abc123" },
    ]);
    expect(out).toContain("@[Zhijing Jin](urn:li:person:abc123)");
  });

  it("leaves an author with no URN as a plain name", () => {
    // The rule: URN if we have one, otherwise the name exactly as the post already spells it.
    // There is no fallback that would ping anyone -- LinkedIn addresses people only by URN.
    const out = buildLinkedInCommentary("Joint work by Alice Doe!", [
      { name: "Alice Doe", linkedin_url: "https://linkedin.com/in/alice-doe" },
    ]);
    expect(out).toContain("Alice Doe");
    expect(out).not.toContain("@[");
  });

  it("mentions each person once, at the first occurrence", () => {
    const out = buildLinkedInCommentary("Zhijing Jin led this. Thanks Zhijing Jin!", [
      { name: "Zhijing Jin", linkedin_urn: "urn:li:person:abc" },
    ]);
    expect(out.match(/@\[Zhijing Jin\]/gu)).toHaveLength(1);
  });

  it("mentions inside text that also needed escaping", () => {
    // The mention wrapper is itself made of reserved characters, so it must be inserted
    // after escaping and must survive intact.
    const out = buildLinkedInCommentary("Great work (2026) by Zhijing Jin", [
      { name: "Zhijing Jin", linkedin_urn: "urn:li:person:abc" },
    ]);
    expect(out).toContain("\\(2026\\)");
    expect(out).toContain("@[Zhijing Jin](urn:li:person:abc)");
  });

  it("skips an author whose name does not appear in the post", () => {
    const out = buildLinkedInCommentary("A post naming nobody.", [
      { name: "Zhijing Jin", linkedin_urn: "urn:li:person:abc" },
    ]);
    expect(out).not.toContain("@[");
  });
});
