import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import { paperInvolvesMember } from "../../contracts/paper-involvement.js";
import { countNeedleHits, reviewerExemptionReason } from "./openreview-matching.js";

export type PeerReviewDraft = { purpose: string; draft_url: string; nominee_ids: string[] };

/** Private author working copy only. A nomination never creates an invitation or assignment. */
export function parsePeerReviewDraft(value: unknown): PeerReviewDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !["purpose", "draft_url", "nominee_ids"].includes(key)) ||
    typeof data.purpose !== "string" ||
    data.purpose.length > 2000 ||
    typeof data.draft_url !== "string" ||
    data.draft_url.length > 2000 ||
    !Array.isArray(data.nominee_ids) ||
    data.nominee_ids.length > 10 ||
    data.nominee_ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)
  ) {
    return null;
  }
  const draftUrl = data.draft_url.trim();
  if (draftUrl) {
    try {
      const url = new URL(draftUrl);
      if (url.protocol !== "https:" || url.username || url.password) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return {
    purpose: data.purpose.trim(),
    draft_url: draftUrl,
    nominee_ids: [...new Set(data.nominee_ids as string[])],
  };
}

export function nomineeBlockReason(
  member: AdminBotLabMember,
  paper: AdminBotPaperRecord,
): string | undefined {
  if (paperInvolvesMember(paper, member.id, member.name)) {
    return "Author or project participant";
  }
  if (reviewerExemptionReason(member)) {
    return "Unavailable for reviewer nomination";
  }
  return undefined;
}

/** Public research topics only; no OpenReview account requirement or private availability notes. */
export function internalReviewerSuggestions(
  members: readonly AdminBotLabMember[],
  paper: AdminBotPaperRecord,
) {
  const text = paper.title;
  return members
    .filter((member) => !nomineeBlockReason(member, paper))
    .map((member) => {
      const topics = [
        ...new Set(
          [member.research_branch ?? "", ...(member.research_topics ?? [])]
            .map((topic) => topic.trim())
            .filter(Boolean),
        ),
      ];
      const matched_topics = topics.filter((topic) => countNeedleHits(text, [topic]) > 0);
      return { member_id: member.id, name: member.name, matched_topics };
    })
    .filter((row) => row.matched_topics.length)
    .toSorted(
      (a, b) =>
        b.matched_topics.length - a.matched_topics.length ||
        a.name.localeCompare(b.name) ||
        a.member_id.localeCompare(b.member_id),
    )
    .slice(0, 10);
}
