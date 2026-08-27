import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import { belongsOnSurface, surfaceMembershipPlan } from "./surface-membership.js";

const member = (over: Partial<AdminBotLabMember> & { id: string }): AdminBotLabMember =>
  ({
    name: `Member ${over.id}`,
    privilege_level: "member",
    status: "active",
    ...over,
  }) as AdminBotLabMember;

const ROSTER: AdminBotLabMember[] = [
  member({ id: "full", email: "full@lab.test" }),
  member({ id: "admin", privilege_level: "admin", email: "admin@lab.test" }),
  member({ id: "trial", privilege_level: "trial", email: "trial@lab.test" }),
  member({
    id: "major",
    privilege_level: "external_collaborator",
    collaborator_subgroup: "coauthor_major",
    email: "major@other.test",
  }),
  member({
    id: "minor",
    privilege_level: "external_collaborator",
    collaborator_subgroup: "coauthor_minor",
    email: "minor@other.test",
  }),
  member({ id: "alum", status: "alumni", email: "alum@lab.test" }),
  member({ id: "ext", status: "external", email: "ext@lab.test" }),
];

describe("belongsOnSurface", () => {
  it("seats major coauthors at the group meeting but not on the lab calendar", () => {
    const major = ROSTER.find((entry) => entry.id === "major")!;
    expect(belongsOnSurface(major, "group_meeting")).toBe(true);
    expect(belongsOnSurface(major, "lab_calendar")).toBe(false);
  });

  it("keeps full members on both, and everyone else on neither", () => {
    for (const id of ["full", "admin"]) {
      const entry = ROSTER.find((candidate) => candidate.id === id)!;
      expect(belongsOnSurface(entry, "lab_calendar"), id).toBe(true);
      expect(belongsOnSurface(entry, "group_meeting"), id).toBe(true);
    }
    for (const id of ["trial", "minor", "alum", "ext"]) {
      const entry = ROSTER.find((candidate) => candidate.id === id)!;
      expect(belongsOnSurface(entry, "lab_calendar"), id).toBe(false);
      expect(belongsOnSurface(entry, "group_meeting"), id).toBe(false);
    }
  });

  // Removal is the destructive direction, so a row the two signals disagree about stays put.
  it("treats either full signal as enough", () => {
    const byType = member({ id: "t", privilege_level: "trial", member_type: "full" });
    expect(belongsOnSurface(byType, "lab_calendar")).toBe(true);
    // ...but an alumni token still wins over it.
    const left = member({ id: "l", privilege_level: "member", member_type: "full, alumni" });
    expect(belongsOnSurface(left, "lab_calendar")).toBe(false);
  });
});

describe("surfaceMembershipPlan", () => {
  const attendees = [
    "full@lab.test",
    "trial@lab.test",
    "major@other.test",
    "minor@other.test",
    "alum@lab.test",
  ];

  it("drops non-full people from the lab calendar, major coauthors included", () => {
    const plan = surfaceMembershipPlan({ members: ROSTER, attendees, surface: "lab_calendar" });
    expect(plan.remove.map((entry) => entry.member_id).toSorted()).toEqual([
      "alum",
      "major",
      "minor",
      "trial",
    ]);
    expect(plan.keep).toEqual(["full@lab.test"]);
  });

  it("keeps major coauthors in the group meeting and drops the rest", () => {
    const plan = surfaceMembershipPlan({ members: ROSTER, attendees, surface: "group_meeting" });
    expect(plan.remove.map((entry) => entry.member_id).toSorted()).toEqual([
      "alum",
      "minor",
      "trial",
    ]);
    expect(plan.keep.toSorted()).toEqual(["full@lab.test", "major@other.test"]);
    expect(plan.remove.find((entry) => entry.member_id === "minor")?.reason).toContain(
      "not a major coauthor",
    );
  });

  // The failure that matters: uninviting a guest speaker nobody has a roster row for.
  it("keeps an address it cannot explain, and reports it instead", () => {
    const plan = surfaceMembershipPlan({
      members: ROSTER,
      attendees: ["full@lab.test", "guest@elsewhere.test", "room-2@resource.test"],
      surface: "group_meeting",
    });
    expect(plan.remove).toEqual([]);
    expect(plan.unrecognized).toEqual(["guest@elsewhere.test", "room-2@resource.test"]);
    expect(plan.keep).toContain("guest@elsewhere.test");
  });

  it("matches any address the roster holds for a person", () => {
    const roster = [
      member({ id: "x", status: "alumni", email: "x@lab.test", calendar_email: "x.cal@lab.test" }),
    ];
    const plan = surfaceMembershipPlan({
      members: roster,
      attendees: ["X.Cal@Lab.test"],
      surface: "lab_calendar",
    });
    // Matched case-insensitively on the calendar address, and reported with the original spelling
    // so the caller can remove exactly what the invite holds.
    expect(plan.remove).toHaveLength(1);
    expect(plan.remove[0]?.email).toBe("X.Cal@Lab.test");
    expect(plan.remove[0]?.reason).toBe("has left the lab");
  });

  it("does not remove one address twice when the invite repeats it", () => {
    const plan = surfaceMembershipPlan({
      members: ROSTER,
      attendees: ["trial@lab.test", "TRIAL@lab.test", " trial@lab.test "],
      surface: "lab_calendar",
    });
    expect(plan.remove).toHaveLength(1);
  });

  it("returns the full remaining list, since the write replaces every attendee", () => {
    const plan = surfaceMembershipPlan({ members: ROSTER, attendees, surface: "group_meeting" });
    // keep + remove accounts for every distinct address that went in: a partial keep list would
    // silently uninvite whoever it omitted.
    expect(plan.keep.length + plan.remove.length).toBe(attendees.length);
  });
});
