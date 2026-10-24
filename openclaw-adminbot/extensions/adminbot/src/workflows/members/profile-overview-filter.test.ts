import { describe, expect, it } from "vitest";
import {
  deskAdoption,
  EMPTY_PROFILE_OVERVIEW_FILTER,
  incompleteProfiles,
  profileOverviewFilterParams,
  readProfileOverviewFilter,
  thinTimelines,
  unattendedProjects,
  type ProfileOverviewFilterRow,
} from "./profile-overview-filter.js";

function row(index: number): ProfileOverviewFilterRow {
  return {
    id: `m${index}`,
    name: `Member ${index}`,
    privilege_level: "member",
    // Deliberately colliding keys, so ties are what decide the heads.
    missing_fields: Array.from({ length: index % 4 }, (_, field) => `f${field}`),
    timeline: { total: index % 3 },
    projects: { total: index % 5, self_updated: index % 2 },
    ...(index % 11 === 0 ? { member_type: "alumni" } : {}),
  };
}

describe("profile overview filter", () => {
  it("reads back the filter the browser writes", () => {
    const filter = {
      gap: "timeline" as const,
      membership: "full" as const,
      search: "ada",
      activity: "never" as const,
      memberTypes: ["alumni", "coauthor-major"],
    };
    expect(readProfileOverviewFilter(profileOverviewFilterParams(filter))).toEqual(filter);
    expect(profileOverviewFilterParams(EMPTY_PROFILE_OVERVIEW_FILTER).toString()).toBe("");
    expect(readProfileOverviewFilter(new URLSearchParams("activity=sometimes"))).toBe("invalid");
  });

  it("gives My Desk the same column heads it would draw from the whole roster", () => {
    const roster = Array.from({ length: 300 }, (_, index) => row(index));
    const { members, counts } = deskAdoption(roster, 20);
    for (const column of [incompleteProfiles, thinTimelines, unattendedProjects]) {
      const ids = (rows: ProfileOverviewFilterRow[]) => rows.slice(0, 20).map((entry) => entry.id);
      expect(ids(column(members))).toEqual(ids(column(roster)));
    }
    expect(counts.profile).toBe(incompleteProfiles(roster).length);
    expect(counts.timeline).toBe(thinTimelines(roster).length);
    expect(counts.papers).toBe(unattendedProjects(roster).length);
    expect(members.length).toBeLessThanOrEqual(60);
  });
});
