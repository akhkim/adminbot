// Active Papers: where every paper in the lab stands, as a spreadsheet.
//
// This replaced a Gantt chart. The chart drew one timeline bar per step per paper on a shared
// business-day scale, which answered "how long is this paper" beautifully and "which papers need me
// today" not at all -- the question an administrator actually arrives with. Seventy papers of bars
// is a picture you look at; seventy rows sorted by what is outstanding is a list you work through.
// The per-paper timeline did not disappear, it moved to the paper's own card in My Projects &
// Papers, which is where somebody reading one paper already is.
//
// Deliberately the same shape as Profile Completeness next door: a roll-up line, a filter row, then
// one row per thing with the scannable measure on the left and the detail on the right. The two
// tabs of Lab Overview answer the same kind of question about different subjects, and reading the
// second should cost nothing once you have read the first.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { PaperSlotOverviewRow } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";

/**
 * Which papers the page is looking at.
 *
 * `state` is the grouping that makes this a working list rather than an inventory: `attention` is
 * everything with something outstanding on it, which is the sweep, and `dormant` is the pile that
 * would otherwise pad every count on the page.
 */
export type PaperOverviewState = "all" | "attention" | "in_flight" | "dormant";

export type PaperOverviewFilter = {
  search: string;
  venue: string;
  stage: string;
  state: PaperOverviewState;
};

export const EMPTY_PAPER_OVERVIEW_FILTER: PaperOverviewFilter = {
  search: "",
  venue: "",
  stage: "",
  state: "all",
};

/** One paper with the evidence the service counted for it folded in. */
export type PaperOverviewRow = {
  paper: AdminBotPaperRecord;
  /**
   * How many steps of the flow are behind this paper, and how many there are.
   *
   * Deliberately a step count and not the service's `progress_percent`. That field is a lookup:
   * `current_step` against a fixed eight-step plan weighted by hardcoded day estimates, so every
   * paper on the same step reports the same number forever -- a draft nobody has started and a
   * draft about to be submitted both read 12% -- it jumps 12% to 44% for one step, and a paper on
   * the last step reads 88% and can never reach 100% unless somebody sets `reminder.status`. It
   * measures which step the paper is on, which is what the Stage column says in words anyway. A
   * step count says the same true thing without implying it knows how much of the work is done.
   */
  stepIndex: number;
  stepCount: number;
  /** The cycle is finished: the reminder says so, or the service closed it. */
  complete: boolean;
  currentLabel: string;
  nextLabel: string;
  venue: string;
  deadline: string;
  slots: PaperSlotOverviewRow | undefined;
  openBlockers: number;
  /** Something is outstanding on this paper: evidence, a blocker, or an escalation. */
  needsAttention: boolean;
  /** Nobody is expected to move this right now -- dormant, or the cycle is closed. */
  dormant: boolean;
};

export type PaperOverviewSummary = {
  papers: number;
  attention: number;
  inFlight: number;
  dormant: number;
  /** Papers with no venue recorded. The ones nobody can plan around. */
  withoutVenue: number;
};

const STATE_OPTIONS: Array<{ value: PaperOverviewState; labelKey: string }> = [
  { value: "attention", labelKey: "paperOverview.filters.attention" },
  { value: "in_flight", labelKey: "paperOverview.filters.inFlight" },
  { value: "dormant", labelKey: "paperOverview.filters.dormant" },
  { value: "all", labelKey: "paperOverview.filters.all" },
];

/**
 * The venue a paper is aimed at or landed in.
 *
 * Accepted first: once a paper is in somewhere, that is its venue, and the target it was aimed at
 * months ago is history the row does not need.
 */
export function paperVenue(paper: AdminBotPaperRecord): string {
  const artifacts = paper.artifacts ?? {};
  return (
    paper.accepted_venue?.trim() ||
    paper.venue?.trim() ||
    artifacts.conference?.trim() ||
    artifacts.venue?.trim() ||
    ""
  );
}

