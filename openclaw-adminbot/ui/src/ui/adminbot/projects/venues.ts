// Where a project is aimed: the venue picker's options, what a new project defaults to, and the
// card's own target editor.
//
// The venue *list* is the catalog (data/venue-catalog.ts); the default is read from the deadline
// board, so a new paper is aimed at whatever is actually next rather than whatever someone typed
// last year. Shared by the add-project form and the project page so the two can never offer
// different venues -- the page is where a registration gets corrected.
import { html, nothing } from "lit";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { aoeInstantMs } from "../data/deadline-time.ts";
import { DEADLINE_SUMMARIES } from "../data/deadlines-summary.ts";
import {
  ARCHIVAL_VENUES,
  type CatalogVenue,
  NON_ARCHIVAL_VENUES,
  WORKSHOP_VENUES,
  formatVenue,
  parseVenue,
  venueYears,
} from "../data/venue-catalog.ts";
import {
  effectiveVenueTargets,
  formatVenueTargets,
  readVenueTargets,
  serializeVenueTargets,
  venueTargetMatches,
} from "../venue-targets.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

/** How sure the authors are about hitting this venue. Coarse on purpose: finer is false precision. */
export const CONFIDENCE_OPTIONS = ["30", "50", "80", "99"];

/**
 * The venue select's options, grouped by whether publishing there consumes the paper.
 *
 * Workshops are their own group because "is this archival" is a question the CFP answers per
 * workshop rather than something the catalog can state for the venue.
 */
export function venueOptions(selectedId: string) {
  const group = (label: string, entries: CatalogVenue[]) => html`
    <optgroup label=${label}>
      ${entries.map(
        (entry) => html`
          <option value=${entry.id} ?selected=${entry.id === selectedId}>${entry.label}</option>
        `,
      )}
    </optgroup>
  `;
  return html`
    ${group("Archival", ARCHIVAL_VENUES)} ${group("Non-archival", NON_ARCHIVAL_VENUES)}
    ${group("Workshops (check the CFP)", WORKSHOP_VENUES)}
  `;
}

/**
 * The next real archival deadlines, soonest first.
 *
 * Archival conference deadlines only -- camera-ready and commitment rows are not things you target
 * from scratch, and sorting purely by date buries ICLR and ARR under fifty workshop commitments.
 */
function upcomingVenues(now = new Date()) {
  const future = DEADLINE_SUMMARIES.filter((venue) => {
    const due = aoeInstantMs(venue.deadline_aoe);
    return Number.isFinite(due) && due > now.getTime();
  })
    .filter((venue) => venue.archival_status === "archival")
    .toSorted((left, right) => left.deadline_aoe.localeCompare(right.deadline_aoe));

  // One row per venue, not one per milestone: ICLR appears twice (abstract, then full paper) and
  // offering both as separate targets asks a question nobody means to answer. Keep the paper
  // deadline, since that is the one people are working towards.
  const byGroup = new Map<string, (typeof future)[number]>();
  for (const venue of future) {
    const key = venue.venue_group || venue.name;
    const kept = byGroup.get(key);
    const isPaperDeadline = venue.milestone !== "abstract";
    if (!kept || (isPaperDeadline && kept.milestone === "abstract")) {
      byGroup.set(key, venue);
    }
  }
  return [...byGroup.values()].slice(0, 6);
}

/**
 * What a new paper is aimed at before anyone says otherwise: the next real deadline, expressed as
 * a catalog venue and a year so the selects open on it. A deadline the catalog cannot name falls
 * through to no venue rather than to a target nobody can then edit.
 */
export function defaultTarget(now = new Date()) {
  const year = now.getUTCFullYear();
  for (const venue of upcomingVenues(now)) {
    const parsed = parseVenue(venue.name);
    if (parsed.id) {
      return { id: parsed.id, year: parsed.year ?? year };
    }
  }
  return { id: "", year };
}

/**
 * Where this paper is aimed, stated rather than implied: the selects are the right control for
 * changing a target and the wrong one for reading it.
 */
