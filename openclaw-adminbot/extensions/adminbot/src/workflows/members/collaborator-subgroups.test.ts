import { describe, expect, it } from "vitest";
import {
  adminBotExternalCollaboratorSubgroups,
  type AdminBotExternalCollaboratorSubgroup,
  type AdminBotLabMember,
} from "../../contracts/actions.js";
import {
  adminBotCollaboratorAccessCells,
  collaboratorSubgroupAccess,
  vectorSponsorRoster,
  type AdminBotCollaboratorAccessItemId,
} from "./collaborator-subgroups.js";

function grantedItems(subgroup: AdminBotExternalCollaboratorSubgroup) {
  return collaboratorSubgroupAccess(subgroup).map((grant) => grant.item);
}

describe("collaboratorSubgroupAccess", () => {
  it("grants every subgroup something and never repeats an item", () => {
    for (const subgroup of adminBotExternalCollaboratorSubgroups) {
      const items = grantedItems(subgroup);
      expect(items.length).toBeGreaterThan(0);
      expect(new Set(items).size).toBe(items.length);
    }
  });

  it("returns matrix row order, repeatably", () => {
    const expected: AdminBotCollaboratorAccessItemId[] = [
      "welcome_linkedin_twitter",
      "slack_guest_space_check",
      "slack_guest_chat_zhijing",
      "project_drive_folder",
      "what_to_expect_stories",
      "city_dinner_invite",
    ];
    expect(grantedItems("interviewee")).toEqual(expected);
    expect(grantedItems("interviewee")).toEqual(expected);
  });

  it("carries labels, details, and only granted cell codes", () => {
    for (const subgroup of adminBotExternalCollaboratorSubgroups) {
      for (const grant of collaboratorSubgroupAccess(subgroup)) {
        expect(grant.label.length).toBeGreaterThan(0);
        expect(grant.detail.length).toBeGreaterThan(0);
        expect(adminBotCollaboratorAccessCells).toContain(grant.cell);
        expect(grant.cell).not.toBe("no");
      }
    }
  });

  it.each([
    ["interviewee", "slack_guest_space_check", "yes"],
    ["interviewee", "what_to_expect_stories", "yes_separate"],
    ["own_pace_advisee", "adminbot_portal_access", "yes"],
    ["own_pace_advisee", "rec_letter_button", "yes"],
    ["own_pace_advisee", "what_to_expect_stories", "yes_separate"],
    ["coauthor_discussant_designer", "active_channels", "yes"],
    ["coauthor_discussant_designer", "project_channel", "yes"],
    ["coauthor_minor", "slack_guest_space_check", "yes"],
    ["slightly_better_than_emails", "spreadsheet_basic", "yes"],
    ["alumni", "rec_letter_button", "yes"],
    ["coauthor_minor", "google_file_practice_guide", "yes_separate"],
    ["coauthor_minor", "rec_letter_button", "case_by_case"],
    ["coauthor_major", "weekly_meeting", "yes"],
    ["disappearing_coauthor", "rec_letter_button", "auto_decline"],
    ["external_prof", "backend_email_triggers", "yes"],
  ] as const)("resolves %s / %s as %s", (subgroup, item, cell) => {
    const grant = collaboratorSubgroupAccess(subgroup).find((entry) => entry.item === item);
    expect(grant?.cell).toBe(cell);
  });

  it.each([
    ["slightly_better_than_emails", "rec_letter_button"],
    ["external_prof", "weekly_meeting"],
    ["interviewee", "spreadsheet_basic"],
    ["interviewee", "project_channel"],
    ["disappearing_coauthor", "project_drive_folder"],
    // coauthor_minor is not in the two active channels; the sheet gives that row to
    // own_pace_advisee, coauthor_major and coauthor_discussant_designer only.
    ["coauthor_minor", "active_channels"],
    ["own_pace_advisee", "project_channel"],
    ["own_pace_advisee", "weekly_meeting"],
    ["coauthor_discussant_designer", "rec_letter_button"],
    ["coauthor_discussant_designer", "welcome_linkedin_twitter"],
  ] as const)("omits ungranted %s / %s", (subgroup, item) => {
    expect(grantedItems(subgroup)).not.toContain(item);
  });

  it("leaves coauthor_minor exactly two rows coauthor_major does not hold", () => {
    // Not a superset relation: a major coauthor is already inside the main Slack space, so the
    // guest-space check is a row the lighter subgroup holds and the heavier one does not.
    const major = new Set(grantedItems("coauthor_major"));
    const minorOnly = grantedItems("coauthor_minor").filter((item) => !major.has(item));
    expect(minorOnly).toEqual(["spreadsheet_basic", "slack_guest_space_check"]);
  });

  it("carries the unanswered private-info row without granting it to anyone", () => {
    for (const subgroup of adminBotExternalCollaboratorSubgroups) {
      expect(grantedItems(subgroup)).not.toContain("trusted_lab_private_info");
    }
  });

  it("puts only coauthor_major on the Vector sponsor roster row", () => {
    for (const subgroup of adminBotExternalCollaboratorSubgroups) {
      const granted = grantedItems(subgroup).includes("vector_roster_share");
      expect(granted).toBe(subgroup === "coauthor_major");
    }
  });

  it("invites everyone on the social follow welcome to city dinners, and one subgroup more", () => {
    // These two rows tracked each other while the matrix had eight columns. They no longer do:
    // coauthor_discussant_designer is on the dinner row but not the LinkedIn/Twitter welcome row,
    // so the relation is containment rather than equality.
    for (const subgroup of adminBotExternalCollaboratorSubgroups) {
      const items = grantedItems(subgroup);
      if (items.includes("welcome_linkedin_twitter")) {
        expect(items).toContain("city_dinner_invite");
      }
    }
    expect(grantedItems("coauthor_discussant_designer")).toContain("city_dinner_invite");
    expect(grantedItems("coauthor_discussant_designer")).not.toContain("welcome_linkedin_twitter");
  });
});

