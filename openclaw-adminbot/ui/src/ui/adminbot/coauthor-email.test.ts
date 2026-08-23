import { describe, expect, it } from "vitest";
import {
  ADMINBOT_BCC,
  buildCoauthorEmail,
  coauthorEmails,
  firstFullMemberAuthor,
  hasPlaceholders,
  unreachableAuthors,
} from "./coauthor-email.ts";
import type { AdminBotLabMember, AdminBotPaperRecord } from "./controllers/admin.ts";

const roster = [
  { id: "ext", name: "Outside Collaborator", privilege_level: "external_collaborator", email: "ext@x.com" },
  { id: "tri", name: "Trial Person", privilege_level: "trial", email: "trial@lab.test" },
  { id: "mem", name: "Joeun Yook", privilege_level: "member", email: "joeun@lab.test" },
  { id: "pi", name: "Zhijing Jin", privilege_level: "admin", correspondence_email: "zj@lab.test" },
] as never as AdminBotLabMember[];

function paper(authors: string[], fields: Record<string, unknown> = {}): AdminBotPaperRecord {
  return { id: "p1", title: "A paper", authors, current_step: "submission", ...fields } as never;
}

describe("who is asked to send it", () => {
  it("picks the first full member, not the first author", () => {
    // Papers routinely list a student or an external collaborator first, and the mail carries the
    // lab's name.
    const chosen = firstFullMemberAuthor(paper(["Outside Collaborator", "Joeun Yook"]), roster);
    expect(chosen?.id).toBe("mem");
  });

  it("skips trial members and external collaborators", () => {
    expect(firstFullMemberAuthor(paper(["Trial Person", "Outside Collaborator"]), roster)).toBeUndefined();
  });

  it("counts an admin as a full member", () => {
    expect(firstFullMemberAuthor(paper(["Zhijing Jin"]), roster)?.id).toBe("pi");
  });

  it("follows author order, so the answer is predictable from the paper", () => {
    expect(firstFullMemberAuthor(paper(["Zhijing Jin", "Joeun Yook"]), roster)?.id).toBe("pi");
    expect(firstFullMemberAuthor(paper(["Joeun Yook", "Zhijing Jin"]), roster)?.id).toBe("mem");
  });

  it("matches names carrying an equal-contribution marker", () => {
    expect(firstFullMemberAuthor(paper(["Joeun Yook*"]), roster)?.id).toBe("mem");
  });
});

describe("recipients", () => {
  it("collects everyone the roster knows, senior authors included", () => {
    expect(coauthorEmails(paper(["Joeun Yook", "Zhijing Jin"]), roster)).toEqual([
      "joeun@lab.test",
      "zj@lab.test",
    ]);
  });

  it("prefers the correspondence address over the login one", () => {
    expect(coauthorEmails(paper(["Zhijing Jin"]), roster)).toEqual(["zj@lab.test"]);
  });

  it("names anyone with no address rather than quietly dropping them", () => {
    expect(unreachableAuthors(paper(["Joeun Yook", "Nobody Known"]), roster)).toEqual([
      "Nobody Known",
    ]);
  });

  it("does not repeat an address when somebody is listed twice", () => {
    expect(coauthorEmails(paper(["Joeun Yook", "Joeun Yook*"]), roster)).toEqual(["joeun@lab.test"]);
  });
});

describe("the draft", () => {
  it("fills in what the record knows and brackets what it does not", () => {
    const draft = buildCoauthorEmail(
      paper(["Joeun Yook"], { presentation_type: "findings" }),
      "accept",
      "EMNLP 2026",
      "Joeun Yook",
    );
    expect(draft.subject).toBe("Accepted to EMNLP 2026: A paper");
    expect(draft.body).toContain("accepted to EMNLP 2026 (findings)");
    expect(draft.body).toContain("Joeun Yook");
    expect(hasPlaceholders(draft.body)).toBe(true);
  });

  it("says something different on a rejection", () => {
    const draft = buildCoauthorEmail(paper([]), "reject", "ICLR 2027", "Joeun Yook");
    expect(draft.body).toContain("was not accepted at ICLR 2027");
    expect(draft.body).toContain("[PROPOSE THE NEXT VENUE");
  });

  it("stops warning once the brackets are filled in", () => {
    expect(hasPlaceholders("Dear all,\n\nCamera ready is 3 Nov.\n\nBest,\nJoeun")).toBe(false);
  });

  it("always copies the lab mailbox", () => {
    expect(ADMINBOT_BCC).toBe("jinesis.adminbot@gmail.com");
  });
});
