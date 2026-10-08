// The viewer's own papers and where each one sits in the pipeline.
//
// Split from my-work.ts so the dashboard and the shell can read these without pulling the paper
// workspace -- the cards, the sheet, the deadline catalogue behind them -- into the first load.
import { paperInvolvesMember } from "../../../../../extensions/adminbot/src/contracts/paper-involvement.js";
import type { AppViewState } from "../../app-view-state.ts";
import type { AdminBotPaperRecord, AdminBotPaperStep } from "../controllers/admin.ts";
import { paperSteps, stepLabels } from "../data/paper-steps.ts";
import { findOwnMember } from "./profile-fields.ts";

export function ownPapers(state: AppViewState): AdminBotPaperRecord[] {
  const member = findOwnMember(state);
  // The same rule GET /papers?scope=mine applies, so a page that read only the viewer's papers
  // shows the rows it used to pick out of the full list. Names compare as people (isSamePerson):
  // a raw lowercase comparison once hid a co-first author's paper behind the "*" marking it.
  return (state.adminBotData?.papers ?? []).filter((paper) =>
    paperInvolvesMember(paper, state.memberId, member?.name),
  );
}

// Progress is position in the PaperPublish pipeline, not a number someone types. A paper at
// "Submission" is 3 of 8 through, and that is the only progress the lab actually tracks.
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
