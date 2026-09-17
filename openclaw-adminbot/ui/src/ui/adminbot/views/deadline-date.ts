// The two-part deadline date, shared by the full board and the dashboard glance.
//
// The date and its AoE time are separate spans so the time can recede: a reader scanning a column
// of these is looking for the day, and "11:59 AoE" is the same on nearly every row. Kept out of
// data/deadline-time.ts because that module is deliberately lit-free.
import { html } from "lit";
import { deadlineDisplayLabel } from "../data/deadline-display-time.ts";
import { deadlineDateTimeLabel, aoeDateTimeLabel } from "../data/deadline-time.ts";
import type { DeadlineVenue } from "../data/deadlines.ts";

export function renderAoeDateTime(aoe: string) {
  const label = aoeDateTimeLabel(aoe);
  const separator = label.indexOf(" \u00b7 ");
  return separator < 0
    ? html`<span class="deadline-date">${label}</span>`
    : html`<span class="deadline-date">${label.slice(0, separator)}</span>
        <span class="deadline-time">${label.slice(separator)}</span>`;
}

export function renderDeadlineDate(
  venue: Pick<
    DeadlineVenue,
    | "deadline_aoe"
    | "deadline_at"
    | "deadline_date"
    | "deadline_timezone"
    | "deadline_time_precision"
  >,
  displayZone?: string,
  includeOffset = false,
) {
  const label = displayZone
    ? deadlineDisplayLabel(venue, displayZone, includeOffset)
    : deadlineDateTimeLabel(venue);
  const separator = label.indexOf(" · ");
  return separator < 0
    ? html`<span class="deadline-date">${label}</span>`
    : html`<span class="deadline-date">${label.slice(0, separator)}</span>
        <span class="deadline-time">${label.slice(separator)}</span>`;
}
