// Native rendering for every Control UI deadline surface.
//
// The service also exposes a self-contained version at GET /deadlines. Both surfaces read the
// generated deadline dataset and present the same board: period, type and priority filters,
// search, venue groups, source links, history, and card/group/table views. This renderer stays in
// app's document flow so the containing page owns one ordinary vertical scroll.

import { html, nothing, LitElement } from "lit";
import { t } from "../../../i18n/index.ts";
import {
  aoeDateLabel,
  aoeDateTimeLabel,
  aoeInstantMs,
  countdownLabel,
  MS_DAY,
  urgencyOf,
  type Urgency,
} from "../data/deadline-time.ts";
import { DEADLINE_VENUES, type DeadlineVenue } from "../data/deadlines.ts";

export type DeadlineBoardEntry = { venue: DeadlineVenue; instant: number };
type DeadlineGroupKind = "archival" | "nonArchival" | "mixed" | "unknown" | "other";
export type DeadlineBoardGroup = {
  id: string;
  label: string;
  entries: DeadlineBoardEntry[];
  instant: number;
  sections: Record<DeadlineGroupKind, DeadlineBoardEntry[]>;
};
export type DeadlineBoardView = "cards" | "groups" | "table";
export type DeadlineBoardPeriod = "upcoming" | "past";
export type DeadlineBoardEntryType = "all" | DeadlineVenue["entry_type"];
export type DeadlineBoardArchivalStatus = "all" | DeadlineVenue["archival_status"];
export type DeadlineBoardPriority = "all" | DeadlineVenue["venue_priority"];
export type DeadlineBoardFilters = Readonly<{
  entryType: DeadlineBoardEntryType;
  archivalStatus: DeadlineBoardArchivalStatus;
  priority: DeadlineBoardPriority;
}>;
type DeadlineUrgency = Urgency | "passed";

export const DEFAULT_DEADLINE_BOARD_FILTERS: DeadlineBoardFilters = {
  entryType: "all",
  archivalStatus: "all",
  priority: "all",
};

export function buildDeadlineBoardEntries(): DeadlineBoardEntry[] {
  return DEADLINE_VENUES.map((venue) => ({ venue, instant: aoeInstantMs(venue.deadline_aoe) }))
    .filter((entry) => Number.isFinite(entry.instant))
    .toSorted(
      (left, right) =>
        left.instant - right.instant || left.venue.name.localeCompare(right.venue.name),
    );
}

export function entriesForDeadlinePeriod(
  entries: readonly DeadlineBoardEntry[],
  now: number,
  period: DeadlineBoardPeriod,
): DeadlineBoardEntry[] {
  return entries
    .filter((entry) => (period === "upcoming" ? entry.instant > now : entry.instant <= now))
    .toSorted((left, right) =>
      period === "upcoming"
        ? left.instant - right.instant || left.venue.name.localeCompare(right.venue.name)
        : right.instant - left.instant || left.venue.name.localeCompare(right.venue.name),
    );
}

export function filterDeadlineBoardEntries(
  entries: readonly DeadlineBoardEntry[],
  group: string,
  query: string,
  filters: DeadlineBoardFilters = DEFAULT_DEADLINE_BOARD_FILTERS,
): DeadlineBoardEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(({ venue }) => {
    if (group && venue.venue_group !== group) {
      return false;
    }
    if (filters.entryType !== "all" && venue.entry_type !== filters.entryType) {
      return false;
    }
    if (filters.archivalStatus !== "all" && venue.archival_status !== filters.archivalStatus) {
      return false;
    }
    if (filters.priority !== "all" && venue.venue_priority !== filters.priority) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return [
      venue.name,
      venue.venue_group,
      venue.entry_type,
      venue.deadline_label,
      venue.archival_status,
      venue.venue_priority,
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
  });
}

