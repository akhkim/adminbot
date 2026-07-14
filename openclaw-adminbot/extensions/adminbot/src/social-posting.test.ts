import { describe, expect, it } from "vitest";
import { assertSocialPayloadReady, buildPaperSocialPayload, splitForX } from "./social-posting.js";

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
