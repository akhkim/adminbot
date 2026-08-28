import { describe, expect, it } from "vitest";
import {
  ADMINBOT_CONTACT_SHEET_DEFAULT_RANGE,
  contactRecordValues,
  contactSheetRange,
  createContactSheetLookup,
  findContactByEmail,
  parseContactSheetRows,
} from "./contact-sheet.js";
import { createAdminBotOnboardingSender } from "./guide-sender.js";

// The real header row of the "Full Slack Member List" tab: column A carries the name under an
// empty header, and the address column's header is a sentence rather than a word.
const HEADER = [
  "",
  "Joined month",
  "Location",
  "Email for correspondence (the more professional the better)",
  "Gmail for calendar",
  "Slack email",
  "Member Type",
  "projects",
  "theme",
  "tldr",
];

const MATRIX = [
  HEADER,
  [
    "Ada Lovelace",
    "2024-01",
    "Toronto",
    "ada@example.edu",
    "ada.personal@example.com",
    "adalo@cs.example.edu",
    "full",
    "Causal RL",
    "",
    "",
  ],
  // An external professor: no member type, background carried in tldr, project only in theme.
  [
    "Rex Kramer",
    "2025-03",
    "Berlin",
    "rex@uni.example",
    "",
    "",
    "",
    "",
    "Alignment",
    "Professor, Uni Example",
  ],
  // Spacing row -- no name and no address anywhere.
  ["", "", "", "", "", "", "", "", "", ""],
];

describe("contact sheet", () => {
  it("reads people off the tab, skipping spacing rows", () => {
    const records = parseContactSheetRows(MATRIX);
    expect(records.map((record) => record.name)).toEqual(["Ada Lovelace", "Rex Kramer"]);
    expect(records[0]?.email).toBe("ada@example.edu");
    expect(records[0]?.member_type).toBe("full");
    expect(records[1]?.tldr).toBe("Professor, Uni Example");
  });

  // Sheets drops trailing empty cells, so a short row must not read as a parse failure.
  it("tolerates ragged rows", () => {
    const records = parseContactSheetRows([HEADER, ["Solo", "", "", "solo@example.edu"]]);
    expect(records).toHaveLength(1);
    expect(records[0]?.email).toBe("solo@example.edu");
    expect(records[0]?.projects).toBe("");
  });

  it("returns nothing for an empty sheet", () => {
    expect(parseContactSheetRows([])).toEqual([]);
  });

  // The address an onboarding mail goes to is often the Slack alias or the calendar Gmail rather
  // than the "correspondence" one, so all three columns have to match.
  it("matches on any of the three address columns, case-insensitively", () => {
    const records = parseContactSheetRows(MATRIX);
    for (const address of [
      "ADA@example.edu",
      " ada.personal@example.com ",
      "adalo@cs.example.edu",
    ]) {
      expect(findContactByEmail(records, address)?.name).toBe("Ada Lovelace");
    }
    expect(findContactByEmail(records, "nobody@example.edu")).toBeUndefined();
    expect(findContactByEmail(records, "not-an-address")).toBeUndefined();
  });

  it("maps a row onto the record_* tokens, falling back for external people", () => {
    const [ada, rex] = parseContactSheetRows(MATRIX);
    // "Member Type" is the internal tier, so it never becomes the Role line -- Ada has no tldr and
    // therefore no role, which the send path reports as missing rather than filling with "full".
    expect(contactRecordValues(ada)).toEqual({
      record_name: "Ada Lovelace",
      record_email: "ada@example.edu",
      record_projects: "Causal RL",
    });
    // No projects column: role comes from the background line, project from theme.
    expect(contactRecordValues(rex)).toMatchObject({
      record_role: "Professor, Uni Example",
      record_projects: "Alignment",
    });
    // A miss yields no tokens at all rather than blanks, so the send path still reports them missing.
    expect(contactRecordValues(undefined)).toEqual({});
  });

  // A real row on this sheet reads "full, adminbot-admin, adminbot-developer". Quoting that back
  // would name the recipient's internal tier and disclose who holds admin.
  it("never lets the internal tier or privilege flags become the Role line", () => {
    const [record] = parseContactSheetRows([
      HEADER,
      [
        "Zed Admin",
        "",
        "",
        "zed@example.edu",
        "",
        "",
        "full, adminbot-admin, adminbot-developer",
        "",
        "",
        "",
      ],
    ]);
    const values = contactRecordValues(record);
    expect(values.record_role).toBeUndefined();
    expect(JSON.stringify(values)).not.toContain("adminbot-admin");
  });

  it("reads the named tab, since the workbook's first tab is not the member list", () => {
    expect(contactSheetRange({})).toBe(ADMINBOT_CONTACT_SHEET_DEFAULT_RANGE);
    expect(ADMINBOT_CONTACT_SHEET_DEFAULT_RANGE).toContain("Full Slack Member List");
    expect(contactSheetRange({ ADMINBOT_CONTACT_SHEET_RANGE: "'Other'!A:C" })).toBe("'Other'!A:C");
  });

  it("caches one read across a burst, then refreshes", async () => {
    let reads = 0;
    let clock = 0;
    const lookup = createContactSheetLookup({
      env: {},
      cacheMs: 1000,
      now: () => clock,
      readRows: async () => {
        reads += 1;
        return MATRIX;
      },
    });
    expect((await lookup("ada@example.edu"))?.name).toBe("Ada Lovelace");
    expect((await lookup("rex@uni.example"))?.name).toBe("Rex Kramer");
    expect(reads).toBe(1);
    clock = 5000;
    await lookup("ada@example.edu");
    expect(reads).toBe(2);
  });

  // An unreachable sheet must not block onboarding: it only supplies defaults, and the send path
  // still refuses on anything genuinely required.
  it("fails soft when the sheet cannot be read", async () => {
    const lookup = createContactSheetLookup({
      env: {},
      readRows: async () => {
        throw new Error("no google account configured");
      },
    });
    await expect(lookup("ada@example.edu")).resolves.toBeUndefined();
  });
});