export function groupDeadlineBoardEntries(
  entries: readonly DeadlineBoardEntry[],
): DeadlineBoardGroup[] {
  const groups = new Map<string, DeadlineBoardGroup>();
  for (const entry of entries) {
    const id = entry.venue.venue_group.trim();
    const kind: DeadlineGroupKind =
      entry.venue.entry_type === "rebuttal"
        ? "other"
        : entry.venue.archival_status === "archival"
          ? "archival"
          : entry.venue.archival_status === "non_archival"
            ? "nonArchival"
            : entry.venue.archival_status === "mixed"
              ? "mixed"
              : "unknown";
    const current = groups.get(id);
    if (current) {
      current.entries.push(entry);
      current.sections[kind].push(entry);
    } else {
      const sections: Record<DeadlineGroupKind, DeadlineBoardEntry[]> = {
        archival: [],
        nonArchival: [],
        mixed: [],
        unknown: [],
        other: [],
      };
      sections[kind].push(entry);
      groups.set(id, {
        id,
        label: id,
        entries: [entry],
        instant: entry.instant,
        sections,
      });
    }
  }
  return [...groups.values()];
}

function groupOptions(entries: readonly DeadlineBoardEntry[], period: DeadlineBoardPeriod) {
  const groups = new Map<string, { id: string; label: string; count: number; instant: number }>();
  for (const entry of entries) {
    const current = groups.get(entry.venue.venue_group);
    if (current) {
      current.count += 1;
      current.instant =
        period === "upcoming"
          ? Math.min(current.instant, entry.instant)
          : Math.max(current.instant, entry.instant);
    } else {
      groups.set(entry.venue.venue_group, {
        id: entry.venue.venue_group,
        label: entry.venue.venue_group,
        count: 1,
        instant: entry.instant,
      });
    }
  }
  return [...groups.values()].toSorted((left, right) => {
    const chronology =
      period === "upcoming" ? left.instant - right.instant : right.instant - left.instant;
    return chronology || left.label.localeCompare(right.label);
  });
}

export function workshopSourceLinks(venue: DeadlineVenue): {
  titleUrl: string;
  sourceUrl: string;
  sourceLabel: "Call for papers" | "Official site" | "";
  openReviewUrl: string;
} | null {
  if (venue.entry_type !== "workshop") {
    return null;
  }
  const cfpUrl = venue.cfp_url?.trim() || "";
  const homepageUrl = venue.homepage_url?.trim() || "";
  return {
    titleUrl: homepageUrl,
    sourceUrl: cfpUrl || homepageUrl,
    sourceLabel: cfpUrl ? "Call for papers" : homepageUrl ? "Official site" : "",
    openReviewUrl: venue.openreview_url?.trim() || "",
  };
}

export function priorDeadlineRevisions(venue: DeadlineVenue) {
  return venue.revisions.slice(0, -1);
}

function renderDeadlineTitle(venue: DeadlineVenue, label = venue.name) {
  const titleUrl = workshopSourceLinks(venue)?.titleUrl || venue.link?.trim();
  return titleUrl
    ? html`<a href=${titleUrl} target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
}

export function priorityLabelOf(venue: DeadlineVenue): string {
  if (venue.venue_priority === "primary") {
    return "Primary";
  }
  return venue.venue_priority === "secondary" ? "Secondary" : "";
}

export function archivalLabelOf(venue: DeadlineVenue): string {
  if (venue.archival_status === "unknown") {
    return "Archival status not established";
  }
  if (venue.archival_status === "mixed") {
    return "Archival + non-archival";
  }
  return venue.archival_status === "non_archival" ? "Non-archival" : "Archival";
}

function renderClassification(venue: DeadlineVenue) {
  const priority = priorityLabelOf(venue);
  const archival = archivalLabelOf(venue);
  return priority || archival
    ? html`<span class="deadline-classification">
        ${priority
          ? html`<span class="deadline-priority" data-priority=${venue.venue_priority}
              >${priority}</span
            >`
          : nothing}
        ${archival
          ? html`<span class="deadline-archival" data-archival=${venue.archival_status}
              >${archival}</span
            >`
          : nothing}
      </span>`
    : nothing;
}

const ENTRY_TYPE_LABELS: Record<DeadlineVenue["entry_type"], string> = {
  main_conference: "Main conference",
  demo_track: "Demo track",
  workshop: "Workshop",
  arr_direct_submission: "ARR direct submission",
  arr_commitment: "ARR commitment",
  rebuttal: "Rebuttal",
  other: "Other",
};

const ENTRY_TYPE_OPTIONS: ReadonlyArray<{ value: DeadlineBoardEntryType; label: string }> = [
  { value: "all", label: "All entry types" },
  { value: "main_conference", label: "Main conferences" },
  { value: "demo_track", label: "Demo tracks" },
  { value: "workshop", label: "Workshops" },
  { value: "arr_direct_submission", label: "ARR direct submissions" },
  { value: "arr_commitment", label: "ARR commitments" },
  { value: "rebuttal", label: "Rebuttals" },
  { value: "other", label: "Other" },
];

const ARCHIVAL_STATUS_OPTIONS: ReadonlyArray<{
  value: DeadlineBoardArchivalStatus;
  label: string;
}> = [
  { value: "all", label: "All archival statuses" },
  { value: "archival", label: "Archival" },
  { value: "non_archival", label: "Non-archival" },
  { value: "mixed", label: "Archival + non-archival" },
  { value: "unknown", label: "Archival status unknown" },
];

const PRIORITY_OPTIONS: ReadonlyArray<{ value: DeadlineBoardPriority; label: string }> = [
  { value: "all", label: "All priorities" },
  { value: "primary", label: "Primary priority" },
  { value: "secondary", label: "Secondary priority" },
  { value: "standard", label: "Standard priority" },
];

function urgency(entry: DeadlineBoardEntry, now: number): DeadlineUrgency {
  return entry.instant <= now ? "passed" : urgencyOf(entry.instant, now);
}

function urgencyLabel(entry: DeadlineBoardEntry, now: number): string {
  const diff = entry.instant - now;
  if (diff <= 0) {
    return "passed";
  }
  const days = Math.floor(diff / MS_DAY);
  return days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} left`;
}