/** Builds the rows the page shows, before any filter is applied. */
export function paperOverviewRows(params: {
  papers: readonly AdminBotPaperRecord[];
  slots: readonly PaperSlotOverviewRow[];
  blockerCounts: ReadonlyMap<string, number>;
  stepLabel: (step: string) => string;
  /** How many steps the flow has, for a paper the service has not computed a timeline for. */
  stepCount: number;
}): PaperOverviewRow[] {
  const slotsById = new Map(params.slots.map((row) => [row.paper_id, row]));
  return params.papers.map((paper) => {
    const slots = slotsById.get(paper.id);
    const timeline = paper.timeline;
    const current = timeline?.items.find((item) => item.status === "current");
    const next = timeline?.items.find((item) => item.status === "upcoming");
    const openBlockers = params.blockerCounts.get(paper.id) ?? 0;
    const dormant = Boolean(paper.dormant_override || slots?.closed || slots?.cycle_closed);
    const missingEvidence = slots ? slots.required_count - slots.provided_count : 0;
    const stepCount = timeline?.items.length || params.stepCount;
    const complete =
      paper.reminder?.status === "complete" || Boolean(slots?.closed || slots?.cycle_closed);
    return {
      paper,
      stepIndex: complete ? stepCount : (timeline?.current_step_index ?? 0),
      stepCount,
      complete,
      currentLabel: current?.label ?? params.stepLabel(paper.current_step),
      nextLabel: next?.label ?? "",
      venue: paperVenue(paper),
      deadline: paper.deadline?.trim() ?? "",
      slots,
      openBlockers,
      // A dormant paper is outstanding to nobody, whatever it is missing -- counting it would make
      // the sweep permanently non-empty and so permanently ignorable.
      needsAttention:
        !dormant && (missingEvidence > 0 || openBlockers > 0 || Boolean(slots?.escalating)),
      dormant,
    };
  });
}

/** The rows a filter shows. Exported so the page, the count and the tests agree on one definition. */
export function filterPaperRows(
  rows: readonly PaperOverviewRow[],
  filter: PaperOverviewFilter,
): PaperOverviewRow[] {
  const search = filter.search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (
      search &&
      !`${row.paper.title} ${row.paper.authors.join(" ")} ${row.venue}`
        .toLocaleLowerCase()
        .includes(search)
    ) {
      return false;
    }
    if (filter.venue && row.venue !== filter.venue) {
      return false;
    }
    if (filter.stage && row.paper.current_step !== filter.stage) {
      return false;
    }
    switch (filter.state) {
      case "attention":
        return row.needsAttention;
      case "in_flight":
        return !row.dormant;
      case "dormant":
        return row.dormant;
      default:
        return true;
    }
  });
}

/** The line above the table. Counted over every paper, not over what the filter left. */
export function paperOverviewSummary(rows: readonly PaperOverviewRow[]): PaperOverviewSummary {
  return {
    papers: rows.length,
    attention: rows.filter((row) => row.needsAttention).length,
    inFlight: rows.filter((row) => !row.dormant).length,
    dormant: rows.filter((row) => row.dormant).length,
    withoutVenue: rows.filter((row) => !row.venue).length,
  };
}

