import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import { memberOwnsPaper, paperIdsByOwner, rosterNameCounts } from "./paper-ownership.js";

function member(id: string, name: string, email?: string): AdminBotLabMember {
  return { id, name, ...(email !== undefined ? { email } : {}) } as AdminBotLabMember;
}

function paper(id: string, fields: Partial<AdminBotPaperRecord>): AdminBotPaperRecord {
  return { id, title: id, authors: [], ...fields } as AdminBotPaperRecord;
}

// Deterministic so a failure reproduces.
function lcg(seed: number) {
  let state = seed;
  return (n: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
}

describe("paperIdsByOwner", () => {
  const roster = [
    member("m1", "Ada Lovelace", "ada@lab.org"),
    member("m2", " ada lovelace "), // shares m1's name: neither matches by name
    member("m3", "Grace Hopper", "Grace@Lab.org"),
    member("m4", "Alan Turing", ""),
    member("M5", "Barbara Liskov", "barbara@lab.org"),
    member("m6", "", "nameless@lab.org"),
    member("m7", "Édouard Lucas"),
  ];
  const spellings = [
    "Ada Lovelace",
    " grace hopper",
    "GRACE@LAB.ORG",
    "alan turing ",
    "m5",
    "M4",
    "barbara@lab.org",
    "",
    "nameless@lab.org",
    "ÉDOUARD LUCAS",
    "Someone External",
  ];

  it("gives every member the same papers, in the same order, as checking each pair", () => {
    const rand = lcg(7);
    const ids = roster.map((entry) => entry.id).concat(["ghost"]);
    const papers = Array.from({ length: 300 }, (_, index) =>
      paper(`p${index}`, {
        authors: Array.from({ length: rand(4) }, () => spellings[rand(spellings.length)] ?? ""),
        ...(rand(4) === 0 ? { submitted_by_member_id: ids[rand(ids.length)] } : {}),
        ...(rand(4) === 0 ? { first_author_member_id: ids[rand(ids.length)] } : {}),
        ...(rand(3) === 0
          ? {
              author_links: [
                { name: "x", member_id: ids[rand(ids.length)] },
                { name: "external", email: "e@x.org" },
              ],
            }
          : {}),
      } as Partial<AdminBotPaperRecord>),
    );
    const counts = rosterNameCounts(roster);
    const nameCount = (name: string) => counts.get(name) ?? 0;
    for (const members of [roster, roster.slice(2)]) {
      const owned = paperIdsByOwner(members, papers, counts);
      for (const entry of members) {
        const expected = papers
          .filter((candidate) => memberOwnsPaper(entry, candidate, nameCount))
          .map((candidate) => candidate.id);
        expect(owned.get(entry.id)).toEqual(expected);
      }
      expect([...owned.keys()]).toEqual(members.map((entry) => entry.id));
    }
  });

  it("does not match a name another roster member shares, even when that member is not listed", () => {
    const papers = [paper("p1", { authors: ["Ada Lovelace"] })];
    const owned = paperIdsByOwner([roster[0] as AdminBotLabMember], papers, rosterNameCounts(roster));
    expect(owned.get("m1")).toEqual([]);
  });
});
