// Who has gone quiet, and what the lab does about it.
//
// Two sweeps share this module because they answer the same question at different times. A member
// who has gone quiet is chased on their group's standing policy (contracts/engagement.ts); a member
// who was *just* sent an onboarding email is chased on a ladder that starts five business days later
// and ends on the professor's desk. The second owns anybody it is running for, so the two never both message the
// same person -- which is the whole reason they are planned in one place rather than as two sweeps
// that each try to remember what the other did.
//
// Pure: every input arrives as an argument and the result is a decision, never a send. The service
// does the I/O. That split is what lets the ladder's gaps be tested without a clock or a Slack.

import {
  adminBotDormantChaseMemberTypes,
  adminBotHasMemberType,
  adminBotIsAlumniMember,
  adminBotOnboardingFollowUpPlan,
  type AdminBotLabMember,
} from "../../contracts/actions.js";
import type { AdminBotEngagementPolicyEntry } from "../../contracts/engagement.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Business days between two instants, counting neither endpoint's partial day.
 *
 * A local copy of the service's `countBusinessDays` rather than an import: this module is the pure
 * half and the service is the I/O half, and the dependency runs that way round. Weekends only --
 * the lab has no holiday calendar on file, and inventing one here would make the ladder fire on a
 * different day than anybody expects.
 */
export function businessDaysBetween(startIso: string, now: Date): number {
  const start = new Date(startIso);
  if (!Number.isFinite(start.getTime()) || now.getTime() <= start.getTime()) {
    return 0;
  }
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let days = 0;
  for (let cursor = startDay + DAY_MS; cursor <= endDay; cursor += DAY_MS) {
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      days += 1;
    }
  }
  return days;
}

function calendarDaysBetween(startIso: string, now: Date): number {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) {
    return 0;
  }
  return Math.floor((now.getTime() - start) / DAY_MS);
}

/**
 * Whether this member is one of the ones these sweeps chase at all.
 *
 * Alumni are refused ahead of the type list, the same way `sendMemberNudge` refuses them: somebody
 * who has left is not chased, and that has been a property of the system rather than a per-person
 * choice since long before there was a list. It matters here because `adminBotDormantChaseMemberTypes`
 * is expected to grow an `"alumni"` entry -- and when it does, this line is what keeps it meaning
 * "an alumnus who still holds a lab role", not "chase people who have left".
 */
export function isChaseableMember(
  member: AdminBotLabMember,
  types: readonly string[] = adminBotDormantChaseMemberTypes,
): boolean {
  if (adminBotIsAlumniMember(member)) {
    return false;
  }
  return adminBotHasMemberType(member, types);
}

/** Has this member ever done anything themselves? "Login time == 0" plus the edit case. */
/**
 * The sightings the ladder accepts as "they arrived".
 *
 * Everything `adminBotMemberEngagement` counts except Slack: being active in the lab's Slack says
 * nothing about whether somebody has opened the account the ladder is asking them to open. A CLI
 * token, on the other hand, can only be minted from inside the account, so it is as good as a login.
 */
export type OnboardingSightings = {
  lastLoginAt?: string | undefined;
  lastSelfEditAt?: string | undefined;
  lastSeenAt?: string | undefined;
  lastCliAt?: string | undefined;
};

function sightingsOf(params: OnboardingSightings): Array<string | undefined> {
  return [params.lastLoginAt, params.lastSelfEditAt, params.lastSeenAt, params.lastCliAt];
}

/** Has this member ever done anything themselves, on any channel the ladder accepts? */
export function hasEverEngaged(params: OnboardingSightings): boolean {
  return sightingsOf(params).some((stamp) => Boolean(stamp?.trim()));
}

/**
 * Whether the member has done anything since the welcome went out.
 *
 * "Since", not "ever": somebody re-onboarded after a standing change may well have signed in last
 * year, and a ladder that read that as engagement would never chase the new cycle at all. An
 * unparseable stamp counts as no activity rather than as activity, so a bad date cannot silently
 * switch the ladder off.
 */
export function engagedSince(welcomedAt: string, params: OnboardingSightings): boolean {
  const from = Date.parse(welcomedAt);
  if (!Number.isFinite(from)) {
    return false;
  }
  return sightingsOf(params).some((stamp) => {
    const at = Date.parse(stamp ?? "");
    return Number.isFinite(at) && at >= from;
  });
}

