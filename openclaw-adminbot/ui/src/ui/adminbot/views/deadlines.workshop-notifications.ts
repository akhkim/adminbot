import { html, nothing } from "lit";
import type { DeadlineMilestone, DeadlineVenue } from "../data/deadlines.ts";

/** Keep organizer requirements separate from the workshop's own decision date. */
export function workshopNotificationMilestones(venue: DeadlineVenue): DeadlineMilestone[] {
  if (venue.venue_type !== "workshop") {
    return [];
  }
  const policy = venue.notification_policy;
  if (policy?.date) {
    return [{ ...policy, label: "Notify authors by" }];
  }
  if (venue.notification_previous_aoe && venue.notification_status !== "source_backed") {
    return [
      {
        milestone: "notification",
        label: "Decision date (unverified)",
        kind: "date",
        date: venue.notification_previous_aoe.slice(0, 10),
      },
    ];
  }
  return [];
}

/** Return a conference-wide organizer requirement only when the workshop group agrees on it. */
export function sharedWorkshopNotificationPolicy(
  venues: readonly DeadlineVenue[],
): DeadlineVenue["notification_policy"] | undefined {
  const policies = venues
    .filter((venue) => venue.venue_type === "workshop")
    .map((venue) => venue.notification_policy)
    .filter((policy): policy is NonNullable<DeadlineVenue["notification_policy"]> =>
      Boolean(policy?.date),
    );
  if (!policies.length || policies.some((policy) => policy.date !== policies[0].date)) {
    return undefined;
  }
  return (
    policies.find((policy) =>
      ["source_unavailable", "extraction_unavailable"].includes(policy.status ?? ""),
    ) ??
    policies.find((policy) => policy.status === "unverified" || !policy.evidence) ??
    policies[0]
  );
}

export function renderWorkshopNotificationNotes(venue: DeadlineVenue) {
  if (venue.venue_type !== "workshop") {
    return nothing;
  }
  const notes = [...(venue.notification_issues ?? [])];
  if (venue.deadline_source_status === "legacy_unverified") {
    notes.unshift("Previous submission date; not yet verified against its source.");
  }
  return notes.length ? html`<p class="deadline-card__note">${notes.join(" ")}</p>` : nothing;
}
