import { describe, expect, it } from "vitest";
import {
  assertDcsRosterHeader,
  buildDcsRosterRow,
  chooseDcsUsername,
  createDcsRosterSheetRecorder,
  dcsAddressOf,
  dcsCredentialsEmail,
  dcsUsernameCandidates,
  DCS_DEFAULT_PERMISSION,
  DCS_ROSTER_SHEET_COLUMNS,
  generateDcsTemporaryPassword,
  normalizeDcsUsername,
  splitDisplayName,
  usernamePart,
} from "./dcs-roster-sheet.js";

const HEADER = [...DCS_ROSTER_SHEET_COLUMNS];
const column = (row: string[], name: (typeof DCS_ROSTER_SHEET_COLUMNS)[number]) =>
  row[DCS_ROSTER_SHEET_COLUMNS.indexOf(name)];

describe("splitDisplayName", () => {
  it("takes the last token as the family name", () => {
    expect(splitDisplayName("Ada Lovelace")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("keeps middle names on the first-name side", () => {
    expect(splitDisplayName("Mary Jane Watson")).toEqual({
      firstName: "Mary Jane",
      lastName: "Watson",
    });
  });

  // A name pasted out of Slack or Sheets can carry a non-breaking or full-width space. Against a
  // literal " " these looked exactly like mononyms.
  it("splits on any whitespace, not only the ASCII space", () => {
    expect(splitDisplayName("Eric Zhang")).toEqual({
      firstName: "Eric",
      lastName: "Zhang",
    });
    expect(splitDisplayName("Eric　Zhang")).toEqual({
      firstName: "Eric",
      lastName: "Zhang",
    });
  });

  it("gives nothing for a one-word name", () => {
    expect(splitDisplayName("Cher")).toBeUndefined();
    expect(splitDisplayName("   ")).toBeUndefined();
  });
});

describe("usernamePart", () => {
  // Decomposing and stripping the marks keeps the letter. Dropping the whole codepoint would
  // turn Bilodeau into bildeau.
  it("folds accents to their base letter rather than dropping them", () => {
    expect(usernamePart("Bilodeau")).toBe("bilodeau");
    expect(usernamePart("Müller")).toBe("muller");
    expect(usernamePart("Ångström")).toBe("angstrom");
  });

  it("drops the punctuation a unix account name cannot carry", () => {
    expect(usernamePart("O'Neill")).toBe("oneill");
    expect(usernamePart("Sainte-Marie")).toBe("saintemarie");
  });
});

describe("dcsUsernameCandidates", () => {
  // The lab's rules, in the order it prefers them.
  it("offers firstname, lastname, then initial+lastname", () => {
    expect(dcsUsernameCandidates("Andrew Kim")).toEqual(["andrew", "kim", "akim"]);
  });

  // Bare account names, not addresses: dcs_username is the unix account the sysadmin's roster is
  // keyed on, and the rows already on the sheet are bare. The address is the mail's business.
  it("gives bare account names, never addresses", () => {
    for (const candidate of dcsUsernameCandidates("Andrew Kim")) {
      expect(candidate).not.toContain("@");
    }
    expect(dcsAddressOf("andrew")).toBe("andrew@cs.toronto.edu");
  });

  // "Li Li" would otherwise offer the same string twice and hand the sysadmin a choice that is
  // not one.
  it("dedupes when the rules collide", () => {
    expect(dcsUsernameCandidates("Li Li")).toEqual(["li", "lli"]);
  });

  it("gives nothing for a mononym, rather than guessing", () => {
    expect(dcsUsernameCandidates("Eric")).toEqual([]);
  });

  // Nothing survives normalization, so there is no name to propose. A person picks this by hand.
  it("gives nothing when the name is entirely non-Latin", () => {
    expect(dcsUsernameCandidates("金 智静")).toEqual([]);
  });
});

describe("normalizeDcsUsername", () => {
  // The column is meant to hold a bare name, but it is typed into by hand and one row may well
  // arrive as a full address. Comparing the spellings literally reports a taken name as free.
  it("reduces every spelling of one account to the same key", () => {
    expect(normalizeDcsUsername("andrew")).toBe("andrew");
    expect(normalizeDcsUsername("  ANDREW@CS.Toronto.edu ")).toBe("andrew");
    expect(normalizeDcsUsername("Andrew@cs.toronto.edu")).toBe("andrew");
  });
});

describe("chooseDcsUsername", () => {
  it("takes the first candidate nobody holds", () => {
    expect(chooseDcsUsername(["andrew", "kim"], ["andrew"])).toBe("kim");
  });

  // The regression this exists for: the sheet stores bare names, so a full-address comparison
  // never matched and the taken-check was inert.
  it("matches a taken name whether it is stored bare or as an address", () => {
    expect(chooseDcsUsername(["andrew"], ["andrew"])).toBeUndefined();
    expect(chooseDcsUsername(["andrew"], ["  ANDREW@CS.Toronto.edu "])).toBeUndefined();
  });

  it("gives nothing when every candidate is taken", () => {
    expect(chooseDcsUsername(["a"], ["a"])).toBeUndefined();
  });
});

describe("generateDcsTemporaryPassword", () => {
  it("draws only from the unambiguous alphabet", () => {
    for (let run = 0; run < 50; run += 1) {
      expect(generateDcsTemporaryPassword()).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{20}$/u);
    }
  });

  // The point of the change that added this: every seeded account used to start on one shared
  // word.
  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateDcsTemporaryPassword()));
    expect(seen.size).toBe(200);
  });
});

