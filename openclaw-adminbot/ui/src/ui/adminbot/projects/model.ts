// My Projects & Papers: the lanes a project moves along, where each project lives in the URL, and
// which papers count as the viewer's own.
//
// A project is one paper record. Its work splits into five lanes, which are the service's slot
// branches (contracts/paper-slots.ts) under the names authors use for them.
import type { AdminBotPaperSlotBranch } from "../../../../../extensions/adminbot/src/contracts/paper-slots.js";
import { isSamePerson } from "../../../../../extensions/adminbot/src/contracts/person-names.js";
import type { AdminBotMyProjectSummary } from "../../../../../extensions/adminbot/src/workflows/papers/my-projects.js";
import type { AppViewState } from "../../app-view-state.ts";
import type { AdminBotPaperRecord, AdminBotPaperStep } from "../controllers/admin.ts";
import { paperSteps, stepLabels } from "../data/paper-steps.ts";
import { findOwnMember } from "../views/profile-fields.ts";

export type { AdminBotMyProjectSummary as ProjectSummary };

export type ProjectLane = {
  branch: AdminBotPaperSlotBranch;
  /** The tab's URL segment. */
  segment: string;
  label: string;
  /** The hover legend on a lane dot. */
  legend: string;
};

/** In the order the work happens, which is also the order of the tabs and the dots. */
export const PROJECT_LANES: readonly ProjectLane[] = [
  {
    branch: "core",
    segment: "writing",
    label: "Writing",
    legend: "Writing: the draft, Overleaf, review fixes, a clean PDF",
  },
  {
    branch: "venue",
    segment: "venue",
    label: "Venue & submission",
    legend: "Venue: the submission and the venue's decision",
  },
  {
    branch: "archive",
    segment: "archival",
    label: "Archival",
    legend: "Archival: the Drive copy, author list, PI approval, arXiv",
  },
  {
    branch: "talk",
    segment: "talk",
    label: "Talk",
    legend: "Talk: slides, poster, and the talk video",
  },
  {
    branch: "social",
    segment: "social",
    label: "Social",
    legend: "Social: the X and LinkedIn posts, signed off by coauthors",
  },
];

export type ProjectTab = "project" | ProjectLane["segment"];

export type ProjectRoute = { paperId: string | null; tab: ProjectTab };

export const PROJECTS_BASE_PATH = "/my-work";

/**
 * Where the URL says the viewer is: `/my-work` is the card list, `/my-work/<paper>` a project,
 * `/my-work/<paper>/<lane>` one of its tabs. An unknown lane falls back to the project tab rather
 * than to nothing, so an old or mistyped link still lands on the paper.
 */
export function projectRouteFromPath(pathname: string, basePath = ""): ProjectRoute {
  const rest = pathname.slice(basePath.length).replace(/\/+$/u, "");
  if (!rest.startsWith(`${PROJECTS_BASE_PATH}/`)) {
    return { paperId: null, tab: "project" };
  }
  const [paperId = "", segment = ""] = rest.slice(PROJECTS_BASE_PATH.length + 1).split("/");
  const tab = PROJECT_LANES.find((lane) => lane.segment === segment)?.segment ?? "project";
  return { paperId: paperId ? decodeURIComponent(paperId) : null, tab };
}

export function projectPath(
  paperId: string | null,
  tab: ProjectTab = "project",
  basePath = "",
): string {
  if (!paperId) {
    return `${basePath}${PROJECTS_BASE_PATH}`;
  }
  const paper = `${basePath}${PROJECTS_BASE_PATH}/${encodeURIComponent(paperId)}`;
  return tab === "project" ? paper : `${paper}/${tab}`;
}

/** Moves within My Projects without leaving the tab: a history entry, then a re-render. */
export function navigateToProject(
  state: AppViewState,
  paperId: string | null,
  tab: ProjectTab = "project",
): void {
  const target = projectPath(paperId, tab, state.basePath);
  if (state.tab !== "myWork") {
    // Switching tabs writes `/my-work` into history itself; this entry replaces that one, so Back
    // returns to the tab the viewer came from rather than to an empty card list.
    state.setTab("myWork");
    window.history.replaceState({}, "", target);
  } else if (window.location.pathname !== target) {
    window.history.pushState({}, "", target);
  }
  (state as { requestUpdate?: () => void }).requestUpdate?.();
}

/** Which lanes still have work open, in lane order. A lane with nothing open has no dot. */
export function openLanes(summary: AdminBotMyProjectSummary) {
  return PROJECT_LANES.filter((lane) => summary.lanes[lane.branch].open > 0).map((lane) => {
    const { open, ready } = summary.lanes[lane.branch];
    return { lane, open, ready };
  });
}

export function laneDotTitle(lane: ProjectLane, open: number, ready: number): string {
  const now = ready > 0 ? `, ${ready} can be done now` : ", waiting on earlier steps";
  return `${lane.legend}. ${open} open${now}.`;
}

/** "99% ICLR 2027 · 30% NeurIPS", or the record's own venue, or nothing yet. */
export function venuePosition(summary: AdminBotMyProjectSummary): string {
  if (summary.venue_decision === "accept") {
    return `Accepted${summary.venue ? ` at ${summary.venue}` : ""}`;
  }
  if (summary.venue_targets.length > 0) {
    return summary.venue_targets
      .map((target) => `${Math.round(target.confidence)}% ${target.label}`)
      .join(" · ");
  }
  return summary.venue ? `Aiming at ${summary.venue}` : "No venue picked yet";
}

/**
 * The papers that are the viewer's own, read from the lab list the page already holds. Used where
 * the full record is needed; the active list itself comes from the service (`GET /my/projects`).
 */
export function ownPapers(state: AppViewState): AdminBotPaperRecord[] {
  const member = findOwnMember(state);
  const memberId = state.memberId;
  const name = member?.name ?? "";
  return (state.adminBotData?.papers ?? []).filter(
    (paper) =>
      (memberId && paper.submitted_by_member_id === memberId) ||
      (memberId && paper.first_author_member_id === memberId) ||
      (memberId && paper.mentor_member_id === memberId) ||
      (memberId && (paper.author_links ?? []).some((link) => link.member_id === memberId)) ||
      // Author entries carry marks about authorship, not identity ("Joeun Yook*" for equal
      // contribution), which a raw comparison would read as somebody else.
      (name.length > 0 && (paper.authors ?? []).some((author) => isSamePerson(author, name))),
  );
}

// Progress is position in the PaperPublish pipeline, not a number someone types.
export function paperProgress(paper: AdminBotPaperRecord): { index: number; percent: number } {
  const index = paperSteps.indexOf(paper.current_step as AdminBotPaperStep);
  if (index < 0) {
    return { index: -1, percent: 0 };
  }
  return { index, percent: Math.round(((index + 1) / paperSteps.length) * 100) };
}

export function stepLabel(step: string): string {
  return stepLabels[step] ?? step;
}