describe("records-confirmation send", () => {
  const ENV: NodeJS.ProcessEnv = {
    ADMINBOT_SLACK_INVITE_URL: "https://join.slack.com/t/example/shared_invite/zt-example",
    ADMINBOT_CONTACT_EMAILS: "ops@example.com",
    ADMINBOT_BOT_EMAIL: "adminbot@example.com",
  };

  function senderWith(overrides: Parameters<typeof createAdminBotOnboardingSender>[0] = {}) {
    const sent: { subject: string; body: string }[] = [];
    const sender = createAdminBotOnboardingSender({
      env: ENV,
      lookupContact: async (email) => findContactByEmail(parseContactSheetRows(MATRIX), email),
      sendEmail: async ({ subject, body }) => {
        sent.push({ subject, body });
      },
      ...overrides,
    });
    return { sender, sent };
  }

  it("fills the record_* tokens from the sheet instead of asking the operator", async () => {
    const { sender, sent } = senderWith();
    const result = await sender({
      template_id: "external_prof_records_check",
      name: "Rex Kramer",
      email: "rex@uni.example",
    });
    expect(result.ok).toBe(true);
    expect(sent[0]?.body).toContain("- Name: Rex Kramer");
    expect(sent[0]?.body).toContain("- Role: Professor, Uni Example");
    expect(sent[0]?.body).toContain("- Preferred email: rex@uni.example");
    expect(sent[0]?.body).toContain("- Collaborating with us on: Alignment");
    expect(sent[0]?.body).not.toMatch(/\{[a-z_]+\}/u);
  });

  // A correction the operator just typed must beat the row that has not been updated yet.
  it("lets a typed value win over the sheet, and ignores blanks", async () => {
    const { sender, sent } = senderWith();
    const result = await sender({
      template_id: "external_prof_records_check",
      name: "Rex Kramer",
      email: "rex@uni.example",
      values: { record_role: "Professor, Somewhere Else", record_projects: "   " },
    });
    expect(result.ok).toBe(true);
    expect(sent[0]?.body).toContain("- Role: Professor, Somewhere Else");
    // The blank did not clobber the sheet's value.
    expect(sent[0]?.body).toContain("- Collaborating with us on: Alignment");
  });

  it("still reports what is missing when the sheet has no row for them", async () => {
    const { sender } = senderWith();
    const result = await sender({
      template_id: "external_prof_records_check",
      name: "Nobody Here",
      email: "nobody@example.edu",
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? [] : result.error.missing).toEqual([
      "record_email",
      "record_name",
      "record_projects",
      "record_role",
    ]);
  });

  // Most onboarding mails name nothing off the sheet; reading it for them would put a Google call
  // on the critical path of every send for nothing.
  it("does not touch the sheet for a template with no record_* token", async () => {
    let reads = 0;
    const { sender } = senderWith({
      lookupContact: async () => {
        reads += 1;
        return undefined;
      },
    });
    const result = await sender({
      template_id: "rejection",
      name: "Ada Lovelace",
      email: "ada@example.edu",
    });
    expect(result.ok).toBe(true);
    expect(reads).toBe(0);
  });
});
