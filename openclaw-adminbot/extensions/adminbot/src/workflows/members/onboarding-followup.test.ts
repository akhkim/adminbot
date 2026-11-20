import { describe, expect, it } from "vitest";
import {
  adminBotDormantChaseMemberTypes,
  adminBotOnboardingFollowUpPlan,
  type AdminBotLabMember,
} from "../../contracts/actions.js";
import {
  businessDaysBetween,
  engagedSince,
  hasEverEngaged,
  isChaseableMember,
  planEngagementReminder,
  planOnboardingFollowUp,
} from "./onboarding-followup.js";

const member = (fields: Partial<AdminBotLabMember> = {}) =>
  ({ id: "m", name: "Ada", privilege_level: "member", ...fields }) as AdminBotLabMember;

// Monday 2 March 2026, so a "five business days" window from here lands on the following Monday.
const MONDAY = "2026-03-02T09:00:00.000Z";
const at = (iso: string) => new Date(iso);

describe("who these sweeps chase", () => {
  it("chases the configured member types and nobody else", () => {
    expect(isChaseableMember(member({ member_type: "full" }))).toBe(true);
    expect(isChaseableMember(member({ member_type: "acquaintance" }))).toBe(false);
    expect(isChaseableMember(member({}))).toBe(false);
  });

  it("reads one type out of a member who holds several, without matching a prefix", () => {
    expect(isChaseableMember(member({ member_type: "full, coauthor-major" }))).toBe(true);
    // The list is ["full"] today; a coauthor-minor must not be swept in by "full" or by a
    // substring of a longer type.
    expect(isChaseableMember(member({ member_type: "coauthor-minor" }))).toBe(false);
  });

  it("takes the type list as an argument, so widening it is the only change needed", () => {
    const widened = [...adminBotDormantChaseMemberTypes, "own-pace-advisee", "coauthor-major"];
    const advisee = member({ member_type: "own-pace-advisee" });
    expect(isChaseableMember(advisee)).toBe(false);
    expect(isChaseableMember(advisee, widened)).toBe(true);
    expect(isChaseableMember(member({ member_type: "coauthor-major" }), widened)).toBe(true);
  });

  it("never chases somebody who has left, whatever the type list says", () => {
    // The guard that has to hold when "alumni" is added to the list: it must then mean "an alumnus
    // still holding a lab role", never "chase people who have left".
    const gone = member({ member_type: "full, alumni", status: "alumni" });
    expect(isChaseableMember(gone)).toBe(false);
    expect(isChaseableMember(gone, ["full", "alumni"])).toBe(false);
  });
});

describe("business days", () => {
  it("skips the weekend, so a Thursday welcome is not chased over it", () => {
    // Thursday 5 March -> the fifth business day is Thursday 12 March, not Tuesday 10th.
    expect(businessDaysBetween("2026-03-05T09:00:00.000Z", at("2026-03-10T09:00:00.000Z"))).toBe(3);
    expect(businessDaysBetween("2026-03-05T09:00:00.000Z", at("2026-03-12T09:00:00.000Z"))).toBe(5);
  });

  it("is zero before the clock starts", () => {
    expect(businessDaysBetween(MONDAY, at("2026-03-01T09:00:00.000Z"))).toBe(0);
    expect(businessDaysBetween("not-a-date", at(MONDAY))).toBe(0);
  });
});