export function renderVenueTargets(paper: AdminBotPaperRecord) {
  const targets = effectiveVenueTargets(paper);
  if (targets.length === 0) {
    return nothing;
  }
  return html`
    <p class="paper-targets" data-testid=${`paper-targets-${paper.id}`}>
      <span class="paper-targets__label">Pre-registered</span>
      <span class="paper-targets__value">${formatVenueTargets(targets)}</span>
    </p>
  `;
}

/**
 * Target venue and confidence, editable in place.
 *
 * Year and venue are separate because they change for different reasons: a slipped paper keeps its
 * venue and moves a year, and a rejected one keeps the year and moves venue.
 */
export function renderTarget(paper: AdminBotPaperRecord, props: PaperWorkspaceProps) {
  const current = paper.artifacts?.conference ?? "";
  const confidence = paper.artifacts?.confidence ?? "";
  const parsed = parseVenue(current);
  // Keep whatever the paper already names when the catalog cannot express it, or touching either
  // select would silently retarget the paper.
  const custom = current && !parsed.id ? current : "";
  const year = parsed.year ?? defaultTarget().year;

  /**
   * Save the target, and register the paper for it.
   *
   * Declaring where a paper is going *is* pre-registering it, and every reader of "is this paper
   * pre-registered" looks at `artifacts.venue_targets`. The chosen venue is upserted rather than
   * made the whole list: a paper aimed at two venues through the pre-registration dialog must not
   * lose one because somebody adjusted the year here.
   */
  const save = (conference: string, odds: string) => {
    const existing = readVenueTargets(paper);
    const parsedNext = parseVenue(conference);
    const venueId = parsedNext.id ?? conference.trim();
    // Matched on the venue rather than the id string so a target written by the dialog's id space
    // is replaced rather than duplicated.
    const kept = existing.filter((target) => !venueId || !venueTargetMatches(target, venueId));
    const confidenceValue = Number(odds);
    const targets = venueId
      ? [
          ...kept,
          {
            venue_id: venueId,
            label: conference.trim() || venueId,
            // "No estimate" still has to carry a number; the add form's own default is the honest one.
            confidence:
              Number.isFinite(confidenceValue) && confidenceValue > 0 ? confidenceValue : 50,
          },
        ]
      : kept;
    props.onSavePaper({
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      currentStep: paper.current_step,
      conference,
      confidence: odds,
      venueTargets: serializeVenueTargets(targets),
    });
  };

  // Both selects write the one `conference` field, so whichever one moved has to read the other.
  const retarget = (event: Event) => {
    const root = (event.target as HTMLElement).closest(".my-work-item__target");
    const pick = (role: string) =>
      root?.querySelector<HTMLSelectElement>(`[data-role="${role}"]`)?.value ?? "";
    const venueId = pick("venue-name");
    if (!venueId) {
      save("", confidence);
      return;
    }
    if (venueId === custom) {
      save(custom, confidence);
      return;
    }
    save(formatVenue(venueId, Number(pick("venue-year"))), confidence);
  };

  return html`
    <p class="my-work-item__target">
      <select
        class="target__select"
        data-role="venue-year"
        aria-label="Target year"
        data-testid=${`target-venue-year-${paper.id}`}
        @change=${retarget}
      >
        ${venueYears().map(
          (option) => html`
            <option value=${String(option)} ?selected=${option === year}>${option}</option>
          `,
        )}
      </select>
      <select
        class="target__select"
        data-role="venue-name"
        aria-label="Target venue"
        data-testid=${`target-venue-${paper.id}`}
        @change=${retarget}
      >
        ${custom ? html`<option value=${custom} selected>${custom}</option>` : nothing}
        ${venueOptions(parsed.id ?? "")}
        <option value="" ?selected=${!current}>Other / not decided yet</option>
      </select>
      <select
        class="target__select"
        aria-label="How likely"
        data-testid=${`target-confidence-${paper.id}`}
        @change=${(event: Event) => save(current, (event.target as HTMLSelectElement).value)}
      >
        <option value="" ?selected=${!confidence}>No estimate</option>
        ${CONFIDENCE_OPTIONS.map(
          (value) => html`
            <option value=${value} ?selected=${value === confidence}>${value}% likely</option>
          `,
        )}
      </select>
    </p>
  `;
}
