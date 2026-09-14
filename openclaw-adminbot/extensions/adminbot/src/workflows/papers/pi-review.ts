// The papers waiting on the one decision AdminBot must never make for itself.
//
// `pi_approval` is PaperFlow's GT gate -- "prepared is not permission" -- and it is the only slot
// owned by the PI. Everything upstream of it can be chased, evidenced and advanced automatically;
// this one is a person saying yes to a paper going public under the lab's name, and nothing here
// ticks it.
//
// What is automated is the *asking*. Until now nothing did: the nudge sweep computed the item,
// resolved its owner to the head professor, and `sendMemberNudge` then refused to message her --
// by design, because the lab does not chase its PI. So the gate sat open with no one told. A paper
// whose package is prepared now signs itself up: it appears in her own queue on My Desk, and she
// is told once that it is there.
//
// Derived, not stored. The queue is a function of the slots, so a paper leaves it the moment she
// ticks the box or an admin waives it, and there is no second list to fall out of step.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";

/** One paper waiting on the PI, with the evidence that says it is ready to be looked at. */
export type PiReviewRow = {
  paper_id: string;
  title: string;
  authors: string[];
  venue?: string;
  /** When the package became ready, from the evidence that made it ready. */
  waiting_since?: string;
  /** The lab's copy of the exact PDF that would be posted, when one is on file. */
  drive_pdf_url?: string;
  /**
   * Whether everything else the arXiv package needs is on file.
   *
   * Not a condition of asking her: the gate is about permission, and a missing paper password is
   * the first author's errand, not a reason to keep the decision waiting. Shown so she can see at
   * a glance whether saying yes finishes the job or starts a chase.
   */
  package_complete: boolean;
};

export type PiReviewCandidate = {
  paper: AdminBotPaperRecord;
  slots: readonly AdminBotPaperSlotRecord[];
};

/**
 * Whether this paper is at the gate: the package is prepared and the yes has not been given.
 *
 * The two conditions are the graph's own -- PK before GT. `authors_ack` is the last thing the
 * authors do to the package, and its own upstream is the Drive copy, so requiring both is
 * requiring the package rather than a single tick.
 */
export function isAwaitingPiReview(slots: readonly AdminBotPaperSlotRecord[]): boolean {
  const status = (slot: string) => slots.find((row) => row.slot === slot)?.status ?? "missing";
  if (isAdminBotPaperSlotSettled(status("pi_approval"))) {
    return false;
  }
  return (
    isAdminBotPaperSlotSettled(status("authors_ack")) &&
    isAdminBotPaperSlotSettled(status("drive_pdf_arxiv"))
  );
}

/** The queue itself, oldest wait first: the paper that has been held up longest is the one to read. */
export function piReviewQueue(candidates: readonly PiReviewCandidate[]): PiReviewRow[] {
  return candidates
    .flatMap((candidate) => {
      if (!isAwaitingPiReview(candidate.slots)) {
        return [];
      }
      const slot = (name: string) => candidate.slots.find((row) => row.slot === name);
      const drivePdf = slot("drive_pdf_arxiv")?.url;
      const waitingSince = slot("authors_ack")?.provided_at;
      const row: PiReviewRow = {
        paper_id: candidate.paper.id,
        title: candidate.paper.title,
        authors: candidate.paper.authors,
        ...(candidate.paper.venue ? { venue: candidate.paper.venue } : {}),
        ...(waitingSince ? { waiting_since: waitingSince } : {}),
        ...(drivePdf ? { drive_pdf_url: drivePdf } : {}),
        package_complete: isAdminBotPaperSlotSettled(
          slot("arxiv_paper_password")?.status ?? "missing",
        ),
      };
      return [row];
    })
    .toSorted(
      (left, right) =>
        (left.waiting_since ?? "9999").localeCompare(right.waiting_since ?? "9999") ||
        left.paper_id.localeCompare(right.paper_id),
    );
}

/**
 * The say-once key for telling her a paper has arrived at the gate.
 *
 * Carries when the package became ready, so a paper that goes round again -- revised, re-prepared
 * after a rejection, the arXiv branch re-opened for a new version -- announces itself again rather
 * than staying silent because it was announced a year ago.
 */
export function piReviewLedgerSubject(row: PiReviewRow): string {
  return `${row.paper_id}|${row.waiting_since ?? "unknown"}`;
}

/** What she is told, once, when a paper reaches the gate. */
export function buildPiReviewNotice(row: PiReviewRow): { title: string; body: string } {
  return {
    title: "A paper is ready for your yes",
    body: [
      `"${row.title}" (${row.authors.join(", ")}) has its arXiv package prepared and is waiting on your approval to post.`,
      row.package_complete
        ? ""
        : "The paper password is not on file yet, so the authors still have that to do.",
      "It is on My Desk, under the papers waiting on you.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
