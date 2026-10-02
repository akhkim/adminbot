import { html, nothing } from "lit";
import type { DeadlineVenue } from "../data/deadlines.ts";

export function renderPublicationPolicy(venue: DeadlineVenue, archival: string, placement: string) {
  const id = `archival-${placement}-${venue.id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  const explanation = {
    archival:
      "Papers enter published proceedings. Check the venue’s policy before submitting the same work elsewhere.",
    non_archival:
      "Papers do not enter archival proceedings. Check both venues’ policies before submitting the same work elsewhere.",
    mixed:
      "This workshop offers archival and non-archival routes. Check which route applies to your submission.",
    unknown: "The publication policy has not been confirmed. Check the call for papers.",
  }[venue.archival_status];
  return archival
    ? html`<span class="deadline-classification">
        <button
          type="button"
          class="deadline-archival"
          data-archival=${venue.archival_status}
          popovertarget=${id}
          aria-label=${`${archival}: publication policy`}
          style=${`anchor-name: --${id}`}
        >
          ${archival} <span aria-hidden="true">ⓘ</span>
        </button>
        <span
          id=${id}
          popover="auto"
          role="note"
          class="deadline-archival__explanation"
          style=${`position-anchor: --${id}`}
          ><strong>${archival}</strong>${explanation}</span
        >
      </span>`
    : nothing;
}
