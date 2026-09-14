// What the lab says to an author about PaperMentor, and when it says it.
//
// Every paper is reviewed before submission, so the review is a step like any other on the
// checklist -- and three things can be wrong with it that the slot's own status cannot express:
// the draft is somewhere PaperMentor cannot read, the review has never been run, or it was run so
// long ago that it is no longer about the paper that will be submitted.
//
// The first is the one worth catching early. PaperMentor only reads projects on the lab's own
// Overleaf, so a draft on overleaf.com cannot clear this step at all -- and the worst moment to
// discover that is the week of the deadline, which is exactly when somebody would otherwise find
// out. The link is already on the paper, so the lab can say it in week one.
//
// Pure, like the rest of the nudge layer: given a paper's review state and a clock, this says what
// the line in the message should read. The service gathers the state and sends.
import { resolveAdminBotLabOverleafHost } from "../../contracts/overleaf.js";
import type { AdminBotPaperMentorRun } from "../../contracts/papermentor.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a PaperMentor review stays current.
 *
 * Three weeks. A review is about a draft, and a draft three weeks into a writing push is a
 * different paper -- the sections it flagged as thin have usually been rewritten, and the ones
 * written since have never been read. Short enough that the review a paper is submitted on is
 * recognisably about that paper; long enough that a paper being edited daily is not asked to
 * re-run it every week.
 *
 * It is a guess at how fast a draft moves, not a fact about the lab, which is why it is a named
 * constant rather than arithmetic inside the sweep.
 */
export const adminBotPaperMentorFreshnessDays = 21;

/** What the paper carries, as far as the review is concerned. */
export type PaperMentorContext = {
  /**
   * The Overleaf project the paper names, if it names one this deployment recognizes.
   *
   * `lab` is the question that matters: PaperMentor is part of the lab's own Overleaf and cannot
   * read a project hosted anywhere else.
   */
  project?: { lab: boolean; host: string };
  /** The newest review on file, from the ingest. Absent when PaperMentor has never seen it. */
  latest?: AdminBotPaperMentorRun;
};

export type PaperMentorReviewState =
  /** No Overleaf project on the paper yet; the link is its own slot and is chased there. */
  | { kind: "no_project" }
  /** The draft is on an Overleaf PaperMentor cannot read. Nothing else can happen until it moves. */
  | { kind: "unreachable"; host: string }
  /** Reviewable, and never reviewed. */
  | { kind: "never" }
  /** Reviewed, but long enough ago that the review is about an older draft. */
  | { kind: "stale"; reviewed_at: string; days_ago: number }
  | { kind: "fresh"; reviewed_at: string; days_ago: number };

/** Where this paper stands with the reviewer. */
export function paperMentorReviewState(
  context: PaperMentorContext,
  now: Date,
  freshnessDays: number = adminBotPaperMentorFreshnessDays,
): PaperMentorReviewState {
  if (!context.project) {
    return { kind: "no_project" };
  }
  if (!context.project.lab) {
    return { kind: "unreachable", host: context.project.host };
  }
  const latest = context.latest;
  if (!latest) {
    return { kind: "never" };
  }
  const reviewedMs = Date.parse(latest.reviewed_at);
  if (!Number.isFinite(reviewedMs)) {
    return { kind: "never" };
  }
  const daysAgo = calendarDaysBetween(reviewedMs, now);
  return daysAgo >= freshnessDays
    ? { kind: "stale", reviewed_at: latest.reviewed_at, days_ago: daysAgo }
    : { kind: "fresh", reviewed_at: latest.reviewed_at, days_ago: daysAgo };
}

/**
 * Whether to ask about a review the slot already says is done.
 *
 * Only staleness re-opens it. The other unfinished states leave the slot open on their own, so
 * this is the single case where the stored tick and the thing worth saying disagree -- and it is
 * deliberately not a write: a review that happened did happen, and the row should keep saying so.
 */
export function isPaperMentorReviewStale(state: PaperMentorReviewState): boolean {
  return state.kind === "stale";
}

/** The line appended to "PaperMentor review done" in a nudge, or nothing when the label says it all. */
export function paperMentorReviewDetail(
  state: PaperMentorReviewState,
  labHost: string = resolveAdminBotLabOverleafHost(),
): string | undefined {
  switch (state.kind) {
    case "unreachable":
      // The only line here that asks for something other than "run the review": this paper cannot
      // clear the step at all until it moves, and saying so in week one is the whole point.
      return `the draft is on ${state.host}, which PaperMentor cannot read — move the project to ${labHost} first, then run the review from the AI Tutor panel`;
    case "never":
      return "open the project on the lab's Overleaf and run it from the AI Tutor panel";
    case "stale":
      return `the last review was ${agePhrase(state.days_ago)} — run it again so the review is about the draft you will submit`;
    default:
      return undefined;
  }
}

