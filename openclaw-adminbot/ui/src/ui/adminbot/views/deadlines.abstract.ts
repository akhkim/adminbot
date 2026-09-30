import { html, nothing } from "lit";
import { deadlineDisplayLabel } from "../data/deadline-display-time.ts";
import { deadlineInstantMs } from "../data/deadline-time.ts";
import type { DeadlineMilestone, DeadlineVenue } from "../data/deadlines.ts";

export function abstractPrerequisite(
  venue: DeadlineVenue,
  venues: readonly DeadlineVenue[],
): DeadlineVenue | undefined {
  if (!venue.abstract_deadline_id) {
    return undefined;
  }
  return venues.find(
    (candidate) =>
      candidate.id !== venue.id &&
      (candidate.deadline_id || candidate.id) === venue.abstract_deadline_id &&
      !candidate.stale &&
      candidate.venue_id === venue.venue_id &&
      candidate.venue_group === venue.venue_group &&
      (candidate.track || "") === (venue.track || "") &&
      (candidate.submission_type || "") === (venue.submission_type || "") &&
      (candidate.milestone === "abstract" || /\babstract\b/iu.test(candidate.deadline_label)) &&
      deadlineInstantMs(candidate) <= deadlineInstantMs(venue),
  );
}

export type AbstractMilestone = DeadlineMilestone & { abstractVenue?: DeadlineVenue };

export function abstractMilestone(
  venue: DeadlineVenue,
  venues: readonly DeadlineVenue[],
): AbstractMilestone | undefined {
  const abstract = abstractPrerequisite(venue, venues);
  return abstract
    ? {
        milestone: "abstract",
        label: "Abstract",
        kind: abstract.deadline_time_precision === "date_only" ? "date" : "deadline",
        date:
          abstract.deadline_time_precision === "date_only"
            ? abstract.deadline_date
            : abstract.deadline_aoe,
        abstractVenue: abstract,
      }
    : undefined;
}

export function renderAbstractMilestoneDate(venue: DeadlineVenue, zone: string, _now: number) {
  return deadlineDisplayLabel(venue, zone);
}

export function abstractRequirementStatus(venue: DeadlineVenue): string | undefined {
  if (
    /\babstract\b/iu.test(venue.deadline_label) ||
    venue.milestone === "abstract" ||
    venue.submission_type === "commitment" ||
    venue.entry_type === "arr_commitment" ||
    (venue.milestone && !["full_paper", "direct_submission", "demo"].includes(venue.milestone)) ||
    !["workshop", "main_conference", "demo_track", "arr_direct_submission"].includes(
      venue.entry_type,
    )
  ) {
    return undefined;
  }
  return venue.abstract_requirement_conflict
    ? "Sources disagree"
    : venue.abstract_requirement === "not_required"
      ? "Not required"
      : venue.abstract_requirement === "required"
        ? "Date unknown"
        : "Requirement unknown";
}

export function renderAbstractRequirement(
  venue: DeadlineVenue,
  venues: readonly DeadlineVenue[],
  _zone: string,
  _now: number,
  details = false,
) {
  if (!details || !abstractRequirementStatus(venue)) {
    return nothing;
  }
  const abstract = abstractPrerequisite(venue, venues);
  const requirement = venue.abstract_requirement;
  const label = venue.abstract_requirement_conflict
    ? "Abstract registration: unclear — sources disagree"
    : requirement === "not_required"
      ? "No separate abstract registration required"
      : requirement === "required"
        ? abstract
          ? "Abstract registration required"
          : "Abstract registration required · deadline unknown"
        : "Abstract registration: unknown";
  const source = venue.abstract_requirement_source_url || "";
  return html`<p class="deadline-card__note" data-testid="abstract-requirement">${label}</p>
    ${details && venue.abstract_requirement_evidence
      ? html`<p class="deadline-card__note">
          ${venue.abstract_requirement_evidence}${/^https?:\/\//iu.test(source)
            ? html` · <a href=${source} target="_blank" rel="noopener noreferrer">Source ↗</a>`
            : nothing}
        </p>`
      : nothing}`;
}
