// The disengagement sweep end to end: who it messages, when, and where the escalation lands.
//
// The ladder's arithmetic is covered by workflows/members/onboarding-followup.test.ts. What is
// tested here is the half that only exists once the service is involved -- reading the welcome off
// the audit trail, the ledger advancing the sequence, the two rules not both firing on the same
// person, and the escalation arriving on the queue the professor's page already reads.

import { describe, expect, it, vi } from "vitest";
import { adminBotOnboardingFollowUpPlan } from "../contracts/actions.js";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const WELCOME_AT = "2026-03-02T09:00:00.000Z";
/** Five business days after Monday 2 March. */
const FIRST_DUE = "2026-03-09T09:00:00.000Z";
const SECOND_DUE = "2026-03-12T09:00:00.000Z";
const ESCALATE_DUE = "2026-03-17T09:00:00.000Z";

function lab(
  options: {
    memberType?: string | null;
    slack?: boolean;
    /** Anything else on the roster row: status, name, address, nudge-list membership. */
    extra?: Record<string, unknown>;
    /** A live Slack executor, for the sweeps that count a member reached only by a sent proposal. */
    executor?: boolean;
  } = {},
) {
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(
    store,
    options.executor ? { executor: { execute: async () => ({ handled: true }) } } : undefined,
  );
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      email: "ada@lab.test",
      // `null` means the roster row carries no type at all, which is most of the imported roster.
      ...(options.memberType === null ? {} : { member_type: options.memberType ?? "full" }),
      receives_nudges: true,
      ...(options.slack === false ? {} : { slack_user_id: "U-ADA" }),
      ...options.extra,
    } as never),
  );
  return { store, service };
}

/** The manual onboarding email, as the sender records it. */
function welcome(service: AdminBotService, at = WELCOME_AT) {
  // recordAudit stamps "now", so the clock is set to the welcome the test means.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(at) });
  try {
    service.recordOnboardingGuideSent({
      actor: "andrew-kim",
      template_id: "full_member",
      email: "ada@lab.test",
      sent: true,
    });
  } finally {
    vi.useRealTimers();
  }
}

/**
 * A pass at the lab's *standing* pace and reach.
 *
 * Stated rather than defaulted, because the shipped default is whichever temporary catch-up round
 * is live (ADMINBOT_ONBOARDING_CATCH_UP_ROUND). These cases are about the ladder's own mechanics --
 * the five-business-day gate, the ledger advancing the sequence, the two sweeps not both firing --
 * and pinning them to the standing values is what lets a round be switched on and off without
 * rewriting them.
 */
const run = (service: AdminBotService, nowIso: string) =>
  service.chaseDisengagedMembers("service", {
    nowIso,
    followUp: { plan: adminBotOnboardingFollowUpPlan, claimAlreadyEmailed: false },
  });

/** A pass at the current catch-up round's pace and reach: the shipped default. */
const runRound = (service: AdminBotService, nowIso: string) =>
  service.chaseDisengagedMembers("service", { nowIso });

