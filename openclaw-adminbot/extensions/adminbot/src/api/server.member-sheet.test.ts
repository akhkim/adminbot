import { describe, expect, it, vi } from "vitest";
import type { AdminBotService } from "../kernel/service.js";
import {
  describeMemberSheetReadFailure,
  memberSheetSource,
  parseSheetUrl,
  resolveMemberSheetConfig,
} from "./member-sheet-config.js";
import { defaultMemberSheet } from "./server.js";
import {
  type MemberSheetSource,
  onboardFromMemberSheet,
  proposeMemberSheetEdits,
  readMemberSheet,
} from "./server.member-sheet.js";

const HEADER = [
  "Name",
  "Email for correspondence (the more professional the better)",
  "Slack email",
  "Member Type",
  "tldr",
];

const ROWS = [
  HEADER,
  ["Yuen Chen", "yuenc2@illinois.edu", "yuenc2@cs.toronto.edu", "alumni", ""],
  ["Rauno Arike", "", "rauno.arike@gmail.com", "coauthor-discussant-or-designer", ""],
  ["Korinna Fragkia", "", "korinna@cmu.edu", "coauthor-minor"],
];

function source(rows: string[][] = ROWS): MemberSheetSource & { read: ReturnType<typeof vi.fn> } {
  return {
    spreadsheetId: "1ZqdaRze",
    tab: "Full Slack Member List",
    read: vi.fn(async () => rows),
  };
}

/** Just enough service to record what the routes propose. */
function fakeService() {
  const proposals: { type: string; summary: string; payload: unknown }[] = [];
  const service = {
    createProposal(proposal: { type: string; summary: string; proposed_payload?: unknown }) {
      proposals.push({
        type: proposal.type,
        summary: proposal.summary,
        payload: proposal.proposed_payload,
      });
      return {
        ok: true as const,
        status: 200,
        payload: { id: `act_${proposals.length}`, status: "pending" },
      };
    },
  } as unknown as AdminBotService;
  return { service, proposals };
}

describe("reading the roster", () => {
  it("returns the tab with each row's true sheet number and a link to the sheet", async () => {
    const view = await readMemberSheet(source());
    expect(view.header).toEqual(HEADER);
    expect(view.rows[0]).toEqual({
      sheet_row: 2,
      cells: ["Yuen Chen", "yuenc2@illinois.edu", "yuenc2@cs.toronto.edu", "alumni", ""],
    });
    // The third fixture row is short; it must arrive padded or an edit to `tldr` writes elsewhere.
    expect(view.rows[2]!.cells).toHaveLength(HEADER.length);
    expect(view.url).toContain("1ZqdaRze");
  });

  it("asks for the configured tab by name", async () => {
    const sheet = source();
    await readMemberSheet(sheet);
    expect(sheet.read).toHaveBeenCalledWith("Full Slack Member List!A:Z");
  });
});