function renderAoeDateTime(aoe: string) {
  const label = aoeDateTimeLabel(aoe);
  const separator = label.indexOf(" · ");
  return separator < 0
    ? label
    : html`${label.slice(0, separator)}
        <span class="deadline-time">${label.slice(separator)}</span>`;
}

function capitalize(value: string): string {
  return value ? `${value[0].toLocaleUpperCase()}${value.slice(1)}` : "Deadline";
}

function groupRowTitle(venue: DeadlineVenue, conference: string) {
  const stage = capitalize(venue.deadline_label);
  const titleContext = venue.venue_group.trim().replace(/\s+workshops$/iu, "") || conference;
  let name = venue.name.trim();
  for (const affix of [` (${titleContext})`, ` [${titleContext}]`]) {
    if (name.endsWith(affix)) {
      name = name.slice(0, -affix.length).trim();
    }
  }
  for (const separator of [" — ", " – ", " - ", ": "]) {
    if (name.startsWith(`${titleContext}${separator}`)) {
      name = name.slice(titleContext.length + separator.length).trim();
    }
  }
  if (name.toLocaleLowerCase() === titleContext.toLocaleLowerCase()) {
    return { name: stage, stage: "" };
  }
  if (stage.toLocaleLowerCase() === "arr commitment") {
    name = name.replace(/\s*(?:\(ARR commitment\)|[-—–:]?\s*ARR commitment)$/iu, "").trim();
  }
  return { name: name || venue.name, stage };
}

function countdownParts(diff: number) {
  const left = Math.max(diff, 0);
  return {
    days: Math.floor(left / MS_DAY),
    hours: Math.floor(left / 3_600_000) % 24,
    minutes: Math.floor(left / 60_000) % 60,
    seconds: Math.floor(left / 1000) % 60,
  };
}

const pad = (value: number): string => String(value).padStart(2, "0");

function aoeDayKey(now: number): string {
  return new Date(now - 12 * 3_600_000).toISOString().slice(0, 10);
}

