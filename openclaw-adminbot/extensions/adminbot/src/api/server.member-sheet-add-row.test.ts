// Add row: one admin click appends the roster row, creates the member and sends their guide, each
// through the approval gate with the clicking admin as approver.
import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { AdminBotService } from "../kernel/service.js";
import { addMemberSheetRow, type MemberSheetSource } from "./server.member-sheet.js";

const HEADER = [
  "Name",
  "Member Type",
  "Member Attributes",
  "Email for correspondence (the more professional the better)",
  "Slack email",
  "tldr",
];

const ADMIN = { approver_role: "admin", approver_id: "andrew-kim" };

function source(rows: string[][] = [HEADER]): MemberSheetSource {
  return { spreadsheetId: "sheet-1", tab: "Full Slack Member List", read: vi.fn(async () => rows) };
}

function harness(fail: Partial<Record<string, string>> = {}) {
  const executed: AdminBotStoredProposal[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        const reason = fail[proposal.type];
        if (reason) {
          throw new Error(reason);
        }
        executed.push(proposal);
        return { handled: true };
      },
    },
  });
  return { service, executed };
}

const ADA = {
  name: "Ada Lovelace",
  member_type: "full",
  email: "ada@cs.toronto.edu",
  slack_email: "ada@gmail.com",
  member_attributes: "PhD",
};

describe("addMemberSheetRow", () => {
  it("appends the row, creates the member and sends the guide, all approved by the admin", async () => {
    const { service, executed } = harness();
    const result = await addMemberSheetRow(service, source(), ADA, ADMIN, "andrew-kim");

    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.member_id).toBe("ada-lovelace");
    expect(result.sheet.status).toBe("done");
    expect(result.member.status).toBe("done");
    expect(result.onboarding).toMatchObject({ status: "done", template_id: "member" });

    expect(executed.map((proposal) => proposal.type)).toEqual([
      "sheet.append_rows",
      "onboarding.send_guide",
    ]);
    // The row is written in the sheet's own column order, quoted tab, trailing blanks dropped.
    expect(executed[0]?.proposed_payload).toEqual({
      spreadsheet_id: "sheet-1",
      range: "'Full Slack Member List'!A:ZZ",
      rows: [["Ada Lovelace", "full", "PhD", "ada@cs.toronto.edu", "ada@gmail.com"]],
    });
    expect(executed[1]?.proposed_payload).toMatchObject({
      email: "ada@cs.toronto.edu",
      member_id: "ada-lovelace",
    });
    // Nothing is left waiting in Pending Actions.
    const pending = service.listPending();
    expect(pending.ok && pending.payload.proposals).toEqual([]);
    const members = service.listLabMembers();
    expect(members.ok && members.payload.members.map((member) => member.id)).toContain(
      "ada-lovelace",
    );
  });

  // The roster tab can be protected against the bot. The person should not wait on that.
  it("still creates the member and sends the guide when the sheet write fails", async () => {
    const { service, executed } = harness({
      "sheet.append_rows": "You are trying to edit a protected cell or object.",
    });
    const result = await addMemberSheetRow(service, source(), ADA, ADMIN, "andrew-kim");

    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.sheet).toMatchObject({ status: "failed" });
    expect(result.sheet.status === "failed" && result.sheet.reason).toContain("protected");
    expect(result.member.status).toBe("done");
    expect(result.onboarding.status).toBe("done");
    expect(executed.map((proposal) => proposal.type)).toEqual(["onboarding.send_guide"]);
  });

  it("skips the mail for a Member Type whose onboarding is access alone", async () => {
    const { service, executed } = harness();
    const result = await addMemberSheetRow(
      service,
      source(),
      { ...ADA, member_type: "acquaintance" },
      ADMIN,
      "andrew-kim",
    );

    if ("error" in result) {
      throw new Error(result.error.message);
    }
    expect(result.member.status).toBe("done");
    expect(result.onboarding.status).toBe("skipped");
    expect(executed.map((proposal) => proposal.type)).toEqual(["sheet.append_rows"]);
  });

  it("refuses somebody already on the sheet, and writes nothing", async () => {
    const { service, executed } = harness();
    const result = await addMemberSheetRow(
      service,
      source([HEADER, ["Ada L.", "full", "", "", "ADA@gmail.com"]]),
      ADA,
      ADMIN,
      "andrew-kim",
    );

    expect("error" in result && result.error.status).toBe(409);
    expect(executed).toEqual([]);
  });

  it("refuses somebody already on the roster", async () => {
    const { service, executed } = harness();
    const created = service.upsertLabMember({
      id: "ada-l",
      name: "Ada L.",
      email: "ada@cs.toronto.edu",
    } as never);
    expect(created.ok).toBe(true);

    const result = await addMemberSheetRow(service, source(), ADA, ADMIN, "andrew-kim");
    expect("error" in result && result.error.status).toBe(409);
    expect(executed).toEqual([]);
  });

  it.each([
    [{ ...ADA, name: " " }, "name"],
    [{ ...ADA, member_type: "" }, "member_type"],
    [{ ...ADA, email: "not-an-address" }, "email"],
    [{ ...ADA, slack_email: "nope" }, "slack_email"],
  ])("rejects a malformed request (%#)", async (request, field) => {
    const { service, executed } = harness();
    const result = await addMemberSheetRow(service, source(), request, ADMIN, "andrew-kim");
    expect("error" in result && result.error.status).toBe(400);
    expect("error" in result && result.error.message).toContain(field);
    expect(executed).toEqual([]);
  });

  it("422s a sheet with no Member Type column", async () => {
    const { service } = harness();
    const result = await addMemberSheetRow(
      service,
      source([["Name", "Slack email"]]),
      ADA,
      ADMIN,
      "andrew-kim",
    );
    expect("error" in result && result.error.status).toBe(422);
  });
});