describe("the onboarding ladder", () => {
  it("says nothing until five business days after the welcome", async () => {
    const { service } = lab();
    welcome(service);
    // Friday is four business days in.
    expect(unwrap(await run(service, "2026-03-06T09:00:00.000Z")).reminded).toEqual([]);
    const due = unwrap(await run(service, FIRST_DUE));
    expect(due.reminded).toMatchObject([{ member_id: "ada", step: "first_reminder" }]);
  });

  it("walks the three steps in order and stops there", async () => {
    const { service, store } = lab();
    welcome(service);

    expect(unwrap(await run(service, FIRST_DUE)).reminded).toMatchObject([
      { step: "first_reminder" },
    ]);
    // Same day again changes nothing: the ledger is what advances the ladder.
    expect(unwrap(await run(service, FIRST_DUE)).reminded).toEqual([]);

    expect(unwrap(await run(service, SECOND_DUE)).reminded).toMatchObject([
      { step: "second_reminder" },
    ]);
    expect(unwrap(await run(service, "2026-03-14T09:00:00.000Z")).reminded).toEqual([]);

    const escalated = unwrap(await run(service, ESCALATE_DUE));
    expect(escalated.reminded).toEqual([]);
    expect(escalated.escalated).toMatchObject([{ member_id: "ada", notifications: 2 }]);

    // Two reminders, and only two: the ladder is a bounded sequence.
    expect(store.listMemberNotifications("ada")).toHaveLength(2);

    // Nothing escalates twice, and no third ladder reminder ever goes out. (The standing
    // dormant-account reminder does resume here -- see its own test -- which is why this asserts on
    // the ladder's own fields rather than on the notification count.)
    const after = unwrap(await run(service, "2026-04-30T09:00:00.000Z"));
    expect(after.reminded).toEqual([]);
    expect(after.escalated).toEqual([]);
  });

  it("puts both reminders on the professor's desk, named, under the member", async () => {
    const { service } = lab();
    welcome(service);
    await run(service, FIRST_DUE);
    await run(service, SECOND_DUE);
    await run(service, ESCALATE_DUE);

    // The queue the professor's page already reads -- what needs nudging, grouped per person.
    const desk = unwrap(service.listEscalatedNudges());
    expect(desk.members).toHaveLength(1);
    expect(desk.members[0]).toMatchObject({ member_id: "ada", name: "Ada Lovelace" });
    expect(desk.members[0]?.notifications.map((entry) => entry.title)).toEqual([
      "Your AdminBot account is waiting for you",
      "Second reminder: your AdminBot account",
    ]);
  });

  it("stops the moment they sign in, at every step", async () => {
    for (const stopAfter of [0, 1, 2]) {
      const { service, store } = lab();
      welcome(service);
      const days = [FIRST_DUE, SECOND_DUE, ESCALATE_DUE];
      for (let step = 0; step < stopAfter; step += 1) {
        await run(service, days[step]!);
      }
      store.appendLoginEvent({
        id: `l-${stopAfter}`,
        member_id: "ada",
        at: "2026-03-13T09:00:00.000Z",
      });
      const after = unwrap(await run(service, "2026-04-30T09:00:00.000Z"));
      expect(after.reminded).toEqual([]);
      expect(after.escalated).toEqual([]);
    }
  });

  it("counts an edit the member made themselves as showing up", async () => {
    const { service } = lab();
    welcome(service);
    // A self-edit stamps field provenance, which is what lastSelfEditAt reads.
    unwrap(
      service.upsertLabMember(
        { id: "ada", name: "Ada Lovelace", whatsapp: "+1 555 0100" },
        { actor: "ada", source: "member" },
      ),
    );
    expect(unwrap(await run(service, FIRST_DUE)).reminded).toEqual([]);
  });
});

describe("the dormant-account reminder", () => {
  it("chases somebody who has never signed in every three days", async () => {
    const { service } = lab();
    // No welcome recorded, so the ladder never owns this member.
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual(["ada"]);
    expect(unwrap(await run(service, "2026-03-04T09:00:00.000Z")).dormant).toEqual([]);
    expect(unwrap(await run(service, "2026-03-05T09:00:00.000Z")).dormant).toEqual(["ada"]);
  });

  it("stands aside while the onboarding ladder is running", async () => {
    const { service } = lab();
    welcome(service);
    // Inside the ladder's first window: the ladder has not spoken yet and neither does this.
    expect(unwrap(await run(service, "2026-03-04T09:00:00.000Z")).dormant).toEqual([]);
    // And on the day the ladder speaks, it speaks -- not both.
    const due = unwrap(await run(service, FIRST_DUE));
    expect(due.reminded).toHaveLength(1);
    expect(due.dormant).toEqual([]);
  });

  it("takes the member back once the ladder has finished with them", async () => {
    const { service } = lab();
    welcome(service);
    await run(service, FIRST_DUE);
    await run(service, SECOND_DUE);
    await run(service, ESCALATE_DUE);
    // The ladder is done and they still have never signed in, so the standing reminder resumes.
    expect(unwrap(await run(service, "2026-03-25T09:00:00.000Z")).dormant).toEqual(["ada"]);
  });

  it("stops once they have signed in", async () => {
    const { service, store } = lab();
    store.appendLoginEvent({ id: "l1", member_id: "ada", at: "2026-03-01T09:00:00.000Z" });
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual([]);
  });
});