describe("buildDcsRosterRow", () => {
  const base = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    username: "ada",
    password: "TEMPpw",
    now: new Date("2026-09-20T12:00:00Z"),
  };

  it("puts every value in the column the sheet expects", () => {
    const row = buildDcsRosterRow({
      ...base,
      facts: {
        id: "member-1",
        member_type: "PhD student",
        at_uoft: true,
        correspondence_email: "ada@ethz.ch",
        compute_access: ["UofT-AI-Slurm"],
      },
    });
    expect(row).toHaveLength(DCS_ROSTER_SHEET_COLUMNS.length);
    expect(column(row, "full_name")).toBe("Ada Lovelace");
    expect(column(row, "adminbot_internal_id")).toBe("member-1");
    expect(column(row, "dcs_username")).toBe("ada");
    expect(column(row, "dcs_password")).toBe("TEMPpw");
    expect(column(row, "non_dcs_email")).toBe("ada@ethz.ch");
    expect(column(row, "career_stage")).toBe("PhD student");
    expect(column(row, "at_uoft_or_not")).toBe("yes");
    expect(column(row, "permission")).toBe("UofT-AI-Slurm");
    expect(column(row, "date_of_this_row_change")).toBe("2026-09-20");
  });

  // The roster contract is explicit that a blank `at_uoft` means "we do not know". Reporting that
  // to DCS as "no" is a claim about somebody's eligibility rather than an absence of information.
  it("leaves at_uoft blank when the roster does not know, never 'no'", () => {
    expect(column(buildDcsRosterRow(base), "at_uoft_or_not")).toBe("");
    expect(
      column(buildDcsRosterRow({ ...base, facts: { at_uoft: false } }), "at_uoft_or_not"),
    ).toBe("no");
  });

  // New members default to the least-privileged tier. An escalation is a deliberate later row.
  it("asks for the least-privileged access when nothing is granted yet", () => {
    expect(column(buildDcsRosterRow(base), "permission")).toBe(DCS_DEFAULT_PERMISSION);
    expect(
      column(buildDcsRosterRow({ ...base, facts: { compute_access: [] } }), "permission"),
    ).toBe(DCS_DEFAULT_PERMISSION);
  });

  it("falls back to the address the mail went to when the roster has no correspondence address", () => {
    expect(column(buildDcsRosterRow(base), "non_dcs_email")).toBe("ada@example.com");
  });
});

describe("assertDcsRosterHeader", () => {
  it("accepts the sheet as it is", () => {
    expect(() => assertDcsRosterHeader(HEADER)).not.toThrow();
  });

  // The failure this exists to prevent is silent: insert one column and every later row files a
  // password under non_dcs_email, in a document other people can read.
  it("refuses a sheet whose columns moved", () => {
    const shifted = ["full_name", "surprise_new_column", ...HEADER.slice(1)];
    expect(() => assertDcsRosterHeader(shifted)).toThrow(
      /columns are not the ones AdminBot writes/u,
    );
  });

  it("refuses an empty sheet rather than seeding a header of its own", () => {
    expect(() => assertDcsRosterHeader(undefined)).toThrow(/an empty first row/u);
    expect(() => assertDcsRosterHeader([])).toThrow(/an empty first row/u);
  });
});