/** Where a member is on the onboarding ladder. */
export type OnboardingFollowUpStep =
  /** First Slack reminder, five business days after the welcome. */
  | "first_reminder"
  /** Second Slack reminder, three days after the first. */
  | "second_reminder"
  /** Both reminders go to the professor's desk; AdminBot stops asking. */
  | "escalate";

/**
 * The ladder's gaps, as a shape rather than as the shipped constant's literal type.
 *
 * `adminBotOnboardingFollowUpPlan` is `as const`, so its type is the three exact numbers. Taking
 * that type here would mean the only plan this function accepts is the one already shipped -- which
 * makes the parameter pointless and the gaps untestable at any other value.
 */
export type OnboardingFollowUpPlan = {
  firstChaseBusinessDays: number;
  secondChaseDays: number;
  escalateAfterDays: number;
};

export type OnboardingFollowUpDecision =
  | { due: false; reason: "engaged" | "too_soon" | "finished" }
  | { due: true; step: OnboardingFollowUpStep };

/**
 * The next move for one member's onboarding ladder, or why there is none.
 *
 * Driven by the ledger's `nudge_count` rather than by a stored step, so the sequence has one
 * source of truth and a re-run cannot advance it twice: the count is only incremented when a
 * message actually went out. Steps are measured from the previous message rather than from the
 * welcome, so a sweep that missed a day slides the rest of the ladder along instead of firing two
 * reminders at once to catch up.
 */
export function planOnboardingFollowUp(params: {
  /**
   * When the onboarding email went out, when the trail records one.
   *
   * Optional only alongside `alreadyEmailed`: the roster knows the lab has emailed hundreds of
   * people whose sends predate the audit trail, and refusing to chase them for want of a timestamp
   * would leave exactly the backlog the ladder is for.
   */
  welcomedAt?: string | undefined;
  lastLoginAt?: string | undefined;
  lastSelfEditAt?: string | undefined;
  lastSeenAt?: string | undefined;
  lastCliAt?: string | undefined;
  /** How many ladder messages have already gone out (the ledger's count). */
  sentCount: number;
  /** When the last ladder message went out. Absent when none has. */
  lastNudgedAt?: string | undefined;
  /**
   * The roster says this person has had the onboarding email, though the trail has no record of it.
   *
   * Only consulted when `welcomedAt` is absent, and that precedence is the whole subtlety. A
   * recorded welcome is a date the ladder can measure five business days from, and it should --
   * somebody emailed by the system on Monday is not overdue on Tuesday for being a full member.
   * This flag is for the other case: the hundreds of people emailed before the trail existed, for
   * whom there is no date to wait from and the only sensible question left is "have they ever
   * signed in?".
   */
  alreadyEmailed?: boolean;
  now: Date;
  plan?: OnboardingFollowUpPlan;
}): OnboardingFollowUpDecision {
  const plan = params.plan ?? adminBotOnboardingFollowUpPlan;
  // Any sign of life ends the ladder, at every step including before the escalation. The ladder
  // exists to reach somebody who has not arrived; once they have, the remaining steps are the lab
  // chasing a person who is already here.
  //
  // "Since the welcome" when there is a welcome to measure from, and "ever" when there is not.
  // The first is the sharper test -- somebody re-onboarded after a standing change may well have
  // signed in last year -- but it needs a date, and for the already-emailed backlog there is none.
  const engaged = params.welcomedAt
    ? engagedSince(params.welcomedAt, params)
    : hasEverEngaged(params);
  if (engaged) {
    return { due: false, reason: "engaged" };
  }
  if (params.sentCount === 0) {
    if (params.welcomedAt) {
      // A recorded welcome wins over the roster flag: it is an actual date, so the actual wait
      // applies. Letting `alreadyEmailed` short-circuit here would fire on somebody the system
      // emailed this morning, purely for being a full member.
      return businessDaysBetween(params.welcomedAt, params.now) >= plan.firstChaseBusinessDays
        ? { due: true, step: "first_reminder" }
        : { due: false, reason: "too_soon" };
    }
    if (params.alreadyEmailed) {
      // Straight in at the first reminder. The wait this skips is a wait for an email they have
      // already had, measured from a date nobody wrote down.
      return { due: true, step: "first_reminder" };
    }
    // No welcome and not emailed: the ladder has not started for this person, and sending the
    // email is not this function's step to take.
    return { due: false, reason: "too_soon" };
  }
  const since = params.lastNudgedAt;
  if (!since) {
    // A count with no stamp predates this sweep, or the stamp was lost. Treated as "not yet due"
    // rather than as due now: the failure mode of an unreadable ledger should be a late reminder,
    // never a burst of them.
    return { due: false, reason: "too_soon" };
  }
  if (params.sentCount === 1) {
    return calendarDaysBetween(since, params.now) >= plan.secondChaseDays
      ? { due: true, step: "second_reminder" }
      : { due: false, reason: "too_soon" };
  }
  if (params.sentCount === 2) {
    return calendarDaysBetween(since, params.now) >= plan.escalateAfterDays
      ? { due: true, step: "escalate" }
      : { due: false, reason: "too_soon" };
  }
  // Escalated already. The professor's desk drains when the member reads the nudge; nothing here
  // escalates a second time, for the reason escalateStaleNudges gives -- a repeat escalation is
  // the lab appearing to nag through its professor.
  return { due: false, reason: "finished" };
}

