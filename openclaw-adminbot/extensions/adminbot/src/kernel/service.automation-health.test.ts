import { describe, expect, it, vi } from "vitest";
import type { AdminBotAuditEvent } from "../contracts/actions.js";
import { automationHealthIssues, cronMaxGapMinutes } from "./service.automation-health.js";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
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
    expect(issues).toEqual([expect.objectContaining({ kind: "repeating_failure", count: 3 })]);
  });

  it("keeps an alert for later when there is no admin to tell", () => {
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store, {});
    unwrap(
      service.recordAutomationHeartbeat("cron", {
        job: "adminbot-daily",
        cron: "0 8 * * *",
        ok: false,
      }),
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

describe("settling notifications", () => {
  it("takes a recovered automation alert off the dashboard on the next health pass", () => {
    const { service, store } = lab(async () => ({ handled: true }));
    store.saveMemberNotification({
      id: "n-old",
      member_id: "boss",
      kind: "automation",
      title: "calendar.add_attendees keeps failing",
      body: "6 failures in 24h",
      created_at: new Date(Date.now() - DAY).toISOString(),
    });
    unwrap(service.raiseAutomationHealthAlerts("cron"));
    const [settled] = store.listMemberNotifications("boss");
    expect(settled?.resolved_at).toBeDefined();
    expect(settled?.read_at).toBeDefined();
    expect(unwrap(service.listMemberNotifications("boss")).notifications).toHaveLength(1);
  });

  it("expires stale suggestions on read, but keeps escalations and one-off notices", () => {
    const { service, store } = lab(async () => ({ handled: true }));
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const base = { member_id: "boss", body: "", created_at: old };
    store.saveMemberNotification({
      ...base,
      id: "workshop",
      kind: "workshop",
      title: "Workshops that may fit your papers",
    });
    store.saveMemberNotification({
      ...base,
      id: "evidence",
      kind: "paper_slot",
      title: "Evidence still missing on your paper",
    });
    store.saveMemberNotification({
      ...base,
      id: "pi-review",
      kind: "paper_slot",
      title: "A paper is waiting on your review",
    });
    store.saveMemberNotification({
      ...base,
      id: "escalated",
      kind: "nudge",
      title: "Overdue",
      escalated_at: old,
    });
    unwrap(service.listMemberNotifications("boss"));
    const resolved = store
      .listMemberNotifications("boss")
      .filter((notification) => notification.resolved_at)
      .map((notification) => notification.id)
      .toSorted();
    expect(resolved).toEqual(["evidence", "workshop"]);
  });
});

describe("Slack Connect for people in another workspace", () => {
  it("files one admin-approved invitation in place of the manual invite, and leaves guests manual", async () => {
    const { service, store } = lab(async (proposal) => {
      const payload = proposal.proposed_payload as { user_id: string };
      throw new Error(
        payload.user_id === "U-EXT"
          ? "Slack channel invite failed 200: user_team_not_in_channel"
          : "Slack channel invite failed 200: user_is_restricted",
      );
    });
    for (const [id, slack, email] of [
      ["ext", "U-EXT", "ext@other.example"],
      ["guest", "U-GUEST", "guest@lab.example"],
    ]) {
      unwrap(
        service.upsertLabMember({
          id,
          name: id,
          privilege_level: "member",
          slack_user_id: slack,
          email,
        } as never),
      );
      await service.execute(unwrap(invite(service, "random-active", slack)).id, { dry_run: false });
    }

    const first = unwrap(service.raiseAutomationHealthAlerts("cron"));
    expect(first.connect_invites_proposed).toHaveLength(1);
    const [proposal] = store.listProposalsByType("slack.connect_invite");
    expect(proposal).toMatchObject({
      status: "pending",
      proposed_payload: { email: "ext@other.example", channel: "random-active", member_id: "ext" },
    });
    // The person with a proposal is in the approval queue; only the guest is asked for by hand.
    expect(unwrap(service.automationHealth()).issues).toEqual([
      expect.objectContaining({ key: "slack-manual-invite:random-active:U-GUEST" }),
    ]);
    expect(unwrap(service.raiseAutomationHealthAlerts("cron")).connect_invites_proposed).toEqual(
      [],
    );

    // Rejected: not filed again, and the person goes back on the manual list.
    store.saveProposal({ ...proposal!, status: "rejected" });
    expect(unwrap(service.raiseAutomationHealthAlerts("cron")).connect_invites_proposed).toEqual(
      [],
    );
    expect(unwrap(service.automationHealth()).issues).toEqual([
      expect.objectContaining({ key: "slack-manual-invite:random-active:U-EXT,U-GUEST" }),
    ]);
  });
});

describe("OpenReview login health", () => {
  const login = (
    type: "openreview.login_rejected" | "openreview.login_restored",
    timestamp: string,
  ): AdminBotAuditEvent => ({
    id: `aud_${timestamp}`,
    type,
    actor: "adminbot",
    timestamp,
    details:
      type === "openreview.login_rejected"
        ? { source: "citation_checks", error: "OpenReview rejected the login (403)" }
        : { source: "citation_checks" },
  });
  const issuesOf = (events: AdminBotAuditEvent[]) =>
    automationHealthIssues(events, () => undefined, new Date("2026-11-10T12:00:00Z")).filter(
      (issue) => issue.key === "openreview-login",
    );

  it("is open while the newest login was refused, and closed once one works", () => {
    expect(issuesOf([])).toEqual([]);
    expect(issuesOf([login("openreview.login_rejected", "2026-11-10T09:00:00.000Z")])).toEqual([
      expect.objectContaining({
        kind: "credentials",
        last_seen: "2026-11-10T09:00:00.000Z",
        detail: expect.stringContaining("OpenReview rejected the login (403)"),
      }),
    ]);
    expect(
      issuesOf([
        login("openreview.login_rejected", "2026-11-10T09:00:00.000Z"),
        login("openreview.login_restored", "2026-11-10T10:00:00.000Z"),
      ]),
    ).toEqual([]);
    // Order in the trail does not matter, only the timestamps.
    expect(
      issuesOf([
        login("openreview.login_rejected", "2026-11-10T11:00:00.000Z"),
        login("openreview.login_restored", "2026-11-10T10:00:00.000Z"),
      ]),
    ).toHaveLength(1);
  });

  it("is recorded by the service only when a check's outcome changes", () => {
    const { store, service } = lab(async () => ({ handled: true }));
    service.recordOpenReviewLogin("citation_checks", { ok: true });
    service.recordOpenReviewLogin("citation_checks", { ok: false, error: "refused" });
    service.recordOpenReviewLogin("citation_checks", { ok: false, error: "refused" });
    service.recordOpenReviewLogin("integrity_checks", { ok: false, error: "refused" });
    service.recordOpenReviewLogin("integrity_checks", { ok: true });
    service.recordOpenReviewLogin("citation_checks", { ok: true });
    expect(
      store
        .listAuditEvents()
        .filter((event) => event.type.startsWith("openreview.login"))
        .map((event) => `${event.type} ${String(event.details?.source)}`),
    ).toEqual([
      "openreview.login_rejected citation_checks",
      "openreview.login_rejected integrity_checks",
      "openreview.login_restored integrity_checks",
      "openreview.login_restored citation_checks",
    ]);
  });

  // Each check has its own OpenReview session: one still holding a cached token keeps working
  // after the password stops, which says nothing about the login the other was refused.
  it("is not cleared by a different check that never had to log in", () => {
    const { service } = lab(async () => ({ handled: true }));
    service.recordOpenReviewLogin("citation_checks", { ok: false, error: "refused" });
    service.recordOpenReviewLogin("integrity_checks", { ok: true });
    expect(unwrap(service.automationHealth()).issues.map((issue) => issue.key)).toContain(
      "openreview-login",
    );
    service.recordOpenReviewLogin("citation_checks", { ok: true });
    expect(unwrap(service.automationHealth()).issues.map((issue) => issue.key)).not.toContain(
      "openreview-login",
    );
  });

  it("picks up a refusal recorded before a restart", () => {
    const first = lab(async () => ({ handled: true }));
    first.service.recordOpenReviewLogin("citation_checks", { ok: false, error: "refused" });
    // A new service over the same store has no memory of it but must still clear it.
    const restarted = new AdminBotService(first.store);
    restarted.recordOpenReviewLogin("citation_checks", { ok: true });
    expect(unwrap(restarted.automationHealth()).issues.map((issue) => issue.key)).not.toContain(
      "openreview-login",
    );
  });
});

describe("Google credential failures", () => {
  const event = (type: string, timestamp: string, details: Record<string, unknown>) =>
    ({ id: `audit_${type}_${timestamp}`, type, actor: "adminbot", timestamp, details }) as never;

  it("raises one issue on the first expired-token mail failure, and clears it on a later success", () => {
    const failed = event("auth.approval_email_failed", "2026-03-02T09:00:00.000Z", {
      error: 'gog gmail send failed: oauth2: "invalid_grant" "Token has been expired or revoked."',
    });
    const now = new Date("2026-03-02T10:00:00.000Z");
    const issues = automationHealthIssues([failed], () => undefined, now);
    expect(issues).toEqual([
      expect.objectContaining({
        kind: "google_credentials",
        key: "google-credentials:credentials",
      }),
    ]);
    expect(issues[0]?.detail).toContain("gog auth add");

    const recovered = event("execution.executed", "2026-03-02T09:30:00.000Z", {
      action_type: "email.send",
    });
    expect(automationHealthIssues([failed, recovered], () => undefined, now)).toEqual([]);
  });

  // One token can lack the Gmail scope while Calendar works, so a calendar success must not
  // clear the mail alert -- only a later mail send can.
  it("clears a mail credential failure only on a mail success", () => {
    const now = new Date("2026-03-02T10:00:00.000Z");
    const failed = event("execution.failed", "2026-03-02T09:00:00.000Z", {
      action_type: "email.send",
      error: "gog gmail send failed: insufficient authentication scopes",
    });
    const calendar = event("execution.executed", "2026-03-02T09:30:00.000Z", {
      action_type: "calendar.create_event",
    });
    const mail = event("execution.executed", "2026-03-02T09:45:00.000Z", {
      action_type: "email.send",
    });
    const googleIssues = (events: never[]) =>
      automationHealthIssues(events, () => undefined, now).filter(
        (issue) => issue.kind === "google_credentials",
      );
    expect(googleIssues([failed, calendar])).toEqual([
      expect.objectContaining({ key: "google-credentials:credentials" }),
    ]);
    expect(googleIssues([failed, calendar, mail])).toEqual([]);

    // A missing gog binary is cleared by any gog run: the binary is evidently there.
    const missing = event("execution.failed", "2026-03-02T09:00:00.000Z", {
      action_type: "email.send",
      error: "gog: executable was not found in $PATH",
    });
    expect(googleIssues([missing])).toEqual([
      expect.objectContaining({ key: "google-credentials:connector_missing" }),
    ]);
    expect(googleIssues([missing, calendar])).toEqual([]);
  });

  it("does not read a Slack 401 or an ordinary send rejection as the Google token", () => {
    const now = new Date("2026-03-02T10:00:00.000Z");
    const issues = automationHealthIssues(
      [
        event("execution.failed", "2026-03-02T09:00:00.000Z", {
          action_type: "message.send",
          error: "Slack API error 401 invalid_auth",
        }),
        event("execution.failed", "2026-03-02T09:01:00.000Z", {
          action_type: "email.send",
          error: "gog command failed (exit 1): Google API error (400 invalidArgument)",
        }),
      ],
      () => undefined,
      now,
    );
    expect(issues.filter((issue) => issue.kind === "google_credentials")).toEqual([]);
  });
});