describe("vectorSponsorRoster", () => {
  function member(overrides: Partial<AdminBotLabMember> & { id: string }): AdminBotLabMember {
    return {
      name: overrides.id,
      privilege_level: "member",
      // The sheet selects on member_type now, not privilege_level: privilege says what somebody may
      // do, and nearly every imported row defaults to `member`.
      member_type: "full",
      access: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("carries full members, admins, and coauthor-major collaborators", () => {
    const roster = vectorSponsorRoster([
      member({ id: "ada", name: "Ada", email: "ada@utoronto.ca" }),
      member({ id: "zed", name: "Zed", privilege_level: "admin", email: "zed@utoronto.ca" }),
      member({
        id: "cora",
        name: "Cora",
        privilege_level: "external_collaborator",
        member_type: "coauthor-major",
        collaborator_subgroup: "coauthor_major",
        email: "cora@example.edu",
      }),
    ]);

    expect(roster.entries).toEqual([
      { id: "ada", name: "Ada", email: "ada@utoronto.ca" },
      { id: "cora", name: "Cora", email: "cora@example.edu" },
      { id: "zed", name: "Zed", email: "zed@utoronto.ca" },
    ]);
    expect(roster.missing_email).toEqual([]);
  });

  it("leaves off trials and every collaborator subgroup below coauthor-major", () => {
    const roster = vectorSponsorRoster([
      member({
        id: "tri",
        privilege_level: "trial",
        member_type: "interviewee",
        email: "tri@utoronto.ca",
      }),
      member({
        id: "minor",
        privilege_level: "external_collaborator",
        member_type: "coauthor-minor",
        collaborator_subgroup: "coauthor_minor",
        email: "minor@example.edu",
      }),
      member({
        id: "prof",
        privilege_level: "external_collaborator",
        member_type: "external-prof",
        collaborator_subgroup: "external_prof",
        email: "prof@example.edu",
      }),
      // Neither the type column nor anything else names this one, which is the case that used to
      // put most of the roster on the sheet: an imported row whose privilege defaulted to `member`.
      member({ id: "blank", member_type: "", email: "blank@utoronto.ca" }),
    ]);

    expect(roster.entries).toEqual([]);
  });

  // Dropping someone silently would read to the sponsor as an account to remove, so the gap is
  // reported instead.
  it("reports people who belong on the sheet but have no email", () => {
    const roster = vectorSponsorRoster([
      member({ id: "noemail", name: "No Email" }),
      member({ id: "blank", name: "Blank", email: "   " }),
      member({ id: "ok", name: "Ok", email: "ok@utoronto.ca" }),
    ]);

    expect(roster.entries.map((entry) => entry.id)).toEqual(["ok"]);
    expect(roster.missing_email).toEqual(["blank", "noemail"]);
  });

  // The sheet is auto-shared and constantly refreshed, so unstable ordering would churn the diff.
  it("sorts by name so refreshes do not reshuffle the shared sheet", () => {
    const roster = vectorSponsorRoster([
      member({ id: "c", name: "Carol", email: "c@utoronto.ca" }),
      member({ id: "a", name: "Alice", email: "a@utoronto.ca" }),
      member({ id: "b", name: "Bob", email: "b@utoronto.ca" }),
    ]);

    expect(roster.entries.map((entry) => entry.name)).toEqual(["Alice", "Bob", "Carol"]);
  });
});
