import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  dcsRosterEntryValues,
  dcsRosterRoleGained,
  dcsRosterRoleOf,
  dcsRosterRowForHeader,
  dcsRosterSheetUsernames,
  dcsRosterUsernameCandidates,
  findDcsRosterRow,
  resolveDcsRosterUsername,
} from "./dcs-roster-entry.js";

// The live sheet's header as of 2026-10-20: `dcs_password` gone, `UTORid` added before the date.
const HEADER = [
  "full_name",
  "adminbot_internal_id",
  "dcs_username",
  "non_dcs_email",
  "career_stage",
  "at_uoft_or_not",
  "permission",
  "UTORid",
  "date_of_this_row_change",
];

const member = (overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember =>
  ({
    id: "ada-lovelace",
    name: "Ada Lovelace",
    privilege_level: "member",
    member_type: "full",
    email: "ada@example.test",
    ...overrides,
  }) as AdminBotLabMember;

describe("who the DCS roster sheet is for", () => {
  it("is full members and major coauthors, full winning when somebody is both", () => {
    expect(dcsRosterRoleOf({ member_type: "full" })).toBe("full");
    expect(dcsRosterRoleOf({ member_type: "coauthor-major" })).toBe("coauthor-major");
    expect(dcsRosterRoleOf({ member_type: "coauthor-major, full" })).toBe("full");
    for (const type of ["coauthor-minor", "own-pace-advisee", "external-prof", "", undefined]) {
      expect(dcsRosterRoleOf({ member_type: type }), String(type)).toBeUndefined();
    }
  });

  // The type column keeps `full` after somebody leaves; asking DCS for an account for them would
  // be the Vector sheet's mistake again.
  it("leaves alumni off, however the roster records that they left", () => {
    expect(dcsRosterRoleOf({ member_type: "full, alumni" })).toBeUndefined();
    expect(dcsRosterRoleOf({ member_type: "coauthor-major", status: "alumni" })).toBeUndefined();
  });

  it("files on becoming one of the two, not on every edit of the type string", () => {
    expect(dcsRosterRoleGained({ member_type: "" }, { member_type: "full" })).toBe("full");
    expect(
      dcsRosterRoleGained({ member_type: "coauthor-minor" }, { member_type: "coauthor-major" }),
    ).toBe("coauthor-major");
    // A major coauthor joining the lab is becoming a full member.
    expect(dcsRosterRoleGained({ member_type: "coauthor-major" }, { member_type: "full" })).toBe(
      "full",
    );
    // Still a full member: nothing new to file.
    expect(
      dcsRosterRoleGained({ member_type: "full" }, { member_type: "full, coauthor-major" }),
    ).toBeUndefined();
    // Leaving, or stepping down, files nothing.
    expect(dcsRosterRoleGained({ member_type: "full" }, { member_type: "alumni" })).toBeUndefined();
    expect(
      dcsRosterRoleGained({ member_type: "coauthor-major" }, { member_type: "coauthor-minor" }),
    ).toBeUndefined();
  });
});

describe("what the row says", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("fills the sheet's columns from the record", () => {
    expect(
      dcsRosterEntryValues(
        member({
          member_type: "coauthor-major",
          at_uoft: true,
          dcs_username: " ALovelace ",
          compute_access: ["UofT-AI-Slurm", "UofT-slack-only"],
        }),
        now,
      ),
    ).toEqual({
      full_name: "Ada Lovelace",
      adminbot_internal_id: "ada-lovelace",
      dcs_username: "alovelace",
      non_dcs_email: "ada@example.test",
      career_stage: "coauthor-major",
      at_uoft_or_not: "yes",
      permission: "UofT-slack-only, UofT-AI-Slurm",
      date_of_this_row_change: "2026-10-20",
    });
  });

  // An unknown affiliation is not "not at UofT", and a newcomer gets the least-privileged access.
  it("writes an unknown as a blank and defaults to the newcomer-safe permission", () => {
    const values = dcsRosterEntryValues(member(), now);
    expect(values.at_uoft_or_not).toBe("");
    expect(values.permission).toBe("UofT-slack-only");
    expect(dcsRosterEntryValues(member({ at_uoft: false }), now).at_uoft_or_not).toBe("no");
  });

  // Vector and Compute Canada grants are another sysadmin's business.
  it("names only DCS access in the permission cell", () => {
    expect(
      dcsRosterEntryValues(member({ compute_access: ["vector-basic-A100", "UofT-H100"] }), now)
        .permission,
    ).toBe("UofT-H100");
    expect(
      dcsRosterEntryValues(member({ compute_access: ["vector-basic-A100"] }), now).permission,
    ).toBe("UofT-slack-only");
  });

  it("never puts the DCS account's own address in the non-DCS column", () => {
    expect(
      dcsRosterEntryValues(
        member({ email: "ada@cs.toronto.edu", correspondence_email: "ada@gmail.example" }),
        now,
      ).non_dcs_email,
    ).toBe("ada@gmail.example");
    expect(dcsRosterEntryValues(member({ email: "ada@cs.toronto.edu" }), now).non_dcs_email).toBe(
      "",
    );
  });

  it("offers username candidates only when none is stored", () => {
    expect(dcsRosterUsernameCandidates(member())).toEqual(["ada", "lovelace", "alovelace"]);
    expect(dcsRosterUsernameCandidates(member({ dcs_username: "ada" }))).toEqual([]);
    expect(dcsRosterUsernameCandidates(member({ name: "Ada" }))).toEqual([]);
  });
});

