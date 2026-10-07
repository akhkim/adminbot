// Schedule stage ordering and the schedule-check status note for the deadline board.
import { html, nothing } from "lit";
import type { DeadlineVenue } from "../data/deadlines.ts";

/**
 * Stage order for a rendered schedule: the story, not the calendar.
 *
 * Sorted by stage first because a venue can date two stages the same day -- ICLR releases reviews
 * and opens author discussion both on 5 November -- and a date-only sort puts them in whichever
 * order the source happened to list, which reads as noise. Anything unrecognised sorts last rather
 * than being dropped: a venue inventing a stage is a thing to show, not to hide.
 */
const MILESTONE_ORDER = [
  "abstract",
  "submission",
  "reviews",
  "rebuttal",
  "author_response",
  "discussion",
  "review_issue",
  "notification",
  "notification_by",
  "cycle_end",
  "camera_ready",
  "conference",
];

export function milestoneRank(milestone: string): number {
  const index = MILESTONE_ORDER.indexOf(milestone);
  return index === -1 ? MILESTONE_ORDER.length : index;
}

/** Say when the venue's schedule check failed or left details unresolved. */
export function renderScheduleStatusNote(venue: DeadlineVenue) {
  const scheduleNote = ["source_unavailable", "extraction_unavailable"].includes(
    venue.schedule_status ?? "",
  )
    ? "Schedule check failed; previous dates retained."
    : venue.schedule_status === "needs_review"
      ? "Schedule has unresolved details."
      : venue.schedule_status === "unverified"
        ? "Schedule has not been verified."
        : "";
  return scheduleNote
    ? html`<p class="deadline-card__note" data-testid="deadline-schedule-status">
        ${scheduleNote}
        ${(venue.schedule_issues ?? []).map((issue) => html`<span> ${issue}</span>`)}
      </p>`
    : nothing;
}
