import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { AdminBotService } from "../kernel/service.js";
import {
  describeMemberSheetReadFailure,
  memberSheetSource,
  parseSheetUrl,
  resolveMemberSheetConfig,
} from "./member-sheet-config.js";
import { defaultMemberSheet } from "./server.js";
import { onboardNewMember, queueNewMemberGuide } from "./server.member-onboarding.js";
import {
  type MemberSheetOnboardRequest,
  type MemberSheetSource,
  onboardFromMemberSheet,
  previewOnboardFromMemberSheet,
  proposeMemberSheetEdits,
  readMemberSheet,
  writeMemberTypeToSheet,
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
  // Row 5: a type whose template still needs a value only a human can give. The alumni and
  // coauthor-minor mails no longer have one -- everything they interpolate is either derived from
  // the row or configured for the deployment -- so the "ask for it, do not guess" path needs a
  // template that genuinely has an outstanding token.
  ["Van Bui", "", "van.bui@example.com", "disappearing-coauthor"],
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
    expect(sheet.read).toHaveBeenCalledWith("Full Slack Member List!A:ZZ");
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
    expect(await proposeMemberSheetEdits(service, source(), { edits: [] }, "andrew")).toMatchObject(
      {
        error: { status: 400 },
      },
    );
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

/** A real service whose executor records what ran, so approvals and pending proposals are real. */
function realService() {
  const executed: AdminBotStoredProposal[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        executed.push(proposal);
        return { handled: true };
      },
    },
  });
  const pending = () => {
    const listed = service.listPending();
    return listed.ok ? listed.payload.proposals : [];
  };
  return { service, executed, pending };
}

const ADMIN = { approver_role: "admin", approver_id: "andrew" };

/** "Onboard selected rows" as the route wires it: enrollment on the admin's click, mail queued. */
function onboardRows(
  service: AdminBotService,
  sheet: MemberSheetSource,
  request: MemberSheetOnboardRequest,
  env: NodeJS.ProcessEnv,
) {
  const deps = { service, approver: ADMIN, actor: "andrew", recordAudit: () => {} };
  return onboardFromMemberSheet(
    service,
    sheet,
    request,
    {
      enroll: (input) =>
        onboardNewMember(deps, input, {
          origin: { source: "admin", actor: "andrew" },
          guide: "none",
          skipSheet: "the row is already on the sheet",
        }),
      queueGuide: (memberId, options) => queueNewMemberGuide(deps, memberId, options),
    },
    env,
  );
}

describe("previewing an onboarding", () => {
  const env = { ADMINBOT_SLACK_INVITE_URL: "https://join.slack.example" } as NodeJS.ProcessEnv;

  // The preview is the mail, not a summary of it: both routes run the same plan over the same
  // sheet, so what the admin read in the panel is what confirming queues.
  it("composes the same mails onboarding would queue, and queues none of them", async () => {
    const { service, pending } = realService();
    const request = { sheet_rows: [2, 3] };
    const preview = await previewOnboardFromMemberSheet(source(), request, env);
    if ("error" in preview) {
      throw new Error(preview.error.message);
    }
    expect(pending()).toHaveLength(0);

    expect(preview.planned).toHaveLength(1);
    const mail = preview.planned[0]!;
    expect(mail).toMatchObject({
      sheet_row: 2,
      name: "Yuen Chen",
      email: "yuenc2@illinois.edu",
      template_id: "alumni",
      reply_to: "akim@cs.toronto.edu",
    });
    expect(mail.body.length).toBeGreaterThan(0);
    // A no-mail type is not skipped: its onboarding is the access its type grants.
    expect(preview.access_only).toMatchObject([{ sheet_row: 3, name: "Rauno Arike" }]);

    const executed = await onboardRows(service, source(), request, env);
    if ("error" in executed) {
      throw new Error(executed.error.message);
    }
    const guide = pending().find((proposal) => proposal.type === "onboarding.send_guide");
    expect(guide?.proposed_payload).toMatchObject({ email: mail.email, template_id: "alumni" });
  });

  it("refuses an empty selection the way executing does", async () => {
    const preview = await previewOnboardFromMemberSheet(source(), { sheet_rows: [] }, env);
    expect(preview).toMatchObject({ error: { status: 400 } });
  });
});

