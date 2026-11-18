import { describe, expect, it } from "vitest";
import {
  adminBotMemberTypes,
  type AdminBotLabMember,
  type AdminBotPaperRecord,
} from "../../contracts/actions.js";
import { joinedMonthOrder, memberRosterPage } from "./member-roster.js";
const member = (id: string, extra = {}): AdminBotLabMember => ({
  id,
  name: id,
  privilege_level: "member",
  created_at: "2020-01-01",
  updated_at: "2020-01-01",
  access: [],
  ...extra,
});
const roster = Array.from({ length: 120 }, (_, i) =>
  member(`member-${String(i).padStart(3, "0")}`, {
    joined_month: "2025-01",
    member_type: "full",
    location: "London",
  }),
);
const target = member("target", {
  joined_month: "2019-01",
  location: "Zurich",
  role: "PhD Student, Research Assistant",
  member_type: "full, alumni",
  projects: "Atlas",
  research_topics: "Causal inference",
  email: "person@example.test",
});
const papers = [
  {
    id: "paper",
    title: "Study",
    authors: ["person@example.test"],
    artifacts: { conference: "ExampleConf" },
  },
] as AdminBotPaperRecord[];

describe("memberRosterPage", () => {
  it("sorts the whole roster before paging and keeps ties stable, unknown dates last", () => {
    const members = [...roster, target, member("unknown")];
    const first = memberRosterPage(members, papers, { limit: 50, offset: 0, filters: {} });
    const second = memberRosterPage(members, papers, { limit: 50, offset: 50, filters: {} });
    expect(first.total).toBe(122);
    expect(first.members[0]?.id).toBe("target");
    expect(second.members[0]?.id).toBe("member-049");
    expect(new Set([...first.members, ...second.members].map((m) => m.id)).size).toBe(100);
    expect(
      memberRosterPage(members, papers, { limit: 50, offset: 100, filters: {} }).members.at(-1)?.id,
    ).toBe("unknown");
    expect(members[0]?.id).toBe("member-000");
  });
  it("reads every way a joined month has been typed, and orders them by time", () => {
    const order = (value: string) => joinedMonthOrder(value);
    expect(order("Jan-25")).toBe(order("2025-01"));
    expect(order("25-Sep")).toBe(order("2025-09-14"));
    expect(order("Sept 2024")).toBe(order("2024-09"));
    expect(order("June 2025")).toBe(order("2025-06"));
    expect(order("2025")).toBe(order("2025-01"));
    expect([order("206-09"), order(""), order("soon")]).toEqual([null, null, null]);
    const members = [
      member("undated-new", { created_at: "2026-09-01" }),
      member("undated-old-alumni", { created_at: "2026-07-20", status: "alumni" }),
      member("undated-old", { created_at: "2026-07-02" }),
      member("y2026", { joined_month: "2026-01" }),
      member("jan25-alumni", { joined_month: "Jan-25", member_type: "full, alumni" }),
      member("jan25-active", { joined_month: "2025-01", status: "active" }),
      member("sept24", { joined_month: "Sept 2024" }),
    ];
    expect(
      memberRosterPage(members, [], { limit: 50, offset: 0, filters: {} }).members.map((m) => m.id),
    ).toEqual([
      "sept24",
      "jan25-active",
      "jan25-alumni",
      "y2026",
      "undated-old",
      "undated-old-alumni",
      "undated-new",
    ]);
  });
  it("combines every filter before slicing and offers roster-wide options", () => {
    const result = memberRosterPage(
      [...roster, target],
      papers,
      {
        limit: 50,
        offset: 50,
        filters: {
          q: "causal",
          status: "alumni",
          location: "Zurich",
          career: "Research Assistant",
          membership: "alumni",
          project: "Atlas",
          paper: "Study",
          conference: "ExampleConf",
          meeting: "meeting",
        },
      },
      new Set(["target"]),
    );
    expect(result.members.map((m) => m.id)).toEqual(["target"]);
    expect(result.offset).toBe(0);
    expect(result.total).toBe(1);
    expect(result.options.location).toEqual(["London", "Zurich"]);
    expect(result.options.membership).toEqual(expect.arrayContaining([...adminBotMemberTypes]));
    expect(
      memberRosterPage([...roster, target], papers, {
        limit: 50,
        offset: 0,
        filters: { membership: "coauthor-major" },
      }).total,
    ).toBe(0);
  });
  it("resets vanished options and handles legacy lists without changing stored records", () => {
    const original = member("legacy", {
      notes: "Location: Berlin\nJoined month: 2022-04\nprivate prose",
      avatar_url: "x".repeat(10000),
      field_provenance: { x: "large" },
      research_topics: [null, "AI", 42],
      projects: { bad: true },
    });
    const result = memberRosterPage([original], [], {
      limit: 50,
      offset: 0,
      filters: { location: "Zurich" },
    });
    expect(result.filters).toEqual({});
    expect(result.members[0]).toMatchObject({
      location: "Berlin",
      joined_month: "2022-04",
      research_topics: ["AI"],
      projects: [],
    });
    expect(result.members[0]?.notes).toBe(original.notes);
    expect(original.research_topics).toEqual([null, "AI", 42]);
  });
});