/**
 * The line appended to "Review fixes merged", from what the reviewer actually found.
 *
 * Counts, because counts are what the lab keeps -- and because "PaperMentor left 14 comments, 3 of
 * them critical" is a different ask from "tick this box". Nothing here is the reviewer's prose; the
 * comments are in the author's own project, which is where they are useful.
 */
export function paperMentorFixesDetail(
  run: AdminBotPaperMentorRun | undefined,
  now: Date,
): string | undefined {
  if (!run) {
    return undefined;
  }
  const reviewedMs = Date.parse(run.reviewed_at);
  const when = Number.isFinite(reviewedMs)
    ? agePhrase(calendarDaysBetween(reviewedMs, now))
    : undefined;
  if (run.comments_total === 0) {
    // A clean review still has to be ticked -- "merged" then means "nothing to merge" -- but
    // asking somebody to apply fourteen comments that do not exist would read as a bug.
    return when
      ? `PaperMentor found nothing to fix (${when}); tick this to close the step`
      : "PaperMentor found nothing to fix; tick this to close the step";
  }
  // "3 critical, 5 warnings" -- critical reads as an adjective and is not pluralized, the other two
  // are nouns and are. Written out rather than derived, because a rule that produced "3 criticals"
  // would be a rule that made the lab's own reminders read as machine output.
  const severityLabels: Record<string, (count: number) => string> = {
    critical: (count) => `${count} critical`,
    warning: (count) => `${count} warning${count === 1 ? "" : "s"}`,
    suggestion: (count) => `${count} suggestion${count === 1 ? "" : "s"}`,
  };
  const severities = Object.entries(severityLabels)
    .flatMap(([severity, label]) => {
      const count = run.by_severity[severity] ?? 0;
      return count > 0 ? [label(count)] : [];
    })
    .join(", ");
  const comments = `${run.comments_total} comment${run.comments_total === 1 ? "" : "s"}`;
  return [
    `PaperMentor left ${comments}`,
    when ? ` ${when}` : "",
    severities ? ` (${severities})` : "",
    " — the cheap ones are the ones to merge",
  ].join("");
}

/**
 * Whole calendar days between an instant and now, both floored to their UTC day.
 *
 * Calendar days rather than elapsed hours, because this number is read as a date difference: a
 * review at 11pm and a reminder at 9am the next morning is "yesterday" to the person reading it,
 * and calling it "today" because 22 hours have passed reads as the lab having got the date wrong.
 */
function calendarDaysBetween(fromMs: number, now: Date): number {
  const from = new Date(fromMs);
  const fromDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((today - fromDay) / DAY_MS));
}

/**
 * Whether a new review proves the fixes from the last one were merged.
 *
 * The narrow, defensible inference, and it is deliberately narrow. The ask is "merge the cheap
 * ones", not "fix everything", so a count that merely dropped proves somebody did some work and
 * not that the step is done -- that judgement stays the author's tick. What a machine can say for
 * certain is the other end: the reviewer looked at the draft again and found nothing critical and
 * nothing to warn about. There is nothing left to merge, so the step is finished whether or not
 * anybody remembered to say so.
 *
 * Needs a previous run for the same reason: a first review that happens to come back clean says
 * the paper was already good, not that fixes were merged, and ticking a step nobody ever had to do
 * would make the checklist claim work that never happened.
 */
export function reviewProvesFixesMerged(params: {
  latest: AdminBotPaperMentorRun;
  previous?: AdminBotPaperMentorRun;
}): boolean {
  const { latest, previous } = params;
  if (!previous || previous.id === latest.id) {
    return false;
  }
  const open = (run: AdminBotPaperMentorRun) =>
    (run.by_severity.critical ?? 0) + (run.by_severity.warning ?? 0);
  return open(previous) > 0 && open(latest) === 0;
}

/** "today", "yesterday", "34 days ago" -- the age of a review, as a sentence can use it. */
function agePhrase(days: number): string {
  if (days <= 0) {
    return "today";
  }
  return days === 1 ? "yesterday" : `${days} days ago`;
}