export type EngagementReminderDecision =
  | {
      due: false;
      reason: "laddered" | "disabled" | "active" | "too_soon" | "finished";
      /** Set when the member has been back since the last reminder: the spell's count restarts. */
      reset?: true;
    }
  | { due: true; step: "remind" | "escalate"; reset?: true };

/**
 * The standing reminder for a member who has gone quiet, under their group's policy.
 *
 * It replaces "has never signed in, every three days, forever" with "has not been seen anywhere for
 * `inactive_after_days`, every `interval_days`, at most `max_reminders` times, then the professor".
 * Three properties the old rule lacked and the sweep depends on:
 *
 * - **Any channel counts.** `lastActiveAt` is `adminBotMemberEngagement`'s, so a member who lives
 *   in the CLI is active, not dormant.
 * - **It ends.** Counted off the ledger's `nudge_count`, the same single source of truth the ladder
 *   uses, so a re-run cannot advance it twice.
 * - **A return restarts it.** Activity after the last reminder means that spell is over; if they go
 *   quiet again it is a new spell with a fresh count, rather than a member who came back once being
 *   escalated the next time they take a month off. The caller writes the reset to the ledger.
 *
 * The caller still owns precedence: `laddered` is true while the onboarding ladder is running for
 * this member, and the ladder wins.
 */
export function planEngagementReminder(params: {
  policy: Pick<
    AdminBotEngagementPolicyEntry,
    "enabled" | "inactive_after_days" | "interval_days" | "max_reminders" | "escalate"
  >;
  lastActiveAt?: string | undefined;
  /** Reminders already sent in this spell (the ledger's count). */
  sentCount: number;
  lastNudgedAt?: string | undefined;
  now: Date;
  laddered: boolean;
}): EngagementReminderDecision {
  if (params.laddered) {
    return { due: false, reason: "laddered" };
  }
  if (!params.policy.enabled) {
    return { due: false, reason: "disabled" };
  }
  const activeAt = params.lastActiveAt ? Date.parse(params.lastActiveAt) : Number.NaN;
  // No sighting at all reads as inactive rather than as "too new to judge". Every member on the
  // roster was invited at some point, and the ladder -- which does wait from the invitation -- has
  // already taken precedence above for anybody recently welcomed.
  if (
    Number.isFinite(activeAt) &&
    params.now.getTime() - activeAt < params.policy.inactive_after_days * DAY_MS
  ) {
    return { due: false, reason: "active" };
  }
  const nudgedAt = params.lastNudgedAt ? Date.parse(params.lastNudgedAt) : Number.NaN;
  const reset = Number.isFinite(activeAt) && Number.isFinite(nudgedAt) && activeAt > nudgedAt;
  const sent = reset ? 0 : params.sentCount;
  const flag = reset ? ({ reset: true } as const) : {};
  if (sent === 0) {
    return { due: true, step: "remind", ...flag };
  }
  if (!Number.isFinite(nudgedAt)) {
    // A count with no readable stamp: late rather than a burst, as in planOnboardingFollowUp.
    return { due: false, reason: "too_soon", ...flag };
  }
  const elapsed =
    calendarDaysBetween(params.lastNudgedAt ?? "", params.now) >= params.policy.interval_days;
  if (sent < params.policy.max_reminders) {
    return elapsed
      ? { due: true, step: "remind", ...flag }
      : { due: false, reason: "too_soon", ...flag };
  }
  if (sent === params.policy.max_reminders && params.policy.escalate) {
    return elapsed
      ? { due: true, step: "escalate", ...flag }
      : { due: false, reason: "too_soon", ...flag };
  }
  // Out of asks, and either escalated already or a group the lab never escalates. One escalation per
  // spell, for the reason the ladder gives: a repeat is the lab nagging through its professor.
  return { due: false, reason: "finished", ...flag };
}