describe("editing the roster", () => {
  it("proposes one approval-gated write carrying what it overwrites", async () => {
    const { service, proposals } = fakeService();
    const result = await proposeMemberSheetEdits(
      service,
      source(),
      { edits: [{ sheet_row: 4, column: 4, value: "works on alg-circuit" }] },
      "andrew",
    );
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    expect(result.conflicts).toEqual([]);
    expect(proposals[0]!.type).toBe("sheet.update_cells");
    expect(proposals[0]!.payload).toMatchObject({
      spreadsheet_id: "1ZqdaRze",
      updates: [{ range: "'Full Slack Member List'!E4", values: [["works on alg-circuit"]] }],
      before: [{ range: "'Full Slack Member List'!E4", values: [[""]] }],
    });
  });

  // The tab may have been open for an hour. Re-reading is the point: an edit typed against a
  // stale cell would revert whoever changed it in between.
  it("refuses an edit whose cell changed since the grid was drawn, and proposes nothing", async () => {
    const { service, proposals } = fakeService();
    const result = await proposeMemberSheetEdits(
      service,
      source(),
      {
        edits: [{ sheet_row: 2, column: 3, value: "full" }],
        expected: { "2:3": "coauthor-major" },
      },
      "andrew",
    );
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.conflicts).toEqual([
      {
        sheet_row: 2,
        column: 3,
        header: "Member Type",
        expected: "coauthor-major",
        actual: "alumni",
      },
    ]);
    expect(proposals).toHaveLength(0);
  });

  it("says when an edit touches a column that decides access", async () => {
    const { service, proposals } = fakeService();
    const result = await proposeMemberSheetEdits(
      service,
      source(),
      { edits: [{ sheet_row: 2, column: 3, value: "full" }] },
      "andrew",
    );
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.touches_access).toBe(true);
    expect(proposals[0]!.summary).toContain("access column");
  });

  it("reports a no-op edit rather than proposing an empty write", async () => {
    const { service, proposals } = fakeService();
    const result = await proposeMemberSheetEdits(
      service,
      source(),
      { edits: [{ sheet_row: 2, column: 3, value: "alumni" }] },
      "andrew",
    );
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.unchanged).toBe(1);
    expect(result.updates).toEqual([]);
    expect(proposals).toHaveLength(0);
  });

  it("rejects an empty edit set and a row the sheet does not have", async () => {
    const { service } = fakeService();
    expect(await proposeMemberSheetEdits(service, source(), { edits: [] }, "andrew")).toMatchObject({
      error: { status: 400 },
    });
    expect(
      await proposeMemberSheetEdits(
        service,
        source(),
        { edits: [{ sheet_row: 99, column: 1, value: "x" }] },
        "andrew",
      ),
    ).toMatchObject({ error: { status: 400 } });
  });
});

describe("onboarding from the roster", () => {
  const env = { ADMINBOT_SLACK_INVITE_URL: "https://join.slack.example" } as NodeJS.ProcessEnv;

  it("queues one email proposal per selected row, addressed and templated from the sheet", async () => {
    const { service, proposals } = fakeService();
    const result = await onboardFromMemberSheet(
      service,
      source(),
      { sheet_rows: [2], values: { "2": { slack_connect_link: "https://slack.example/x" } } },
      "andrew",
      env,
    );
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.created).toEqual([
      {
        sheet_row: 2,
        email: "yuenc2@illinois.edu",
        template_id: "alumni",
        proposal_id: "act_1",
      },
    ]);
    expect(proposals[0]!.type).toBe("email.send");
    expect(proposals[0]!.payload).toMatchObject({
      to: "yuenc2@illinois.edu",
      reply_to: "akim@cs.toronto.edu",
    });
  });

  // The whole reason these three types exist: their onboarding is the backend access grant.
  it("skips a row whose member type sends no mail, and says why", async () => {
    const { service, proposals } = fakeService();
    const result = await onboardFromMemberSheet(
      service,
      source(),
      { sheet_rows: [3] },
      "andrew",
      env,
    );
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("sends no onboarding mail");
    expect(proposals).toHaveLength(0);
  });

  it("falls back to the Slack address when the correspondence column is empty", async () => {
    const { service } = fakeService();
    const result = await onboardFromMemberSheet(
      service,
      source(),
      { sheet_rows: [4], values: { "4": { project_or_context: "alg-circuit" } } },
      "andrew",
      env,
    );
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.created[0]).toMatchObject({ email: "korinna@cmu.edu" });
  });

  // The alumni mail needs a Slack Connect invite, which is provisioned at send time and is not on
  // the roster. Half-rendering it around the gap would mail a literal placeholder.
  it("skips a row missing a send-time value and names the token to collect", async () => {
    const { service, proposals } = fakeService();
    const result = await onboardFromMemberSheet(
      service,
      source(),
      { sheet_rows: [2] },
      "andrew",
      env,
    );
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.missing).toContain("slack_connect_link");
    expect(proposals).toHaveLength(0);
  });

  it("names a selected row the sheet does not have rather than silently dropping it", async () => {
    const { service } = fakeService();
    const result = await onboardFromMemberSheet(
      service,
      source(),
      { sheet_rows: [999] },
      "andrew",
      env,
    );
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.skipped).toEqual([{ sheet_row: 999, reason: "no such row in the sheet" }]);
  });

  it("refuses a sheet with no Member Type column rather than guessing a template", async () => {
    const { service } = fakeService();
    const result = await onboardFromMemberSheet(
      service,
      source([["Name"], ["Yuen Chen"]]),
      { sheet_rows: [2] },
      "andrew",
      env,
    );
    expect(result).toMatchObject({ error: { status: 422 } });
  });

  it("rejects an empty selection", async () => {
    const { service } = fakeService();
    expect(
      await onboardFromMemberSheet(service, source(), { sheet_rows: [] }, "andrew", env),
    ).toMatchObject({ error: { status: 400 } });
  });
});