describe("who the sweep is for", () => {
  it("leaves the groups the policy switches off alone, and an untyped row too", async () => {
    for (const memberType of ["acquaintance", "mailing-list", "external-prof", null]) {
      const { service, store } = lab({ memberType });
      welcome(service);
      const result = unwrap(await run(service, ESCALATE_DUE));
      expect(result.reminded).toEqual([]);
      expect(result.dormant).toEqual([]);
      expect(store.listMemberNotifications("ada")).toEqual([]);
    }
  });

  it("reports a member it could not reach instead of silently dropping them", async () => {
    const { service } = lab({ slack: false });
    welcome(service);
    const result = unwrap(await run(service, FIRST_DUE));
    // The reminder is still recorded against them -- the notification was filed -- and the failure
    // to deliver is named rather than swallowed.
    expect(result.reminded).toMatchObject([{ member_id: "ada" }]);
    expect(result.skipped).toMatchObject([
      { member_id: "ada", reason: "member has no slack_user_id" },
    ]);
  });

  it("re-dates the ladder to the most recent welcome", async () => {
    const { service } = lab();
    welcome(service, "2025-01-01T09:00:00.000Z");
    await run(service, "2025-01-10T09:00:00.000Z");
    await run(service, "2025-01-15T09:00:00.000Z");
    await run(service, "2025-01-25T09:00:00.000Z");
    // Re-onboarded a year later. The ladder is spent, so this is the standing reminder's member
    // again -- the second welcome does not restart a sequence the ledger says is finished.
    welcome(service, WELCOME_AT);
    const result = unwrap(await run(service, FIRST_DUE));
    expect(result.reminded).toEqual([]);
    expect(result.dormant).toEqual(["ada"]);
  });
});

