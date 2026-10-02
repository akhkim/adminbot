import { describe, expect, it } from "vitest";
import { parseRosterSheet } from "../workflows/members/roster-sync.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const HEADER = ["Name", "AdminBot ID", "Slack email", "Member Type"];

function sheet(rows: [string, string, string, string][]) {
  return parseRosterSheet(
    HEADER,
    rows.map((cells, index) => ({ sheetRow: index + 2, cells })),
  );
}

function lab() {
  const service = new AdminBotService();
  unwrap(
    service.upsertLabMember({
      id: "mei",
      name: "Mei Chen",
      email: "mei@cs.toronto.edu",
      privilege_level: "member",
      member_type: "full",
      slack_user_id: "U_MEI",
    }),
  );
  return service;
}

describe("AdminBotService.syncMemberRoster", () => {
  it("writes the sheet's Member Type onto the member", () => {
    const service = lab();

    const result = unwrap(
      service.syncMemberRoster({
        sheet: sheet([["Mei Chen", "mei", "mei@cs.toronto.edu", "alumni"]]),
        actor: "admin-1",
      }),
    );

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ member_id: "mei", from: "full", to: "alumni" });
    const stored = unwrap(service.listLabMembers()).members.find((entry) => entry.id === "mei");
    expect(stored?.member_type).toBe("alumni");
  });

  // The sheet knows one column of thirty. A patch, not a replace.
  it("leaves every other field on the record alone", () => {
    const service = lab();

    unwrap(
      service.syncMemberRoster({
        sheet: sheet([["Mei Chen", "mei", "mei@cs.toronto.edu", "alumni"]]),
        actor: "admin-1",
      }),
    );

    const stored = unwrap(service.listLabMembers()).members.find((entry) => entry.id === "mei");
    expect(stored).toMatchObject({
      name: "Mei Chen",
      email: "mei@cs.toronto.edu",
      slack_user_id: "U_MEI",
      privilege_level: "member",
    });
  });

  it("reports what the change costs them, without filing the calendar removal itself", () => {
    const service = lab();

    const result = unwrap(
      service.syncMemberRoster({
        sheet: sheet([["Mei Chen", "mei", "mei@cs.toronto.edu", "alumni"]]),
        actor: "admin-1",
      }),
    );

    expect(result.applied[0]?.access).toMatchObject({
      lab_calendar: "lost",
      group_meeting: "lost",
      consequential: true,
    });
    // adminbot-meeting-membership reconciles both invites against the roster every morning; filing
    // a calendar removal here as well would propose dropping one person from one meeting twice.
    expect(result.proposals.every((entry) => entry.channel !== "")).toBe(true);
    const pending = unwrap(service.listPending()).proposals;
    expect(pending.some((entry) => entry.type === "calendar.remove_attendees")).toBe(false);
  });

  it("proposes the Slack removals a revoked matrix row implies, and executes none of them", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "kim",
        name: "Kim Park",
        email: "kim@example.com",
        privilege_level: "external_collaborator",
        // No `collaborator_subgroup`: the matrix row is read off the member type, which is the
        // shape of every row on the live roster and the case this sync exists for.
        member_type: "coauthor-major",
        slack_user_id: "U_KIM",
      }),
    );

    const result = unwrap(
      service.syncMemberRoster({
        sheet: sheet([["Kim Park", "kim", "kim@example.com", "acquaintance"]]),
        actor: "admin-1",
      }),
    );

    expect(result.proposals.length).toBeGreaterThan(0);
    const pending = unwrap(service.listPending()).proposals;
    const removals = pending.filter((entry) => entry.type === "slack.remove_from_channel");
    expect(removals.length).toBe(result.proposals.length);
    // Proposed, never executed: losing a conversation you were part of is not a cron job's call.
    expect(removals.every((entry) => entry.status !== "executed")).toBe(true);
  });

  // An admin who set `collaborator_subgroup` outranks the spreadsheet, so the matrix rows stay put.
  // That is the right precedence, and reporting it as "no consequences" would read as "nothing to
  // do" when the truth is that the answer came from somewhere else.
  it("flags a member whose record pins the subgroup instead of silently doing nothing", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "pin",
        name: "Pinned Person",
        email: "pin@example.com",
        privilege_level: "external_collaborator",
        collaborator_subgroup: "coauthor_major",
        member_type: "coauthor-major",
        slack_user_id: "U_PIN",
      }),
    );

    const result = unwrap(
      service.syncMemberRoster({
        sheet: sheet([["Pinned Person", "pin", "pin@example.com", "acquaintance"]]),
        actor: "admin-1",
      }),
    );

    expect(result.applied[0]?.access).toMatchObject({ subgroup_pinned: true, revoked: [] });
    expect(result.proposals).toHaveLength(0);
  });

  it("files no Slack proposal for a member with no linked account", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "nos",
        name: "No Slack",
        email: "nos@example.com",
        privilege_level: "external_collaborator",
        member_type: "coauthor-major",
      }),
    );

    const result = unwrap(
      service.syncMemberRoster({
        sheet: sheet([["No Slack", "nos", "nos@example.com", "acquaintance"]]),
        actor: "admin-1",
      }),
    );

    expect(result.applied).toHaveLength(1);
    expect(result.proposals).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it("changes nothing on a dry run but still reports the whole diff", () => {
    const service = lab();

    const result = unwrap(
      service.syncMemberRoster({
        sheet: sheet([["Mei Chen", "mei", "mei@cs.toronto.edu", "alumni"]]),
        actor: "admin-1",
        dryRun: true,
      }),
    );

    expect(result.dry_run).toBe(true);
    expect(result.member_type_changes).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
    const stored = unwrap(service.listLabMembers()).members.find((entry) => entry.id === "mei");
    expect(stored?.member_type).toBe("full");
  });

  // Every upstream failure -- a bad range, a renamed tab, a revoked token -- arrives as a sheet
  // with no rows, and the plan built from it says every member has left.
  it("refuses an empty read outright", () => {
    const service = lab();

    const result = service.syncMemberRoster({ sheet: sheet([]), actor: "admin-1" });

    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("stops a pass that would rewrite most of the roster, and applies nothing", () => {
    const service = new AdminBotService();
    for (let index = 0; index < 20; index += 1) {
      unwrap(
        service.upsertLabMember({
          id: `m${index}`,
          name: `Member ${index}`,
          email: `m${index}@example.com`,
          privilege_level: "member",
          member_type: "full",
        }),
      );
    }

    const rows = Array.from(
      { length: 20 },
      (_, index) =>
        [`Member ${index}`, `m${index}`, `m${index}@example.com`, "alumni"] as [
          string,
          string,
          string,
          string,
        ],
    );
    const result = unwrap(service.syncMemberRoster({ sheet: sheet(rows), actor: "admin-1" }));

    expect(result.refused).toMatch(/refusing to apply 20/u);
    expect(result.applied).toHaveLength(0);
    const stored = unwrap(service.listLabMembers()).members;
    expect(stored.every((entry) => entry.member_type === "full")).toBe(true);

    // Same sheet, forced: an admin who has looked at it gets the pass through.
    const forced = unwrap(
      service.syncMemberRoster({ sheet: sheet(rows), actor: "admin-1", force: true }),
    );
    expect(forced.refused).toBeUndefined();
    expect(forced.applied).toHaveLength(20);
  });

  // Creating a member is an access grant, which is exactly what a sync must never make on its own.
  it("reports a sheet row matching nobody without creating anybody", () => {
    const service = lab();

    const result = unwrap(
      service.syncMemberRoster({
        sheet: sheet([
          ["Mei Chen", "mei", "mei@cs.toronto.edu", "full"],
          ["New Person", "", "new@example.com", "coauthor-minor"],
        ]),
        actor: "admin-1",
      }),
    );

    expect(result.additions).toEqual([
      { sheet_row: 3, name: "New Person", email: "new@example.com", member_type: "coauthor-minor" },
    ]);
    expect(unwrap(service.listLabMembers()).members).toHaveLength(1);
  });

  // A member with no sheet row is far more often an address the sheet spells differently than a
  // departure, and removing their access on that guess is not recoverable by them.
  it("reports a member matching no sheet row without touching their record", () => {
    const service = lab();
    unwrap(
      service.upsertLabMember({
        id: "ghost",
        name: "Not On Sheet",
        email: "ghost@example.com",
        privilege_level: "member",
        member_type: "full",
      }),
    );

    const result = unwrap(
      service.syncMemberRoster({
        sheet: sheet([["Mei Chen", "mei", "mei@cs.toronto.edu", "full"]]),
        actor: "admin-1",
      }),
    );

    expect(result.absent).toEqual([
      { member_id: "ghost", member_name: "Not On Sheet", member_type: "full" },
    ]);
    const stored = unwrap(service.listLabMembers()).members.find((entry) => entry.id === "ghost");
    expect(stored?.member_type).toBe("full");
  });

  it("leaves an audit row naming what the change cost", () => {
    const service = lab();

    unwrap(
      service.syncMemberRoster({
        sheet: sheet([["Mei Chen", "mei", "mei@cs.toronto.edu", "alumni"]]),
        actor: "admin-1",
      }),
    );

    const entries = service.listAuditEvents();
    const changed = entries.find((entry) => entry.type === "roster_sync.member_type_changed");
    expect(changed?.details).toMatchObject({
      member_id: "mei",
      from: "full",
      to: "alumni",
      lab_calendar: "lost",
    });
    expect(entries.some((entry) => entry.type === "roster_sync.completed")).toBe(true);
  });
});
