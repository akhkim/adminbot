import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotSocialDraftRecord } from "../../contracts/paper-cycle.js";
import {
  adminBotPaperSlotChartOrder,
  adminBotPaperSlotRegistry,
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlotBranch,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import { readPaperVenueTargets, type AdminBotVenueTarget } from "../../contracts/venue-targets.js";
import { isPaperClosed, isPaperDormant, paperSlotRows } from "./paper-slots.js";

/** One open item on a project. `ready` means nothing upstream is still missing. */
export type AdminBotProjectTodo = {
  id: string;
  label: string;
  lane: AdminBotPaperSlotBranch;
  ready: boolean;
};

export type AdminBotProjectLaneCount = { open: number; ready: number };

/**
 * A member's project as the sidebar and the project cards draw it.
 *
 * Deliberately small: the per-project page reads the full cycle from `GET /papers/:id/slots`, so
 * this carries only what a list needs -- where the paper is going and what is still open per lane.
 */
export type AdminBotMyProjectSummary = {
  paper_id: string;
  title: string;
  alias?: string;
  venue?: string;
  deadline?: string;
  venue_decision?: string;
  current_step: string;
  venue_targets: AdminBotVenueTarget[];
  provided_count: number;
  required_count: number;
  lanes: Record<AdminBotPaperSlotBranch, AdminBotProjectLaneCount>;
  todos: AdminBotProjectTodo[];
};

/**
 * Active means somebody still works on it: not dormant, not rejected, and not marked complete.
 * `completed_at` is the author's own "this one is done" switch, stored on the record's artifacts.
 */
export function isProjectActive(paper: AdminBotPaperRecord, now: Date): boolean {
  // `completed_at` rides in the free-form artifacts map, which the service merges on write.
  const completedAt = (paper.artifacts as Record<string, unknown> | undefined)?.completed_at;
  return !isPaperDormant(paper, now) && !isPaperClosed(paper) && !completedAt;
}

export function summarizeProject(
  paper: AdminBotPaperRecord,
  stored: AdminBotPaperSlotRecord[],
  drafts: AdminBotSocialDraftRecord[],
): AdminBotMyProjectSummary {
  const rows = paperSlotRows(paper.id, stored, drafts);
  const settled = new Set(
    rows.filter((row) => isAdminBotPaperSlotSettled(row.status)).map((row) => row.slot),
  );
  const required = rows.filter((row) => adminBotPaperSlotRegistry[row.slot].required);
  const todos: AdminBotProjectTodo[] = required
    .filter((row) => !settled.has(row.slot))
    .map((row) => {
      const definition = adminBotPaperSlotRegistry[row.slot];
      return {
        id: row.slot,
        label: definition.label,
        lane: definition.branch,
        ready: definition.upstream.every((slot) => settled.has(slot)),
      };
    });
  // The venue answers on its own clock, but until it does the venue lane is not finished.
  if (settled.has("submission") && (paper.venue_decision ?? "pending") === "pending") {
    todos.push({ id: "venue_decision", label: "Venue decision", lane: "venue", ready: false });
  }
  todos.sort((left, right) => Number(right.ready) - Number(left.ready));
  const lanes = Object.fromEntries(
    adminBotPaperSlotChartOrder.map((lane) => {
      const open = todos.filter((todo) => todo.lane === lane);
      return [lane, { open: open.length, ready: open.filter((todo) => todo.ready).length }];
    }),
  ) as Record<AdminBotPaperSlotBranch, AdminBotProjectLaneCount>;
  return {
    paper_id: paper.id,
    title: paper.title,
    ...(paper.alias ? { alias: paper.alias } : {}),
    ...(paper.venue ? { venue: paper.venue } : {}),
    ...(paper.deadline ? { deadline: paper.deadline } : {}),
    ...(paper.venue_decision ? { venue_decision: paper.venue_decision } : {}),
    current_step: paper.current_step,
    venue_targets: readPaperVenueTargets(paper),
    provided_count: required.filter((row) => settled.has(row.slot)).length,
    required_count: required.length,
    lanes,
    todos,
  };
}
