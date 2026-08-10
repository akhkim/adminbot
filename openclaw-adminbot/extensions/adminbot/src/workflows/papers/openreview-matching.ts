// Matching lab members to papers by research focus. This is the one matcher in the
// service: `listPapersRelevantToMember` (the member-facing "papers relevant to me"
// list) and the emergency-reviewer suggester both call it, so the two views can never
// disagree about what "relevant" means.

import type { AdminBotLabMember } from "../../contracts/actions.js";
import { fullyAwayOn } from "../members/availability.js";

// A member's research focus, flattened to lowercase substrings. The member's own name
// is included deliberately: it makes them match papers they are already an author on,
// which is what the member-facing "relevant papers" list wants — and which the reviewer
// suggester below then excludes as a conflict.
export function memberRelevanceNeedles(member: AdminBotLabMember): string[] {
  const values = [
    member.name,
    member.research_branch,
    ...(member.research_topics ?? []),
    ...(member.projects ?? []),
  ];
  return values
    .flatMap((value) => (typeof value === "string" ? [value.trim().toLowerCase()] : []))
    .filter((value) => value.length > 0);
}

export function textMatchesNeedles(text: string, needles: readonly string[]): boolean {
  return countNeedleHits(text, needles) > 0;
}

// Needles match on word boundaries, not as bare substrings. Plain `includes` makes any
// short needle — a two-letter surname, a one-word project name — match inside unrelated
// words ("Li" in "quality"), which floods both the member-facing relevant-papers list and
// the reviewer suggestions with noise. Lookarounds rather than \b so needles ending in
// punctuation ("c++") still behave.
function needlePattern(needle: string): RegExp {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
}

// Hit count, not just a boolean, so candidates can be ranked: a member matching three
// of a paper's topics is a better emergency reviewer than one matching a single word.
export function countNeedleHits(text: string, needles: readonly string[]): number {
  if (needles.length === 0) {
    return 0;
  }
  return needles.filter((needle) => needlePattern(needle).test(text)).length;
}

export type AdminBotOpenReviewSubmissionSummary = {
  number: number;
  title: string;
  abstract?: string;
  keywords?: string[];
  // Tilde ids already assigned to this submission, so they are not suggested again.
  assigned_reviewers?: string[];
};

export type AdminBotReviewerSuggestionOptions = {
  limit?: number;
  // Today, for resolving which availability period is in force. Injected so the ranking
  // is deterministic in tests rather than depending on when they run.
  todayIso?: string;
  // The OpenReview profile the automation runs as. Whoever is chairing a submission can
  // never be one of its reviewers, so this is derived rather than configured.
  operatorOpenReviewId?: string;
};

// Why a member can never be an emergency reviewer, as opposed to merely being a poor
// match. Returned to the caller so the assignment route can refuse the same people the
// suggester greys out, instead of each surface deciding for itself.
export function reviewerExemptionReason(
  member: AdminBotLabMember,
  operatorOpenReviewId?: string,
): string | undefined {
  if (member.reviewer_exempt) {
    return "exempt from reviewer assignment";
  }
  if (operatorOpenReviewId && member.openreview_id === operatorOpenReviewId) {
    return "is the profile chairing this venue";
  }
  return undefined;
}

export type AdminBotReviewerSuggestion = {
  member_id: string;
  name: string;
  openreview_id?: string;
  score: number;
  matched_on: string[];
  // Populated when the member cannot actually be assigned; the UI shows them greyed
  // out with the reason rather than hiding them, so "why isn't X suggested?" is answerable.
  blocked_reason?: string;
};

const UNAVAILABLE_STATUSES = new Set(["on_leave", "alumni"]);

// Ranked Jinesis members for an unreviewed submission. Availability and conflicts are
// reported rather than filtered, because the AC making the call needs to see that the
// obvious expert is on leave.
export function suggestReviewersForSubmission(
  members: readonly AdminBotLabMember[],
  submission: AdminBotOpenReviewSubmissionSummary,
  options: AdminBotReviewerSuggestionOptions = {},
): AdminBotReviewerSuggestion[] {
  const text = [submission.title, submission.abstract ?? "", ...(submission.keywords ?? [])].join(
    "\n",
  );
  const assigned = new Set(submission.assigned_reviewers ?? []);
  const suggestions: AdminBotReviewerSuggestion[] = [];

  for (const member of members) {
    const needles = memberRelevanceNeedles(member);
    const matched = needles.filter((needle) => countNeedleHits(text, [needle]) > 0);
    if (matched.length === 0) {
      continue;
    }
    const nameHit = member.name.trim().toLowerCase();
    // A name hit means the member is on the paper — an author, not a reviewer.
    const isAuthor = Boolean(nameHit) && matched.includes(nameHit);
    const exempt = reviewerExemptionReason(member, options.operatorOpenReviewId);
    const away = options.todayIso ? fullyAwayOn(member, options.todayIso) : undefined;
    const blocked = exempt
      ? exempt
      : away
        ? `away from the lab${away.note ? ` (${away.note})` : ""}`
        : isAuthor
          ? "appears to be an author on this submission"
          : member.openreview_id && assigned.has(member.openreview_id)
            ? "already assigned to this submission"
            : UNAVAILABLE_STATUSES.has(member.status ?? "")
              ? `unavailable (${member.status})`
              : !member.openreview_id
                ? "no openreview_id on file — add one before assigning"
                : undefined;
    suggestions.push({
      member_id: member.id,
      name: member.name,
      openreview_id: member.openreview_id,
      // The name hit is an authorship signal, not topical expertise, so it never
      // contributes to the score.
      score: matched.filter((needle) => needle !== nameHit).length,
      matched_on: matched.filter((needle) => needle !== nameHit),
      blocked_reason: blocked,
    });
  }

  return suggestions
    .toSorted((left, right) => {
      const blockedDelta =
        Number(Boolean(left.blocked_reason)) - Number(Boolean(right.blocked_reason));
      return blockedDelta !== 0
        ? blockedDelta
        : right.score - left.score || left.name.localeCompare(right.name);
    })
    .slice(0, options.limit ?? 10);
}
