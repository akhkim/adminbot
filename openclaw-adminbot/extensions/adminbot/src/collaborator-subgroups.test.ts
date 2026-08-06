import { describe, expect, it } from "vitest";
import {
  adminBotCollaboratorAccessCells,
  collaboratorSubgroupAccess,
  type AdminBotCollaboratorAccessItemId,
} from "./collaborator-subgroups.js";
import {
  adminBotExternalCollaboratorSubgroups,
  type AdminBotExternalCollaboratorSubgroup,
} from "./contracts.js";

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
      "project_channel",
      "project_drive_folder",
      "what_to_expect_stories",
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
    // The `p` cell from the spreadsheet: unconfirmed, and deliberately not a yes or a no.
    ["interviewee", "project_channel", "pending"],
    ["interviewee", "what_to_expect_stories", "yes_separate"],
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
    ["disappearing_coauthor", "project_drive_folder"],
  ] as const)("omits ungranted %s / %s", (subgroup, item) => {
    expect(grantedItems(subgroup)).not.toContain(item);
  });

  it("keeps coauthor_major a superset of coauthor_minor apart from the basic spreadsheet row", () => {
    const major = new Set(grantedItems("coauthor_major"));
    const minorOnly = grantedItems("coauthor_minor").filter((item) => !major.has(item));
    expect(minorOnly).toEqual(["spreadsheet_basic"]);
  });
});
