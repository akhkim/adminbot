// When a paper is finished, and what "finished" is allowed to mean.
//
// The step ladder ends at `poster_making`, but reaching the last step is not the same as being
// done: the poster gets made days before the poster gets presented, and a paper sitting on the
// last step reads as still-in-flight to every count on the page. What actually ends a paper is an
// event nothing in AdminBot can observe -- somebody stood next to it at a conference -- so this
// is a fact a human states, not one the service derives.
//
// The two halves are deliberately split by who knows them:
//
//   accepted    the venue said yes. AdminBot knows this: it is `venue_decision`, recorded when
//               the acceptance mail arrives, and it gates the control.
//   presented   somebody presented it. Nobody but that person knows, so clicking is the record.
//
// Stored as `artifacts.completed_at`, the same free-form map that carries the nudge log, blockers
// and the venue targets, for the same reason: the service merges artifacts on write, so this needs
// no migration and becomes a backfill if `papers.completed_at` ever exists. See venue-targets.ts,
// which made this call first.
import type { AdminBotPaperRecord } from "./controllers/admin.ts";

const ARTIFACT_KEY = "completed_at";

/** When the paper was marked done, or null while it is still in flight. */
export function completedAt(paper: AdminBotPaperRecord): string | null {
  const raw = paper.artifacts?.[ARTIFACT_KEY];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function isPaperCompleted(paper: AdminBotPaperRecord): boolean {
  return completedAt(paper) !== null;
}

/**
 * Papers still in flight, and papers that are done — in that order, both preserving input order.
 *
 * One pass rather than two filters: the card list renders both halves and needs the counts for its
 * headings, and walking the list twice to answer one question is the kind of thing that quietly
 * disagrees with itself once a third state appears.
 */
export function partitionByCompletion(papers: AdminBotPaperRecord[]): {
  ongoing: AdminBotPaperRecord[];
  completed: AdminBotPaperRecord[];
} {
  const ongoing: AdminBotPaperRecord[] = [];
  const completed: AdminBotPaperRecord[] = [];
  for (const paper of papers) {
    (isPaperCompleted(paper) ? completed : ongoing).push(paper);
  }
  return { ongoing, completed };
}

/**
 * Whether the "mark it done" control is offered, and what to say when it is not.
 *
 * Refusing with a reason rather than hiding the button: "why can I not close this paper" is a
 * question people ask of the card, and a control that is simply absent answers it with silence.
 */
export function completionReadiness(paper: AdminBotPaperRecord): {
  ready: boolean;
  reason?: string;
} {
  if (paper.venue_decision === "accept") {
    return { ready: true };
  }
  if (paper.venue_decision === "reject") {
    // A rejected paper is not finished, it is between venues -- the attempt counter exists for
    // exactly this. Completing it here would take it off the list with its work still to do.
    return { ready: false, reason: "Rejected papers go back out to another venue, not to done." };
  }
  return { ready: false, reason: "Available once a venue has accepted the paper." };
}

/** The date a completed card shows. Date only: nobody needs the minute a paper finished. */
export function completedOnLabel(paper: AdminBotPaperRecord): string {
  return completedAt(paper)?.slice(0, 10) ?? "";
}
