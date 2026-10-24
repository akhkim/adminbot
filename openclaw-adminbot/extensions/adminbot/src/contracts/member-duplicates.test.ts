// The two questions an admin is answering when they press Merge: is this one person, and what
// does the surviving record say afterwards.
import { describe, expect, it } from "vitest";
import {
  findDuplicateMembers,
  memberDuplicateReasons,
  planMemberMerge,
} from "./member-duplicates.js";

// The real shape of the collision: the Quick-Start survey writes the full name and the career
// detail, the Slack export writes the workspace name and the account facts.
const surveyHalf = {
  id: "terry-jingchen-zhang",
  name: "Terry Jingchen Zhang",
  email: "tzkpgc@gmail.com",
  role: "Master's Student",
  affiliation: "ETH",
  research_topics: ["Causality"],
  notes: "Source: Quick-Start Survey for Research Mentees\nCareer stage: MSc",
};

const slackHalf = {
  id: "terry-zhang",
  name: "Terry Zhang",
  correspondence_email: "zjingchen@cs.toronto.edu",
  slack_user_id: "U09QKBM74M6",
  location: "Asia/Chongqing",
  research_topics: ["causality", "Multi-agent"],
  notes: "Created from the Slack member export.\nMember Type: full",
};

describe("memberDuplicateReasons", () => {
  it("sees a full name and the short name behind it", () => {
    expect(memberDuplicateReasons(surveyHalf, slackHalf)).toEqual(["name_contains"]);
  });

  it("sees an English given name on one record only", () => {
    // isSamePerson cannot: it requires the first token to match, and these differ.
    expect(
      memberDuplicateReasons(
        { id: "alice-yuchen-zhang", name: "Alice Yuchen Zhang" },
        { id: "yuchen-zhang", name: "Yuchen Zhang" },
      ),
    ).toEqual(["name_contains"]);
  });

  it("leaves two different people who share a first and last name alone", () => {
    // The roster's own fixtures. Neither token set contains the other, so this is not a pair.
    expect(
      memberDuplicateReasons(
        { id: "proof-plain-member", name: "Proof Plain Member" },
        { id: "proof-admin-member", name: "Proof Admin Member" },
      ),
    ).toEqual([]);
  });

  it("matches on an account fact whatever the names say", () => {
    expect(
      memberDuplicateReasons(
        { id: "a", name: "Sam Okafor", email: "sam@lab.test" },
        { id: "b", name: "Samuel Okafor-Reed", correspondence_email: "SAM@lab.test" },
      ),
    ).toContain("same_email");
    expect(
      memberDuplicateReasons(
        { id: "a", name: "One Person", slack_user_id: "U1" },
        { id: "b", name: "Someone Else", slack_user_id: "U1" },
      ),
    ).toEqual(["same_slack_user_id"]);
  });
});