// TEMPORARY -- the current catch-up round. When the round ends and
// ADMINBOT_ONBOARDING_CATCH_UP_ROUND is deleted, this block goes with it; the block above is the
// standing behaviour and stays.
describe("the catch-up round", () => {
  it("starts an already-emailed member at the Slack reminder, with no welcome on file", async () => {
    const { service } = lab();
    // No welcome recorded: the email went out before the audit trail existed, which is the state
    // most of the roster is in. The standing ladder cannot see these people at all.
    expect(unwrap(await run(service, WELCOME_AT)).reminded).toEqual([]);
    // A fresh roster for the round: the standing pass above just sent Ada her dormant reminder,
    // and the shared long-term cycle would rightly hold a second ask the same day.
    const { service: round } = lab();
    expect(unwrap(await runRound(round, WELCOME_AT)).reminded).toMatchObject([
      { member_id: "ada", step: "first_reminder" },
    ]);
  });

  it("does not claim to know when an email it has no record of went out", async () => {
    const { service, store } = lab();
    await runRound(service, WELCOME_AT);
    const [notification] = store.listMemberNotifications("ada");
    // Deriving a number from created_at would have produced "your onboarding email went out 400
    // days ago" -- an accusation about a date nobody wrote down.
    expect(notification?.body).toContain("Your onboarding email has gone out");
    expect(notification?.body).not.toMatch(/\d+ days ago/u);
  });

  it("still waits when the welcome IS on file — two business days, not five", async () => {
    const { service } = lab();
    welcome(service);
    // The recorded date still wins over the roster flag: somebody the system emailed on Monday is
    // not chased the same afternoon for being a full member. The round only shortens the wait.
    // Tuesday is one business day in.
    expect(unwrap(await runRound(service, "2026-03-03T09:00:00.000Z")).reminded).toEqual([]);
    // Wednesday is two.
    expect(unwrap(await runRound(service, "2026-03-04T09:00:00.000Z")).reminded).toMatchObject([
      { step: "first_reminder" },
    ]);
  });

  it("counts the first gap in business days, so it cannot open on a weekend", async () => {
    const { service } = lab();
    // Welcomed Friday 6 March. Two calendar days is Sunday; two business days is Tuesday.
    welcome(service, "2026-03-06T09:00:00.000Z");
    expect(unwrap(await runRound(service, "2026-03-08T09:00:00.000Z")).reminded).toEqual([]);
    expect(unwrap(await runRound(service, "2026-03-10T09:00:00.000Z")).reminded).toMatchObject([
      { step: "first_reminder" },
    ]);
  });

  it("leaves two days between steps instead of three and five", async () => {
    const { service } = lab();
    await runRound(service, "2026-03-02T09:00:00.000Z");
    // Second reminder at +2, not +3.
    expect(unwrap(await runRound(service, "2026-03-03T09:00:00.000Z")).reminded).toEqual([]);
    expect(unwrap(await runRound(service, "2026-03-04T09:00:00.000Z")).reminded).toMatchObject([
      { step: "second_reminder" },
    ]);
    // Escalation at +2 again, not +5.
    expect(unwrap(await runRound(service, "2026-03-05T09:00:00.000Z")).escalated).toEqual([]);
    expect(unwrap(await runRound(service, "2026-03-06T09:00:00.000Z")).escalated).toMatchObject([
      { member_id: "ada", notifications: 2 },
    ]);
  });

  it("reaches a Test Onboard batch member the standing sweep never touches", async () => {
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store);
    unwrap(
      service.upsertLabMember({
        id: "khai",
        name: "Khai",
        email: "khai@lab.test",
        // No `full` token, so adminBotDormantChaseMemberTypes (["full"]) excludes them entirely.
        test_onboard_batch: 2,
        receives_nudges: true,
        slack_user_id: "U-KHAI",
      }),
    );
    expect(unwrap(await run(service, WELCOME_AT)).reminded).toEqual([]);
    expect(unwrap(await runRound(service, WELCOME_AT)).reminded).toMatchObject([
      { member_id: "khai", step: "first_reminder" },
    ]);
  });

  it("leaves alumni alone however the spreadsheet marks them", async () => {
    const { service } = lab({ memberType: "alumni, full" });
    // The batch and the `full` token both survive somebody leaving; having left wins over both.
    expect(unwrap(await runRound(service, WELCOME_AT)).reminded).toEqual([]);
  });

  it("stops on any sign of life, without a welcome to measure from", async () => {
    const { service } = lab();
    unwrap(
      service.updateOwnProfile(
        "ada",
        { whatsapp: "+1 555 0100" },
        { source: "member", actor: "ada" },
      ),
    );
    // With no welcome date there is no "since" to test against, so the question becomes "have they
    // ever been here" -- and they have.
    expect(unwrap(await runRound(service, WELCOME_AT)).reminded).toEqual([]);
  });
});

