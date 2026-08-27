// Control UI view renders the AdminBot Opportunities board: PhD programs, internships, grants and
// awards, and Rising Stars workshops, split across sub-tabs. Self-contained -- reads the bundled
// OPPORTUNITIES snapshot, so the tab needs no gateway load (see app-settings.ts).
//
// Undated entries are first-class here rather than filtered out: an annual program whose next
// cycle has not been announced is still the thing a member wants to know exists. They render as
// "Deadline TBA" and sort last, never as an expired or invented date.
import { html, nothing, LitElement } from "lit";
import {
  OPPORTUNITIES,
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_CATEGORY_LABELS,
  type Opportunity,
  type OpportunityCategory,
} from "../data/opportunities-data.ts";

const MS_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Filter = OpportunityCategory | "all";

// AoE (UTC-12): a wall-clock deadline maps to its UTC instant + 12h. Same convention as the
// deadlines board, so a date means the same thing on both tabs.
function aoeInstantMs(aoe: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(aoe);
  if (!m) {
    return Number.NaN;
  }
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) + 12 * 3600 * 1000;
}

function aoeDateLabel(aoe: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/u.exec(aoe);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : "";
}

// "in 12 days" / "in 1 day" / "today". Deliberately coarser than the deadlines board's live
// countdown: this is a browsing surface, not a submission-day clock.
function relativeLabel(instant: number, now: number): string {
  const days = Math.floor((instant - now) / MS_DAY);
  if (days < 0) {
    return "closed";
  }
  if (days === 0) {
    return "today";
  }
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

function urgencyColor(instant: number, now: number): string {
  if (!Number.isFinite(instant)) {
    return "#66799a";
  }
  const days = Math.floor((instant - now) / MS_DAY);
  if (days < 0) {
    return "#66799a";
  }
  if (days <= 7) {
    return "#f2606a";
  }
  if (days <= 30) {
    return "#eab54a";
  }
  return "#34d3a6";
}

type Row = { item: Opportunity; instant: number };

// Dated entries ascending, then undated. NaN never participates in the numeric compare, so the
// ordering stays total regardless of how many entries are undated.
function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const aDated = Number.isFinite(a.instant);
    const bDated = Number.isFinite(b.instant);
    if (aDated && bDated) {
      return a.instant - b.instant;
    }
    if (aDated !== bDated) {
      return aDated ? -1 : 1;
    }
    return a.item.name.localeCompare(b.item.name);
  });
}

export function opportunityRows(filter: Filter, items: Opportunity[] = OPPORTUNITIES): Row[] {
  const scoped = filter === "all" ? items : items.filter((item) => item.category === filter);
  return sortRows(scoped.map((item) => ({ item, instant: aoeInstantMs(item.deadline_aoe) })));
}

export function categoryCount(category: Filter, items: Opportunity[] = OPPORTUNITIES): number {
  return category === "all"
    ? items.length
    : items.filter((item) => item.category === category).length;
}

// Custom element so the sub-tab selection lives with the view rather than in app state -- nothing
// outside this tab needs to know which category is showing. The filter is a plain field driven by
// an explicit requestUpdate(), not a Lit reactive property: a declared property plus a class field
// would shadow the generated accessor and silently break reactivity.
class AdminbotOpportunitiesView extends LitElement {
  private filter: Filter = "all";

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private select(next: Filter): void {
    this.filter = next;
    this.requestUpdate();
  }