describe("engagement", () => {
  it("counts a login or a self-edit, and nothing at all as nothing", () => {
    expect(hasEverEngaged({})).toBe(false);
    expect(hasEverEngaged({ lastLoginAt: MONDAY })).toBe(true);
    expect(hasEverEngaged({ lastSelfEditAt: MONDAY })).toBe(true);
  });

  it("counts the CLI and a day the web app saw them, not only a sign-in", () => {
    // A member who authenticates with an API token never produces a login event; before
    // last_cli_at they read as "never arrived" to every sweep.
    expect(hasEverEngaged({ lastCliAt: MONDAY })).toBe(true);
    expect(hasEverEngaged({ lastSeenAt: MONDAY })).toBe(true);
    expect(engagedSince(MONDAY, { lastCliAt: "2026-03-03T00:00:00.000Z" })).toBe(true);
    expect(engagedSince(MONDAY, { lastCliAt: "2025-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("measures since the welcome, not ever", () => {
    // Re-onboarded after a standing change: last year's sign-in must not switch the new ladder off.
    expect(engagedSince(MONDAY, { lastLoginAt: "2025-01-01T00:00:00.000Z" })).toBe(false);
    expect(engagedSince(MONDAY, { lastLoginAt: "2026-03-03T00:00:00.000Z" })).toBe(true);
  });

  it("reads an unparseable stamp as no activity rather than as activity", () => {
    expect(engagedSince(MONDAY, { lastLoginAt: "whenever" })).toBe(false);
    expect(engagedSince("whenever", { lastLoginAt: MONDAY })).toBe(false);
  });
});

describe("the onboarding ladder", () => {
  const base = { welcomedAt: MONDAY, sentCount: 0, now: at(MONDAY) };

  it("waits five business days before the first reminder", () => {
    // Friday is only four business days in.
    expect(planOnboardingFollowUp({ ...base, now: at("2026-03-06T09:00:00.000Z") })).toEqual({
      due: false,
      reason: "too_soon",
    });
    expect(planOnboardingFollowUp({ ...base, now: at("2026-03-09T09:00:00.000Z") })).toEqual({
      due: true,
      step: "first_reminder",
    });
  });

  it("sends the second reminder three days after the first, not after the welcome", () => {
    const afterFirst = {
      welcomedAt: MONDAY,
      sentCount: 1,
      lastNudgedAt: "2026-03-09T09:00:00.000Z",
    };
    expect(planOnboardingFollowUp({ ...afterFirst, now: at("2026-03-11T09:00:00.000Z") })).toEqual({
      due: false,
      reason: "too_soon",
    });
    expect(planOnboardingFollowUp({ ...afterFirst, now: at("2026-03-12T09:00:00.000Z") })).toEqual({
      due: true,
      step: "second_reminder",
    });
  });

  it("escalates five days after the second reminder, then never again", () => {
    const afterSecond = {
      welcomedAt: MONDAY,
      sentCount: 2,
      lastNudgedAt: "2026-03-12T09:00:00.000Z",
    };
    expect(planOnboardingFollowUp({ ...afterSecond, now: at("2026-03-16T09:00:00.000Z") })).toEqual(
      {
        due: false,
        reason: "too_soon",
      },
    );
    expect(planOnboardingFollowUp({ ...afterSecond, now: at("2026-03-17T09:00:00.000Z") })).toEqual(
      {
        due: true,
        step: "escalate",
      },
    );
    // A repeat escalation is the lab appearing to nag through its professor.
    expect(
      planOnboardingFollowUp({ ...afterSecond, sentCount: 3, now: at("2026-04-01T09:00:00.000Z") }),
    ).toEqual({ due: false, reason: "finished" });
  });

  it("stops the moment the member shows up, at every step", () => {
    for (const sentCount of [0, 1, 2]) {
      expect(
        planOnboardingFollowUp({
          welcomedAt: MONDAY,
          sentCount,
          lastNudgedAt: "2026-03-12T09:00:00.000Z",
          lastLoginAt: "2026-03-13T09:00:00.000Z",
          now: at("2026-04-01T09:00:00.000Z"),
        }),
      ).toEqual({ due: false, reason: "engaged" });
    }
  });

  it("counts an edit as showing up, not only a sign-in", () => {
    expect(
      planOnboardingFollowUp({
        ...base,
        lastSelfEditAt: "2026-03-03T09:00:00.000Z",
        now: at("2026-04-01T09:00:00.000Z"),
      }),
    ).toEqual({ due: false, reason: "engaged" });
  });

  it("holds rather than bursting when a count has no stamp behind it", () => {
    expect(
      planOnboardingFollowUp({
        welcomedAt: MONDAY,
        sentCount: 1,
        now: at("2026-06-01T09:00:00.000Z"),
      }),
    ).toEqual({ due: false, reason: "too_soon" });
  });

  it("slides the ladder along after a missed run instead of firing twice to catch up", () => {
    // The sweep did not run for a fortnight. The second reminder is due once, and the escalation
    // only after the second has actually gone out -- the count is what advances the ladder.
    const late = planOnboardingFollowUp({
      welcomedAt: MONDAY,
      sentCount: 1,
      lastNudgedAt: "2026-03-09T09:00:00.000Z",
      now: at("2026-03-30T09:00:00.000Z"),
    });
    expect(late).toEqual({ due: true, step: "second_reminder" });
  });

  it("takes the plan as an argument, so the gaps can be retuned in one place", () => {
    const plan = { firstChaseBusinessDays: 1, secondChaseDays: 1, escalateAfterDays: 1 } as const;
    expect(planOnboardingFollowUp({ ...base, now: at("2026-03-03T09:00:00.000Z"), plan })).toEqual({
      due: true,
      step: "first_reminder",
    });
    // And the shipped plan is the one the lab stated.
    expect(adminBotOnboardingFollowUpPlan).toEqual({
      firstChaseBusinessDays: 5,
      secondChaseDays: 3,
      escalateAfterDays: 5,
    });
  });
});

describe("the standing engagement reminder", () => {
  const policy = {
    enabled: true,
    inactive_after_days: 14,
    interval_days: 3,
    max_reminders: 2,
    escalate: true,
  };
  const plan = (fields: Partial<Parameters<typeof planEngagementReminder>[0]> = {}) =>
    planEngagementReminder({ policy, sentCount: 0, now: at(MONDAY), laddered: false, ...fields });
  const DAYS_AGO = (days: number) =>
    new Date(at(MONDAY).getTime() - days * 86_400_000).toISOString();

  it("stands aside while the onboarding ladder owns the member", () => {
    // Otherwise a newly welcomed member gets the ladder's reminder and this one in the same week.
    expect(plan({ laddered: true })).toEqual({ due: false, reason: "laddered" });
  });

  it("does nothing for a group the policy switches off", () => {
    expect(plan({ policy: { ...policy, enabled: false } })).toEqual({
      due: false,
      reason: "disabled",
    });
  });

  it("chases somebody who has never been seen anywhere", () => {
    expect(plan()).toEqual({ due: true, step: "remind" });
  });

  it("leaves alone anybody seen inside the threshold, on any channel", () => {
    expect(plan({ lastActiveAt: DAYS_AGO(13) })).toEqual({ due: false, reason: "active" });
    expect(plan({ lastActiveAt: DAYS_AGO(14) })).toEqual({ due: true, step: "remind" });
  });

  it("waits the interval between reminders", () => {
    const sent = { sentCount: 1, lastActiveAt: DAYS_AGO(30) };
    expect(plan({ ...sent, lastNudgedAt: DAYS_AGO(2) })).toEqual({
      due: false,
      reason: "too_soon",
    });
    expect(plan({ ...sent, lastNudgedAt: DAYS_AGO(3) })).toEqual({ due: true, step: "remind" });
  });

  it("escalates once after the last reminder, then stops", () => {
    const spent = { sentCount: 2, lastActiveAt: DAYS_AGO(30), lastNudgedAt: DAYS_AGO(3) };
    expect(plan(spent)).toEqual({ due: true, step: "escalate" });
    // The ledger counts the escalation too, so the next pass sees max + 1.
    expect(plan({ ...spent, sentCount: 3 })).toEqual({ due: false, reason: "finished" });
  });

  it("stops without escalating for a group that never escalates", () => {
    expect(
      plan({
        policy: { ...policy, escalate: false },
        sentCount: 2,
        lastActiveAt: DAYS_AGO(30),
        lastNudgedAt: DAYS_AGO(3),
      }),
    ).toEqual({ due: false, reason: "finished" });
  });

  it("starts a fresh spell when the member came back after the last reminder", () => {
    // Back on day 20 after a reminder on day 25-ago, quiet again since: a new spell, not the tail
    // of an old one that would escalate them on their next month off.
    expect(plan({ sentCount: 2, lastNudgedAt: DAYS_AGO(25), lastActiveAt: DAYS_AGO(20) })).toEqual({
      due: true,
      step: "remind",
      reset: true,
    });
  });

  it("holds rather than bursting when a count has no stamp behind it", () => {
    expect(plan({ sentCount: 1, lastActiveAt: DAYS_AGO(30) })).toEqual({
      due: false,
      reason: "too_soon",
    });
  });

  it("reads an unparseable sighting as no sighting", () => {
    expect(plan({ lastActiveAt: "whenever" })).toEqual({ due: true, step: "remind" });
  });
});

describe("planOnboardingFollowUp — the already-emailed backlog", () => {
  const NOW = new Date("2026-03-02T09:00:00.000Z");

  it("enters at the first reminder when there is no welcome to wait from", () => {
    expect(planOnboardingFollowUp({ alreadyEmailed: true, sentCount: 0, now: NOW })).toEqual({
      due: true,
      step: "first_reminder",
    });
  });

  it("lets a recorded welcome outrank the roster flag", () => {
    // The subtlety worth pinning: a date the trail actually holds is a date the ladder should
    // wait from. Otherwise somebody emailed this morning is chased this afternoon for being a
    // full member.
    expect(
      planOnboardingFollowUp({
        welcomedAt: "2026-03-02T08:00:00.000Z",
        alreadyEmailed: true,
        sentCount: 0,
        now: NOW,
      }),
    ).toEqual({ due: false, reason: "too_soon" });
  });

  it("does nothing for somebody who has had neither an email nor a welcome", () => {
    // Sending the first email is not this function's step to take.
    expect(planOnboardingFollowUp({ sentCount: 0, now: NOW })).toEqual({
      due: false,
      reason: "too_soon",
    });
  });

  it("falls back to 'ever engaged' when there is no welcome to measure since", () => {
    expect(
      planOnboardingFollowUp({
        alreadyEmailed: true,
        lastLoginAt: "2025-01-01T00:00:00.000Z",
        sentCount: 0,
        now: NOW,
      }),
    ).toEqual({ due: false, reason: "engaged" });
  });

  it("keeps measuring the later steps from the last message, not from the flag", () => {
    // The flag only ever answers the first gate. Everything after it is the ordinary ladder.
    expect(
      planOnboardingFollowUp({
        alreadyEmailed: true,
        sentCount: 1,
        lastNudgedAt: "2026-03-01T09:00:00.000Z",
        now: NOW,
        plan: { firstChaseBusinessDays: 5, secondChaseDays: 2, escalateAfterDays: 2 },
      }),
    ).toEqual({ due: false, reason: "too_soon" });
  });
});
