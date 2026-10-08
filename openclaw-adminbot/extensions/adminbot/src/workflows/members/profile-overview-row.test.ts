import { describe, expect, it } from "vitest";
import type { AdminBotMemberProfileOverviewRow } from "../../contracts/actions.js";
import { profileOverviewWireRow } from "./profile-overview-row.js";

const DORMANT: AdminBotMemberProfileOverviewRow = {
  id: "ada",
  name: "Ada",
  status: "active",
  privilege_level: "member",
  member_type: "full",
  missing_fields: [],
  filled_field_count: 0,
  self_filled_field_count: 0,
  projects: { total: 0, self_updated: 0 },
  timeline: { availability: 0, time_off: 0, milestones: 0, trips: 0, total: 0 },
  activity: { logins: 0, profile_edits: 0, paper_updates: 0 },
};

describe("profileOverviewWireRow", () => {
  it("leaves out what the client fills in for a member who has done nothing yet", () => {
    expect(profileOverviewWireRow(DORMANT)).toEqual({
      id: "ada",
      name: "Ada",
      status: "active",
      member_type: "full",
    });
  });

  it("sends every group that has a number in it, whole", () => {
    const row: AdminBotMemberProfileOverviewRow = {
      ...DORMANT,
      privilege_level: "admin",
      missing_fields: ["orcid"],
      filled_field_count: 9,
      self_filled_field_count: 3,
      projects: { total: 2, self_updated: 0 },
      timeline: { availability: 0, time_off: 1, milestones: 0, trips: 0, total: 1 },
      activity: { logins: 0, profile_edits: 0, paper_updates: 0, last_active_at: "2026-01-01" },
      last_login_at: "2026-01-01T00:00:00.000Z",
    };
    expect(profileOverviewWireRow(row)).toEqual(row);
  });
});
