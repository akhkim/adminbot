// Turning a printed author list into people: what resolves, what deliberately does not, and what
// an external coauthor is allowed to be.
import { describe, expect, it } from "vitest";
import {
  authorMemberIds,
  authorNamesFromLinks,
  buildAuthorLinks,
  externalAuthors,
  isEmailLike,
  resolveAuthorMember,
} from "./author-links.js";

const roster = [
  { id: "joeun-yook", name: "Joeun Yook", email: "yookjoeu@cs.toronto.edu" },
  { id: "andrew-kim", name: "Andrew Kim", email: "andrewkihyun@gmail.com" },
  { id: "zhijing-jin", name: "Zhijing Jin", email: "zjin@cs.toronto.edu" },
  { id: "terry-jingchen-zhang", name: "Terry Jingchen Zhang" },
  // Two people who share a name, on purpose: the roster really has pairs like this.
  { id: "chen-one", name: "Wei Chen", email: "wei.one@lab.test" },
  { id: "chen-two", name: "Wei Chen", email: "wei.two@lab.test" },
];

describe("resolveAuthorMember", () => {
  it("matches through the marks a venue adds", () => {
    // Equal-contribution asterisk, a BibTeX "Last, First", and a middle name on one side only.
    expect(resolveAuthorMember("Joeun Yook*", roster)?.id).toBe("joeun-yook");
    expect(resolveAuthorMember("Yook, Joeun", roster)?.id).toBe("joeun-yook");
    expect(resolveAuthorMember("Terry Zhang", roster)?.id).toBe("terry-jingchen-zhang");
  });

  it("matches an id or an address outright", () => {
    expect(resolveAuthorMember("andrew-kim", roster)?.id).toBe("andrew-kim");
    expect(resolveAuthorMember("ZJIN@cs.toronto.edu", roster)?.id).toBe("zhijing-jin");
  });

  it("refuses to guess between two people with the same name", () => {
    // Being asked to pick beats putting somebody else's paper on your page.
    expect(resolveAuthorMember("Wei Chen", roster)).toBeUndefined();
  });

  it("leaves a stranger unresolved", () => {
    expect(resolveAuthorMember("Bernhard Schölkopf", roster)).toBeUndefined();
    expect(resolveAuthorMember("", roster)).toBeUndefined();
  });
});

describe("buildAuthorLinks", () => {
  it("links what it can from a plain printed list, in print order", () => {
    const links = buildAuthorLinks({
      names: ["Joeun Yook*", "Bernhard Schölkopf", "Zhijing Jin"],
      roster,
    });
    expect(links).toEqual([
      { name: "Joeun Yook*", member_id: "joeun-yook" },
      { name: "Bernhard Schölkopf" },
      { name: "Zhijing Jin", member_id: "zhijing-jin" },
    ]);
    // The printed spelling survives -- the paper says "Joeun Yook*" and keeps saying it.
    expect(authorNamesFromLinks(links)).toEqual([
      "Joeun Yook*",
      "Bernhard Schölkopf",
      "Zhijing Jin",
    ]);
    expect(authorMemberIds(links)).toEqual(["joeun-yook", "zhijing-jin"]);
  });

  it("prefers recorded links over the printed names", () => {
    // The picker said who this is; the name column is only how the paper spells it.
    const links = buildAuthorLinks({
      links: [{ name: "W. Chen", member_id: "chen-two" }],
      names: ["somebody else entirely"],
      roster,
    });
    expect(links).toEqual([{ name: "W. Chen", member_id: "chen-two" }]);
  });

  it("keeps an external as an address and nothing more", () => {
    const links = buildAuthorLinks({
      links: [{ name: "Bernhard Schölkopf", email: "bs@tue.mpg.de" }],
      roster,
    });
    expect(links).toEqual([{ name: "Bernhard Schölkopf", email: "bs@tue.mpg.de" }]);
    expect(authorMemberIds(links)).toEqual([]);
    expect(externalAuthors(links)).toEqual([
      { name: "Bernhard Schölkopf", email: "bs@tue.mpg.de" },
    ]);
  });

  it("promotes an address that turns out to be a member's", () => {
    // Typing a colleague's address means the colleague, not a stranger who shares it.
    const links = buildAuthorLinks({
      links: [{ name: "Andrew", email: "andrewkihyun@gmail.com" }],
      roster,
    });
    expect(links).toEqual([{ name: "Andrew", member_id: "andrew-kim" }]);
  });

  it("never carries both an id and an address", () => {
    const links = buildAuthorLinks({
      links: [{ name: "Joeun", member_id: "joeun-yook", email: "elsewhere@example.test" }],
      roster,
    });
    expect(links).toEqual([{ name: "Joeun", member_id: "joeun-yook" }]);
  });

  it("reads a bare address in the name column as an address", () => {
    const links = buildAuthorLinks({ names: ["bs@tue.mpg.de"], roster });
    expect(links).toEqual([{ name: "bs@tue.mpg.de", email: "bs@tue.mpg.de" }]);
  });

  it("drops duplicates by person, not by spelling", () => {
    const links = buildAuthorLinks({
      names: ["Joeun Yook", "Yook, Joeun", "Joeun Yook*"],
      roster,
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ member_id: "joeun-yook" });
  });

  it("keeps two different unresolved names apart", () => {
    const links = buildAuthorLinks({
      names: ["Bernhard Schölkopf", "Rada Mihalcea", "  "],
      roster,
    });
    expect(links.map((link) => link.name)).toEqual(["Bernhard Schölkopf", "Rada Mihalcea"]);
  });
});

describe("isEmailLike", () => {
  it("accepts an address and rejects a name", () => {
    expect(isEmailLike("bs@tue.mpg.de")).toBe(true);
    expect(isEmailLike(" a@b.co ")).toBe(true);
    expect(isEmailLike("Bernhard Schölkopf")).toBe(false);
    expect(isEmailLike("not-an-email@")).toBe(false);
  });
});
