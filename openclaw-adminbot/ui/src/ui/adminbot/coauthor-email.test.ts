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
    expect(draft.subject).toBe("Accepted 🎉 [PAPER_SHORT_TITLE] at EMNLP 2026");
    expect(draft.body).toContain("A paper has been accepted at EMNLP 2026!");
    expect(draft.body).toContain("Camera-ready is due [DATE]");
    expect(draft.body).toContain("Joeun Yook");
    expect(hasPlaceholders(draft.body)).toBe(true);
  });

  it("says something different on a rejection", () => {
    const draft = buildCoauthorEmail(paper([]), "reject", "ICLR 2027", "Joeun Yook");
    expect(draft.subject).toBe("[PAPER_SHORT_TITLE]: ICLR 2027 outcome and next steps");
    expect(draft.body).toContain("The ICLR 2027 decision for A paper unfortunately came back");
    expect(draft.body).toContain("resubmit to [NEXT_VENUE]");
    expect(draft.body).toContain("[REVIEWS_LINK]");
  });

  it("stops warning once the brackets are filled in", () => {
    expect(hasPlaceholders("Dear all,\n\nCamera ready is 3 Nov.\n\nBest,\nJoeun")).toBe(false);
  });

  it("always copies the lab mailbox", () => {
    expect(ADMINBOT_BCC).toBe("jinesis.adminbot@gmail.com");
  });
});

describe("the pinned EMNLP 2026 senders", () => {
  const roster = [
    { id: "terry", name: "Terry Zhang", privilege_level: "member" },
    { id: "joeun", name: "Joeun Yook", privilege_level: "member" },
    { id: "vedant", name: "Vedant Palit", privilege_level: "member" },
    { id: "ryan", name: "Ryan Faulkner", privilege_level: "member" },
    { id: "zhijing", name: "Zhijing Jin", privilege_level: "admin" },
    // Labelled a member on the deployed roster, and not on the lab's list of 49. This is the row
    // the pinning exists to overrule.
    { id: "francesco", name: "Francesco Ortu", privilege_level: "member" },
  ] as never[];

  const titled = (title: string, authors: string[]) =>
    ({ id: title, title, authors }) as never;

  it("gives Terry the five that are his", () => {
    const his = [
      "PruneGround: Plug-and-play Spatial Pruning",
      "Computation Graph Recovery from Chain-of-Thought",
      "Fluid Reasoning Representations",
      "Evaluating Second-Order Bias of LLMs",
      "How Does Alignment Tuning Shape Representations",
    ];
    for (const title of his) {
      expect(firstFullMemberAuthor(titled(title, ["Someone Else", "Zhijing Jin"]), roster)?.id).toBe(
        "terry",
      );
    }
  });

  it("overrules a roster row the lab does not recognise", () => {
    const paper = titled("Preserving Historical Truth: Detecting Historical Revisionism", [
      "Francesco Ortu*",
      "Joeun Yook*",
      "Keenan Samway",
      "Zhijing Jin",
    ]);
    expect(firstFullMemberAuthor(paper, roster)?.id).toBe("joeun");
  });

  it("assigns the remaining three", () => {
    expect(firstFullMemberAuthor(titled("How Do Linear Probes Emerge?", []), roster)?.id).toBe(
      "vedant",
    );
    expect(
      firstFullMemberAuthor(titled("Simulating Democratic Deliberation", []), roster)?.id,
    ).toBe("ryan");
    expect(
      firstFullMemberAuthor(titled("Tracing Multilingual Representations in LLMs", []), roster)?.id,
    ).toBe("zhijing");
  });

  it("leaves every other paper to the rule", () => {
    const paper = titled("Some Unrelated Paper", ["Francesco Ortu", "Joeun Yook"]);
    expect(firstFullMemberAuthor(paper, roster)?.id).toBe("francesco");
  });
});