/** Every venue named by at least one paper, for the filter. */
export function paperVenueOptions(rows: readonly PaperOverviewRow[]): string[] {
  return [...new Set(rows.map((row) => row.venue).filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export type PaperOverviewProps = {
  rows: PaperOverviewRow[];
  filter: PaperOverviewFilter;
  onFilterChange: (filter: PaperOverviewFilter) => void;
  /** Opens the paper itself. The row is a summary; the record is edited where it is edited. */
  onOpenPaper: (paperId: string) => void;
  stages: ReadonlyArray<{ value: string; label: string }>;
  /** Drawn in the header, where the page's own actions belong. Optional so tests need none. */
  actions?: unknown;
};

export function renderPaperOverviewTable(props: PaperOverviewProps) {
  const summary = paperOverviewSummary(props.rows);
  const shown = filterPaperRows(props.rows, props.filter);
  const venues = paperVenueOptions(props.rows);
  return html`
    <section class="adminbot-shell paper-overview" data-testid="adminbot-paper-overview">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="profile-overview__heading">
          <div>
            <div class="card-title">${t("paperOverview.title")}</div>
            <div class="card-sub">${t("paperOverview.sub")}</div>
          </div>
          <div class="profile-overview__actions">
            <label class="profile-overview__filter">
              <span class="sr-only">${t("paperOverview.filters.searchLabel")}</span>
              <input
                class="input"
                type="search"
                data-testid="paper-overview-search"
                placeholder=${t("paperOverview.filters.searchPlaceholder")}
                .value=${props.filter.search}
                @input=${(event: Event) =>
                  props.onFilterChange({
                    ...props.filter,
                    search: (event.target as HTMLInputElement).value,
                  })}
              />
            </label>
            ${renderSelect({
              testId: "paper-overview-filter-state",
              label: t("paperOverview.filters.stateLabel"),
              value: props.filter.state,
              options: STATE_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              })),
              onChange: (value) =>
                props.onFilterChange({ ...props.filter, state: value as PaperOverviewState }),
            })}
            ${renderSelect({
              testId: "paper-overview-filter-stage",
              label: t("paperOverview.filters.stageLabel"),
              value: props.filter.stage,
              options: [
                { value: "", label: t("paperOverview.filters.allStages") },
                ...props.stages,
              ],
              onChange: (value) => props.onFilterChange({ ...props.filter, stage: value }),
            })}
            ${renderSelect({
              testId: "paper-overview-filter-venue",
              label: t("paperOverview.filters.venueLabel"),
              value: props.filter.venue,
              options: [
                { value: "", label: t("paperOverview.filters.allVenues") },
                ...venues.map((venue) => ({ value: venue, label: venue })),
              ],
              onChange: (value) => props.onFilterChange({ ...props.filter, venue: value }),
            })}
            ${props.actions ?? nothing}
          </div>
        </div>

        ${renderSummary(summary, props)}
        ${shown.length
          ? html`
              <div class="profile-overview__scroll">
                <table class="profile-overview__table paper-overview__table">
                  <thead>
                    <tr>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.paper")}
                      </th>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.stage")}
                      </th>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.evidence")}
                      </th>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.venue")}
                      </th>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.outstanding")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    ${shown.map((row) => renderRow(props, row))}
                  </tbody>
                </table>
              </div>
            `
          : html`<p class="logistics-requests__empty" data-testid="paper-overview-empty">
              ${props.rows.length ? t("paperOverview.noMatches") : t("paperOverview.empty")}
            </p>`}
      </div>
    </section>
  `;
}

/**
 * The roll-up, whose figures double as the filter.
 *
 * Pressing a number is the same gesture as reading it: an administrator who has just been told
 * eleven papers need attention wants those eleven, and making them hunt for the matching option in
 * a select is asking them to say it twice.
 */
function renderSummary(summary: PaperOverviewSummary, props: PaperOverviewProps) {
  const figure = (
    value: number,
    labelKey: string,
    state: PaperOverviewState,
    tone?: "attention",
  ) => html`
    <button
      class="paper-overview__figure ${props.filter.state === state ? "is-active" : ""}"
      type="button"
      data-testid=${`paper-overview-figure-${state}`}
      aria-pressed=${props.filter.state === state ? "true" : "false"}
      @click=${() => props.onFilterChange({ ...props.filter, state })}
    >
      <span
        class="profile-overview__adoption-figure ab-num ${tone === "attention" && value > 0
          ? "is-attention"
          : ""}"
        >${value}</span
      >
      <span class="muted">${t(labelKey)}</span>
    </button>
  `;
  return html`
    <div class="profile-overview__adoption-summary" data-testid="paper-overview-summary">
      ${figure(summary.attention, "paperOverview.summary.attention", "attention", "attention")}
      ${figure(summary.inFlight, "paperOverview.summary.inFlight", "in_flight")}
      ${figure(summary.dormant, "paperOverview.summary.dormant", "dormant")}
      ${figure(summary.papers, "paperOverview.summary.papers", "all")}
      ${summary.withoutVenue
        ? html`<div class="paper-overview__figure paper-overview__figure--static">
            <span class="profile-overview__adoption-figure ab-num">${summary.withoutVenue}</span>
            <span class="muted">${t("paperOverview.summary.withoutVenue")}</span>
          </div>`
        : nothing}
    </div>
  `;
}

function renderSelect(params: {
  testId: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return html`
    <label class="profile-overview__filter">
      <span class="sr-only">${params.label}</span>
      <select
        class="target__select"
        data-testid=${params.testId}
        @change=${(event: Event) => params.onChange((event.target as HTMLSelectElement).value)}
      >
        ${params.options.map(
          (option) => html`
            <option value=${option.value} ?selected=${option.value === params.value}>
              ${option.label}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

/**
 * The stage cell: how far along the flow this paper is, in steps.
 *
 * The bar is the scannable part and the words underneath are for the row you stop on -- the same
 * bargain Profile Completeness strikes with its field count. "Step 3 of 8" rather than a
 * percentage, because a step is a thing that either has happened or has not, and a percentage
 * derived from one implies a precision nothing here has.
 */
function renderStageCell(row: PaperOverviewRow) {
  const filled = row.stepCount > 0 ? Math.round((row.stepIndex / row.stepCount) * 100) : 0;
  return html`
    <div class="paper-overview__stage">
      <div class="profile-overview__progress">
        <div
          class="profile-overview__bar ${row.complete ? "is-complete" : ""}"
          role="img"
          aria-label=${row.complete
            ? t("paperOverview.stageComplete")
            : t("paperOverview.stageLabel", {
                index: String(row.stepIndex + 1),
                total: String(row.stepCount),
              })}
        >
          <span class="profile-overview__bar-fill" style="width: ${filled}%"></span>
        </div>
        <span class="profile-overview__percent">
          ${row.complete ? t("paperOverview.stageDone") : `${row.stepIndex + 1}/${row.stepCount}`}
        </span>
      </div>
      <strong>${row.complete ? t("paperOverview.stageComplete") : row.currentLabel}</strong>
      ${!row.complete && row.nextLabel
        ? html`<span class="profile-overview__status"
            >${t("paperOverview.next", { step: row.nextLabel })}</span
          >`
        : nothing}
    </div>
  `;
}

/**
 * The evidence cell: how much of what this paper owes has arrived.
 *
 * Named blanks under the count, not just a fraction, for the same reason Profile Completeness names
 * missing fields: the name is the thing an administrator repeats to the author. Capped at three
 * because past that the answer is "most of it" and the row stops being scannable.
 */
function renderEvidenceCell(row: PaperOverviewRow) {
  if (!row.slots) {
    return html`<span class="muted">${t("paperOverview.noEvidence")}</span>`;
  }
  const missing = row.slots.required_count - row.slots.provided_count;
  return html`
    <div class="paper-overview__evidence">
      <span class="ab-num ${missing > 0 ? "is-attention" : ""}"
        >${row.slots.provided_count}/${row.slots.required_count}</span
      >
      ${row.slots.missing_slots.length
        ? html`<ul class="profile-overview__missing">
            ${row.slots.missing_slots
              .slice(0, 3)
              .map((slot) => html`<li>${slot.replaceAll("_", " ")}</li>`)}
            ${row.slots.missing_slots.length > 3
              ? html`<li class="muted">
                  ${t("paperOverview.moreMissing", {
                    count: String(row.slots.missing_slots.length - 3),
                  })}
                </li>`
              : nothing}
          </ul>`
        : html`<span class="profile-overview__done">${t("paperOverview.allEvidence")}</span>`}
    </div>
  `;
}

function renderOutstandingCell(row: PaperOverviewRow) {
  const flags = [
    row.openBlockers
      ? html`<span class="profile-overview__flag" data-testid="paper-overview-blocked"
          >${t("paperOverview.blocked", { count: String(row.openBlockers) })}</span
        >`
      : nothing,
    row.slots?.escalating
      ? html`<span class="profile-overview__flag">${t("paperOverview.escalating")}</span>`
      : nothing,
    row.dormant
      ? html`<span class="paper-overview__chip">${t("paperOverview.dormant")}</span>`
      : nothing,
  ].filter((flag) => flag !== nothing);
  if (!flags.length) {
    return html`<span class="muted">—</span>`;
  }
  return html`<div class="paper-overview__flags">${flags}</div>`;
}

function renderRow(props: PaperOverviewProps, row: PaperOverviewRow) {
  return html`
    <tr
      class="profile-overview__row paper-overview__row"
      data-attention=${row.needsAttention}
      data-dormant=${row.dormant}
    >
      <td class="profile-overview__cell">
        <button
          class="logistics-requests__open"
          type="button"
          @click=${() => props.onOpenPaper(row.paper.id)}
        >
          ${row.paper.title}
        </button>
        <span class="profile-overview__status"
          >${row.paper.authors.join(", ") || t("paperOverview.noAuthors")}</span
        >
      </td>
      <td class="profile-overview__cell">${renderStageCell(row)}</td>
      <td class="profile-overview__cell profile-overview__cell--missing">
        ${renderEvidenceCell(row)}
      </td>
      <td class="profile-overview__cell">
        ${row.venue
          ? html`<span>${row.venue}</span>`
          : html`<span class="profile-overview__flag">${t("paperOverview.noVenue")}</span>`}
        ${row.deadline
          ? html`<span class="profile-overview__status">${row.deadline}</span>`
          : nothing}
      </td>
      <td class="profile-overview__cell">${renderOutstandingCell(row)}</td>
    </tr>
  `;
}
