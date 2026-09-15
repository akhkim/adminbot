import { describe, expect, it } from "vitest";
import type { RosterSheetParse } from "../workflows/members/roster-sync.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const sheet = (
  rows: Array<{ row: number; name: string; email?: string; type: string }>,
): RosterSheetParse => ({
  rows: rows.map((r) => ({
    sheet_row: r.row,
    name: r.name,
    emails: r.email ? [r.email] : [],
    member_type: r.type,
  })),
  unidentifiable: [],
});

const stored = (service: AdminBotService, memberId: string) =>
  (
    service as never as { store: { getLabMember: (id: string) => { privilege_level?: string } } }
  ).store.getLabMember(memberId);

const run = (service: AdminBotService, parsed: RosterSheetParse, dryRun = false) =>
  service.sweepOnboardingMail({ sheet: parsed, actor: "cron", dryRun });

describe("the weekly onboarding sheet sweep", () => {
  it("creates the member behind a joining row and reports the mail they are owed", () => {
    const service = new AdminBotService();
    const out = unwrap(
      run(service, sheet([{ row: 84, name: "Grace Hopper", email: "grace@lab.co", type: "full" }])),
    );
    expect(out.created).toEqual(["grace-hopper"]);
    expect(out.mail).toHaveLength(1);
    expect(out.mail[0]).toMatchObject({ email: "grace@lab.co", template_id: "member" });
    // Created, but never privileged: the sheet is not an authorization surface.
    expect(stored(service, "grace-hopper")?.privilege_level).toBe("external_collaborator");
  });

  // A first run has no audit history at all, so the only evidence is the sheet disagreeing with
  // the database -- which is precisely the set the lab wants mailed and nobody else.
  it("on a first run mails only the members whose type mismatches", () => {
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        id: "ada",
        name: "Ada Lovelace",
        email: "ada@lab.co",
        member_type: "coauthor-minor",
      } as never),
    );
    unwrap(
      service.upsertLabMember({
        id: "settled",
        name: "Settled Sam",
        email: "sam@lab.co",
        member_type: "full",
      } as never),
    );
    const out = unwrap(
      run(
        service,
        sheet([
          { row: 3, name: "Ada Lovelace", email: "ada@lab.co", type: "full" },
          { row: 4, name: "Settled Sam", email: "sam@lab.co", type: "full" },
        ]),
      ),
    );
    expect(out.since).toBe("");
    // Sam agrees with the sheet and is left alone; only the mismatch is mailed.
    expect(out.mail.map((row) => row.email)).toEqual(["ada@lab.co"]);
  });

  it("files a T3 send_guide proposal rather than mailing directly", () => {
    const service = new AdminBotService();
    const out = unwrap(
      run(service, sheet([{ row: 84, name: "Grace Hopper", email: "grace@lab.co", type: "full" }])),
    );
    expect(out.proposals).toHaveLength(1);
    const filed = (
      service as never as {
        store: { listProposalsByType: (t: string) => Array<{ proposed_payload: unknown }> };
      }
    ).store.listProposalsByType("onboarding.send_guide");
    // The payload names the template and the recipient and carries no body: the sender composes,
    // so the copy can never drift from the provisioning it promises.
    expect(filed).toHaveLength(1);
    expect(filed[0]?.proposed_payload).toMatchObject({
      template_id: "member",
      email: "grace@lab.co",
    });
  });

  it("does not mail the same person twice on a second run", () => {
    const service = new AdminBotService();
    const rows = sheet([{ row: 84, name: "Grace Hopper", email: "grace@lab.co", type: "full" }]);
    const first = unwrap(run(service, rows));
    expect(first.mail).toHaveLength(1);
    // The member now exists and their type agrees, so the second pass finds nothing.
    const second = unwrap(run(service, rows));
    expect(second.created).toEqual([]);
    expect(second.mail).toEqual([]);
    expect(second.since).not.toBe("");
  });

  // An empty read is what a bad range or a revoked token looks like, and the plan built from it
  // calls every member new.
  it("refuses an empty sheet read rather than treating the lab as 200 joiners", () => {
    const service = new AdminBotService();
    expect(run(service, { rows: [], unidentifiable: [] })).toMatchObject({
      ok: false,
      status: 422,
    });
  });

  it("writes nothing on a dry run", () => {
    const service = new AdminBotService();
    const out = unwrap(
      run(
        service,
        sheet([{ row: 84, name: "Grace Hopper", email: "grace@lab.co", type: "full" }]),
        true,
      ),
    );
    expect(out.mail).toHaveLength(1);
    expect(out.created).toEqual([]);
    expect(out.proposals).toEqual([]);
    expect(stored(service, "grace-hopper")).toBeUndefined();
  });
});