describe("the engagement policy", () => {
  const DAY = 86_400_000;
  const after = (days: number) => new Date(Date.parse(WELCOME_AT) + days * DAY).toISOString();
  const titles = (store: AdminBotMemoryStore) =>
    store.listMemberNotifications("ada").map((entry) => entry.title);

  it("counts CLI use as being here, and says when it last saw them", async () => {
    const { service, store } = lab();
    // A member who only ever uses an API token: no login event, no web sighting.
    store.patchLabMemberAuthFields("ada", { last_cli_at: "2026-03-01T09:00:00.000Z" });
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual([]);
    // Two weeks of silence on every channel (from 1 March, the day before WELCOME_AT) is what
    // makes them quiet.
    expect(unwrap(await run(service, after(12))).dormant).toEqual([]);
    expect(unwrap(await run(service, after(13))).dormant).toEqual(["ada"]);
    expect(store.listMemberNotifications("ada")[0]?.body).toContain(
      "AdminBot last saw you on March 1, 2026",
    );
  });

  it("emails a minor coauthor on a slow clock, and never escalates them", async () => {
    const { service, store } = lab({ memberType: "coauthor-minor", slack: false });
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual(["ada"]);
    expect(unwrap(await run(service, after(13))).dormant).toEqual([]);
    expect(unwrap(await run(service, after(14))).dormant).toEqual(["ada"]);
    // Two asks, then done: no third, and nothing on the professor's desk.
    const spent = unwrap(await run(service, after(60)));
    expect(spent.dormant).toEqual([]);
    expect(spent.dormant_escalated).toEqual([]);
    expect(titles(store)).toEqual(["Your AdminBot account", "Your AdminBot account"]);
    expect(store.listMemberNotifications("ada").some((entry) => entry.important)).toBe(false);
  });

  it("chases a part-time member gently, without the full member's escalation", async () => {
    const { service, store } = lab({ extra: { status: "part_time" } });
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual(["ada"]);
    expect(unwrap(await run(service, after(6))).dormant).toEqual([]);
    expect(unwrap(await run(service, after(7))).dormant).toEqual(["ada"]);
    expect(unwrap(await run(service, after(30))).dormant_escalated).toEqual([]);
    expect(store.listMemberNotifications("ada").some((entry) => entry.important)).toBe(false);
  });

  it("sends somebody who has left one gentle email, not the full member's Slack chase", async () => {
    const { service, store } = lab({ extra: { status: "alumni" } });
    welcome(service);
    // The ladder never owns an alumnus, however their row is typed.
    const first = unwrap(await run(service, ESCALATE_DUE));
    expect(first.reminded).toEqual([]);
    expect(first.dormant).toEqual(["ada"]);
    expect(titles(store)).toEqual(["Your alumni access to AdminBot"]);
    // One ask per quiet spell, and never escalated.
    const later = unwrap(await run(service, after(400)));
    expect(later.dormant).toEqual([]);
    expect(later.dormant_escalated).toEqual([]);
  });

  it("puts a full member on the professor's desk once the reminders run out", async () => {
    const { service } = lab();
    unwrap(
      service.updateSettings({
        engagement_policy: { full: { max_reminders: 1 } },
      } as never),
    );
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual(["ada"]);
    expect(unwrap(await run(service, after(2))).dormant_escalated).toEqual([]);
    expect(unwrap(await run(service, after(3))).dormant_escalated).toEqual([
      { member_id: "ada", notifications: 1 },
    ]);
    expect(unwrap(service.listEscalatedNudges()).members[0]).toMatchObject({ member_id: "ada" });
    // Once per spell.
    const spent = unwrap(await run(service, after(30)));
    expect(spent.dormant).toEqual([]);
    expect(spent.dormant_escalated).toEqual([]);
  });

  it("starts a fresh spell when the member comes back and goes quiet again", async () => {
    const { service, store } = lab();
    unwrap(service.updateSettings({ engagement_policy: { full: { max_reminders: 1 } } } as never));
    await run(service, WELCOME_AT);
    store.patchLabMemberAuthFields("ada", { last_cli_at: after(1) });
    expect(unwrap(await run(service, after(3))).dormant_escalated).toEqual([]);
    // Fourteen days after they were last here: a new first reminder, not the old spell's
    // escalation.
    const again = unwrap(await run(service, after(15)));
    expect(again.dormant).toEqual(["ada"]);
    expect(again.dormant_escalated).toEqual([]);
  });

  it("flags a broken address instead of mailing it, and keeps flagging until it is fixed", async () => {
    const { service, store } = lab({
      memberType: "coauthor-minor",
      extra: { email: "ada@lab.test." },
    });
    for (const day of [0, 30]) {
      const result = unwrap(await run(service, after(day)));
      expect(result.dormant).toEqual([]);
      expect(result.flagged).toEqual([
        { member_id: "ada", address: "ada@lab.test.", problem: "trailing_dot" },
      ]);
    }
    expect(store.listMemberNotifications("ada")).toEqual([]);
  });

  it("skips a member with no address at all on the email policy", async () => {
    const { service } = lab({ memberType: "coauthor-minor", extra: { email: "" } });
    const result = unwrap(await run(service, WELCOME_AT));
    expect(result.dormant).toEqual([]);
    expect(result.flagged).toEqual([]);
    expect(result.skipped).toMatchObject([
      { member_id: "ada", reason: "member has no correspondence or account email" },
    ]);
  });

  it("respects do-not-contact and the nudge list", async () => {
    for (const extra of [{ name: "Ada, do not contact" }, { receives_nudges: false }]) {
      const { service, store } = lab({ extra });
      const result = unwrap(await run(service, WELCOME_AT));
      expect(result.dormant).toEqual([]);
      expect(store.listMemberNotifications("ada")).toEqual([]);
    }
  });

  it("does not count a reminder the member never got towards escalating them", async () => {
    const { service } = lab({ extra: { receives_nudges: false } });
    unwrap(service.updateSettings({ engagement_policy: { full: { max_reminders: 1 } } } as never));
    await run(service, WELCOME_AT);
    unwrap(service.upsertLabMember({ id: "ada", name: "Ada Lovelace", receives_nudges: true }));
    // Back on the list: this is their first reminder, not grounds to escalate.
    const result = unwrap(await run(service, after(3)));
    expect(result.dormant).toEqual(["ada"]);
    expect(result.dormant_escalated).toEqual([]);
  });

  it("switches a group off through settings", async () => {
    const { service } = lab();
    unwrap(service.updateSettings({ engagement_policy: { full: { enabled: false } } } as never));
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual([]);
    // And `{}` puts the shipped policy back.
    unwrap(service.updateSettings({ engagement_policy: {} } as never));
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual(["ada"]);
  });

  it("refuses a policy setting it cannot honor, rather than dropping the bad field", () => {
    const { service } = lab();
    for (const engagement_policy of [
      { full: { interval_days: 0 } },
      { full: { channel: "sms" } },
      { wizards: { enabled: true } },
      { full: { enabeld: false } },
    ]) {
      expect(service.updateSettings({ engagement_policy } as never).ok).toBe(false);
    }
  });
});

