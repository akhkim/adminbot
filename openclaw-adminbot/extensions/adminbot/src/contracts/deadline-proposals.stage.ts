import type { DeadlineProposalInput } from "./deadline-proposals.js";

/** A single addition or correction; date fields remain on the proposal itself. */
export type DeadlineProposalStage = {
  milestone: string;
  label: string;
  venueId?: string;
  operation: "add" | "correct";
  previous?: string;
};
export const deadlineStageKinds = [
  ["submission", "Paper submission"],
  ["abstract", "Abstract registration"],
  ["notification", "Decisions"],
  ["camera_ready", "Camera-ready"],
  ["author_response", "Author response"],
  ["registration", "Registration"],
  ["conference", "Conference"],
  ["other", "Other"],
] as const;
export type ProposalScheduleStage = {
  milestone: string;
  label: string;
  kind: "deadline" | "date" | "period";
  date?: string;
  starts?: string;
  ends?: string;
  timezone?: string;
  planning_at?: string;
};
export function validateProposalStage(raw: unknown): DeadlineProposalStage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  if (
    typeof row.milestone !== "string" ||
    typeof row.label !== "string" ||
    !row.milestone.trim() ||
    row.milestone.length > 160 ||
    !row.label.trim() ||
    row.label.length > 120 ||
    (row.operation !== "add" && row.operation !== "correct") ||
    (row.venueId !== undefined &&
      (typeof row.venueId !== "string" || !row.venueId || row.venueId.length > 300)) ||
    (row.previous !== undefined &&
      (typeof row.previous !== "string" || row.previous.length > 2000)) ||
    (row.operation === "correct" && (!row.venueId || !row.previous)) ||
    (row.operation === "add" && row.previous !== undefined) ||
    row.milestone === "notification_by"
  ) {
    return undefined;
  }
  return {
    milestone: row.milestone.trim(),
    label: row.label.trim(),
    operation: row.operation as "add" | "correct",
    ...(row.venueId ? { venueId: row.venueId } : {}),
    ...(row.previous ? { previous: row.previous } : {}),
  };
}
export function stageSnapshot(stage: ProposalScheduleStage): string {
  return JSON.stringify([
    stage.milestone,
    stage.label,
    stage.kind,
    stage.date ?? "",
    stage.starts ?? "",
    stage.ends ?? "",
    stage.timezone ?? "",
    stage.planning_at ?? "",
  ]);
}
function stageKind(key: string): string {
  if (["full_paper", "direct_submission", "paper", "paper_submission"].includes(key)) {
    return "submission";
  }
  if (["abstract_registration", "abstract_submission"].includes(key)) {
    return "abstract";
  }
  if (["decisions", "accept_reject"].includes(key)) {
    return "notification";
  }
  if (key === "rebuttal") {
    return "author_response";
  }
  return key;
}
export function proposalSchedule(venue: Record<string, unknown>): ProposalScheduleStage[] {
  const stages = Array.isArray(venue.schedule) ? (venue.schedule as ProposalScheduleStage[]) : [];
  if (
    (venue.venue_type !== "workshop" || venue.notification_status === "source_backed") &&
    typeof venue.notification_aoe === "string" &&
    venue.notification_aoe &&
    !stages.some((s) => stageKind(s.milestone) === "notification")
  ) {
    return [
      ...stages,
      {
        milestone: "notification",
        label: "Accept/reject",
        kind: "deadline",
        date: venue.notification_aoe,
      },
    ];
  }
  return stages;
}
/** Recheck at submission and execution, so approval never overwrites a newer source observation. */
export function stageProposalConflict(
  stage: DeadlineProposalStage,
  target?: Record<string, unknown>,
): string | undefined {
  if (!stage.venueId) {
    return stage.operation === "add" ? undefined : "Choose an existing stage.";
  }
  if (!target) {
    return "The conference or workshop is no longer available.";
  }
  const matches = proposalSchedule(target).filter(
    (s) => stageKind(s.milestone) === stageKind(stage.milestone) && s.label === stage.label,
  );
  if (stage.operation === "correct") {
    if (matches.length !== 1 || stageSnapshot(matches[0]) !== stage.previous) {
      return "This stage changed; open its details and submit a fresh correction.";
    }
    if (matches[0].kind === "period") {
      return "A date range cannot be replaced with a single deadline.";
    }
  } else if (
    matches.length ||
    (stageKind(stage.milestone) === "abstract" && Boolean(target.abstract_deadline_id)) ||
    proposalSchedule(target).some(
      (s) =>
        !stage.milestone.startsWith("custom:") &&
        stageKind(s.milestone) === stageKind(stage.milestone),
    ) ||
    stageKind(typeof target.milestone === "string" ? target.milestone : "submission") ===
      stageKind(stage.milestone)
  ) {
    return "This stage already exists. Use Suggest deadline correction in its details.";
  }
  return undefined;
}
export function proposalStageDate(
  input: DeadlineProposalInput,
  instant: string,
): ProposalScheduleStage {
  const stage = input.stage!;
  return {
    milestone: stage.milestone,
    label: stage.label,
    kind: input.deadlineTime ? "deadline" : "date",
    date: input.deadlineTime ? instant : input.deadlineDate,
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(!input.deadlineTime ? { planning_at: instant } : {}),
  };
}
export function applyStageProposal(
  venue: Record<string, unknown>,
  input: DeadlineProposalInput,
  instant: string,
): Record<string, unknown> {
  const stage = input.stage!;
  const schedule = proposalSchedule(venue);
  const next = proposalStageDate(input, instant);
  const index = schedule.findIndex(
    (s) => stageKind(s.milestone) === stageKind(stage.milestone) && s.label === stage.label,
  );
  // Approved manual values stay authoritative when a later source refresh changes the same stage.
  return {
    ...venue,
    schedule: index < 0 ? [...schedule, next] : schedule.map((s, i) => (i === index ? next : s)),
  };
}
