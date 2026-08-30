import { describe, expect, it, vi } from "vitest";
import type { AdminBotService } from "../kernel/service.js";
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
