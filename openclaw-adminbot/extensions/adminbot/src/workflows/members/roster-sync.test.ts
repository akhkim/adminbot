import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  parseRosterSheet,
  planRosterSync,
  rosterSyncRefusal,
  sameMemberType,
} from "./roster-sync.js";

const HEADER = [
  "Name",
  "AdminBot ID",
  "Slack email",
  "Email for correspondence (the more professional the better)",
  "Member Type",
];

function row(sheetRow: number, cells: (string | undefined)[]) {
  return { sheetRow, cells: HEADER.map((_, index) => cells[index] ?? "") };
}

function member(overrides: Partial<AdminBotLabMember> & { id: string }): AdminBotLabMember {
  return {
    name: `Member ${overrides.id}`,
    privilege_level: "member",
    ...overrides,
  } as AdminBotLabMember;
}

describe("parseRosterSheet", () => {
  // Addresses come back in ROSTER_SHEET_EMAIL_HEADERS order, not column order, so `emails[0]` is
  // the correspondence address wherever the sheet happens to put that column -- which is the one
  // reported for a row matching nobody.
  it("reads the id, every address on the row, and the type verbatim", () => {
    const parsed = parseRosterSheet(HEADER, [
      row(2, ["Mei Chen", "mei", "Mei@Example.com", "mei.chen@cs.toronto.edu", "full"]),
    ]);

    expect(parsed.rows).toEqual([
      {
        sheet_row: 2,
        name: "Mei Chen",
        member_id: "mei",
        emails: ["mei.chen@cs.toronto.edu", "mei@example.com"],
        member_type: "full",
      },
    ]);
  });

  it("splits a cell holding two addresses, which the roster routinely does", () => {
    const parsed = parseRosterSheet(HEADER, [
      row(2, ["Mei", "", "mei@a.com, mei@b.com", "", "coauthor-major"]),
    ]);

    expect(parsed.rows[0]?.emails).toEqual(["mei@a.com", "mei@b.com"]);
  });

  it("skips spacer rows and sets aside rows nothing can be matched by", () => {
    const parsed = parseRosterSheet(HEADER, [
      row(2, ["", "", "", "", ""]),
      row(3, ["Someone", "", "", "", "full"]),
    ]);

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.unidentifiable).toEqual([{ sheet_row: 3, name: "Someone" }]);
  });

  // Without the column every row reads as "type cleared", which is a mass revocation dressed up as
  // a sync. It has to stop the pass, and it has to say what it saw.
  it("refuses a sheet with no Member Type column and names the headers it found", () => {
    expect(() => parseRosterSheet(["Name", "Slack email"], [])).toThrow(/Member Type/u);
    expect(() => parseRosterSheet(["Name", "Slack email"], [])).toThrow(/Name, Slack email/u);
  });
});

describe("sameMemberType", () => {
  it("ignores order, spacing and case, because a person types this column by hand", () => {
    expect(sameMemberType("full, coauthor-major", "coauthor-major,full")).toBe(true);
    expect(sameMemberType("Full", " full ")).toBe(true);
    expect(sameMemberType(undefined, "")).toBe(true);
  });

  it("still sees a real change", () => {
    expect(sameMemberType("full", "alumni")).toBe(false);
    expect(sameMemberType("full", "full, coauthor-major")).toBe(false);
    expect(sameMemberType("full", "")).toBe(false);
  });
});

describe("planRosterSync", () => {
  const sheet = (rows: ReturnType<typeof row>[]) => parseRosterSheet(HEADER, rows);

  it("matches by id first and reports the type change", () => {
    const plan = planRosterSync({
      sheet: sheet([row(2, ["Mei Chen", "mei", "mei@a.com", "", "alumni"])]),
      members: [member({ id: "mei", name: "Mei Chen", member_type: "full" })],
    });

    expect(plan.member_type_changes).toEqual([
      { member_id: "mei", member_name: "Mei Chen", sheet_row: 2, from: "full", to: "alumni" },
    ]);
    expect(plan.additions).toHaveLength(0);
    expect(plan.absent).toHaveLength(0);
  });

  // The roster keeps three addresses per person and the sheet does not say which one a row used.
  it("matches on any stored address, not just the login one", () => {
    const plan = planRosterSync({
      sheet: sheet([row(2, ["Mei", "", "mei.personal@gmail.com", "", "full"])]),
      members: [
        member({
          id: "mei",
          email: "mei@cs.toronto.edu",
          calendar_email: "mei.personal@gmail.com",
          member_type: "full",
        }),
      ],
    });

    expect(plan.additions).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it("reports both directions without acting on either", () => {
    const plan = planRosterSync({
      sheet: sheet([row(2, ["New Person", "", "new@a.com", "", "coauthor-minor"])]),
      members: [member({ id: "old", name: "Old Person", email: "old@a.com", member_type: "full" })],
    });

    expect(plan.additions).toEqual([
      { sheet_row: 2, name: "New Person", email: "new@a.com", member_type: "coauthor-minor" },
    ]);
    expect(plan.absent).toEqual([
      { member_id: "old", member_name: "Old Person", member_type: "full" },
    ]);
    expect(plan.member_type_changes).toHaveLength(0);
  });

  // Applying the second row's type over the first would make the result depend on sheet order.
  it("reports two rows resolving to one member rather than picking one", () => {
    const plan = planRosterSync({
      sheet: sheet([
        row(2, ["Mei", "mei", "", "", "full"]),
        row(3, ["Mei again", "mei", "", "", "alumni"]),
      ]),
      members: [member({ id: "mei", member_type: "full" })],
    });

    expect(plan.duplicates).toEqual([{ member_id: "mei", sheet_rows: [2, 3] }]);
    expect(plan.member_type_changes).toHaveLength(0);
  });

  it("counts rows that already agree, which is what makes the summary readable", () => {
    const plan = planRosterSync({
      sheet: sheet([
        row(2, ["A", "a", "", "", "full"]),
        row(3, ["B", "b", "", "", "coauthor-major, full"]),
      ]),
      members: [
        member({ id: "a", member_type: "full" }),
        member({ id: "b", member_type: "full, coauthor-major" }),
      ],
    });

    expect(plan.unchanged).toBe(2);
    expect(plan.member_type_changes).toHaveLength(0);
  });
});

describe("rosterSyncRefusal", () => {
  const planWith = (count: number) => ({
    member_type_changes: Array.from({ length: count }, (_, index) => ({
      member_id: `m${index}`,
      member_name: `M${index}`,
      sheet_row: index + 2,
      to: "alumni",
    })),
    additions: [],
    absent: [],
    unidentifiable: [],
    unchanged: 0,
    duplicates: [],
  });

  it("lets an ordinary night through", () => {
    expect(rosterSyncRefusal(planWith(3), 200)).toBeUndefined();
  });

  // A truncated read, a renamed tab or a filter left on all look like this, and no correct read
  // does: the lab does not re-type a third of its roster in one night.
  it("refuses a pass that would rewrite a quarter of the roster", () => {
    expect(rosterSyncRefusal(planWith(60), 200)).toMatch(/refusing to apply 60/u);
  });

  it("keeps a floor so a small lab is not blocked by its own size", () => {
    // 25% of 12 is 3, but 10 changes in a 12-person lab is a plausible re-labelling.
    expect(rosterSyncRefusal(planWith(9), 12)).toBeUndefined();
    expect(rosterSyncRefusal(planWith(11), 12)).toMatch(/ceiling 10/u);
  });

  it("says nothing about a pass with no changes at all", () => {
    expect(rosterSyncRefusal(planWith(0), 0)).toBeUndefined();
  });
});
