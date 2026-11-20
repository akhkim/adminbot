import { describe, expect, it } from "vitest";
import {
  adminBotMemberTypes,
  type AdminBotLabMember,
  type AdminBotPaperRecord,
} from "../../contracts/actions.js";
import {
  buildMemberRosterIndex,
  joinedMonthOrder,
  memberRosterPage,
  selectMemberRosterPage,
} from "./member-roster.js";
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
  it("sorts the whole roster before paging, active members first, unknown dates last", () => {
    const members = [...roster, target, member("unknown")];
    const first = memberRosterPage(members, papers, { limit: 50, offset: 0, filters: {} });
    const second = memberRosterPage(members, papers, { limit: 50, offset: 50, filters: {} });
    expect(first.total).toBe(122);
    // The alumni joined earliest but follows all 120 active members.
    expect(first.members[0]?.id).toBe("member-000");
    expect(second.members[0]?.id).toBe("member-050");
    expect(new Set([...first.members, ...second.members].map((m) => m.id)).size).toBe(100);
    expect(
      memberRosterPage(members, papers, { limit: 50, offset: 100, filters: {} })
        .members.slice(-2)
        .map((m) => m.id),
    ).toEqual(["target", "unknown"]);
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
      member("undated-old-full", { created_at: "2026-07-02", member_type: "full" }),
      member("y2026-coauthor", { joined_month: "2026-01", member_type: "coauthor-major" }),
      member("jan25-alumni", { joined_month: "Jan-25", member_type: "full, alumni" }),
      member("jan25-acquaintance", { joined_month: "2025-01", member_type: "acquaintance" }),
      member("sept24-full", { joined_month: "Sept 2024", member_type: "full" }),
    ];
    // Active members first (earliest joiner first), then everybody else in the same order.
    expect(
      memberRosterPage(members, [], { limit: 50, offset: 0, filters: {} }).members.map((m) => m.id),
    ).toEqual([
      "sept24-full",
      "y2026-coauthor",
      "undated-old-full",
      "jan25-acquaintance",
      "jan25-alumni",
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
  it("builds the index once and pages it many times with lean rows", () => {
    const heavy = member("heavy", {
      email: "person@example.test",
      field_provenance: { name: "sheet" },
      onboarding: { steps: [] },
      availability: "Mon 9-5",
      time_off: [{ start: "2026-01-01" }],
      merch_requests: "hoodie",
    });
    const index = buildMemberRosterIndex([...roster, heavy], papers);
    const page = selectMemberRosterPage(index, { limit: 50, offset: 0, filters: { q: "study" } });
    expect(page.members.map((m) => m.id)).toEqual(["heavy"]);
    const row = page.members[0] as Record<string, unknown>;
    expect(row.roster_papers).toEqual([{ title: "Study", conference: "ExampleConf" }]);
    for (const field of ["field_provenance", "onboarding", "availability", "time_off"]) {
      expect(row).not.toHaveProperty(field);
    }
    // Registry form fields stay, so the inline editor never saves them away.
    expect(row.merch_requests).toBe("hoodie");
    expect(
      selectMemberRosterPage(index, { limit: 50, offset: 100, filters: {} }).members,
    ).toHaveLength(21);
  });
});