describe("defaultMemberSheet", () => {
  // The tab answered 503 in production for months because nothing set this variable, and a 503 on
  // the read path is indistinguishable, from the grid, from a sheet with no rows.
  it("resolves the lab's own roster with nothing configured", () => {
    const source = defaultMemberSheet({});
    expect(source.spreadsheetId).toBe("1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68");
    expect(source.tab).toBe("Full Slack Member List");
  });

  it("takes the tab from the poller's range, which deployments already set", () => {
    expect(resolveMemberSheetConfig({ ADMINBOT_MEMBER_SHEET_RANGE: "'Full Slack Member List'!A:Z" }).tab)
      .toBe("Full Slack Member List");
    expect(resolveMemberSheetConfig({ ADMINBOT_MEMBER_SHEET_RANGE: "Members!A:Z" }).tab).toBe(
      "Members",
    );
    // A bare range names no tab, so it must not be mistaken for one.
    expect(resolveMemberSheetConfig({ ADMINBOT_MEMBER_SHEET_RANGE: "A:Z" }).tab).toBe(
      "Full Slack Member List",
    );
  });

  it("lets the environment point at another sheet entirely", () => {
    const source = defaultMemberSheet({
      ADMINBOT_MEMBER_SHEET_ID: "other-sheet",
      ADMINBOT_MEMBER_SHEET_TAB: "Roster copy",
      ADMINBOT_MEMBER_SHEET_RANGE: "Ignored!A:Z",
    });
    expect(source.spreadsheetId).toBe("other-sheet");
    expect(source.tab).toBe("Roster copy");
  });
});

describe("resolveMemberSheetConfig", () => {
  it("defaults to the gid of the lab's roster tab, not just its title", () => {
    expect(resolveMemberSheetConfig({})).toEqual({
      spreadsheetId: "1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68",
      tab: "Full Slack Member List",
      gid: 764749323,
    });
  });

  it("reads the spreadsheet and the tab out of a pasted URL", () => {
    const config = resolveMemberSheetConfig({
      ADMINBOT_MEMBER_SHEET_URL:
        "https://docs.google.com/spreadsheets/d/1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68/edit?gid=764749323#gid=764749323",
    });
    expect(config).toEqual({
      spreadsheetId: "1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68",
      tab: "Full Slack Member List",
      gid: 764749323,
    });
  });

  it("takes the gid out of a share-dialog URL, which carries it in the query", () => {
    expect(parseSheetUrl("https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing&gid=42")).toEqual(
      { spreadsheetId: "abc123", gid: 42 },
    );
    expect(parseSheetUrl("not a url at all")).toEqual({});
  });

  it("does not carry the lab's gid onto somebody else's spreadsheet", () => {
    // A gid identifies a tab within one file; against another file it would silently name whatever
    // tab happened to be created in the same order.
    expect(resolveMemberSheetConfig({ ADMINBOT_MEMBER_SHEET_ID: "other-sheet" }).gid).toBeUndefined();
  });

  it("lets an explicitly named tab win over the default gid, but not over a configured one", () => {
    expect(resolveMemberSheetConfig({ ADMINBOT_MEMBER_SHEET_TAB: "Roster copy" })).toEqual({
      spreadsheetId: "1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68",
      tab: "Roster copy",
    });
    expect(
      resolveMemberSheetConfig({
        ADMINBOT_MEMBER_SHEET_TAB: "Roster copy",
        ADMINBOT_MEMBER_SHEET_GID: "99",
      }),
    ).toEqual({
      spreadsheetId: "1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68",
      tab: "Roster copy",
      gid: 99,
    });
  });
});

