import { describe, expect, it, vi } from "vitest";
import { cronMaxGapMinutes } from "./service.automation-health.js";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function unwrap<T>(result: { ok: true; payload: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function lab(execute: (proposal: { proposed_payload?: unknown }) => Promise<{ handled: boolean }>) {
  const store = new AdminBotMemoryStore();
  const executor = { execute: vi.fn(execute) };
  const service = new AdminBotService(store, { executor });
  unwrap(
    service.upsertLabMember({
      id: "boss",
      name: "Admin",
      privilege_level: "admin",
      slack_user_id: "U-BOSS",
    } as never),
  );
  return { store, service, executor };
}

function invite(service: AdminBotService, channel: string, userId: string) {
  return service.createProposal({
    type: "slack.invite_to_channel",
    summary: `Add ${userId} to #${channel}`,
    target: { service: "slack", channel: "slack", target: channel },
    proposed_payload: { channel, user_id: userId },
  });
}

describe("cronMaxGapMinutes", () => {
  it.each([
    ["50 * * * *", 60],
    ["*/15 * * * *", 15],
    ["10 9 * * *", 24 * 60],
    // Friday 09:10 to Monday 09:10.
    ["10 9 * * 1-5", 72 * 60],
    ["0 8 * * 0", 7 * 24 * 60],
    ["0 8 * * 7", 7 * 24 * 60],
  ])("%s -> %d", (expression, minutes) => {
    expect(cronMaxGapMinutes(expression)).toBe(minutes);
  });

  it("gives up on what it cannot read", () => {
    expect(cronMaxGapMinutes("@daily")).toBeUndefined();
    expect(cronMaxGapMinutes("61 * * * *")).toBeUndefined();
  });
});

describe("Slack invite failures", () => {
  // The week this was written: one channel that did not exist, 1,281 failed invites into it.
  it("pauses a missing channel after its first failure and says so once", async () => {
    const { service, executor, store } = lab(async () => {
      throw new Error("Slack has no open channel named #help-rec-letters");
    });
    const first = invite(service, "help-rec-letters", "U-1");
    expect((await service.execute(unwrap(first).id, { dry_run: false })).ok).toBe(false);

    for (const user of ["U-2", "U-3", "U-4", "U-5", "U-6", "U-7"]) {
      const next = invite(service, "#help-rec-letters", user);
      expect(next.ok).toBe(false);
      if (!next.ok) {
        expect(next.status).toBe(409);
        expect(next.error.message).toContain("paused");
      }
    }
    expect(executor.execute).toHaveBeenCalledTimes(1);
    // Other channels are not caught by it.
    expect(invite(service, "general", "U-2").ok).toBe(true);

    const issues = unwrap(service.automationHealth()).issues;
    expect(issues.map((issue) => issue.kind)).toEqual(["channel_blocked"]);
    expect(issues[0]?.key).toBe("slack-channel:help-rec-letters:channel_missing");

    const alerts = unwrap(service.raiseAutomationHealthAlerts("cron"));
    expect(alerts).toMatchObject({ alerted: [issues[0]?.key], admins: 1 });
    expect(store.listMemberNotifications("boss")).toHaveLength(1);
    // The next hourly pass, the next day: same problem, nothing new said.
    expect(unwrap(service.raiseAutomationHealthAlerts("cron")).alerted).toEqual([]);
    expect(store.listMemberNotifications("boss")).toHaveLength(1);

    // A day on, one invite may try again.
    const tomorrow = new Date(Date.now() + DAY + HOUR);
    vi.useFakeTimers({ now: tomorrow, toFake: ["Date"] });
    try {
      expect(invite(service, "help-rec-letters", "U-2").ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a person the bot cannot add for a manual invite, without pausing the channel", async () => {
    const { service, executor } = lab(async (proposal) => {
      const payload = proposal.proposed_payload as { user_id: string };
      if (payload.user_id === "U-GUEST") {
        throw new Error("Slack channel invite failed 200: user_team_not_in_channel");
      }
      return { handled: true };
    });
    const guest = unwrap(invite(service, "random-active", "U-GUEST"));
    expect((await service.execute(guest.id, { dry_run: false })).ok).toBe(false);

    const again = invite(service, "random-active", "U-GUEST");
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.message).toContain("needs a manual invite");
    }
    const member = unwrap(invite(service, "random-active", "U-MEMBER"));
    expect((await service.execute(member.id, { dry_run: false })).ok).toBe(true);
    expect(executor.execute).toHaveBeenCalledTimes(2);

    const issues = unwrap(service.automationHealth()).issues;
    expect(issues).toEqual([
      expect.objectContaining({
        kind: "needs_manual_invite",
        key: "slack-manual-invite:random-active:U-GUEST",
      }),
    ]);
  });
});

describe("automation health", () => {
  it("records heartbeats and refuses malformed ones", () => {
    const { service } = lab(async () => ({ handled: true }));
    expect(service.recordAutomationHeartbeat("cron", { job: "Bad Name", ok: true }).ok).toBe(false);
    expect(service.recordAutomationHeartbeat("cron", { job: "adminbot-x" }).ok).toBe(false);
    expect(
      service.recordAutomationHeartbeat("cron", { job: "adminbot-x", ok: true, cron: "50 * * * *" })
        .ok,
    ).toBe(true);
    expect(unwrap(service.automationHealth()).issues).toEqual([]);
  });

  it("notices a job that stopped running", () => {
    const { service } = lab(async () => ({ handled: true }));
    unwrap(
      service.recordAutomationHeartbeat("cron", {
        job: "adminbot-hourly",
        ok: true,
        cron: "50 * * * *",
      }),
    );
    unwrap(
      service.recordAutomationHeartbeat("cron", {
        job: "adminbot-weekday",
        ok: true,
        cron: "10 9 * * 1-5",
      }),
    );
    // Three hours: the hourly job has missed two runs; a weekday job is still on time.
    const later = new Date(Date.now() + 3 * HOUR);
    const issues = unwrap(service.automationHealth(later)).issues;
    expect(issues.map((issue) => issue.key)).toEqual(["stale:adminbot-hourly"]);
  });

  it("notices a daily job failing on its first failure and an hourly one on its second", () => {
    const { service } = lab(async () => ({ handled: true }));
    const beat = (job: string, cron: string, ok: boolean) =>
      unwrap(service.recordAutomationHeartbeat("cron", { job, cron, ok, detail: "invalid_grant" }));
    beat("adminbot-email-review", "0 8 * * *", false);
    beat("adminbot-hourly", "50 * * * *", false);
    expect(unwrap(service.automationHealth()).issues.map((issue) => issue.key)).toEqual([
      "failing:adminbot-email-review",
    ]);
    beat("adminbot-hourly", "50 * * * *", false);
    expect(
      unwrap(service.automationHealth())
        .issues.map((issue) => issue.key)
        .toSorted(),
    ).toEqual(["failing:adminbot-email-review", "failing:adminbot-hourly"]);
    // A green run clears it.
    beat("adminbot-hourly", "50 * * * *", true);
    expect(unwrap(service.automationHealth()).issues.map((issue) => issue.key)).toEqual([
      "failing:adminbot-email-review",
    ]);
  });

  it("groups the same action failure across ids into one repeating issue", async () => {
    let n = 0;
    const { service } = lab(async () => {
      n += 1;
      throw new Error(`openclaw message send failed for notif_${n}abc`);
    });
    // An error the invite classifier does not know is an ordinary failure, not a paused channel.
    for (const channel of ["a", "b", "c"]) {
      const proposal = unwrap(invite(service, channel, "U-1"));
      await service.execute(proposal.id, { dry_run: false });
    }
    const issues = unwrap(service.automationHealth()).issues;
    expect(issues).toEqual([
      expect.objectContaining({ kind: "repeating_failure", count: 3 }),
    ]);
  });

  it("keeps an alert for later when there is no admin to tell", () => {
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store, {});
    unwrap(
      service.recordAutomationHeartbeat("cron", { job: "adminbot-daily", cron: "0 8 * * *", ok: false }),
    );
    expect(unwrap(service.raiseAutomationHealthAlerts("cron"))).toMatchObject({
      issues: 1,
      alerted: [],
      admins: 0,
    });
    unwrap(
      service.upsertLabMember({ id: "boss", name: "Admin", privilege_level: "admin" } as never),
    );
    expect(unwrap(service.raiseAutomationHealthAlerts("cron")).alerted).toEqual([
      "failing:adminbot-daily",
    ]);
  });
});
