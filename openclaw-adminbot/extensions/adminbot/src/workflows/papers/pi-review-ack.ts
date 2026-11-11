// "Reviewed" on a My Desk paper row that has no decision of its own to record.
//
// Most of the head professor's queue is information, not a gate: a camera-ready coming due, what
// OpenReview says a submitted paper needs next, a venue whose submission deadline is close. Until
// now none of those rows could be put away, so the queue only ever grew. Acknowledging one moves
// it to the history list with reason `reviewed`.
//
// The acknowledgement is keyed on the row's state, not just the paper: a new OpenReview stage, a
// different proofreading venue or a moved deadline is a different row, so it comes back by itself
// rather than staying hidden because an older version of it was looked at.
//
// Not every row can be acknowledged. The publication gate (arXiv release awaiting her yes), a
// feedback request and a safety impact statement each have their own answer, recorded where the
// authors can see it; hiding them would leave the authors waiting on a yes nobody gave.
import type { PiReviewRow } from "./pi-review.js";

/** The ledger domain the acknowledgements live in (contracts/paper-cycle.ts). */
export const PI_REVIEW_ACK_DOMAIN = "pi_review_ack";

/** Whether this row is information she can put away, rather than a decision only she can make. */
export function isPiReviewRowAckable(row: PiReviewRow): boolean {
  if (row.feedback || row.impact) {
    return false;
  }
  // An arXiv row with no OpenReview reading is the publication gate itself.
  return !(row.category === "arxiv_release" && !row.openreview);
}

/** The row's identity, including the state it was reviewed in. */
export function piReviewAckKey(row: PiReviewRow): string {
  return [
    row.paper_id,
    row.category,
    row.openreview ? `${row.openreview.status}:${row.openreview.stage ?? ""}` : "",
    row.proofreading?.venue ?? "",
    row.hard_deadline ?? "",
  ].join("|");
}

/**
 * Splits the open queue into what still waits on her and what she has already reviewed. The
 * reviewed rows carry `history_reason: "reviewed"` and keep their key so the desk can undo.
 */
export function applyPiReviewAcks(
  rows: readonly PiReviewRow[],
  acked: ReadonlySet<string>,
): { open: PiReviewRow[]; reviewed: PiReviewRow[] } {
  const open: PiReviewRow[] = [];
  const reviewed: PiReviewRow[] = [];
  for (const row of rows) {
    if (isPiReviewRowAckable(row)) {
      const ack_key = piReviewAckKey(row);
      if (acked.has(ack_key)) {
        reviewed.push({ ...row, ack_key, history_reason: "reviewed" });
        continue;
      }
      open.push({ ...row, ack_key });
      continue;
    }
    open.push(row);
  }
  return { open, reviewed };
}