describe("laying the row out under the live header", () => {
  const values = dcsRosterEntryValues(member(), new Date("2026-10-20T00:00:00Z"));

  it("puts every value under its own column and leaves the others blank", () => {
    const row = dcsRosterRowForHeader([HEADER], { ...values, dcs_username: "ada" });
    expect(row).toEqual([
      "Ada Lovelace",
      "ada-lovelace",
      "ada",
      "ada@example.test",
      "full",
      "",
      "UofT-slack-only",
      "",
      "2026-10-20",
    ]);
  });

  // The failure positional appends had: a column inserted on the sheet moves every later value.
  it("follows a reordered header instead of shifting values into the wrong cells", () => {
    const reordered = ["adminbot_internal_id", "permission", "full_name", "notes"];
    expect(dcsRosterRowForHeader([reordered], values)).toEqual([
      "ada-lovelace",
      "UofT-slack-only",
      "Ada Lovelace",
    ]);
  });

  // A credential column coming back is not a reason for a role change to start writing one.
  it("never writes a password, even if the sheet grows the column again", () => {
    const row = dcsRosterRowForHeader(
      [[...HEADER.slice(0, 3), "dcs_password", ...HEADER.slice(3)]],
      {
        ...values,
        dcs_username: "ada",
      },
    );
    expect(row[3]).toBe("");
  });

  it("refuses a sheet that is not the DCS roster", () => {
    expect(() => dcsRosterRowForHeader([["Name", "Email"]], values)).toThrow(
      /no full_name or adminbot_internal_id column/u,
    );
    expect(() => dcsRosterRowForHeader([], values)).toThrow(/\(empty\)/u);
  });
});

describe("reading the sheet back", () => {
  const rows = [
    HEADER,
    ["Grace Hopper", "grace-hopper", "grace", "", "full"],
    ["Ada Lovelace", " Ada-Lovelace ", "", "", "coauthor-major"],
  ];

  it("finds somebody already on it by id, whatever the cell's case and padding", () => {
    expect(findDcsRosterRow(rows, "ada-lovelace")).toBe(3);
    expect(findDcsRosterRow(rows, "alan-turing")).toBeUndefined();
    expect(findDcsRosterRow([["Name"], ["ada-lovelace"]], "ada-lovelace")).toBeUndefined();
  });

  it("picks the first candidate nobody on the sheet or the roster holds", () => {
    const taken = [...dcsRosterSheetUsernames(rows), "ADA"];
    expect(taken).toEqual(["grace", "ADA"]);
    expect(
      resolveDcsRosterUsername({ ...valuesFor(), dcs_username: "" }, ["ada", "lovelace"], taken),
    ).toBe("lovelace");
    // A stored name is the account; it is never swapped for a candidate.
    expect(resolveDcsRosterUsername({ ...valuesFor(), dcs_username: "ada" }, ["x"], taken)).toBe(
      "ada",
    );
    // Every candidate taken: blank, for the sysadmin to pick, rather than a collision.
    expect(resolveDcsRosterUsername({ ...valuesFor(), dcs_username: "" }, ["grace"], taken)).toBe(
      "",
    );
  });
});

function valuesFor() {
  return dcsRosterEntryValues(member(), new Date("2026-10-20T00:00:00Z"));
}
