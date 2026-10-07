// The paper timeline the API attaches to every paper: the step plan and the longest-path schedule
// over its `depends_on` graph. Pure, so it lives apart from the service that only decorates with it.
import type {
  AdminBotPaperRecord,
  AdminBotPaperStep,
  AdminBotPaperTimeline,
} from "../contracts/actions.js";

type PaperTimelinePlanItem = {
  step: AdminBotPaperStep;
  label: string;
  dependency_group: AdminBotPaperTimeline["items"][number]["dependency_group"];
  duration_business_days: number;
  color: string;
  /**
   * Steps that must finish first. The paper flow is not a single line: slides branch off the
   * submission and run alongside the arXiv/announcement chain, so this is a graph rather than the
   * plan's array order. Scheduling walks these edges; the array order only defines step identity.
   */
  depends_on: readonly AdminBotPaperStep[];
};

const PAPER_TIMELINE_PLAN = [
  {
    step: "brainstorming_docs",
    label: "Brainstorming docs",
    dependency_group: "ideation",
    duration_business_days: 2,
    color: "#64748b",
    depends_on: [],
  },
  {
    step: "overleaf_writing",
    label: "Overleaf writing",
    dependency_group: "writing",
    duration_business_days: 5,
    color: "#2563eb",
    depends_on: ["brainstorming_docs"],
  },
  {
    step: "submission",
    label: "Submission",
    dependency_group: "submission",
    duration_business_days: 1,
    color: "#7c3aed",
    depends_on: ["overleaf_writing"],
  },
  {
    step: "google_drive_pdf",
    label: "Drive PDF",
    dependency_group: "release",
    duration_business_days: 1,
    color: "#0891b2",
    depends_on: ["submission"],
  },
  {
    step: "arxiv_polish",
    label: "arXiv polish",
    dependency_group: "release",
    duration_business_days: 2,
    color: "#0f766e",
    depends_on: ["google_drive_pdf"],
  },
  {
    step: "social_posts",
    label: "Announcements",
    dependency_group: "outreach",
    duration_business_days: 1,
    color: "#db2777",
    depends_on: ["arxiv_polish"],
  },
  {
    step: "slide_making",
    label: "Slides",
    dependency_group: "materials",
    duration_business_days: 2,
    color: "#d97706",
    depends_on: ["submission"],
  },
  {
    step: "poster_making",
    label: "Poster",
    dependency_group: "materials",
    duration_business_days: 2,
    color: "#16a34a",
    depends_on: ["slide_making"],
  },
] as const satisfies readonly PaperTimelinePlanItem[];

export function withPaperTimeline(paper: AdminBotPaperRecord): AdminBotPaperRecord {
  return {
    ...paper,
    timeline: buildPaperTimeline(paper),
  };
}

function buildPaperTimeline(
  paper: Pick<AdminBotPaperRecord, "current_step" | "reminder">,
): AdminBotPaperTimeline {
  const currentStepIndex = Math.max(
    0,
    PAPER_TIMELINE_PLAN.findIndex((item) => item.step === paper.current_step),
  );
  // Work in the plan, used for progress. This is the sum of every step's estimate and is not the
  // same as the schedule length below: parallel branches take calendar time off the schedule
  // without taking work off the paper.
  const totalWorkBusinessDays = PAPER_TIMELINE_PLAN.reduce(
    (total, item) => total + item.duration_business_days,
    0,
  );
  const complete = paper.reminder?.status === "complete";
  const blocked = paper.reminder?.status === "blocked";

  // Earliest start per step = latest finish among its dependencies (longest path). The plan is
  // ordered so every step appears after its dependencies, so one forward pass is enough.
  const finishByStep = new Map<AdminBotPaperStep, number>();
  const items = PAPER_TIMELINE_PLAN.map((item, index) => {
    const start = item.depends_on.reduce(
      (latest, dependency) => Math.max(latest, finishByStep.get(dependency) ?? 0),
      0,
    );
    const end = start + item.duration_business_days;
    finishByStep.set(item.step, end);
    return {
      step: item.step,
      label: item.label,
      dependency_group: item.dependency_group,
      depends_on: [...item.depends_on],
      status: timelineStatus(index, currentStepIndex, complete, blocked),
      offset_start_business_day: start,
      offset_end_business_day: end,
      duration_business_days: item.duration_business_days,
      color: item.color,
    };
  });
  // Schedule length is the critical path, which is what a Gantt axis spans.
  const scheduleBusinessDays = Math.max(1, ...items.map((item) => item.offset_end_business_day));
  const completedWorkBusinessDays = complete
    ? totalWorkBusinessDays
    : PAPER_TIMELINE_PLAN.slice(0, currentStepIndex).reduce(
        (total, item) => total + item.duration_business_days,
        0,
      );
  return {
    progress_percent: Math.round((completedWorkBusinessDays / totalWorkBusinessDays) * 100),
    current_step_index: currentStepIndex,
    total_estimated_business_days: scheduleBusinessDays,
    items,
  };
}

function timelineStatus(
  index: number,
  currentStepIndex: number,
  complete: boolean,
  blocked: boolean,
): AdminBotPaperTimeline["items"][number]["status"] {
  if (complete || index < currentStepIndex) {
    return "complete";
  }
  if (index === currentStepIndex) {
    return blocked ? "blocked" : "current";
  }
  return "upcoming";
}