class AdminbotDeadlinesView extends LitElement {
  private timer: number | undefined;
  private readonly expandedGroups = new Set<string>();
  private now = Date.now();
  private activeGroup = "";
  private query = "";
  private entryType: DeadlineBoardEntryType = "all";
  private archivalStatus: DeadlineBoardArchivalStatus = "all";
  private priority: DeadlineBoardPriority = "all";
  private period: DeadlineBoardPeriod = "upcoming";
  private view: DeadlineBoardView = "groups";

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => {
      this.now = Date.now();
      this.requestUpdate();
    }, 1000);
  }

  override disconnectedCallback(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    super.disconnectedCallback();
  }

  private selectGroup(group: string): void {
    this.activeGroup = group;
    this.requestUpdate();
  }

  private setQuery(event: Event): void {
    this.query = (event.currentTarget as HTMLInputElement).value;
    this.requestUpdate();
  }

  private setEntryType(event: Event): void {
    this.entryType = (event.currentTarget as HTMLSelectElement).value as DeadlineBoardEntryType;
    this.requestUpdate();
  }

  private setArchivalStatus(event: Event): void {
    this.archivalStatus = (event.currentTarget as HTMLSelectElement)
      .value as DeadlineBoardArchivalStatus;
    this.requestUpdate();
  }

  private setPriority(event: Event): void {
    this.priority = (event.currentTarget as HTMLSelectElement).value as DeadlineBoardPriority;
    this.requestUpdate();
  }

  private setPeriod(period: DeadlineBoardPeriod): void {
    this.period = period;
    this.requestUpdate();
  }

  private setView(view: DeadlineBoardView): void {
    this.view = view;
    this.requestUpdate();
  }

  private toggleGroup(group: string): void {
    if (this.expandedGroups.has(group)) {
      this.expandedGroups.delete(group);
    } else {
      this.expandedGroups.add(group);
    }
    this.requestUpdate();
  }

  private renderHero(entry: DeadlineBoardEntry | undefined) {
    const lead = this.period === "upcoming" ? "Next" : "Most recent";
    if (!entry) {
      return html`
        <section class="deadline-board__hero" data-period=${this.period}>
          <p class="deadline-board__eyebrow">${lead} deadline</p>
          <h2 class="deadline-board__hero-name">Nothing matches this filter</h2>
        </section>
      `;
    }
    const parts = countdownParts(entry.instant - this.now);
    return html`
      <section
        class="deadline-board__hero"
        data-entry-type=${entry.venue.entry_type}
        data-archival-status=${entry.venue.archival_status}
        data-venue-priority=${entry.venue.venue_priority}
        data-urgency=${urgency(entry, this.now)}
        data-period=${this.period}
      >
        <p class="deadline-board__eyebrow">${lead} deadline · ${entry.venue.venue_group}</p>
        <h2 class="deadline-board__hero-name">${renderDeadlineTitle(entry.venue)}</h2>
        <p class="deadline-board__hero-meta">
          ${capitalize(entry.venue.deadline_label)} · ${renderAoeDateTime(entry.venue.deadline_aoe)}
          ·
          <span class="deadline-board__hero-urgency">${urgencyLabel(entry, this.now)}</span>
          ${renderClassification(entry.venue)}
        </p>
        ${this.period === "upcoming"
          ? html`<div
              class="deadline-board__hero-countdown"
              aria-label=${countdownLabel(entry.instant - this.now)}
            >
              ${this.renderCountdownUnit(parts.days, "days")}
              <span aria-hidden="true">:</span>
              ${this.renderCountdownUnit(pad(parts.hours), "hrs")}
              <span aria-hidden="true">:</span>
              ${this.renderCountdownUnit(pad(parts.minutes), "min")}
              <span aria-hidden="true">:</span>
              ${this.renderCountdownUnit(pad(parts.seconds), "sec")}
            </div>`
          : nothing}
      </section>
    `;
  }

  private renderCountdownUnit(value: string | number, label: string) {
    return html`<span class="deadline-board__countdown-unit">
      <strong>${value}</strong><small>${label}</small>
    </span>`;
  }

  private renderStats(entries: readonly DeadlineBoardEntry[]) {
    const within = (days: number) =>
      entries.filter((entry) => {
        const distance =
          this.period === "upcoming" ? entry.instant - this.now : this.now - entry.instant;
        return distance >= 0 && distance <= days * MS_DAY;
      }).length;
    const today = entries.filter(
      (entry) => entry.venue.deadline_aoe.slice(0, 10) === aoeDayKey(this.now),
    ).length;
    const direction = this.period === "upcoming" ? "Due" : "Passed";
    return html`
      <dl class="deadline-board__stats">
        <div>
          <dt>Matching deadlines</dt>
          <dd>${entries.length}</dd>
        </div>
        <div>
          <dt>${direction} today</dt>
          <dd data-urgency="critical">${today}</dd>
        </div>
        <div>
          <dt>${direction} within 7 days</dt>
          <dd data-urgency="soon">${within(7)}</dd>
        </div>
        <div>
          <dt>${direction} within 30 days</dt>
          <dd data-urgency="planned">${within(30)}</dd>
        </div>
      </dl>
    `;
  }

  private renderModes() {
    return html`
      <div class="deadline-board__modes">
        <div class="deadline-board__period" role="group" aria-label="Deadline period">
          <button
            type="button"
            aria-pressed=${String(this.period === "past")}
            data-testid="deadline-period-past"
            @click=${() => this.setPeriod("past")}
          >
            Past
          </button>
          <button
            type="button"
            aria-pressed=${String(this.period === "upcoming")}
            data-testid="deadline-period-upcoming"
            @click=${() => this.setPeriod("upcoming")}
          >
            Upcoming
          </button>
        </div>
        <div class="deadline-board__view" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed=${String(this.view === "groups")}
            @click=${() => this.setView("groups")}
          >
            Groups
          </button>
          <button
            type="button"
            aria-pressed=${String(this.view === "cards")}
            @click=${() => this.setView("cards")}
          >
            Cards
          </button>
          <button
            type="button"
            aria-pressed=${String(this.view === "table")}
            @click=${() => this.setView("table")}
          >
            Table
          </button>
        </div>
      </div>
    `;
  }

  private renderControls(
    entries: readonly DeadlineBoardEntry[],
    periodEntries: readonly DeadlineBoardEntry[],
    filters: DeadlineBoardFilters,
  ) {
    const count = <Key extends keyof DeadlineBoardFilters>(
      key: Key,
      value: DeadlineBoardFilters[Key],
    ) =>
      filterDeadlineBoardEntries(periodEntries, "", this.query, {
        ...filters,
        [key]: value,
      }).length;
    return html`
      <div class="deadline-board__controls">
        <label class="deadline-board__search">
          <span class="sr-only">Search deadlines</span>
          <input
            type="search"
            placeholder="Search conferences & workshops…"
            .value=${this.query}
            @input=${this.setQuery}
          />
        </label>
        <label class="deadline-board__facet">
          <span class="sr-only">Filter by entry type</span>
          <select
            data-testid="deadline-filter-entry-type"
            .value=${this.entryType}
            @change=${this.setEntryType}
          >
            ${ENTRY_TYPE_OPTIONS.map(
              (option) => html`<option value=${option.value}>
                ${option.label} (${count("entryType", option.value)})
              </option>`,
            )}
          </select>
        </label>
        <label class="deadline-board__facet">
          <span class="sr-only">Filter by archival status</span>
          <select
            data-testid="deadline-filter-archival-status"
            .value=${this.archivalStatus}
            @change=${this.setArchivalStatus}
          >
            ${ARCHIVAL_STATUS_OPTIONS.map(
              (option) => html`<option value=${option.value}>
                ${option.label} (${count("archivalStatus", option.value)})
              </option>`,
            )}
          </select>
        </label>
        <label class="deadline-board__facet">
          <span class="sr-only">Filter by priority</span>
          <select
            data-testid="deadline-filter-priority"
            .value=${this.priority}
            @change=${this.setPriority}
          >
            ${PRIORITY_OPTIONS.map(
              (option) => html`<option value=${option.value}>
                ${option.label} (${count("priority", option.value)})
              </option>`,
            )}
          </select>
        </label>
        <div class="deadline-board__groups" role="group" aria-label="Filter by venue">
          <button
            type="button"
            aria-pressed=${String(!this.activeGroup)}
            data-testid="deadline-group-all"
            @click=${() => this.selectGroup("")}
          >
            All <span>${entries.length}</span>
          </button>
          ${groupOptions(entries, this.period).map(
            (group) => html`
              <button
                type="button"
                aria-pressed=${String(this.activeGroup === group.id)}
                data-testid=${`deadline-group-${group.id}`}
                @click=${() => this.selectGroup(group.id)}
              >
                ${group.label} <span>${group.count}</span>
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderArchivalGuide() {
    return html`
      <details class="deadline-board__guide">
        <summary>What priority and archival status mean</summary>
        <p>
          Primary and Secondary are the lab's venue priorities. Archival status is a separate
          publication-policy classification.
        </p>
        <p>
          Workshop status follows its own CFP or an official parent policy. A workshop can offer
          archival, non-archival, or separate archival and non-archival routes.
        </p>
        <dl>
          <div>
            <dt>Archival</dt>
            <dd>counts as publishing; the same paper cannot generally be submitted elsewhere.</dd>
          </div>
          <div>
            <dt>Non-archival</dt>
            <dd>does not count as publishing; you can still submit the paper elsewhere.</dd>
          </div>
          <div>
            <dt>Archival + non-archival</dt>
            <dd>choose the CFP's non-archival route if the paper may be submitted elsewhere.</dd>
          </div>
          <div>
            <dt>Unknown</dt>
            <dd>check the call for papers before assuming another submission is allowed.</dd>
          </div>
        </dl>
      </details>
    `;
  }

  private renderHistory(venue: DeadlineVenue) {
    const previous = priorDeadlineRevisions(venue);
    return previous.length
      ? html`<details class="deadline-card__note deadline-card__history">
          <summary>Deadline history (${previous.length})</summary>
          <ul>
            ${previous.map(
              (revision) => html`<li>
                ${renderAoeDateTime(revision.deadline_aoe)} ·
                ${capitalize(revision.deadline_label || "deadline")} · recorded
                ${revision.observed_at.slice(0, 10)}
                ${revision.link
                  ? html` ·
                      <a href=${revision.link} target="_blank" rel="noopener noreferrer"
                        >source ↗</a
                      >`
                  : nothing}
              </li>`,
            )}
          </ul>
        </details>`
      : nothing;
  }

  private renderStale(venue: DeadlineVenue) {
    return venue.stale
      ? html`<p class="deadline-card__note">Source not observed in the latest sweep.</p>`
      : nothing;
  }

  private renderCard(entry: DeadlineBoardEntry) {
    const { venue, instant } = entry;
    return html`
      <article
        class="deadline-card"
        data-entry-type=${venue.entry_type}
        data-archival-status=${venue.archival_status}
        data-venue-priority=${venue.venue_priority}
        data-urgency=${urgency(entry, this.now)}
        data-period=${this.period}
      >
        <div class="deadline-card__topline">
          <span class="deadline-card__type">${ENTRY_TYPE_LABELS[venue.entry_type]}</span>
          <span class="deadline-card__urgency">${urgencyLabel(entry, this.now)}</span>
        </div>
        <h2 class="deadline-card__name">${renderDeadlineTitle(venue)}</h2>
        <p
          class="deadline-card__group"
          title=${`${venue.venue_group} · ${capitalize(venue.deadline_label)}`}
        >
          <span class="deadline-card__group-name">${venue.venue_group}</span>
          <span aria-hidden="true">·</span>
          <span class="deadline-card__stage">${capitalize(venue.deadline_label)}</span>
        </p>
        ${renderClassification(venue)}
        <time class="deadline-card__date" datetime=${venue.deadline_aoe}>
          ${renderAoeDateTime(venue.deadline_aoe)}
        </time>
        <p class="deadline-card__countdown">
          ${this.period === "past" ? "passed" : countdownLabel(instant - this.now)}
        </p>
        ${venue.notification_aoe
          ? html`<p class="deadline-card__note">
              Accept/reject: ${aoeDateLabel(venue.notification_aoe)} AoE
            </p>`
          : nothing}
        ${this.renderStale(venue)} ${this.renderHistory(venue)} ${this.renderSourceActions(venue)}
      </article>
    `;
  }

  private renderSourceActions(venue: DeadlineVenue) {
    const workshop = workshopSourceLinks(venue);
    if (!workshop) {
      return venue.link
        ? html`<span class="deadline-card__actions"
            ><a
              class="deadline-card__source deadline-card__source--button"
              href=${venue.link}
              target="_blank"
              rel="noopener noreferrer"
              aria-label=${`Official site for ${venue.name}`}
              >Official site ↗</a
            ></span
          >`
        : nothing;
    }
    return html`<span class="deadline-card__actions">
      ${workshop.sourceUrl
        ? html`<a
            class="deadline-card__source deadline-card__source--button"
            href=${workshop.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${`${workshop.sourceLabel} for ${venue.name}`}
            >${workshop.sourceLabel} ↗</a
          >`
        : html`<span class="deadline-card__missing">Call for papers not found yet</span>`}
      ${workshop.openReviewUrl
        ? html`<a
            class="deadline-card__source deadline-card__source--button"
            href=${workshop.openReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${`OpenReview for ${venue.name}`}
            >OpenReview ↗</a
          >`
        : nothing}
    </span>`;
  }

  private renderTable(entries: readonly DeadlineBoardEntry[]) {
    return html`
      <div class="deadline-table-wrap">
        <table class="deadline-table">
          <thead>
            <tr>
              <th>Deadline (AoE)</th>
              <th>Countdown</th>
              <th>Item</th>
              <th>Type</th>
              <th>Venue</th>
              <th><span class="sr-only">Source and history</span></th>
            </tr>
          </thead>
          <tbody>
            ${entries.map(
              (entry) => html`
                <tr
                  data-entry-type=${entry.venue.entry_type}
                  data-archival-status=${entry.venue.archival_status}
                  data-venue-priority=${entry.venue.venue_priority}
                  data-urgency=${urgency(entry, this.now)}
                  data-period=${this.period}
                >
                  <td class="deadline-table__date">
                    ${renderAoeDateTime(entry.venue.deadline_aoe)}
                  </td>
                  <td class="deadline-table__countdown">
                    ${this.period === "past" ? "passed" : countdownLabel(entry.instant - this.now)}
                  </td>
                  <td class="deadline-table__name">${renderDeadlineTitle(entry.venue)}</td>
                  <td>
                    <span class="deadline-card__labels">
                      <span class="deadline-card__type"
                        >${ENTRY_TYPE_LABELS[entry.venue.entry_type]}</span
                      >
                      ${renderClassification(entry.venue)}
                    </span>
                  </td>
                  <td class="deadline-table__venue">${entry.venue.venue_group}</td>
                  <td>
                    ${entry.venue.stale
                      ? html`<span
                          class="deadline-table__stale"
                          title="Source not observed in the latest sweep."
                          >stale</span
                        >`
                      : nothing}
                    ${this.renderHistory(entry.venue)} ${this.renderSourceActions(entry.venue)}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderGroupRow(entry: DeadlineBoardEntry, conference: string) {
    const { venue, instant } = entry;
    const title = groupRowTitle(venue, conference);
    const history = priorDeadlineRevisions(venue);
    const details = [
      venue.notification_aoe ? `Accept/reject ${aoeDateLabel(venue.notification_aoe)} AoE` : "",
      history.length
        ? `Previously ${history
            .map(
              (revision) =>
                `${aoeDateTimeLabel(revision.deadline_aoe)} (${capitalize(revision.deadline_label || "deadline")})`,
            )
            .join(", ")}`
        : "",
      venue.stale ? "Source not observed in the latest sweep" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const note = [title.stage, details].filter(Boolean).join(" · ");
    return html`
      <div
        class="deadline-group__row"
        data-entry-type=${venue.entry_type}
        data-archival-status=${venue.archival_status}
        data-venue-priority=${venue.venue_priority}
        data-urgency=${urgency(entry, this.now)}
        data-period=${this.period}
      >
        <span class="deadline-group__row-countdown">
          ${this.period === "past" ? "passed" : countdownLabel(instant - this.now)}
        </span>
        <time class="deadline-group__row-date" datetime=${venue.deadline_aoe}>
          ${renderAoeDateTime(venue.deadline_aoe)}
        </time>
        <div class="deadline-group__row-main">
          <h3 class="deadline-group__row-name">${renderDeadlineTitle(venue, title.name)}</h3>
          <p class="deadline-group__row-note">
            ${note ? html`<span class="deadline-group__row-detail">${note}</span>` : nothing}
            <span class="deadline-card__labels">
              <span class="deadline-card__type">${ENTRY_TYPE_LABELS[venue.entry_type]}</span>
              ${renderClassification(venue)}
            </span>
          </p>
        </div>
        ${this.renderSourceActions(venue)}
      </div>
    `;
  }

  private renderGroupSection(
    label: string,
    entries: readonly DeadlineBoardEntry[],
    conference: string,
  ) {
    if (!entries.length) {
      return nothing;
    }
    return html`
      <section class="deadline-group__section">
        <p class="deadline-group__section-head">
          <strong>${label}</strong><span>${entries.length}</span>
        </p>
        ${entries.map((entry) => this.renderGroupRow(entry, conference))}
      </section>
    `;
  }

  private renderGroups(entries: readonly DeadlineBoardEntry[]) {
    return html`<div class="deadline-board__group-list">
      ${groupDeadlineBoardEntries(entries).map((group, index) => {
        const open = this.expandedGroups.has(group.id);
        const panelId = `deadline-group-panel-${index}`;
        const counts = [
          group.sections.archival.length ? `${group.sections.archival.length} archival` : "",
          group.sections.nonArchival.length
            ? `${group.sections.nonArchival.length} non-archival`
            : "",
          group.sections.mixed.length
            ? `${group.sections.mixed.length} archival + non-archival`
            : "",
          group.sections.unknown.length ? `${group.sections.unknown.length} unknown` : "",
          group.sections.other.length ? `${group.sections.other.length} other` : "",
        ].filter(Boolean);
        return html`
          <section
            class="deadline-group"
            data-count=${group.entries.length}
            data-urgency=${urgency(group.entries[0], this.now)}
            data-period=${this.period}
            ?data-open=${open}
          >
            <button
              type="button"
              class="deadline-group__summary"
              aria-expanded=${String(open)}
              aria-controls=${panelId}
              @click=${() => this.toggleGroup(group.id)}
            >
              <span class="deadline-group__chevron" aria-hidden="true">›</span>
              <span class="deadline-group__summary-countdown"
                >${this.period === "past"
                  ? "passed"
                  : countdownLabel(group.instant - this.now)}</span
              >
              <span class="deadline-group__heading">
                <strong>${group.label}</strong>
                <small>${renderAoeDateTime(group.entries[0].venue.deadline_aoe)}</small>
              </span>
              <span class="deadline-group__count">${counts.join(" · ")}</span>
            </button>
            <div class="deadline-group__panel" id=${panelId} ?hidden=${!open}>
              ${this.renderGroupSection("Archival", group.sections.archival, group.label)}
              ${this.renderGroupSection("Non-archival", group.sections.nonArchival, group.label)}
              ${this.renderGroupSection(
                "Archival + non-archival",
                group.sections.mixed,
                group.label,
              )}
              ${this.renderGroupSection(
                "Archival status unknown",
                group.sections.unknown,
                group.label,
              )}
              ${this.renderGroupSection("Other dates", group.sections.other, group.label)}
            </div>
          </section>
        `;
      })}
    </div>`;
  }

  protected override render() {
    const all = buildDeadlineBoardEntries();
    const periodEntries = entriesForDeadlinePeriod(all, this.now, this.period);
    const filters: DeadlineBoardFilters = {
      entryType: this.entryType,
      archivalStatus: this.archivalStatus,
      priority: this.priority,
    };
    const matching = filterDeadlineBoardEntries(periodEntries, "", this.query, filters);
    if (
      this.activeGroup &&
      !matching.some((entry) => entry.venue.venue_group === this.activeGroup)
    ) {
      this.activeGroup = "";
    }
    const filtered = filterDeadlineBoardEntries(matching, this.activeGroup, "", filters);
    const next = filtered[0];
    const latestSourceCheck = DEADLINE_VENUES.map((venue) => venue.source_checked_at || "")
      .filter(Boolean)
      .toSorted()
      .at(-1)
      ?.slice(0, 10);
    return html`
      <section class="deadline-board">
        <header class="deadline-board__header">
          <h1>${t("tabs.adminbotDeadlines")}</h1>
          <p>${t("subtitles.adminbotDeadlines")}</p>
        </header>
        ${this.renderModes()} ${this.renderControls(matching, periodEntries, filters)}
        ${this.renderArchivalGuide()}
        <div class="deadline-board__overview">
          ${this.renderHero(next)} ${this.renderStats(filtered)}
        </div>
        ${filtered.length
          ? this.view === "cards"
            ? html`<div class="deadline-board__grid">
                ${filtered.map((entry) => this.renderCard(entry))}
              </div>`
            : this.view === "groups"
              ? this.renderGroups(filtered)
              : this.renderTable(filtered)
          : html`<p class="deadline-board__empty">No deadlines match your filter.</p>`}
        <p class="deadline-board__foot">
          Showing ${filtered.length} of ${matching.length} matching ${this.period} deadlines ·
          official venue sites + OpenReview
          ${latestSourceCheck ? ` · source checks through ${latestSourceCheck}` : ""}
        </p>
      </section>
    `;
  }
}

if (!customElements.get("adminbot-deadlines-view")) {
  customElements.define("adminbot-deadlines-view", AdminbotDeadlinesView);
}

export function renderDeadlines() {
  return html`<adminbot-deadlines-view></adminbot-deadlines-view>`;
}
