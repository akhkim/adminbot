import { describe, expect, it } from "vitest";
import { paperInvolvesMember } from "./paper-involvement.js";

describe("paperInvolvesMember", () => {
  it("matches every link a member can have to a paper", () => {
    expect(paperInvolvesMember({ submitted_by_member_id: "ada" }, "ada", "Ada Author")).toBe(true);
    expect(paperInvolvesMember({ first_author_member_id: "ada" }, "ada", null)).toBe(true);
    expect(paperInvolvesMember({ mentor_member_id: "ada" }, "ada", null)).toBe(true);
    expect(paperInvolvesMember({ author_links: [{ member_id: "ada" }] }, "ada", null)).toBe(true);
    expect(paperInvolvesMember({ authors: ["Author, Ada*"] }, null, "Ada Author")).toBe(true);
  });

  it("does not match someone else's paper, or anything for a nameless, idless viewer", () => {
    const paper = { submitted_by_member_id: "bo", authors: ["Bo Coauthor"] };
    expect(paperInvolvesMember(paper, "ada", "Ada Author")).toBe(false);
    expect(paperInvolvesMember(paper, null, "")).toBe(false);
  });
});
