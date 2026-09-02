// Who has gone quiet, and what the lab does about it.
//
// Two sweeps share this module because they answer the same question at different times. A member
// who has never signed in is chased on a standing three-day clock; a member who was *just* sent an
// onboarding email is chased on a ladder that starts five business days later and ends on the
// professor's desk. The second owns anybody it is running for, so the two never both message the
// same person -- which is the whole reason they are planned in one place rather than as two sweeps
// that each try to remember what the other did.
//
// Pure: every input arrives as an argument and the result is a decision, never a send. The service
// does the I/O. That split is what lets the ladder's gaps be tested without a clock or a Slack.

import {
  adminBotDormantChaseIntervalDays,
  adminBotDormantChaseMemberTypes,
  adminBotHasMemberType,
  adminBotIsAlumniMember,
  adminBotOnboardingFollowUpPlan,
  type AdminBotLabMember,
} from "../../contracts/actions.js";

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
export function hasEverEngaged(params: {
  lastLoginAt?: string | undefined;
  lastSelfEditAt?: string | undefined;
}): boolean {
  return Boolean(params.lastLoginAt?.trim() || params.lastSelfEditAt?.trim());
}

/**
 * Whether the member has done anything since the welcome went out.
 *
 * "Since", not "ever": somebody re-onboarded after a standing change may well have signed in last
 * year, and a ladder that read that as engagement would never chase the new cycle at all. An
 * unparseable stamp counts as no activity rather than as activity, so a bad date cannot silently
 * switch the ladder off.
 */
export function engagedSince(
  welcomedAt: string,
  params: { lastLoginAt?: string | undefined; lastSelfEditAt?: string | undefined },
): boolean {
  const from = Date.parse(welcomedAt);
  if (!Number.isFinite(from)) {
    return false;
  }
  return [params.lastLoginAt, params.lastSelfEditAt].some((stamp) => {
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
  welcomedAt: string;
  lastLoginAt?: string | undefined;
  lastSelfEditAt?: string | undefined;
  /** How many ladder messages have already gone out (the ledger's count). */
  sentCount: number;
  /** When the last ladder message went out. Absent when none has. */
  lastNudgedAt?: string | undefined;
  now: Date;
  plan?: OnboardingFollowUpPlan;
}): OnboardingFollowUpDecision {
  const plan = params.plan ?? adminBotOnboardingFollowUpPlan;
  // Any sign of life ends the ladder, at every step including before the escalation. The ladder
  // exists to reach somebody who has not arrived; once they have, the remaining steps are the lab
  // chasing a person who is already here.
  if (engagedSince(params.welcomedAt, params)) {
    return { due: false, reason: "engaged" };
  }
  if (params.sentCount === 0) {
    return businessDaysBetween(params.welcomedAt, params.now) >= plan.firstChaseBusinessDays
      ? { due: true, step: "first_reminder" }
      : { due: false, reason: "too_soon" };
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

/**
 * Whether a member who has never signed in is due their standing reminder.
 *
 * Separate from the ladder and deliberately simpler: no steps and no end, because the question it
 * asks ("have you ever been here?") has no deadline attached. The caller is responsible for not
 * running this on somebody the ladder currently owns -- see `dormantChaseDue`'s `laddered` flag.
 */
export function dormantChaseDue(params: {
  lastLoginAt?: string | undefined;
  lastNudgedAt?: string | undefined;
  now: Date;
  /** True while the onboarding ladder is still running for this member; it takes precedence. */
  laddered: boolean;
  intervalDays?: number;
}): boolean {
  if (params.laddered) {
    return false;
  }
  // "Login time == 0". An edit without a sign-in is not enough to clear this one: the reminder is
  // about the account never having been opened, and an admin editing the record on their behalf is
  // exactly the case that must not silently count as the member arriving.
  if (params.lastLoginAt?.trim()) {
    return false;
  }
  if (!params.lastNudgedAt) {
    return true;
  }
  const interval = params.intervalDays ?? adminBotDormantChaseIntervalDays;
  return calendarDaysBetween(params.lastNudgedAt, params.now) >= interval;
}