describe("one long-term reminder per cycle, across every sweep", () => {
  const profile = (service: AdminBotService, nowIso: string, recipientIds?: string[]) =>
    service.sendMandatoryFieldsReminders("service", {
      nowIso,
      ...(recipientIds ? { recipientIds } : {}),
    });

  it("holds the dormant reminder on the day the profile reminder reached the member", async () => {
    const { service } = lab({ executor: true });
    // Ada is a full member with an empty profile who has never signed in: both sweeps want her.
    expect(unwrap(await profile(service, WELCOME_AT)).created).not.toEqual([]);
    const sameDay = unwrap(await run(service, "2026-03-02T10:50:00.000Z"));
    expect(sameDay.dormant).toEqual([]);
    expect(sameDay.skipped).toContainEqual({
      member_id: "ada",
      reason: "already sent a long-term reminder this cycle",
    });
    // Full's cycle is two calendar days, so Wednesday is hers again.
    expect(unwrap(await run(service, "2026-03-04T10:50:00.000Z")).dormant).toEqual(["ada"]);
  });

  it("holds the profile reminder after the dormant reminder, the other way round", async () => {
    const { service } = lab({ executor: true });
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual(["ada"]);
    const held = unwrap(await profile(service, "2026-03-03T09:20:00.000Z"));
    expect(held.created).toEqual([]);
    expect(held.skipped).toContainEqual({
      member_id: "ada",
      reason: "already sent a long-term reminder this cycle",
    });
  });

  it("still sends what an admin picked by hand, and backs the timers off after it", async () => {
    const { service } = lab({ executor: true });
    expect(unwrap(await run(service, WELCOME_AT)).dormant).toEqual(["ada"]);
    // A person deciding today outranks the cycle the timers approximate.
    expect(unwrap(await profile(service, "2026-03-03T09:20:00.000Z", ["ada"])).created).not.toEqual(
      [],
    );
    // Stamped all the same: Wednesday is inside the cycle that Tuesday's send restarted.
    expect(unwrap(await run(service, "2026-03-04T10:50:00.000Z")).dormant).toEqual([]);
  });

  it("sends a mailing-list member no profile reminder and does not report it", async () => {
    const { service } = lab({ memberType: "mailing-list", executor: true });
    expect(unwrap(await profile(service, WELCOME_AT))).toEqual({ created: [], skipped: [] });
  });

  it("reports an untyped member instead of sending them the dormant reminder", async () => {
    const { service } = lab({ memberType: null, executor: true });
    const result = unwrap(await run(service, WELCOME_AT));
    expect(result.dormant).toEqual([]);
    expect(result.unclassified).toEqual(["ada"]);
    // The profile reminder stands on the empty fields rather than the type, so it still goes.
    expect(unwrap(await profile(service, WELCOME_AT)).created).not.toEqual([]);
  });
});
