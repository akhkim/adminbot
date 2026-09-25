import { describe, expect, it } from "vitest";
import { describeMemberTypeChange } from "./member-type-change.ts";

describe("describeMemberTypeChange", () => {
  it("says what moved and what each step did", () => {
    const notice = describeMemberTypeChange("cora", {
      from: "coauthor-major",
      to: "alumni",
      privilege_level: { from: "external_collaborator", to: "external_collaborator" },
      collaborator_subgroup: { from: "coauthor_major", to: "alumni" },
      steps: [
        { step: "sheet", target: "row 12", status: "done" },
        { step: "slack", target: "#jinesis-active", status: "done" },
        { step: "alumni_mail", target: "cora@lab.test", status: "done" },
        { step: "lab_calendar", status: "skipped", detail: "no address on file" },
      ],
    });

    expect(notice.kind).toBe("success");
    expect(notice.text).toContain("member type coauthor-major → alumni");
    // Unchanged access level is not announced as a change.
    expect(notice.text).not.toContain("Access level");
    expect(notice.text).toContain("Done: member sheet row 12; Slack #jinesis-active; alumni email");
    expect(notice.text).toContain("Skipped: lab calendar (no address on file)");
  });

  it("turns red when a step failed, and names it", () => {
    const notice = describeMemberTypeChange("cora", {
      from: "coauthor-minor",
      to: "full",
      privilege_level: { from: "external_collaborator", to: "member" },
      collaborator_subgroup: { from: "coauthor_minor" },
      steps: [{ step: "group_meeting", status: "failed", detail: "could not read the calendar" }],
    });

    expect(notice.kind).toBe("error");
    expect(notice.text).toContain("Access level external_collaborator → member.");
    expect(notice.text).toContain("Failed: Monday meeting (could not read the calendar)");
  });
});
