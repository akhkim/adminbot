import { describe, expect, it } from "vitest";
import {
  invitableEmail,
  knownCities,
  knownConferences,
  memberNamesByEmail,
  memberIdsWritingFor,
  selectAudience,
} from "./calendar-audience.ts";
import type { AdminBotLabMember, AdminBotPaperRecord } from "./controllers/admin.ts";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "m1",
    name: "Ada Lovelace",
    privilege_level: "member",
    email: "ada@cs.toronto.edu",
    ...overrides,
  } as AdminBotLabMember;
}

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "On analytical engines",
    authors: ["Ada Lovelace"],
    current_step: "drafting",
    artifacts: { conference: "NeurIPS 2026" },
    ...overrides,
  } as AdminBotPaperRecord;
}

describe("selectAudience", () => {
  // "Invite the whole lab" is a decision, not the thing that happens when nothing is picked.
  it("matches nobody when no filter is set", () => {
    expect(selectAudience([member()], [], {}).matches).toEqual([]);
  });

  it("matches on the city a member is in right now", () => {
    const people = [
      member({ id: "m1", name: "Ada", current_city: "Vancouver, BC", location: "Toronto, ON" }),
      member({ id: "m2", name: "Mei", current_city: "Toronto, ON", location: "Toronto, ON" }),
    ];
    const result = selectAudience(people, [], { currentCity: "Toronto" });
    expect(result.matches.map((match) => match.member_id)).toEqual(["m2"]);
  });

  // The two city fields answer different questions, so one must never stand in for the other:
  // Ada lives in Toronto but is away, and a dinner in Toronto is not for her.
  it("keeps the home city and the current city apart", () => {
    const away = member({ id: "m1", current_city: "Vancouver, BC", location: "Toronto, ON" });
    expect(selectAudience([away], [], { currentCity: "Toronto" }).matches).toEqual([]);
    expect(selectAudience([away], [], { homeCity: "Toronto" }).matches).toHaveLength(1);
  });

  // "York" must not pull in "New York", but "Toronto" must still match "Toronto, ON".
  it("matches a city on whole words, not on any substring", () => {
    const newYorker = member({ id: "m1", location: "New York, NY" });
    expect(selectAudience([newYorker], [], { homeCity: "York" }).matches).toEqual([]);
    expect(selectAudience([newYorker], [], { homeCity: "new york" }).matches).toHaveLength(1);
  });

  it("matches the people writing for a conference, through their papers", () => {
    const people = [
      member({ id: "m1", name: "Ada Lovelace" }),
      member({ id: "m2", name: "Mei Chen", email: "mei@cs.toronto.edu" }),
    ];
    const papers = [
      paper({ id: "p1", authors: ["Ada Lovelace"], artifacts: { conference: "NeurIPS 2026" } }),
      paper({ id: "p2", authors: ["Mei Chen"], artifacts: { conference: "ICLR 2027" } }),
    ];
    const result = selectAudience(people, papers, { conference: "neurips 2026" });
    expect(result.matches.map((match) => match.member_id)).toEqual(["m1"]);
    expect(result.matches[0]?.reasons[0]).toContain("neurips 2026");
  });

  // The filer of a paper is writing for it even if their name on the record does not match the
  // roster's spelling.
  it("counts the member who filed the paper as writing for it", () => {
    const people = [member({ id: "m9", name: "A. Lovelace" })];
    const papers = [paper({ authors: ["Someone Else"], submitted_by_member_id: "m9" })];
    expect(selectAudience(people, papers, { conference: "NeurIPS 2026" }).matches).toHaveLength(1);
  });

  it("requires every filter to pass, not any of them", () => {
    const people = [
      member({ id: "m1", name: "Ada", current_city: "Toronto" }),
      member({ id: "m2", name: "Mei", current_city: "Toronto", email: "mei@cs.toronto.edu" }),
    ];
    const papers = [paper({ authors: ["Mei"] })];
    const result = selectAudience(people, papers, {
      currentCity: "Toronto",
      conference: "NeurIPS 2026",
    });
    expect(result.matches.map((match) => match.member_id)).toEqual(["m2"]);
    expect(result.matches[0]?.reasons).toHaveLength(2);
  });

  it("filters on privilege level and status", () => {
    const people = [
      member({ id: "m1", privilege_level: "admin", status: "active", location: "Toronto" }),
      member({ id: "m2", privilege_level: "trial", status: "active", location: "Toronto" }),
    ];
    expect(
      selectAudience(people, [], { homeCity: "Toronto", privilegeLevels: ["trial"] }).matches,
    ).toHaveLength(1);
    expect(
      selectAudience(people, [], { homeCity: "Toronto", statuses: ["alumni"] }).matches,
    ).toEqual([]);
  });

  // Someone with no address cannot be invited, and dropping them silently would make the count on
  // screen disagree with who actually gets the invite.
  it("reports a matching member with no address separately", () => {
    const people = [member({ id: "m1", name: "Ada", location: "Toronto", email: undefined })];
    const result = selectAudience(people, [], { homeCity: "Toronto" });
    expect(result.matches).toEqual([]);
    expect(result.unreachable).toEqual([{ member_id: "m1", name: "Ada" }]);
  });
});