describe("resolving a gid to the tab it names", () => {
  it("reads the tab Google currently calls that gid, and links to it", async () => {
    const readRows = vi.fn(async () => ROWS);
    const source = memberSheetSource(
      { spreadsheetId: "sheet-1", tab: "Stale Name", gid: 764749323 },
      {
        readRows,
        readTabs: async () => [
          { title: "Papers", gid: 513582220 },
          { title: "Full Slack Member List", gid: 764749323 },
        ],
      },
    );
    const view = await readMemberSheet(source);
    expect(readRows).toHaveBeenCalledWith("sheet-1", "Full Slack Member List!A:Z");
    expect(view.tab).toBe("Full Slack Member List");
    expect(view.url).toBe("https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=764749323");
  });

  it("writes edits back to the resolved tab, not the configured one", async () => {
    const { service, proposals } = fakeService();
    const source = memberSheetSource(
      { spreadsheetId: "sheet-1", tab: "Stale Name", gid: 7 },
      { readRows: async () => ROWS, readTabs: async () => [{ title: "Members", gid: 7 }] },
    );
    const result = await proposeMemberSheetEdits(
      service,
      source,
      { edits: [{ sheet_row: 2, column: 4, value: "causal inference" }] },
      "andrew",
    );
    expect(result).not.toHaveProperty("error");
    expect(JSON.stringify(proposals[0]?.payload)).toContain("Members!");
  });

  it("falls back to the configured tab when the metadata call fails", async () => {
    // A metadata outage must not take the roster down: the configured title is right far more
    // often than not, and a wrong one produces a much better error from the read itself.
    const readRows = vi.fn(async () => ROWS);
    const source = memberSheetSource(
      { spreadsheetId: "sheet-1", tab: "Full Slack Member List", gid: 764749323 },
      {
        readRows,
        readTabs: async () => {
          throw new Error("gog command failed (exit 1)");
        },
      },
    );
    const view = await readMemberSheet(source);
    expect(readRows).toHaveBeenCalledWith("sheet-1", "Full Slack Member List!A:Z");
    expect(view.tab).toBe("Full Slack Member List");
  });

  it("asks for no metadata at all when no gid is configured", async () => {
    const readTabs = vi.fn(async () => []);
    const source = memberSheetSource(
      { spreadsheetId: "sheet-1", tab: "Members" },
      { readRows: async () => ROWS, readTabs },
    );
    const view = await readMemberSheet(source);
    expect(readTabs).not.toHaveBeenCalled();
    expect(view.url).toBe("https://docs.google.com/spreadsheets/d/sheet-1/edit");
  });
});

describe("describeMemberSheetReadFailure", () => {
  const target = { spreadsheetId: "sheet-1", tab: "Full Slack Member List" };

  it("names the tab, and the variable that repoints it, when the range does not exist", () => {
    const message = describeMemberSheetReadFailure(
      new Error("gog command failed (exit 1): Unable to parse range: Full Slack Member List!A:Z"),
      target,
    );
    expect(message).toContain('no tab named "Full Slack Member List"');
    expect(message).toContain("ADMINBOT_MEMBER_SHEET_GID");
  });

  it("says the sheet is not shared rather than that it is missing", () => {
    expect(
      describeMemberSheetReadFailure(
        new Error("gog command failed (exit 1): The caller does not have permission"),
        target,
      ),
    ).toContain("share the sheet with it");
  });

  it("points at re-authentication when the Google token is gone", () => {
    expect(
      describeMemberSheetReadFailure(
        new Error('oauth2: "invalid_grant" "Token has been expired or revoked."'),
        target,
      ),
    ).toContain("gog auth add");
  });

  it("still carries anything it cannot classify", () => {
    expect(describeMemberSheetReadFailure(new Error("socket hang up"), target)).toBe(
      "could not read the member sheet: socket hang up",
    );
  });
});
