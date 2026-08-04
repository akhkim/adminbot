// When each reviewing-cycle reminder fires, and what it says. Pure functions over a
// clock: no I/O, no state, so the whole escalation ladder is unit-testable without
// touching OpenReview.
//
// The ladder tightens logarithmically toward the deadline and then turns punitive:
//   halfway            -> "plenty of time, but start"
//   7/4/2/1/0.5 days   -> reminders, only to people who still owe a review
//   +1/+2/+4/+7 days   -> overdue warnings, escalating in tone
// Who gets the message depends on the role being served: an AC nudges their reviewers
// directly, an SAC nudges the ACs who in turn hold the reviewers.

export type AdminBotOpenReviewRole = "reviewer" | "ac" | "sac";

export type AdminBotOpenReviewMilestoneKind = "halfway" | "pre" | "overdue";

export const PRE_DEADLINE_DAYS = [7, 4, 2, 1, 0.5] as const;
export const OVERDUE_DAYS = [1, 2, 4, 7] as const;

const DAY_MS = 86_400_000;

// A milestone stays eligible for this long after its moment passes. Long enough that a
// missed run (box asleep, timer failure) still fires it on the next 6-hourly tick,
// short enough that a venue discovered late doesn't replay a whole cadence at once —
// only the milestones whose windows are genuinely still open fire.
const WINDOW_MS = 12 * 60 * 60 * 1000;

export type AdminBotOpenReviewCycle = {
  venue_id: string;
  role: AdminBotOpenReviewRole;
  deadline_ms: number;
  cycle_start_ms: number | null;
};

export type AdminBotOpenReviewMilestone = {
  // Stable identity of this milestone within (venue, role). Persisted under a unique
  // index, which is what makes sending idempotent across runs and restarts.
  key: string;
  kind: AdminBotOpenReviewMilestoneKind;
  // Days relative to the deadline: positive before, negative after. 0 for halfway.
  offset_days: number;
  due_at_ms: number;
};

export function milestonesFor(cycle: AdminBotOpenReviewCycle): AdminBotOpenReviewMilestone[] {
  const milestones: AdminBotOpenReviewMilestone[] = [];
  const start = cycle.cycle_start_ms;
  if (typeof start === "number" && start < cycle.deadline_ms) {
    milestones.push({
      key: "halfway",
      kind: "halfway",
      offset_days: 0,
      due_at_ms: start + Math.floor((cycle.deadline_ms - start) / 2),
    });
  }
  for (const days of PRE_DEADLINE_DAYS) {
    milestones.push({
      key: `pre-${days}`,
      kind: "pre",
      offset_days: days,
      due_at_ms: cycle.deadline_ms - days * DAY_MS,
    });
  }
  for (const days of OVERDUE_DAYS) {
    milestones.push({
      key: `overdue-${days}`,
      kind: "overdue",
      offset_days: -days,
      due_at_ms: cycle.deadline_ms + days * DAY_MS,
    });
  }
  return milestones.toSorted((left, right) => left.due_at_ms - right.due_at_ms);
}

// The milestones that should fire right now: their moment has arrived, their window has
// not closed, and they have not already fired for this (venue, role).
export function dueMilestones(
  cycle: AdminBotOpenReviewCycle,
  nowMs: number,
  firedKeys: ReadonlySet<string>,
): AdminBotOpenReviewMilestone[] {
  return milestonesFor(cycle).filter(
    (milestone) =>
      !firedKeys.has(milestone.key) &&
      nowMs >= milestone.due_at_ms &&
      nowMs < milestone.due_at_ms + WINDOW_MS,
  );
}

// Milestones whose window closed unfired. Not sent — surfaced, so a silent gap in the
// ladder is visible rather than looking like nobody needed reminding.
export function missedMilestones(
  cycle: AdminBotOpenReviewCycle,
  nowMs: number,
  firedKeys: ReadonlySet<string>,
): AdminBotOpenReviewMilestone[] {
  return milestonesFor(cycle).filter(
    (milestone) => !firedKeys.has(milestone.key) && nowMs >= milestone.due_at_ms + WINDOW_MS,
  );
}

// Overdue warnings and everything an SAC sends late in the cycle carry real social
// weight, so they wait for a human. Routine reminders do not — see the auto-approval
// reasoning on sendMemberNudge in service-core.ts.
export function requiresApproval(milestone: AdminBotOpenReviewMilestone): boolean {
  return milestone.kind === "overdue";
}