describe("invitableEmail", () => {
  // Google reads the calendar account, so it wins over the directory address.
  it("prefers the calendar account, then the directory address", () => {
    expect(
      invitableEmail(member({ calendar_email: "ada@gmail.com", email: "ada@cs.toronto.edu" })),
    ).toBe("ada@gmail.com");
    expect(invitableEmail(member({ calendar_email: undefined }))).toBe("ada@cs.toronto.edu");
    expect(
      invitableEmail(member({ email: undefined, correspondence_email: "ada@example.com" })),
    ).toBe("ada@example.com");
    expect(invitableEmail(member({ email: undefined }))).toBeUndefined();
  });
});

describe("memberNamesByEmail", () => {
  it("resolves a member by any address they might be invited at", () => {
    const map = memberNamesByEmail([
      member({
        name: "Ada Lovelace",
        calendar_email: "ada@gmail.com",
        email: "ada@cs.toronto.edu",
      }),
    ]);
    expect(map.get("ada@gmail.com")).toBe("Ada Lovelace");
    expect(map.get("ada@cs.toronto.edu")).toBe("Ada Lovelace");
  });

  it("matches regardless of case, and leaves outsiders unmapped", () => {
    const map = memberNamesByEmail([member({ email: "Ada@CS.toronto.edu" })]);
    expect(map.get("ada@cs.toronto.edu")).toBe("Ada Lovelace");
    expect(map.get("guest@example.com")).toBeUndefined();
  });
});

describe("the pickers", () => {
  it("lists each venue once, however it was typed", () => {
    const papers = [
      paper({ id: "p1", artifacts: { conference: "NeurIPS 2026" } }),
      paper({ id: "p2", artifacts: { conference: "neurips-2026" } }),
      paper({ id: "p3", artifacts: { conference: "ICLR 2027" } }),
    ];
    expect(knownConferences(papers)).toEqual(["ICLR 2027", "NeurIPS 2026"]);
  });

  it("lists the cities on record for each field separately", () => {
    const people = [
      member({ id: "m1", location: "Toronto, ON", current_city: "Vancouver, BC" }),
      member({ id: "m2", location: "Toronto, ON", current_city: "Toronto, ON" }),
    ];
    expect(knownCities(people, "location")).toEqual(["Toronto, ON"]);
    expect(knownCities(people, "current_city")).toEqual(["Toronto, ON", "Vancouver, BC"]);
  });
});

describe("memberIdsWritingFor", () => {
  it("ignores papers filed against another venue", () => {
    const people = [member({ id: "m1", name: "Ada Lovelace" })];
    const papers = [paper({ artifacts: { conference: "ICLR 2027" } })];
    expect(memberIdsWritingFor(papers, people, "NeurIPS 2026").size).toBe(0);
  });
});