describe("findDuplicateMembers", () => {
  it("ranks account-fact matches above name-only ones", () => {
    const pairs = findDuplicateMembers([
      surveyHalf,
      slackHalf,
      { id: "c", name: "Dana Ruiz", email: "dana@lab.test" },
      { id: "d", name: "Dana Q Ruiz", email: "dana@lab.test" },
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.confidence).toBe("high");
    expect(pairs[0]?.left.id).toBe("c");
    expect(pairs[1]?.confidence).toBe("likely");
  });

  it("finds nothing in a roster of distinct people", () => {
    expect(
      findDuplicateMembers([
        { id: "a", name: "Ada Lovelace", email: "ada@lab.test" },
        { id: "b", name: "Alan Turing", email: "alan@lab.test" },
      ]),
    ).toEqual([]);
  });

  it("matches the original all-pairs result, including pair order and asymmetric author names", () => {
    const spellings = [
      "Terry Zhang",
      "Terry Jingchen Zhang",
      "Alice Yuchen Zhang",
      "Yuchen Zhang",
      "John Smith",
      "Smith, John",
      "John John Smith",
      "John John A Smith",
      "Zoë Müller",
      "Zoe Muller",
      "Proof Plain Member",
      "Proof Admin Member",
      "!!!",
      "???",
    ];
    const roster = Array.from({ length: 91 }, (_, i) => ({
      id: `member-${i}`,
      name: spellings[(i * 11) % spellings.length],
      email: i % 13 === 0 ? `SHARED-${i % 3}@lab.test` : `member-${i}@lab.test`,
      correspondence_email: i % 17 === 0 ? `shared-${i % 3}@lab.test` : undefined,
      slack_user_id: i % 19 === 0 ? `U${i % 4}` : undefined,
    }));
    const original = [];
    for (let i = 0; i < roster.length; i += 1) {
      for (let j = i + 1; j < roster.length; j += 1) {
        const reasons = memberDuplicateReasons(roster[i]!, roster[j]!);
        if (reasons.length) {
          original.push({
            left: roster[i],
            right: roster[j],
            reasons,
            confidence:
              reasons.includes("same_email") || reasons.includes("same_slack_user_id")
                ? ("high" as const)
                : ("likely" as const),
          });
        }
      }
    }
    original.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1));
    expect(findDuplicateMembers(roster)).toEqual(original);
  });

  it("handles a thousand distinct names without comparing every pair", () => {
    const letters = (number: number): string => {
      let value = number + 1;
      let result = "";
      while (value > 0) {
        value -= 1;
        result = String.fromCharCode(97 + (value % 26)) + result;
        value = Math.floor(value / 26);
      }
      return result;
    };
    const roster = Array.from({ length: 1005 }, (_, i) => ({
      id: `member-${i}`,
      name: `Member${letters(i)} Unique`,
      email: `member-${i}@lab.test`,
    }));
    expect(findDuplicateMembers(roster)).toEqual([]);
  });
});

describe("planMemberMerge", () => {
  it("fills the survivor's blanks from the duplicate", () => {
    const { patch } = planMemberMerge(surveyHalf, slackHalf);
    expect(patch).toMatchObject({
      correspondence_email: "zjingchen@cs.toronto.edu",
      slack_user_id: "U09QKBM74M6",
      location: "Asia/Chongqing",
    });
  });

  it("keeps the survivor's answer on a disagreement and says what it dropped", () => {
    const { patch, conflicts } = planMemberMerge(
      { id: "keep", name: "Keep", affiliation: "ETH" },
      { id: "drop", name: "Drop", affiliation: "University of Toronto" },
    );
    expect(patch).not.toHaveProperty("affiliation");
    expect(conflicts).toContainEqual({
      field: "affiliation",
      kept: "ETH",
      discarded: "University of Toronto",
    });
    // The name is a disagreement like any other: an admin chose which record survives, so the
    // survivor keeps their spelling and the other is reported rather than written.
    expect(patch).not.toHaveProperty("name");
    expect(conflicts).toContainEqual({ field: "name", kept: "Keep", discarded: "Drop" });
  });

  it("unions lists case-insensitively rather than choosing one", () => {
    const { patch } = planMemberMerge(surveyHalf, slackHalf);
    expect(patch.research_topics).toEqual(["Causality", "Multi-agent"]);
  });

  it("concatenates both notes blocks, which is where the split detail lives", () => {
    const { patch } = planMemberMerge(surveyHalf, slackHalf);
    expect(patch.notes).toBe(
      [
        "Source: Quick-Start Survey for Research Mentees",
        "Career stage: MSc",
        "Created from the Slack member export.",
        "Member Type: full",
      ].join("\n"),
    );
  });

  it("never carries the id or the login email across", () => {
    const { patch, conflicts } = planMemberMerge(
      { id: "keep", email: "keep@lab.test" },
      { id: "drop", email: "drop@lab.test", created_at: "2020-01-01T00:00:00Z" },
    );
    expect(patch).toEqual({});
    expect(conflicts).toEqual([]);
  });
});
