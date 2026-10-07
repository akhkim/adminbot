// GET /my/projects, cut from service.ts so it stays under its file-size ratchet. The service
// still resolves the member and supplies its own ownership rule; this only lists and summarizes.
import type { AdminBotPaperRecord } from "../contracts/actions.js";
import {
  isProjectActive,
  summarizeProject,
  type AdminBotMyProjectSummary,
} from "../workflows/papers/my-projects.js";
import type { AdminBotServiceStore } from "./service.js";

type ProjectStore = Pick<
  AdminBotServiceStore,
  "listPapers" | "listPaperSlots" | "listSocialDrafts"
>;

/**
 * The member's active projects, each with its open work counted per lane, soonest deadline first.
 *
 * Ownership is the caller's `memberOwnsPaper`, the same rule the write path enforces, so the list
 * never shows a paper its reader could not edit. Hiding a paper is a per-viewer browser preference
 * and is deliberately not applied here: it would hide the paper from every coauthor too.
 */
export function listActiveProjects(
  store: ProjectStore,
  owns: (paper: AdminBotPaperRecord) => boolean,
  nowIso?: string,
): AdminBotMyProjectSummary[] {
  const now = nowIso ? new Date(nowIso) : new Date();
  return store
    .listPapers()
    .filter((paper) => owns(paper) && isProjectActive(paper, now))
    .map((paper) =>
      summarizeProject(paper, store.listPaperSlots(paper.id), store.listSocialDrafts(paper.id)),
    )
    .toSorted((left, right) => (left.deadline ?? "9999").localeCompare(right.deadline ?? "9999"));
}
