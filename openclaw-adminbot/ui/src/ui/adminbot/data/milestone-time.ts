// When a venue's non-submission stages (reviews, rebuttal, the conference itself) stop being ahead.
import { aoeInstantMs } from "./deadline-time.ts";
import type { DeadlineMilestone } from "./deadlines.ts";

/**
 * When a stage stops being something still ahead.
 *
 * Schedule dates are calendar days, not AoE timestamps, so a day is spent only once it is over:
 * read as 23:59:59 in the same AoE frame the submissions use. A period ends when its last day
 * does -- a conference running through Friday is still happening on Friday.
 */
export function milestoneEndInstant(milestone: DeadlineMilestone): number {
  if (milestone.planning_at) {
    return Date.parse(milestone.planning_at);
  }
  if (/(?:Z|[+-]\d{2}:\d{2})$/u.test(milestone.date ?? "")) {
    return Date.parse(milestone.date!);
  }
  const value =
    milestone.kind === "period"
      ? (milestone.ends ?? milestone.starts ?? "")
      : (milestone.date ?? "");
  const day = /(\d{4})-(\d{2})-(\d{2})/u.exec(value)?.[0];
  if (!day) {
    return Number.NaN;
  }
  return aoeInstantMs(/[ T]\d{2}:\d{2}/u.test(value) ? value : `${day} 23:59:59`);
}
