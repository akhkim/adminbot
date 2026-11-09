// What OpenReview has newly said about a lab paper that the head professor should hear.
//
// The author-results snapshot reads every form and reply on the PI's own submissions. Most of it
// is noise to a reader: withdrawal and deletion forms that are always open, comment boxes with no
// deadline, committee-side forms, deadlines a year out that a venue has misconfigured. This module
// keeps the few things that change what the lab has to do -- an author deadline coming up that is
// not yet met, reviews released, a rejection, reviewers or chairs writing back -- and words each
// as one line. The service says each line once (the say-once ledger, keyed by `subject`) and
// gathers a pass's lines into one notification, so a busy review season is one card, not twenty.
//
// Pure on purpose: no store, no clock but the one passed in.

import type { OpenReviewAuthorTask, OpenReviewEvidence } from "./openreview-paper-sync.js";

export type OpenReviewUpdate = {
  /** Say-once key: the same fact on a later pass is not said again. */
  subject: string;
  paper_id: string;
  line: string;
};

/**
 * Deadlines further out than this are not announced yet. They will be, on the first pass inside
 * the window; until then they are either far enough away not to matter or a venue's typo (one
 * ICML 2026 workshop's camera-ready form says it is due in July 2027).
 */
export const OPENREVIEW_TASK_HORIZON_DAYS = 45;

/**
 * A committee comment older than this when first seen is history, not news. It bounds the first
 * pass after deploy, which would otherwise announce every comment ever posted.
 */
export const OPENREVIEW_DISCUSSION_FRESH_DAYS = 7;

const DAY_MS = 86_400_000;

/** "2026-11-19 11:59 UTC": deadlines are minutes-precise and venues set them in odd zones. */
export function openReviewDeadlineText(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function taskLine(task: OpenReviewAuthorTask): string {
  // Most venues leave the form open half an hour past the deadline; only a real grace period,
  // days long, is worth a mention.
  const closes =
    task.closes && Date.parse(task.closes) - Date.parse(task.due) >= DAY_MS
      ? ` (OpenReview accepts it until ${openReviewDeadlineText(task.closes)})`
      : "";
  const progress = task.forms > 1 ? `; ${task.done} of ${task.forms} answered` : "";
  return `${task.name} due ${openReviewDeadlineText(task.due)}${closes}${progress}.`;
}

/**
 * The lines one matched paper contributes on this pass.
 *
 * `stagesClosed` is the PaperFlow stages this pass closed for the paper, and nothing older: a
 * stage proof is recorded once, so a stage in it is news by construction.
 */
export function openReviewUpdatesFor(input: {
  paperId: string;
  evidence: OpenReviewEvidence;
  stagesClosed: readonly string[];
  now: Date;
}): OpenReviewUpdate[] {
  const { paperId, evidence, now } = input;
  const forum = evidence.submission_id ?? evidence.forums[0] ?? "";
  const updates: OpenReviewUpdate[] = [];
  const say = (subject: string, line: string) =>
    updates.push({ subject: `openreview|${paperId}|${subject}`, paper_id: paperId, line });

  // A paper accepted on first sight closes every stage at once; its reviews are not news, and
  // the acceptance has its own camera-ready notice.
  if (evidence.status === "under_review" && input.stagesClosed.includes("reviews_out")) {
    say(`reviews_out|${forum}`, "Reviews are out.");
  }
  if (
    (evidence.status === "rejected" || evidence.status === "desk_rejected") &&
    input.stagesClosed.includes("decision")
  ) {
    say(
      `decision|${forum}`,
      evidence.status === "desk_rejected"
        ? "Desk rejected."
        : "Rejected; the reviews are on OpenReview.",
    );
  }

  const horizon = now.getTime() + OPENREVIEW_TASK_HORIZON_DAYS * DAY_MS;
  for (const task of evidence.author_tasks ?? []) {
    const due = Date.parse(task.due);
    if (!task.open || task.done >= task.forms || due <= now.getTime() || due > horizon) {
      continue;
    }
    say(`task|${forum}|${task.kind}|${task.name}|${task.due}`, taskLine(task));
  }

  const lastAt = evidence.discussion?.last_at;
  if (lastAt && now.getTime() - Date.parse(lastAt) <= OPENREVIEW_DISCUSSION_FRESH_DAYS * DAY_MS) {
    const comments = evidence.discussion?.comments ?? 0;
    say(
      `discussion|${forum}|${lastAt}`,
      `Reviewers or chairs have posted ${comments} comment${comments === 1 ? "" : "s"}; the latest on ${openReviewDeadlineText(lastAt)}.`,
    );
  }
  return updates;
}

const MAX_PAPERS_LISTED = 12;

/** One pass's new lines as one notification, paper by paper, in the order the pass met them. */
export function buildOpenReviewUpdatesNotice(
  updates: readonly OpenReviewUpdate[],
  papers: ReadonlyMap<string, { title: string; venue?: string }>,
): { title: string; body: string } {
  const byPaper = new Map<string, string[]>();
  for (const update of updates) {
    byPaper.set(update.paper_id, [...(byPaper.get(update.paper_id) ?? []), update.line]);
  }
  const sections = [...byPaper].slice(0, MAX_PAPERS_LISTED).map(([paperId, lines]) => {
    const paper = papers.get(paperId);
    const heading = `"${paper?.title ?? paperId}"${paper?.venue ? ` (${paper.venue})` : ""}`;
    return [heading, ...lines.map((line) => `- ${line}`)].join("\n");
  });
  const more = byPaper.size - MAX_PAPERS_LISTED;
  if (more > 0) {
    sections.push(
      `...and ${more} more paper${more === 1 ? "" : "s"}; see each forum on OpenReview.`,
    );
  }
  const count = byPaper.size;
  return {
    title: `OpenReview: news on ${count} paper${count === 1 ? "" : "s"}`,
    body: sections.join("\n\n"),
  };
}
