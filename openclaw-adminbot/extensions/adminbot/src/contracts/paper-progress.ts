// Where a paper is in the step plan, derived from `current_step` alone.
//
// The API used to attach a full per-paper timeline (every step, its offsets, colors and edges) to
// each paper it returned: about 2 KB a paper, five times the stored record, for a Gantt that has
// since been deleted. What its readers actually used was three facts -- the current step's label,
// the next one, and a progress figure -- and all three follow from `current_step`, so each reader
// derives them here instead. Deriving on the client also means a saved paper can never carry the
// progress of the step it was on before the save.
import type { AdminBotPaperStep } from "./actions.js";

/** The plan, in step order, with the work each step is estimated at. */
export const adminBotPaperStepPlan = [
  { step: "brainstorming_docs", label: "Brainstorming docs", business_days: 2 },
  { step: "overleaf_writing", label: "Overleaf writing", business_days: 5 },
  { step: "submission", label: "Submission", business_days: 1 },
  { step: "google_drive_pdf", label: "Drive PDF", business_days: 1 },
  { step: "arxiv_polish", label: "arXiv polish", business_days: 2 },
  { step: "social_posts", label: "Announcements", business_days: 1 },
  { step: "slide_making", label: "Slides", business_days: 2 },
  { step: "poster_making", label: "Poster", business_days: 2 },
] as const satisfies ReadonlyArray<{
  step: AdminBotPaperStep;
  label: string;
  business_days: number;
}>;

export type AdminBotPaperStepProgress = {
  /** Position of `current_step` in the plan; an unknown step reads as the first. */
  stepIndex: number;
  stepCount: number;
  complete: boolean;
  blocked: boolean;
  /** The current step's label, absent once the paper is complete. */
  currentLabel?: string;
  /** The step after the current one, absent on the last step and once complete. */
  nextLabel?: string;
  /** Work-weighted: the estimated days of every step before the current one, over the total. */
  progressPercent: number;
};

const TOTAL_BUSINESS_DAYS = adminBotPaperStepPlan.reduce(
  (total, item) => total + item.business_days,
  0,
);

export function paperStepProgress(paper: {
  current_step?: string;
  reminder?: { status?: string };
}): AdminBotPaperStepProgress {
  const stepIndex = Math.max(
    0,
    adminBotPaperStepPlan.findIndex((item) => item.step === paper.current_step),
  );
  const complete = paper.reminder?.status === "complete";
  const next = complete ? undefined : adminBotPaperStepPlan[stepIndex + 1];
  const done = complete
    ? TOTAL_BUSINESS_DAYS
    : adminBotPaperStepPlan
        .slice(0, stepIndex)
        .reduce((total, item) => total + item.business_days, 0);
  return {
    stepIndex,
    stepCount: adminBotPaperStepPlan.length,
    complete,
    blocked: !complete && paper.reminder?.status === "blocked",
    ...(complete ? {} : { currentLabel: adminBotPaperStepPlan[stepIndex]?.label }),
    ...(next ? { nextLabel: next.label } : {}),
    progressPercent: Math.round((done / TOTAL_BUSINESS_DAYS) * 100),
  };
}