describe("onboarding from the roster", () => {
  const env = { ADMINBOT_SLACK_INVITE_URL: "https://join.slack.example" } as NodeJS.ProcessEnv;

  it("creates the member and queues their guide, the same steps as every other path", async () => {
    const { service, pending } = realService();
    const result = await onboardRows(service, source(), { sheet_rows: [2] }, env);
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.created).toEqual([
      {
        sheet_row: 2,
        email: "yuenc2@illinois.edu",
        template_id: "alumni",
        proposal_id: expect.any(String),
        // Only the standard full-member guide is sent on the admin's click; alumni waits.
        status: "queued",
      },
    ]);
    // An onboarding.send_guide, not a pre-rendered email.send: the send is what provisions the
    // Slack invite and the Drive folder the mail promises.
    expect(pending().map((proposal) => proposal.type)).toEqual(["onboarding.send_guide"]);
    expect(result.enrolled.map((entry) => entry.member_id)).toEqual(["yuen-chen"]);
    const roster = service.listLabMembers();
    const yuen = roster.ok && roster.payload.members.find((member) => member.id === "yuen-chen");
    expect(yuen).toMatchObject({
      privilege_level: "external_collaborator",
      collaborator_subgroup: "alumni",
    });
  });

  it("mails an existing roster member without creating them again", async () => {
    const { service, pending } = realService();
    service.upsertLabMember(
      withCompleteProfile({
        id: "yc",
        name: "Yuen C.",
        email: "yuenc2@illinois.edu",
        member_type: "alumni",
      } as never),
    );
    const result = await onboardRows(service, source(), { sheet_rows: [2] }, env);
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.enrolled).toEqual([]);
    expect(pending()[0]?.proposed_payload).toMatchObject({ member_id: "yc" });

    // A second run finds the guide already waiting and does not queue another copy.
    const again = await onboardRows(service, source(), { sheet_rows: [2] }, env);
    if ("error" in again) {
      throw new Error(again.error.message);
    }
    expect(again.created).toEqual([]);
    expect(again.skipped[0]!.reason).toContain("already queued or sent");
  });

  // Their onboarding is the backend access grant, so they are enrolled rather than skipped.
  it("enrolls a row whose member type sends no mail, and mails nothing", async () => {
    const { service, executed, pending } = realService();
    const result = await onboardRows(service, source(), { sheet_rows: [3] }, env);
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.enrolled.map((entry) => entry.member_id)).toEqual(["rauno-arike"]);
    // The #friends-and-collaborators row, which no guide will mint for them.
    expect(executed.map((proposal) => proposal.type)).toEqual(["slack.connect_invite"]);
    expect(pending()).toEqual([]);
  });

  it("falls back to the Slack address when the correspondence column is empty", async () => {
    const { service } = realService();
    const result = await onboardRows(
      service,
      source(),
      // `what_to_expect_link` rides along because coauthor_minor now requires it: the 2026-08-07
      // template doc added a "Rough Expectation Doc" step, and the send refuses rather than mail a
      // sentence pointing at nothing.
      {
        sheet_rows: [4],
        values: {
          "4": {
            project_or_context: "alg-circuit",
            what_to_expect_link: "https://docs.example/what-to-expect",
          },
        },
      },
      env,
    );
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.created[0]).toMatchObject({ email: "korinna@cmu.edu" });
  });

  // Half-rendering the mail around a value only a human can give would mail a literal placeholder,
  // so the row is skipped whole -- nobody is created -- and the token is named for the tab to ask.
  it("skips a row missing a send-time value and names the token to collect", async () => {
    const { service, pending } = realService();
    const result = await onboardRows(service, source(), { sheet_rows: [5] }, env);
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.created).toEqual([]);
    expect(result.enrolled).toEqual([]);
    expect(result.skipped[0]!.missing).toContain("project_or_context");
    expect(pending()).toHaveLength(0);
  });

  it("names a selected row the sheet does not have rather than silently dropping it", async () => {
    const { service } = realService();
    const result = await onboardRows(service, source(), { sheet_rows: [999] }, env);
    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.skipped).toEqual([{ sheet_row: 999, reason: "no such row in the sheet" }]);
  });

  it("refuses a sheet with no Member Type column rather than guessing a template", async () => {
    const { service } = realService();
    const result = await onboardRows(
      service,
      source([["Name"], ["Yuen Chen"]]),
      { sheet_rows: [2] },
      env,
    );
    expect(result).toMatchObject({ error: { status: 422 } });
  });

  it("rejects an empty selection", async () => {
    const { service } = realService();
    expect(await onboardRows(service, source(), { sheet_rows: [] }, env)).toMatchObject({
      error: { status: 400 },
    });
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
    expect(
      resolveMemberSheetConfig({ ADMINBOT_MEMBER_SHEET_RANGE: "'Full Slack Member List'!A:Z" }).tab,
    ).toBe("Full Slack Member List");
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
    expect(
      parseSheetUrl("https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing&gid=42"),
    ).toEqual({ spreadsheetId: "abc123", gid: 42 });
    expect(parseSheetUrl("not a url at all")).toEqual({});
  });

  it("does not carry the lab's gid onto somebody else's spreadsheet", () => {
    // A gid identifies a tab within one file; against another file it would silently name whatever
    // tab happened to be created in the same order.
    expect(
      resolveMemberSheetConfig({ ADMINBOT_MEMBER_SHEET_ID: "other-sheet" }).gid,
    ).toBeUndefined();
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
    expect(readRows).toHaveBeenCalledWith("sheet-1", "Full Slack Member List!A:ZZ");
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
    expect(readRows).toHaveBeenCalledWith("sheet-1", "Full Slack Member List!A:ZZ");
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
      new Error("gog command failed (exit 1): Unable to parse range: Full Slack Member List!A:ZZ"),
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

describe("member type sheet permissions", () => {
  it("reports protected cells as an owner action without claiming the sheet was updated", async () => {
    const service = new AdminBotService(undefined, {
      executor: {
        execute: async () => {
          throw new Error("You are trying to edit a protected cell or object.");
        },
      },
    });
    const result = await writeMemberTypeToSheet(
      service,
      source(),
      {
        id: "yuen",
        name: "Yuen Chen",
        email: "yuenc2@illinois.edu",
        member_type: "full",
        privilege_level: "member",
        access: [],
        status: "active",
        created_at: "2026-09-30",
        updated_at: "2026-09-30",
      },
      ADMIN,
      "andrew",
    );
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toContain("Ask the spreadsheet owner");
    expect(result.status === "failed" && result.reason).toContain("sheet was not updated");
  });
});
