import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import type { RosterSyncPlan } from "../members/roster-sync.js";
import { memberIdForRow, planOnboardingSweep } from "./onboarding-sweep.js";

const EMPTY: RosterSyncPlan = {
  member_type_changes: [],
  additions: [],
  absent: [],
  unidentifiable: [],
  unchanged: 0,
  duplicates: [],
};

const ROSTER: Record<string, AdminBotLabMember> = {
  ada: { id: "ada", name: "Ada Lovelace", email: "ada@lab.co" } as AdminBotLabMember,
  noaddr: { id: "noaddr", name: "No Address" } as AdminBotLabMember,
};

function sweep(over: Partial<Parameters<typeof planOnboardingSweep>[0]> = {}) {
  return planOnboardingSweep({
    plan: EMPTY,
    appliedChanges: [],
    memberById: (id) => ROSTER[id],
    alreadyMailed: new Set(),
    knownMemberIds: new Set(Object.keys(ROSTER)),
    ...over,
  });
}

describe("who the weekly onboarding sweep mails", () => {
  it("creates and mails a joining sheet row", () => {
    const out = sweep({
      plan: {
        ...EMPTY,
        additions: [
          { sheet_row: 84, name: "Grace Hopper", email: "Grace@lab.co", member_type: "full" },
        ],
      },
    });
    expect(out.create).toEqual([
      {
        sheet_row: 84,
        name: "Grace Hopper",
        email: "grace@lab.co",
        member_type: "full",
        member_id: "grace-hopper",
      },
    ]);
    expect(out.mail).toHaveLength(1);
    expect(out.mail[0]).toMatchObject({ member_id: "grace-hopper", template_id: "member" });
  });

  // The nightly sync at 06:10 writes the sheet's type onto the record, so a weekly job that only
  // looked for live mismatches would find the change already absorbed. The audit row it wrote is
  // the surviving evidence.
  it("mails a change the nightly sync has already applied", () => {
    const out = sweep({ appliedChanges: [{ member_id: "ada", to: "full" }] });
    expect(out.mail.map((m) => m.member_id)).toEqual(["ada"]);
    expect(out.mail[0]?.template_id).toBe("member");
  });

  // ...and the first run, before any audit history exists, is exactly the live-mismatch case.
  it("mails a live mismatch, which is what a first run sees", () => {
    const out = sweep({
      plan: {
        ...EMPTY,
        member_type_changes: [
          {
            member_id: "ada",
            member_name: "Ada Lovelace",
            sheet_row: 3,
            from: "coauthor-minor",
            to: "full",
          },
        ],
      },
    });
    expect(out.mail.map((m) => m.member_id)).toEqual(["ada"]);
    expect(out.mail[0]?.reason).toContain("coauthor-minor");
  });

  // The union reports the same person twice by design -- live this week, from the audit next week.
  it("mails once when a change shows up both live and in the audit", () => {
    const out = sweep({
      plan: {
        ...EMPTY,
        member_type_changes: [
          {
            member_id: "ada",
            member_name: "Ada Lovelace",
            sheet_row: 3,
            from: "coauthor-minor",
            to: "full",
          },
        ],
      },
      appliedChanges: [{ member_id: "ada", to: "full" }],
    });
    expect(out.mail).toHaveLength(1);
  });

  // The ledger is keyed on the address, which is what onboarding.guide_sent records -- and the
  // only key a joiner has before this sweep gives them a member id.
  it("never mails somebody the ledger already records for that template", () => {
    const out = sweep({
      appliedChanges: [{ member_id: "ada", to: "full" }],
      alreadyMailed: new Set(["ada@lab.co:member"]),
    });
    expect(out.mail).toEqual([]);
  });

  // A promotion to a tier whose onboarding is access grants rather than mail sends nothing, and
  // says so rather than going quiet.
  it("sends nothing for a type whose onboarding is backend-only", () => {
    const out = sweep({ appliedChanges: [{ member_id: "ada", to: "external-prof" }] });
    expect(out.mail).toEqual([]);
    expect(out.skipped[0]?.reason).toContain("sends no onboarding mail");
  });

  it("refuses to create a row whose id already belongs to somebody else", () => {
    const out = sweep({
      plan: {
        ...EMPTY,
        additions: [{ sheet_row: 91, name: "Ada", email: "other@lab.co", member_type: "full" }],
      },
      knownMemberIds: new Set(["ada"]),
    });
    expect(out.create).toEqual([]);
    expect(out.skipped[0]?.reason).toContain("already exists");
  });

  it("skips a joining row with no address rather than creating an unmailable member", () => {
    const out = sweep({
      plan: { ...EMPTY, additions: [{ sheet_row: 92, name: "No Mail", member_type: "full" }] },
    });
    expect(out.create).toEqual([]);
    expect(out.skipped[0]?.reason).toContain("no email");
  });

  it("skips a type change for somebody with no address", () => {
    const out = sweep({ appliedChanges: [{ member_id: "noaddr", to: "full" }] });
    expect(out.mail).toEqual([]);
    expect(out.skipped[0]?.reason).toBe("no email on file");
  });
});

describe("the id a joining row gets", () => {
  it("slugs the way the rest of the roster spells ids", () => {
    expect(memberIdForRow("Luke Zhang")).toBe("luke-zhang");
    expect(memberIdForRow("Bernhard Schölkopf")).toBe("bernhard-scholkopf");
    expect(memberIdForRow("  Xuanqiang  Angelo Huang ")).toBe("xuanqiang-angelo-huang");
    expect(memberIdForRow("!!!")).toBe("");
  });
});