describe("createDcsRosterSheetRecorder", () => {
  function harness(
    rows: string[][],
    overrides: Partial<Parameters<typeof createDcsRosterSheetRecorder>[0]> = {},
  ) {
    const appended: string[][] = [];
    const recorder = createDcsRosterSheetRecorder({
      spreadsheetId: "sheet-1",
      readRows: async () => rows,
      appendRows: async (_id, added) => {
        appended.push(...added);
      },
      generatePassword: () => "TEMPpw",
      now: () => new Date("2026-09-20T00:00:00Z"),
      ...overrides,
    });
    return { recorder, appended };
  }

  it("appends one row with the first free username", async () => {
    const { recorder, appended } = harness([HEADER]);
    const record = await recorder!({
      name: "Andrew Kim",
      email: "andrew@example.com",
    });
    expect(record.username).toBe("andrew");
    expect(record.password).toBe("TEMPpw");
    expect(record.candidates).toHaveLength(3);
    expect(appended).toHaveLength(1);
    expect(column(appended[0] as string[], "dcs_username")).toBe("andrew");
  });

  // One row is one account: the sheet carries a single username and a single password per row.
  it("files exactly one row even though three names were considered", async () => {
    const { recorder, appended } = harness([HEADER]);
    await recorder!({ name: "Andrew Kim", email: "andrew@example.com" });
    expect(appended).toHaveLength(1);
  });

  it("steps past a username the sheet already carries", async () => {
    const existing = buildDcsRosterRow({
      name: "Andrew Other",
      email: "other@example.com",
      username: "andrew",
      password: "x",
    });
    const { recorder } = harness([HEADER, existing]);
    const record = await recorder!({
      name: "Andrew Kim",
      email: "andrew@example.com",
    });
    expect(record.username).toBe("kim");
  });

  // Everyone minted before this sheet existed. Without them the first few rows would propose
  // names that are already in use.
  it("also steps past a username only the roster knows about", async () => {
    const { recorder } = harness([HEADER], {
      rosterUsernames: () => ["andrew@cs.toronto.edu", "kim@cs.toronto.edu"],
    });
    const record = await recorder!({
      name: "Andrew Kim",
      email: "andrew@example.com",
    });
    expect(record.username).toBe("akim");
  });

  it("refuses rather than filing when every candidate is taken", async () => {
    const { recorder, appended } = harness([HEADER], {
      rosterUsernames: () => ["andrew@cs.toronto.edu", "kim@cs.toronto.edu", "akim@cs.toronto.edu"],
    });
    await expect(recorder!({ name: "Andrew Kim", email: "a@example.com" })).rejects.toThrow(
      /already taken/u,
    );
    expect(appended).toEqual([]);
  });

  it("refuses a mononym rather than inventing a username", async () => {
    const { recorder, appended } = harness([HEADER]);
    await expect(recorder!({ name: "Eric", email: "eric@example.com" })).rejects.toThrow(
      /first and a last name/u,
    );
    expect(appended).toEqual([]);
  });

  // The header check happens against the live sheet, before anything is written.
  it("refuses to write to a sheet whose columns drifted", async () => {
    const { recorder, appended } = harness([["full_name", "something_else"]]);
    await expect(recorder!({ name: "Andrew Kim", email: "a@example.com" })).rejects.toThrow(
      /columns are not the ones AdminBot writes/u,
    );
    expect(appended).toEqual([]);
  });

  // Unconfigured is not the same as wired-up-and-did-nothing: the caller reports the difference.
  it("is undefined when no spreadsheet is configured", () => {
    expect(
      createDcsRosterSheetRecorder({
        spreadsheetId: "  ",
        readRows: async () => [],
        appendRows: async () => {},
      }),
    ).toBeUndefined();
  });
});

describe("dcsCredentialsEmail", () => {
  const mail = dcsCredentialsEmail({
    name: "Ada Lovelace",
    username: "ada",
    password: "TEMPpw",
  });

  it("carries the username and the password", () => {
    expect(mail.body).toContain("ada@cs.toronto.edu");
    expect(mail.body).toContain("TEMPpw");
  });

  // The two sentences that are not copy to be tuned: the account does not exist yet, and the
  // password is to be changed on first sign-in.
  it("says the account does not exist yet and that the password must be changed", () => {
    expect(mail.body).toMatch(/does not exist yet/u);
    expect(mail.body).toMatch(/change this password immediately/iu);
  });

  it("greets by first name, and survives a mononym without throwing", () => {
    expect(mail.body.startsWith("Hi Ada,")).toBe(true);
    expect(
      dcsCredentialsEmail({
        name: "Cher",
        username: "c",
        password: "x",
      }).body,
    ).toContain("Hi Cher,");
  });
});
