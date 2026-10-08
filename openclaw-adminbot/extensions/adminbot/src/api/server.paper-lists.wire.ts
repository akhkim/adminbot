// What the lab-wide paper boards put on the wire.
//
// The service reads (listPaperSlotOverview, listConferenceRosters, collectPaperNudgeBatches, ...)
// keep their full shapes because the sweeps and their tests reason over them. These projections
// sit at the route instead and keep only what a list draws, since every one of these rows is
// repeated once per paper and the lab's paper count is what grows. Anything a row drops is either
// already on the paper record the page holds from GET /papers, or is read on GET /papers/:id.

import type { AdminBotPaperSlotOverviewRow, AdminBotServiceResponse } from "../kernel/service.js";

/** Reshape a successful payload and pass a failure through untouched, status and all. */
export function mapPayload<T, U>(
  result: AdminBotServiceResponse<T>,
  project: (payload: T) => U,
): AdminBotServiceResponse<U> {
  return result.ok ? { ...result, payload: project(result.payload) } : result;
}

/** One paper's evidence count, as the My Projects cards and the admin next-steps list draw it. */
export type PaperSlotOverviewWireRow = Pick<
  AdminBotPaperSlotOverviewRow,
  | "paper_id"
  | "provided_count"
  | "required_count"
  | "dormant"
  | "closed"
  | "cycle_closed"
  | "missing_slots"
  | "escalating"
>;

/**
 * Title, venue, deadline and step repeat the paper record the page already has, and the
 * attendance tally, acceptance gaps, first author and last-nudged stamp are drawn by nothing that
 * reads this list (the conference roster and the paper's own card carry those). Dropping them
 * takes the row from about 450 to about 120 bytes.
 */
export function slotOverviewWireRow(row: AdminBotPaperSlotOverviewRow): PaperSlotOverviewWireRow {
  return {
    paper_id: row.paper_id,
    provided_count: row.provided_count,
    required_count: row.required_count,
    dormant: row.dormant,
    closed: row.closed,
    cycle_closed: row.cycle_closed,
    missing_slots: row.missing_slots,
    escalating: row.escalating,
  };
}