  private renderTabs() {
    const tabs: Filter[] = ["all", ...OPPORTUNITY_CATEGORIES];
    return html`
      <div class="opp-tabs" role="tablist">
        ${tabs.map((tab) => {
          const count = categoryCount(tab);
          const label = tab === "all" ? "All" : OPPORTUNITY_CATEGORY_LABELS[tab];
          const selected = this.filter === tab;
          return html`
            <button
              class=${`opp-tab ${selected ? "is-active" : ""}`}
              role="tab"
              aria-selected=${selected ? "true" : "false"}
              @click=${() => this.select(tab)}
            >
              ${label}
              <span class="opp-tab-count">${count}</span>
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderRow({ item, instant }: Row, now: number) {
    const dated = Number.isFinite(instant);
    return html`
      <div class="opp-row" style=${`--u:${urgencyColor(instant, now)}`}>
        <div class="opp-when">
          <span class="opp-date">
            ${dated ? `${aoeDateLabel(item.deadline_aoe)} AoE` : "Deadline TBA"}
          </span>
          ${dated ? html`<span class="opp-rel">${relativeLabel(instant, now)}</span>` : nothing}
        </div>
        <div class="opp-body">
          <div class="opp-name">
            ${item.name}
            ${item.link
              ? html`<a href=${item.link} target="_blank" rel="noopener" title="Open program page"
                  >↗</a
                >`
              : nothing}
          </div>
          ${item.org ? html`<div class="opp-org">${item.org}</div>` : nothing}
          ${item.eligibility ? html`<div class="opp-elig">${item.eligibility}</div>` : nothing}
          ${item.note ? html`<div class="opp-note">${item.note}</div>` : nothing}
        </div>
      </div>
    `;
  }

  override render() {
    const now = Date.now();
    const rows = opportunityRows(this.filter);
    return html`
      <style>
        .opportunities-view {
          padding: 4px 2px 24px;
        }
        .opportunities-view .intro {
          color: var(--text-muted, #9fb0cc);
          font-size: 13.5px;
          margin: 0 0 14px;
        }
        .opp-tabs {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 14px;
        }
        .opp-tab {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border: 1px solid var(--border, #26324a);
          border-radius: 999px;
          background: var(--surface, #141b2b);
          color: var(--text, #d7e2f4);
          font-size: 13px;
          cursor: pointer;
        }
        .opp-tab.is-active {
          border-color: var(--accent, #4f8cff);
          color: var(--accent, #4f8cff);
        }
        .opp-tab-count {
          color: var(--text-muted, #66799a);
          font-size: 11.5px;
          font-variant-numeric: tabular-nums;
        }
        .opp-tab.is-active .opp-tab-count {
          color: inherit;
        }
        .opp-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .opp-row {
          display: grid;
          grid-template-columns: 160px 1fr;
          gap: 12px;
          padding: 11px 14px;
          border: 1px solid var(--border, #26324a);
          border-left: 4px solid var(--u);
          border-radius: 10px;
          background: var(--surface, #141b2b);
        }
        .opp-when {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .opp-date {
          font-variant-numeric: tabular-nums;
          font-size: 13px;
        }
        .opp-rel {
          color: var(--u);
          font-size: 11.5px;
          font-weight: 600;
        }
        .opp-name {
          font-size: 13.5px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .opp-org {
          color: var(--text-muted, #9fb0cc);
          font-size: 12px;
          margin-top: 2px;
        }
        .opp-elig {
          color: var(--text-muted, #9fb0cc);
          font-size: 12px;
          margin-top: 4px;
        }
        .opp-note {
          color: var(--text-muted, #66799a);
          font-size: 11.5px;
          margin-top: 4px;
        }
        @media (max-width: 640px) {
          .opp-row {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <section class="opportunities-view">
        <p class="intro">
          Programs the lab wants you to know about. Eligibility is quoted from each program so you
          can judge your own fit &mdash; nothing here is filtered by who you are.
        </p>
        ${this.renderTabs()}
        <div class="opp-list">
          ${rows.length === 0
            ? html`<p class="intro">Nothing listed here yet.</p>`
            : rows.map((row) => this.renderRow(row, now))}
        </div>
      </section>
    `;
  }
}

if (!customElements.get("adminbot-opportunities-view")) {
  customElements.define("adminbot-opportunities-view", AdminbotOpportunitiesView);
}

export function renderOpportunities() {
  return html`<adminbot-opportunities-view></adminbot-opportunities-view>`;
}
