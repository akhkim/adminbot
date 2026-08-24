import type { AdminBotMemberMilestone } from "../../contracts/actions.js";
import { DEADLINE_VENUES } from "./generated/dataset.js";

const AOE_TIMEZONE = "Etc/GMT+12";

type DeadlineRecord = {
  id: string;
  deadline_id: string;
  name: string;
  deadline_aoe: string;
  link?: string;
  revisions?: readonly { deadline_aoe?: string }[];
};

const deadlines = DEADLINE_VENUES as readonly DeadlineRecord[];
const deadlinesById = new Map(
  deadlines.flatMap((deadline) =>
    [deadline.id, deadline.deadline_id].map((id) => [id, deadline] as const),
  ),
);

function deadlineDate(deadline: DeadlineRecord): string {
  return deadline.deadline_aoe.slice(0, 10);
}

function deadlineMilestone(deadline: DeadlineRecord): AdminBotMemberMilestone {
  const link = deadline.link?.trim();
  return {
    deadline_id: deadline.deadline_id,
    date: deadlineDate(deadline),
    label: deadline.name,
    ...(link ? { link } : {}),
    time: deadline.deadline_aoe.slice(11, 16),
    timezone: AOE_TIMEZONE,
  };
}

function legacyDeadline(row: AdminBotMemberMilestone): DeadlineRecord | undefined {
  const label = row.label.trim();
  const matches = deadlines.filter(
    (deadline) =>
      deadline.name.trim() === label &&
      (deadlineDate(deadline) === row.date ||
        deadline.revisions?.some((revision) => revision.deadline_aoe?.slice(0, 10) === row.date)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function isDeadlineMilestoneId(value: string): boolean {
  return deadlinesById.has(value);
}

/**
 * Refreshes board-linked milestones and performs the one-time label/date migration for old rows.
 *
 * A row without a unique board match stays personal. A linked row whose deadline disappeared also
 * stays intact rather than being deleted: retained history should normally keep it resolvable, but
 * losing a generated record must not erase something a member deliberately put on their timeline.
 */
export function reconcileDeadlineMilestones(
  rows: AdminBotMemberMilestone[] | undefined,
): AdminBotMemberMilestone[] | undefined {
  if (!rows) {
    return undefined;
  }
  const seen = new Set<string>();
  const reconciled: AdminBotMemberMilestone[] = [];
  let changed = false;
  for (const row of rows) {
    const deadline = row.deadline_id ? deadlinesById.get(row.deadline_id) : legacyDeadline(row);
    if (!deadline) {
      reconciled.push(row);
      continue;
    }
    if (seen.has(deadline.deadline_id)) {
      changed = true;
      continue;
    }
    seen.add(deadline.deadline_id);
    const current = deadlineMilestone(deadline);
    if (
      row.deadline_id === current.deadline_id &&
      row.date === current.date &&
      row.label === current.label &&
      row.link === current.link &&
      row.time === current.time &&
      row.timezone === current.timezone
    ) {
      reconciled.push(row);
    } else {
      reconciled.push(current);
      changed = true;
    }
  }
  return changed ? reconciled : rows;
}
