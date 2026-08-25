// A thesis on somebody's own timeline: what to say before it, and who to remind after.
//
// The date is the member's own -- a milestone they put on Time Availability -- rather than a field
// the lab keeps about them. That is the right source and it is also the fragile one: the label is
// free text, so this file is the whole of "what counts as a thesis", and it is deliberately narrow.
//
// Pure. Given a roster and a date, this says what would be sent; the service sends it.
import type { AdminBotMemberMilestone } from "../../contracts/actions.js";

/**
 * What reads as a thesis on a free-text timeline.
 *
 * Thesis and dissertation, and nothing else. A defence is a different event with a different
 * follow-up -- nobody grades a thesis five days after the viva, they grade it before -- so matching
 * it here would send the head professor a reminder about work she has already done. A milestone
 * that says "thesis draft" is deliberately included: a draft deadline is still the date the member
 * is planning back from, and the guidebook reading is the same reading.
 */
const THESIS_LABEL = /\b(thesis|theses|dissertation)\b/iu;

/**
 * How long before the date the member is pointed at the guidebook.
 *
 * Two weeks: long enough that reading the submission rules can still change what they do, short
 * enough that it lands while the thesis is the thing they are working on.
 */
export const adminBotThesisGuidanceLeadDays = 14;

/**
 * How long after the date the head professor is asked to grade.
 *
 * Five days, as asked. Measured from the deadline rather than from a submission, because the lab
 * has no record of the submission itself -- what it knows is when the thesis was due.
 */
export const adminBotThesisGradingDelayDays = 5;

/** The guidebook section about submitting. Named here so changing it is a one-line edit. */
export const adminBotThesisGuidebookSection = "Submitting your thesis";

export type ThesisMilestoneMember = {
  id: string;
  name: string;
  status?: string;
  milestones?: AdminBotMemberMilestone[];
};

export type ThesisMilestone = {
  member_id: string;
  member_name: string;
  label: string;
  /** yyyy-mm-dd, as the member wrote it. */
  date: string;
};

export type ThesisMilestoneAction =
  /** Point the member at the guidebook, because the date is close. */
  | (ThesisMilestone & { kind: "guidance"; days_until: number })
  /** Ask the head professor to grade it, because the date has passed. */
  | (ThesisMilestone & { kind: "grading"; days_since: number });

/** Every thesis-shaped milestone on the roster, for members the lab is still working with. */
export function thesisMilestones(members: readonly ThesisMilestoneMember[]): ThesisMilestone[] {
  return members
    .filter((member) => member.status !== "alumni" && member.status !== "external")
    .flatMap((member) =>
      (member.milestones ?? [])
        .filter((milestone) => THESIS_LABEL.test(milestone.label) && isDate(milestone.date))
        .map((milestone) => ({
          member_id: member.id,
          member_name: member.name,
          label: milestone.label.trim(),
          date: milestone.date,
        })),
    )
    .toSorted(
      (left, right) =>
        left.date.localeCompare(right.date) || left.member_id.localeCompare(right.member_id),
    );
}

/**
 * What is due to be said today.
 *
 * Both windows are open-ended on the late side: a sweep that only fires on exactly day 14 or
 * exactly day 5 misses every date the cron ran late for, and the ledger is what stops the open end
 * becoming a daily repeat.
 */
export function thesisMilestoneActions(
  milestones: readonly ThesisMilestone[],
  now: Date,
): ThesisMilestoneAction[] {
  const actions: ThesisMilestoneAction[] = [];
  for (const milestone of milestones) {
    const days = daysUntil(milestone.date, now);
    if (days >= 0 && days <= adminBotThesisGuidanceLeadDays) {
      actions.push({ ...milestone, kind: "guidance", days_until: days });
      continue;
    }
    if (days < 0 && -days >= adminBotThesisGradingDelayDays) {
      actions.push({ ...milestone, kind: "grading", days_since: -days });
    }
  }
  return actions;
}

/** The ledger subject. Keyed by the date, so moving a thesis re-arms both messages. */
export function thesisLedgerSubject(action: ThesisMilestoneAction): string {
  return `thesis|${action.kind}|${action.member_id}|${action.date}`;
}

/** What the member is told as the date approaches. */
export function buildThesisGuidanceMessage(
  action: ThesisMilestone & { days_until: number },
): string {
  const when =
    action.days_until === 0
      ? "today"
      : action.days_until === 1
        ? "tomorrow"
        : `in ${action.days_until} days`;
  return [
    `Your "${action.label}" milestone is ${when}.`,
    "",
    `The guidebook's "${adminBotThesisGuidebookSection}" section covers what the lab needs and when.`,
    "",
    "If the date has moved, update it on Time Availability and I will follow it.",
  ].join("\n");
}

/**
 * What the head professor is asked, once the date has passed.
 *
 * Addressed to her about them, unlike the escalation DM: this is a task of hers, not a conversation
 * with the member -- and a student who has just submitted does not need to watch their supervisor
 * being reminded to mark it.
 */
export function buildThesisGradingMessage(
  actions: ReadonlyArray<ThesisMilestone & { days_since: number }>,
): string {
  return [
    actions.length === 1
      ? "A thesis deadline has passed and is ready to look at:"
      : "These thesis deadlines have passed and are ready to look at:",
    "",
    ...actions.map(
      (action) =>
        `• ${action.member_name} — "${action.label}", due ${action.date} (${action.days_since} days ago)`,
    ),
  ].join("\n");
}

function isDate(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

/**
 * Whole days from now until a calendar date.
 *
 * Both sides are floored to a UTC day before subtracting. Comparing an instant against a date would
 * make "is the thesis today" depend on the hour the cron happened to run.
 */
function daysUntil(date: string, now: Date): number {
  const target = Date.parse(`${date}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}
