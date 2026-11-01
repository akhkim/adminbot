// Which papers PaperMentor should review without being asked, and what to send it.
//
// Every paper is reviewed before submission, and until now that meant an author opening the
// AI Tutor panel and pressing a button. The review step is a step like any other, so the lab can
// run it on the author's behalf the moment a paper reaches it: the edit share link the author
// already gives is enough for the lab's Overleaf to find the project, and the review waits in the
// panel until somebody applies it. Nothing lands in the paper without a person.
//
// Only papers on the lab's own Overleaf. The share link is resolved by the instance that minted
// it, so a draft on overleaf.com cannot be reviewed this way at all -- the slot hint and the nudge
// both say so, in week one.
//
// Pure: given a paper, its rows, its newest review and a clock, this says whether to ask and with
// what. The service makes the request and keeps the record.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import { adminBotOverleafProjectRef, adminBotOverleafShareRef } from "../../contracts/overleaf.js";
import {
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import type { AdminBotPaperMentorRun } from "../../contracts/papermentor.js";
import { isPaperClosed, isPaperDormant } from "./paper-slots.js";
import { paperMentorReviewState } from "./papermentor-nudges.js";

/**
 * How many reviews one pass asks for.
 *
 * A review is a few minutes of a dozen model calls, and the lab's Overleaf runs at most two at a
 * time. A small batch every couple of hours reaches every paper within a day without a backlog
 * ever arriving at once.
 */
export const adminBotPaperMentorAutoReviewLimit = 3;

/** How PaperMentor is told which project to review: the author's own link, or an id already known. */
export type PaperMentorReviewTarget = { share_link: string } | { project_id: string };

export type PaperMentorAutoReviewCandidate = {
  paper_id: string;
  title: string;
  /** Never reviewed, or reviewed long enough ago that the review is about an older draft. */
  reason: "never" | "stale";
  target: PaperMentorReviewTarget;
  /** The panel's venue key, when the paper's venue reads as one ("ICLR 2026" -> iclr_2026). */
  venue?: string;
  /** When the newest review on file ran. */
  reviewed_at?: string;
};

/**
 * Whether to ask PaperMentor to review this paper now, and how to name it.
 *
 * At the review step means: open, not dormant, not yet submitted, and with the review slot either
 * still open or re-opened by staleness -- the same reading the nudge uses, so the lab never runs a
 * review it would not also have asked the author for. A slot an admin waived stays waived, and a
 * review an author ticked by hand is taken at their word.
 */
export function paperMentorAutoReviewCandidate(params: {
  paper: AdminBotPaperRecord;
  slots: readonly AdminBotPaperSlotRecord[];
  latest?: AdminBotPaperMentorRun;
  now: Date;
  env?: NodeJS.ProcessEnv;
}): PaperMentorAutoReviewCandidate | undefined {
  const { paper, slots, latest, now, env } = params;
  if (isPaperClosed(paper) || isPaperDormant(paper, now)) {
    return undefined;
  }
  const row = (slot: string) => slots.find((entry) => entry.slot === slot);
  if (isAdminBotPaperSlotSettled(row("submission")?.status ?? "missing")) {
    return undefined;
  }
  const review = row("papermentor_review")?.status ?? "missing";
  if (review === "waived") {
    return undefined;
  }
  const target = reviewTarget(paper, slots, env);
  if (!target) {
    return undefined;
  }
  const state = paperMentorReviewState(
    { project: { lab: true, host: "" }, ...(latest ? { latest } : {}) },
    now,
  );
  // An open slot is the review step itself; a settled one only re-opens once its review is stale.
  // "never" with a settled slot is an author's own tick, which stands.
  const reason =
    state.kind === "stale"
      ? "stale"
      : state.kind === "never" && !isAdminBotPaperSlotSettled(review)
        ? "never"
        : undefined;
  if (!reason) {
    return undefined;
  }
  const venue = paperMentorVenueKey(paper.venue);
  return {
    paper_id: paper.id,
    title: paper.title,
    reason,
    target,
    ...(venue ? { venue } : {}),
    ...(latest ? { reviewed_at: latest.reviewed_at } : {}),
  };
}

/**
 * The lab's own link to the paper: the edit share link first, then a project link from before
 * the share link replaced it. Links on any other Overleaf are not targets.
 */
function reviewTarget(
  paper: AdminBotPaperRecord,
  slots: readonly AdminBotPaperSlotRecord[],
  env: NodeJS.ProcessEnv | undefined,
): PaperMentorReviewTarget | undefined {
  const share = slots.find((entry) => entry.slot === "overleaf_share");
  const shareRef =
    share?.status === "provided" && share.url
      ? adminBotOverleafShareRef(share.url, env)
      : undefined;
  if (shareRef?.lab) {
    return { share_link: shareRef.url };
  }
  const projectLink =
    slots.find((entry) => entry.slot === "overleaf_edit")?.url ??
    paper.artifacts?.overleaf_edit_url;
  const project = projectLink ? adminBotOverleafProjectRef(projectLink, env) : undefined;
  return project?.lab ? { project_id: project.projectId } : undefined;
}

/**
 * "ICLR 2026" as the panel names it, `iclr_2026`. A guess, and a safe one: the lab's Overleaf
 * only reviews against a venue it has guidelines for and treats anything else as arXiv.
 */
export function paperMentorVenueKey(venue: string | undefined): string | undefined {
  const match = /^\s*([A-Za-z]+)[\s'-]*((?:19|20)\d{2})\b/u.exec(venue ?? "");
  return match ? `${match[1]!.toLowerCase()}_${match[2]}` : undefined;
}

/**
 * The papers to ask about this pass: never-reviewed ones first, since they are the ones the review
 * step is holding up, then the stalest reviews.
 */
export function paperMentorAutoReviewQueue(
  candidates: readonly PaperMentorAutoReviewCandidate[],
): PaperMentorAutoReviewCandidate[] {
  return candidates.toSorted(
    (left, right) =>
      Number(left.reason === "stale") - Number(right.reason === "stale") ||
      (left.reviewed_at ?? "").localeCompare(right.reviewed_at ?? "") ||
      left.paper_id.localeCompare(right.paper_id),
  );
}
