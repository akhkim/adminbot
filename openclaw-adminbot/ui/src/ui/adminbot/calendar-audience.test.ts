import { describe, expect, it } from "vitest";
import {
  hasAudienceFilter,
  invitableEmail,
  knownCities,
  knownConferences,
  memberNamesByEmail,
  memberIdsWritingFor,
  reconcileAudience,
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

describe("selectAudience: combining place with timezone", () => {
  const people = [
    member({
      id: "berlin",
      name: "Berliner",
      location: "Berlin",
      timezone: "Europe/Berlin",
    }),
    member({ id: "placeless", name: "Zoned only", timezone: "Europe/Berlin" }),
    member({ id: "zoneless", name: "Placed only", location: "Berlin" }),
    member({
      id: "neither",
      name: "Elsewhere",
      location: "Toronto",
      timezone: "America/Toronto",
    }),
  ];

  it("narrows by default, matching only members who satisfy both", () => {
    const result = selectAudience(people, [], {
      homeCity: "Berlin",
      timezone: "Europe/Berlin",
    });
    expect(result.matches.map((match) => match.member_id)).toEqual(["berlin"]);
  });

  // The point of the mode: a roster that knows a city for one person and only a zone for another
  // should not drop both when an operator wants "everyone on Berlin hours".
  it("widens on or, taking members who satisfy either", () => {
    const result = selectAudience(people, [], {
      homeCity: "Berlin",
      timezone: "Europe/Berlin",
      placeMode: "or",
    });
    expect(result.matches.map((match) => match.member_id).toSorted()).toEqual([
      "berlin",
      "placeless",
      "zoneless",
    ]);
  });

  // Listing a filter somebody failed as their reason for being included would be a lie.
  it("credits only the filters a member actually met", () => {
    const result = selectAudience(people, [], {
      homeCity: "Berlin",
      timezone: "Europe/Berlin",
      placeMode: "or",
    });
    const placeless = result.matches.find((match) => match.member_id === "placeless");
    expect(placeless?.reasons).toEqual(["Europe/Berlin"]);
  });

  // Who someone *is* stays ANDed on top, or an OR would re-invite people just excluded by level.
  it("keeps membership filters ANDed even in or mode", () => {
    const result = selectAudience(
      [
        member({ id: "admin", location: "Berlin", privilege_level: "admin" }),
        member({
          id: "plain",
          timezone: "Europe/Berlin",
          privilege_level: "member",
        }),
      ],
      [],
      {
        homeCity: "Berlin",
        timezone: "Europe/Berlin",
        placeMode: "or",
        privilegeLevels: ["admin"],
      },
    );
    expect(result.matches.map((match) => match.member_id)).toEqual(["admin"]);
  });

  it("behaves the same in either mode when only one place filter is set", () => {
    const and = selectAudience(people, [], { timezone: "Europe/Berlin" });
    const or = selectAudience(people, [], {
      timezone: "Europe/Berlin",
      placeMode: "or",
    });
    expect(or.matches.map((match) => match.member_id)).toEqual(
      and.matches.map((match) => match.member_id),
    );
  });
});

describe("selectAudience", () => {
  // "Invite the whole lab" is a decision, not the thing that happens when nothing is picked.
  it("matches nobody when no filter is set", () => {
    expect(selectAudience([member()], [], {}).matches).toEqual([]);
  });

  it("matches on the city a member is in right now", () => {
    const people = [
      member({
        id: "m1",
        name: "Ada",
        current_city: "Vancouver, BC",
        location: "Toronto, ON",
      }),
      member({
        id: "m2",
        name: "Mei",
        current_city: "Toronto, ON",
        location: "Toronto, ON",
      }),
    ];
    const result = selectAudience(people, [], { currentCity: "Toronto" });
    expect(result.matches.map((match) => match.member_id)).toEqual(["m2"]);
  });

  // The two city fields answer different questions, so one must never stand in for the other:
  // Ada lives in Toronto but is away, and a dinner in Toronto is not for her.
  it("keeps the home city and the current city apart", () => {
    const away = member({
      id: "m1",
      current_city: "Vancouver, BC",
      location: "Toronto, ON",
    });
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
      paper({
        id: "p1",
        authors: ["Ada Lovelace"],
        artifacts: { conference: "NeurIPS 2026" },
      }),
      paper({
        id: "p2",
        authors: ["Mei Chen"],
        artifacts: { conference: "ICLR 2027" },
      }),
    ];
    const result = selectAudience(people, papers, {
      conference: "neurips 2026",
    });
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
      member({
        id: "m2",
        name: "Mei",
        current_city: "Toronto",
        email: "mei@cs.toronto.edu",
      }),
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
      member({
        id: "m1",
        privilege_level: "admin",
        status: "active",
        location: "Toronto",
      }),
      member({
        id: "m2",
        privilege_level: "trial",
        status: "active",
        location: "Toronto",
      }),
    ];
    expect(
      selectAudience(people, [], {
        homeCity: "Toronto",
        privilegeLevels: ["trial"],
      }).matches,
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
      invitableEmail(
        member({
          calendar_email: "ada@gmail.com",
          email: "ada@cs.toronto.edu",
        }),
      ),
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
      member({
        id: "m1",
        location: "Toronto, ON",
        current_city: "Vancouver, BC",
      }),
      member({
        id: "m2",
        location: "Toronto, ON",
        current_city: "Toronto, ON",
      }),
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

// The exclusive pass. An event kept current by additive sends accumulates everyone who ever
// matched any filter, so the send has to be able to take people off as well as put them on.
describe("reconcileAudience", () => {
  const roster = [
    member({
      id: "in1",
      name: "In One",
      email: "in1@cs.toronto.edu",
      location: "Toronto",
    }),
    member({
      id: "in2",
      name: "In Two",
      email: "in2@cs.toronto.edu",
      location: "Toronto",
    }),
    member({
      id: "out",
      name: "Out There",
      email: "out@cs.toronto.edu",
      location: "Berlin",
    }),
  ];
  const toronto = { homeCity: "Toronto" };

  it("adds who matches, removes the roster members who do not, and leaves guests alone", () => {
    const plan = reconcileAudience({
      members: roster,
      papers: [],
      filter: toronto,
      attendees: ["in1@cs.toronto.edu", "out@cs.toronto.edu", "speaker@elsewhere.org"],
    });

    expect(plan.invite).toEqual(["in2@cs.toronto.edu"]);
    expect(plan.keep).toEqual(["in1@cs.toronto.edu"]);
    expect(plan.remove).toEqual([
      {
        email: "out@cs.toronto.edu",
        member_id: "out",
        name: "Out There",
        reason: "does not match the filters",
      },
    ]);
    // A guest speaker is not a roster mistake to tidy away.
    expect(plan.unrecognized).toEqual(["speaker@elsewhere.org"]);
    expect(plan.remaining.toSorted()).toEqual([
      "in1@cs.toronto.edu",
      "in2@cs.toronto.edu",
      "speaker@elsewhere.org",
    ]);
  });

  // The write behind a removal replaces the guest list, so the people just invited have to be in
  // the set that remains or the same call would uninvite them.
  it("keeps everyone it is inviting in the remaining set", () => {
    const plan = reconcileAudience({
      members: roster,
      papers: [],
      filter: toronto,
      attendees: ["out@cs.toronto.edu"],
    });
    for (const email of plan.invite) {
      expect(plan.remaining).toContain(email);
    }
  });

  it("does not re-invite somebody already on the event at another of their addresses", () => {
    const dual = member({
      id: "dual",
      name: "Two Addresses",
      email: "dual@cs.toronto.edu",
      calendar_email: "dual@gmail.com",
      location: "Toronto",
    });
    const plan = reconcileAudience({
      members: [dual],
      papers: [],
      filter: toronto,
      // On the event at the roster address; `invitableEmail` would send to the calendar one.
      attendees: ["dual@cs.toronto.edu"],
    });
    expect(plan.invite).toEqual([]);
    expect(plan.keep).toEqual(["dual@cs.toronto.edu"]);
    expect(plan.remove).toEqual([]);
  });

  it("treats an unticked match as not chosen, and says so", () => {
    const plan = reconcileAudience({
      members: roster,
      papers: [],
      filter: toronto,
      attendees: ["in1@cs.toronto.edu", "in2@cs.toronto.edu"],
      excludedMemberIds: ["in2"],
    });
    expect(plan.invite).toEqual([]);
    expect(plan.remove).toEqual([
      {
        email: "in2@cs.toronto.edu",
        member_id: "in2",
        name: "In Two",
        reason: "unticked on this send",
      },
    ]);
  });

  // Google lists the organizing calendar among the attendees on plenty of events; a plan that
  // excluded it would hand the connector a write dropping the organizer off the meeting.
  it("never removes a protected address", () => {
    const lab = member({
      id: "lab",
      name: "Lab Calendar",
      email: "lab@cs.toronto.edu",
    });
    const plan = reconcileAudience({
      members: [...roster, lab],
      papers: [],
      filter: toronto,
      attendees: ["lab@cs.toronto.edu", "out@cs.toronto.edu"],
      protectedEmails: ["LAB@cs.toronto.edu"],
    });
    expect(plan.keep).toContain("lab@cs.toronto.edu");
    expect(plan.remove.map((row) => row.member_id)).toEqual(["out"]);
  });

  it("removes nobody when no filter is set, since nobody is chosen", () => {
    const plan = reconcileAudience({
      members: roster,
      papers: [],
      filter: {},
      attendees: ["in1@cs.toronto.edu"],
    });
    // An empty filter selects nobody by design; that must not read as "everyone comes off".
    expect(plan.invite).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([]);
  });

  it("counts a duplicated attendee once", () => {
    const plan = reconcileAudience({
      members: roster,
      papers: [],
      filter: toronto,
      attendees: ["out@cs.toronto.edu", "OUT@cs.toronto.edu"],
    });
    expect(plan.remove).toHaveLength(1);
  });
});

// The axis the lab actually uses to say who belongs on a recurring meeting. `privilege_level`
// cannot stand in for it -- almost every imported row defaults to `member` there.
describe("the member-type filter", () => {
  const active = ["full", "own-pace-advisee", "coauthor-major"];
  const roster = [
    member({
      id: "f",
      name: "Full Person",
      email: "f@lab.org",
      member_type: "full",
    }),
    member({
      id: "o",
      name: "Own Pace",
      email: "o@lab.org",
      member_type: "own-pace-advisee",
    }),
    member({
      id: "cmaj",
      name: "Big Coauthor",
      email: "cmaj@lab.org",
      member_type: "coauthor-major",
    }),
    member({
      id: "cmin",
      name: "Small Coauthor",
      email: "cmin@lab.org",
      member_type: "coauthor-minor",
    }),
    member({
      id: "alum",
      name: "Old Hand",
      email: "alum@lab.org",
      member_type: "alumni",
    }),
    member({
      id: "both",
      name: "Alum Who Writes",
      email: "both@lab.org",
      member_type: "alumni, coauthor-major",
    }),
    member({ id: "blank", name: "Never Filled In", email: "blank@lab.org" }),
  ];

  it("selects exactly the ticked types, as a union", () => {
    const chosen = selectAudience(roster, [], { memberTypes: active });
    expect(chosen.matches.map((match) => match.member_id).toSorted()).toEqual([
      "both",
      "cmaj",
      "f",
      "o",
    ]);
  });

  // Substring matching would make "coauthor-major" select "coauthor-minor" as well, which is the
  // quiet over-invite nobody checks for until the mail has gone out.
  it("does not let coauthor-major match coauthor-minor", () => {
    const chosen = selectAudience(roster, [], {
      memberTypes: ["coauthor-major"],
    });
    expect(chosen.matches.map((match) => match.member_id)).not.toContain("cmin");
  });

  // Somebody carrying two types is in the audience on the strength of one of them, and the panel
  // has to say which -- a reason that does not survive being checked is worse than none.
  it("gives only the types the person actually holds as the reason", () => {
    const chosen = selectAudience(roster, [], { memberTypes: active });
    const alum = chosen.matches.find((match) => match.member_id === "both");
    expect(alum?.reasons).toEqual(["Coauthor (major)"]);
  });

  it("narrows the other filters rather than widening them", () => {
    const placed = [
      member({
        id: "here",
        name: "Here",
        email: "here@lab.org",
        member_type: "full",
        location: "Toronto",
      }),
      member({
        id: "away",
        name: "Away",
        email: "away@lab.org",
        member_type: "full",
        location: "Berlin",
      }),
    ];
    const chosen = selectAudience(placed, [], {
      memberTypes: ["full"],
      homeCity: "Toronto",
    });
    expect(chosen.matches.map((match) => match.member_id)).toEqual(["here"]);
  });

  it("counts as a chosen audience, so a member-type-only filter can drive a sync", () => {
    expect(hasAudienceFilter({ memberTypes: active })).toBe(true);
    expect(hasAudienceFilter({ memberTypes: [] })).toBe(false);
    expect(hasAudienceFilter({ memberTypes: ["  "] })).toBe(false);
  });

  it("takes the types the filter excludes off the event", () => {
    const plan = reconcileAudience({
      members: roster,
      papers: [],
      filter: { memberTypes: active },
      attendees: [
        "f@lab.org",
        "cmin@lab.org",
        "alum@lab.org",
        "room-42@resource.calendar.google.com",
      ],
    });
    expect(plan.remove.map((row) => row.member_id).toSorted()).toEqual(["alum", "cmin"]);
    expect(plan.keep).toEqual(["f@lab.org"]);
    expect(plan.invite.toSorted()).toEqual(["both@lab.org", "cmaj@lab.org", "o@lab.org"]);
    expect(plan.unrecognized).toEqual(["room-42@resource.calendar.google.com"]);
  });

  // A blank cell means the roster has not been told, not that the person is none of these things.
  // Reading it the second way is what takes the head professor off the group meeting.
  it("keeps a member whose member type is blank, and reports them", () => {
    const plan = reconcileAudience({
      members: roster,
      papers: [],
      filter: { memberTypes: active },
      attendees: ["blank@lab.org", "alum@lab.org"],
    });
    expect(plan.remove.map((row) => row.member_id)).toEqual(["alum"]);
    expect(plan.undecided).toEqual([
      { email: "blank@lab.org", member_id: "blank", name: "Never Filled In" },
    ]);
    expect(plan.remaining).toContain("blank@lab.org");
  });

  // Without a member-type filter a blank field is an ordinary non-match, not a reason to hold on
  // to somebody the operator filtered out on another axis entirely.
  it("holds nobody back when the filter does not turn on member type", () => {
    const plan = reconcileAudience({
      members: roster,
      papers: [],
      filter: { homeCity: "Toronto" },
      attendees: ["blank@lab.org"],
    });
    expect(plan.undecided).toEqual([]);
    expect(plan.remove.map((row) => row.member_id)).toEqual(["blank"]);
  });

  it("still removes somebody unticked even when their member type is blank", () => {
    const plan = reconcileAudience({
      members: roster,
      papers: [],
      filter: { memberTypes: active },
      attendees: ["blank@lab.org"],
      excludedMemberIds: ["blank"],
    });
    expect(plan.undecided).toEqual([]);
    expect(plan.remove[0]?.reason).toBe("unticked on this send");
  });
});