function formatDeadline(deadlineMs: number): string {
  return new Date(deadlineMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function describeRemaining(milestone: AdminBotOpenReviewMilestone): string {
  if (milestone.kind === "overdue") {
    const days = Math.abs(milestone.offset_days);
    return days === 1 ? "1 day past" : `${days} days past`;
  }
  if (milestone.offset_days === 0.5) {
    return "about 12 hours";
  }
  return milestone.offset_days === 1 ? "1 day" : `${milestone.offset_days} days`;
}

export type AdminBotOpenReviewMessageContext = {
  venue_title: string;
  submission_number: number;
  submission_title: string;
  deadline_ms: number;
  // How many of this submission's reviews are still outstanding.
  missing_count: number;
};

export type AdminBotOpenReviewMessage = { subject: string; body: string };

// One template table, keyed by (role, kind). Recipients are always OpenReview group ids
// resolved by the caller, so the wording never names an individual — reviewers are
// anonymous to the AC sending this.
export function renderMilestoneMessage(
  role: AdminBotOpenReviewRole,
  milestone: AdminBotOpenReviewMilestone,
  context: AdminBotOpenReviewMessageContext,
): AdminBotOpenReviewMessage {
  const paper = `Submission ${context.submission_number}${
    context.submission_title ? ` ("${context.submission_title}")` : ""
  }`;
  const deadline = formatDeadline(context.deadline_ms);
  const remaining = describeRemaining(milestone);

  if (role === "sac") {
    if (milestone.kind === "halfway") {
      return {
        subject: `[${context.venue_title}] Halfway to the review deadline — please nudge your reviewers`,
        body: [
          `We are halfway through the reviewing period for ${paper}.`,
          "",
          `${context.missing_count} review(s) are still outstanding on this paper. Could you check in with your reviewers now, while there is still time for them to do a careful job? A nudge at this point is far more effective than one in the last 48 hours.`,
          "",
          `Review deadline: ${deadline}.`,
          "",
          "Thank you for your work on this.",
        ].join("\n"),
      };
    }
    if (milestone.kind === "pre") {
      return {
        subject: `[${context.venue_title}] ${remaining} left — ${context.missing_count} review(s) still missing`,
        body: [
          `${paper} still has ${context.missing_count} outstanding review(s), with ${remaining} until the deadline.`,
          "",
          "Please chase your assigned reviewers directly. If any of them has gone silent or told you they cannot complete the review, now is the time to line up an emergency replacement rather than waiting for the deadline to pass.",
          "",
          `Review deadline: ${deadline}.`,
        ].join("\n"),
      };
    }
    return {
      subject: `[${context.venue_title}] OVERDUE (${remaining}) — ${context.missing_count} review(s) missing`,
      body: [
        `The review deadline for ${paper} passed ${remaining} and ${context.missing_count} review(s) are still missing.`,
        "",
        "This is now blocking the discussion phase. Please either secure the outstanding review(s) immediately or replace the reviewer with an emergency reviewer today, and let me know which you are doing.",
        "",
        `Review deadline was: ${deadline}.`,
      ].join("\n"),
    };
  }

  // AC (and the reviewer-role case, which is only ever a self-reminder) speaking to reviewers.
  if (milestone.kind === "halfway") {
    return {
      subject: `[${context.venue_title}] Halfway to the review deadline for ${paper}`,
      body: [
        `We are halfway through the reviewing period for ${paper}, which is assigned to you.`,
        "",
        "If you are able to submit early, please do — it gives the authors and the rest of the committee more room during the discussion phase, and it means one less thing on your plate as the deadline approaches.",
        "",
        `Review deadline: ${deadline}.`,
        "",
        "If anything about the assignment is a problem (conflict, expertise mismatch, or you simply cannot make the deadline), tell me now rather than later and I will find a replacement.",
      ].join("\n"),
    };
  }
  if (milestone.kind === "pre") {
    return {
      subject: `[${context.venue_title}] ${remaining} until the review deadline — ${paper}`,
      body: [
        `A reminder that your review for ${paper} has not been submitted yet, and there ${
          milestone.offset_days === 1 ? "is" : "are"
        } ${remaining} until the deadline.`,
        "",
        "If you can submit sooner than the deadline, please do.",
        "",
        `Review deadline: ${deadline}.`,
        "",
        "If you cannot complete this review, reply now so I can assign an emergency reviewer — a late notice is much easier to handle than a missing review.",
      ].join("\n"),
    };
  }
  return {
    subject: `[${context.venue_title}] OVERDUE by ${remaining} — review for ${paper}`,
    body: [
      `Your review for ${paper} is now ${remaining} overdue.`,
      "",
      "A missing review holds up the authors, the other reviewers, and the discussion phase for everyone assigned to this paper. Please submit it today.",
      "",
      "If you are not going to complete it, say so explicitly right now so I can find an emergency reviewer. Silence is the one response I cannot work with.",
      "",
      `Review deadline was: ${deadline}.`,
    ].join("\n"),
  };
}
