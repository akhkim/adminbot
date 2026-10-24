import { html } from "lit";
import {
  deadlineStageKinds,
  stageSnapshot,
  type DeadlineProposalStage,
} from "../../../../../extensions/adminbot/src/contracts/deadline-proposals.stage.js";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import { dateTimeFormat } from "../data/date-format.ts";
import { displayTimezone, zonedDeadlineLabel } from "../data/deadline-display-time.ts";
import type { DeadlineProposalInput } from "../data/deadline-proposals.ts";
import { aoeInstantMs, plainDateLabel } from "../data/deadline-time.ts";
import type { DeadlineMilestone, DeadlineVenue } from "../data/deadlines.ts";
export { deadlineStageKinds, stageSnapshot };
export function proposalVenueLabel(venue: DeadlineVenue): string {
  return [venue.name, venue.venue_group, venue.track || venue.deadline_label]
    .filter(Boolean)
    .join(" · ");
}
export function proposalDateFields(
  venue: DeadlineVenue,
  stage?: DeadlineMilestone,
): Partial<DeadlineProposalInput> {
  const raw = stage?.date;
  const dateOnly = stage ? stage.kind === "date" : venue.deadline_time_precision === "date_only";
  const timezone = (
    (stage ? stage.timezone : venue.deadline_timezone) ?? (dateOnly ? "" : "AoE")
  ).replace(/^AoE$/u, "Etc/GMT+12");
  const instant = stage
    ? /(?:Z|[+-]\d{2}:\d{2})$/u.test(raw ?? "")
      ? Date.parse(raw!)
      : aoeInstantMs(raw ?? "")
    : Date.parse(venue.deadline_at ?? "") || aoeInstantMs(venue.deadline_aoe);
  if (dateOnly || !Number.isFinite(instant)) {
    return {
      deadlineDate: raw?.slice(0, 10) ?? venue.deadline_date ?? "",
      deadlineTime: "",
      timezone,
    };
  }
  const parts = dateTimeFormat("en-CA", {
    timeZone: timezone || "Etc/GMT+12",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (kind: string) => parts.find((p) => p.type === kind)?.value;
  return {
    deadlineDate: `${get("year")}-${get("month")}-${get("day")}`,
    deadlineTime: `${get("hour")}:${get("minute")}`,
    timezone,
  };
}
export function stageCorrection(
  venue: DeadlineVenue,
  stage: DeadlineMilestone,
): DeadlineProposalStage {
  return {
    milestone: stage.milestone,
    label: stage.label,
    venueId: venue.id,
    operation: "correct",
    previous: stageSnapshot(stage),
  };
}
export function renderStageDetails(params: {
  venue: DeadlineVenue;
  stage: DeadlineMilestone;
  placement: string;
  dateLabel: string;
  canCorrect: boolean;
  correct: () => void;
}) {
  const { venue, stage } = params;
  const id = `deadline-stage-${encodeURIComponent(JSON.stringify([venue.id, stage.milestone, stage.label, params.placement])).replace(/%/gu, "_")}`;
  const exact = stage.kind === "deadline";
  const instant = /(?:Z|[+-]\d{2}:\d{2})$/u.test(stage.date ?? "")
    ? Date.parse(stage.date!)
    : aoeInstantMs(stage.date ?? "");
  const original = exact
    ? zonedDeadlineLabel(instant, displayTimezone("original", stage.timezone || "AoE"), true)
    : plainDateLabel(stage.date ?? "");
  return html`<span class="deadline-card__history">
    <button
      type="button"
      class="btn btn--icon deadline-card__history-trigger"
      popovertarget=${id}
      aria-haspopup="dialog"
      aria-label=${`Deadline details: ${venue.name} ${stage.label}`}
      style=${`anchor-name: --${id}`}
    >
      ${icons.moreHorizontal}
    </button>
    <div
      id=${id}
      popover="auto"
      class="deadline-card__history-panel"
      role="dialog"
      aria-label=${`Deadline details for ${venue.name}: ${stage.label}`}
      style=${`position-anchor: --${id}`}
    >
      <header class="deadline-details__header">
        <strong>${venue.name}</strong>
        <p>${stage.label}</p>
        <div>${params.dateLabel}</div>
      </header>
      <p>${t("deadlineStageProposal.original")}: ${original}</p>
      <footer class="deadline-details__footer">
        ${params.canCorrect && stage.kind !== "period"
          ? html`<button
              type="button"
              class="btn btn--sm"
              @click=${(event: Event) => {
                (event.currentTarget as HTMLElement)
                  .closest<HTMLElement>("[popover]")
                  ?.hidePopover?.();
                params.correct();
              }}
            >
              ${t("deadlineStageProposal.correct")}
            </button>`
          : null}
      </footer>
    </div></span
  >`;
}
