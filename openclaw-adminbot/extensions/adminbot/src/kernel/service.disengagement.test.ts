// The disengagement sweep end to end: who it messages, when, and where the escalation lands.
//
// The ladder's arithmetic is covered by workflows/members/onboarding-followup.test.ts. What is
// tested here is the half that only exists once the service is involved -- reading the welcome off
// the audit trail, the ledger advancing the sequence, the two rules not both firing on the same
// person, and the escalation arriving on the queue the professor's page already reads.

import { describe, expect, it } from "vitest";
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

function lab(options: { memberType?: string | null; slack?: boolean } = {}) {
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(store);
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      email: "ada@lab.test",
      // `null` means the roster row carries no type at all, which is most of the imported roster.
      ...(options.memberType === null ? {} : { member_type: options.memberType ?? "full" }),
      receives_nudges: true,
      ...(options.slack === false ? {} : { slack_user_id: "U-ADA" }),
    }),
  );
  return { store, service };
}

/** The manual onboarding email, as the sender records it. */
function welcome(service: AdminBotService, at = WELCOME_AT) {
  service.recordOnboardingGuideSent({
    actor: "andrew-kim",
    template_id: "full_member",
    email: "ada@lab.test",
    sent: true,
  });
  // recordAudit stamps "now", so the row is re-dated to the welcome the test means.
  const events = service.listAuditEvents();
  const row = events.find((event) => event.type === "onboarding.guide_sent");
  Object.assign(row as { timestamp: string }, { timestamp: at });
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
  it("chases the configured member types and leaves everyone else alone", async () => {
    for (const memberType of ["acquaintance", "coauthor-minor", null]) {
      const { service } = lab({ memberType });
      welcome(service);
      const result = unwrap(await run(service, ESCALATE_DUE));
      expect(result.reminded).toEqual([]);
      expect(result.dormant).toEqual([]);
    }
  });

  it("never chases somebody who has left", async () => {
    const { service } = lab();
    unwrap(
      service.upsertLabMember({
        id: "ada",
        name: "Ada Lovelace",
        member_type: "full",
        status: "alumni",
      }),
    );
    expect(unwrap(await run(service, ESCALATE_DUE)).dormant).toEqual([]);
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
    expect(unwrap(await runRound(service, WELCOME_AT)).reminded).toMatchObject([
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
