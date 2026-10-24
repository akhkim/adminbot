// The nudge campaign module on its own: filter, dry run, confirm guard, ledger cooldown, pacing,
// error collection and per-send audit. Synthetic members; Slack is a stub function.
import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import type { AdminBotNudgeLedgerRecord } from "../../contracts/paper-cycle.js";
import {
  type AdminBotNudgeCampaign,
  type AdminBotNudgeCampaignDeps,
  askedRecently,
  campaignModeFromBody,
  firstName,
  isCampaignRefusal,
  runNudgeCampaign,
} from "./campaign.js";
import { ADMINBOT_NUDGE_CAMPAIGNS } from "./campaigns.js";
import { PROFILE_PHOTO_NUDGE } from "./profile-photo-nudge.js";

const now = new Date("2026-07-15T12:00:00.000Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

function member(id: string, overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id,
    name: `Test ${id}`,
    privilege_level: "member",
    access: [],
    status: "active",
    receives_nudges: true,
    slack_user_id: `U-${id.toUpperCase()}`,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function campaign(overrides: Partial<AdminBotNudgeCampaign> = {}): AdminBotNudgeCampaign {
  return {
    key: "profile_photo",
    label: "Test campaign",
    description: "A test campaign.",
    route: "/test",
    cooldown_days: null,
    scheduled: false,
    notification: { kind: "nudge", title: "Test" },
    decide: (m) => (m.id.startsWith("skip") ? { skip: "not_chosen" } : { message: `Hi ${m.id}` }),
    ...overrides,
  };
}

function deps(
  members: AdminBotLabMember[],
  overrides: Partial<AdminBotNudgeCampaignDeps> = {},
): AdminBotNudgeCampaignDeps & {
  send: ReturnType<typeof vi.fn>;
  stamp: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  return {
    members,
    ledger: [],
    now,
    send: vi.fn(async () => ({ delivered: true })),
    stamp: vi.fn(),
    audit: vi.fn(),
    sleep: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

const ledgerRow = (memberId: string, at: string): AdminBotNudgeLedgerRecord => ({
  domain: "profile_photo",
  subject_id: "profile_photo",
  member_id: memberId,
  last_nudged_at: at,
  nudge_count: 1,
});

describe("filter", () => {
  it("applies the campaign rule, then the shared rules, and counts every skip by reason", async () => {
    const d = deps(
      [
        member("a"),
        member("skip1"),
        member("pi"),
        member("off", { receives_nudges: false }),
        member("noslack", { slack_user_id: undefined }),
        member("asked"),
        member("gone", { status: "alumni" }),
      ],
      { headProfessorMemberId: "pi", ledger: [ledgerRow("asked", ago(400))] },
    );
    const result = await runNudgeCampaign(campaign(), { dry_run: true }, d);
    expect(result).toMatchObject({
      dry_run: true,
      count: 1,
      skipped: {
        not_chosen: 1,
        head_professor: 1,
        nudges_off: 1,
        no_slack_id: 1,
        already_sent: 1,
      },
      samples: [{ member_id: "a", name: "Test a", message: "Hi a" }],
    });
    // Alumni are not candidates at all, so not a skip either.
    expect(JSON.stringify(result)).not.toContain("gone");
  });

  it("skips a member who DMed AdminBot stop, before any Slack check", async () => {
    const d = deps([
      member("a"),
      member("stopped", { slack_stop_at: ago(3), slack_user_id: undefined }),
    ]);
    const result = await runNudgeCampaign(campaign(), { dry_run: true }, d);
    expect(result).toMatchObject({ count: 1, skipped: { replied_stop: 1 } });
  });

  it("can leave members without Slack to the send (the photo nudge's notify-anyway behaviour)", async () => {
    const d = deps([member("noslack", { slack_user_id: undefined })]);
    const result = await runNudgeCampaign(campaign({ requireSlack: false }), { dry_run: true }, d);
    expect(result).toMatchObject({ count: 1, skipped: {} });
  });
});

describe("dry run", () => {
  it("is the default from a request body and sends nothing", async () => {
    expect(campaignModeFromBody({})).toEqual({ dry_run: true });
    expect(campaignModeFromBody({ dry_run: "false" })).toEqual({ dry_run: true });
    expect(campaignModeFromBody({ dry_run: false, confirm: 3 })).toEqual({
      dry_run: false,
      confirm: 3,
    });
    expect(campaignModeFromBody({ dry_run: false, confirm: "3" })).toEqual({ dry_run: false });
    const d = deps([member("a"), member("b")]);
    await runNudgeCampaign(campaign(), campaignModeFromBody({}), d);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.stamp).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });

  it("shows at most three samples", async () => {
    const d = deps(["a", "b", "c", "d", "e"].map((id) => member(id)));
    const result = await runNudgeCampaign(campaign(), { dry_run: true }, d);
    expect(result).toMatchObject({ count: 5 });
    expect(isCampaignRefusal(result) ? [] : result.samples).toHaveLength(3);
  });
});

describe("confirm guard", () => {
  it("refuses a real send without confirm, or with a count that no longer matches", async () => {
    const d = deps([member("a"), member("b")]);
    expect(await runNudgeCampaign(campaign(), { dry_run: false }, d)).toMatchObject({
      refused: "confirm_required",
      count: 2,
    });
    expect(await runNudgeCampaign(campaign(), { dry_run: false, confirm: 3 }, d)).toMatchObject({
      refused: "confirm_mismatch",
      count: 2,
    });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("is the only guard a scheduled run skips", async () => {
    const d = deps([member("a"), member("off", { receives_nudges: false })]);
    const result = await runNudgeCampaign(campaign(), { dry_run: false, scheduled: true }, d);
    expect(result).toMatchObject({ sent: 1, skipped: { nudges_off: 1 } });
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});

describe("send", () => {
  it("paces sends, stamps and audits only what was delivered, and collects failures", async () => {
    const send = vi.fn(async ({ member: m }: { member: AdminBotLabMember }) => {
      if (m.id === "b") {
        return { delivered: false, reason: "member has no slack_user_id" };
      }
      if (m.id === "c") {
        throw new Error("slack is down");
      }
      return { delivered: true };
    });
    const d = deps([member("a"), member("b"), member("c"), member("d")], { send, paceMs: 1100 });
    const result = await runNudgeCampaign(campaign(), { dry_run: false, confirm: 4 }, d);
    expect(result).toMatchObject({
      dry_run: false,
      count: 4,
      sent: 2,
      failed: [
        { member_id: "b", reason: "member has no slack_user_id" },
        { member_id: "c", reason: "slack is down" },
      ],
    });
    expect(d.sleep).toHaveBeenCalledTimes(3);
    expect(d.sleep).toHaveBeenCalledWith(1100);
    expect(d.stamp.mock.calls.map(([id]) => id)).toEqual(["a", "d"]);
    expect(d.stamp).toHaveBeenCalledWith("a", now.toISOString());
    expect(d.audit.mock.calls.map(([id]) => id)).toEqual(["a", "d"]);
  });

  it("sends in member order, each with their own message", async () => {
    const d = deps([member("a"), member("b")]);
    await runNudgeCampaign(campaign(), { dry_run: false, confirm: 2 }, d);
    expect(d.send.mock.calls.map(([call]) => [call.member.id, call.message])).toEqual([
      ["a", "Hi a"],
      ["b", "Hi b"],
    ]);
  });
});

describe("ledger cooldown", () => {
  it("null asks once ever, 0 never holds back, N days holds back for N days", () => {
    const row = ledgerRow("a", ago(10));
    expect(askedRecently(row, null, now)).toBe(true);
    expect(askedRecently(row, 0, now)).toBe(false);
    expect(askedRecently(row, 14, now)).toBe(true);
    expect(askedRecently(row, 7, now)).toBe(false);
    expect(askedRecently(undefined, null, now)).toBe(false);
  });

  it("reads only this campaign's rows", async () => {
    const other: AdminBotNudgeLedgerRecord = { ...ledgerRow("a", ago(1)), domain: "email_review" };
    const d = deps([member("a")], { ledger: [other] });
    expect(await runNudgeCampaign(campaign(), { dry_run: true }, d)).toMatchObject({ count: 1 });
  });
});

describe("firstName", () => {
  it("takes the first word, and never leaves the greeting empty", () => {
    expect(firstName("Sam Example")).toBe("Sam");
    expect(firstName("  Robin  ")).toBe("Robin");
    expect(firstName("")).toBe("there");
    expect(firstName(undefined)).toBe("there");
  });
});

describe("registered campaigns", () => {
  it("runs the profile-photo campaign only by hand, never on a schedule", () => {
    expect(PROFILE_PHOTO_NUDGE.scheduled).toBe(false);
    expect(ADMINBOT_NUDGE_CAMPAIGNS.filter((c) => c.scheduled).map((c) => c.key)).toEqual([
      "personal_website",
    ]);
  });
});
