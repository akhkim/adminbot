import { describe, it, expect } from "vitest";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import { internalReviewerSuggestions, parsePeerReviewDraft } from "./internal-peer-review.js";
const paper = {
  id: "p",
  title: "Causal models",
  authors: ["Author"],
  author_links: [{ member_id: "author", name: "Author" }],
} as AdminBotPaperRecord;
const member = (id: string, extra: Partial<AdminBotLabMember> = {}) =>
  ({ id, name: id, research_topics: ["causal"], ...extra }) as AdminBotLabMember;
describe("internal reviewer draft", () => {
  it("ranks title/topic matches without OpenReview IDs and excludes participants/exemptions", () => {
    const result = internalReviewerSuggestions(
      [
        member("author", { name: "Author" }),
        member("reader"),
        member("exempt", { reviewer_exempt: true }),
        member("unrelated", { research_topics: ["vision"] }),
      ],
      paper,
    );
    expect(result).toEqual([{ member_id: "reader", name: "reader", matched_topics: ["causal"] }]);
  });
  it("does not disclose private availability notes", () => {
    const result = internalReviewerSuggestions(
      [member("reader", { availability: [{ note: "PRIVATE" }] as never })],
      paper,
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("allows incomplete drafts but refuses credentials in URLs and unknown fields", () => {
    expect(parsePeerReviewDraft({ purpose: "", draft_url: "", nominee_ids: [] })).not.toBeNull();
    expect(
      parsePeerReviewDraft({
        purpose: "",
        draft_url: "https://user:password@example.test",
        nominee_ids: [],
      }),
    ).toBeNull();
    expect(
      parsePeerReviewDraft({ purpose: "", draft_url: "", nominee_ids: [], accepted: true }),
    ).toBeNull();
  });
});
