import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { CURATED_DEADLINES, type CuratedDeadline } from "./deadline-data.js";

export class AdminBotDeadlineBoard extends LitElement {
  static override properties = {
    now: { state: true },
    query: { state: true },
    kind: { state: true },
  };
  static override styles = css`
    :host { display: block; color: var(--text); }
    * { box-sizing: border-box; }
    h1 { margin: 0; color: var(--text-strong); font-family: Georgia, serif; font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 500; }
    .eyebrow { margin: 0 0 .55rem; color: var(--accent); font-size: .65rem; font-weight: 780; letter-spacing: .14em; text-transform: uppercase; }
    .lede { max-width: 48rem; color: var(--text-muted); line-height: 1.6; }
    .filters { display: grid; grid-template-columns: minmax(14rem, 1fr) 12rem; gap: .75rem; margin: 1.5rem 0; }
    input, select { width: 100%; border: 1px solid var(--border-strong); border-radius: .65rem; padding: .72rem; color: var(--text-strong); background: var(--surface-1); font: inherit; }
    .board { display: grid; gap: .65rem; }
    .row { --urgency: var(--accent); display: grid; grid-template-columns: 8.5rem 9.5rem minmax(12rem, 1fr) auto; gap: 1rem; align-items: center; border: 1px solid var(--border); border-left: .25rem solid var(--urgency); border-radius: .8rem; padding: .9rem 1rem; background: var(--surface-2); }
    .date { color: var(--text-muted); font-size: .75rem; }
    .countdown { color: var(--urgency); font: 700 .78rem ui-monospace, monospace; font-variant-numeric: tabular-nums; }
    .name { display: grid; gap: .16rem; }
    .name strong { color: var(--text-strong); font-size: .84rem; }
    .name small { color: var(--text-muted); }
    a { color: var(--accent); text-decoration: none; }
    .empty { border: 1px dashed var(--border); border-radius: .8rem; padding: 2rem; color: var(--text-muted); text-align: center; }
    .provenance { margin-top: 1rem; color: var(--text-faint); font-size: .68rem; }
    @media (max-width: 760px) { .filters { grid-template-columns: 1fr; } .row { grid-template-columns: 1fr auto; } .name { grid-column: 1 / -1; grid-row: 1; } }
  `;

  declare private now: number;
  declare private query: string;
  declare private kind: string;
  private timer: number | undefined;

  constructor() {
    super();
    this.now = Date.now();
    this.query = "";
    this.kind = "";
  }
  override connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => { this.now = Date.now(); }, 1_000);
  }
  override disconnectedCallback(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    super.disconnectedCallback();
  }
  override render(): TemplateResult {
    const query = this.query.trim().toLowerCase();
    const rows = CURATED_DEADLINES
      .filter((deadline) => Date.parse(deadline.occursAtAoe) > this.now)
      .filter((deadline) => !this.kind || deadline.kind === this.kind)
      .filter((deadline) => !query || `${deadline.name} ${deadline.group} ${deadline.label}`.toLowerCase().includes(query))
      .toSorted((left, right) => Date.parse(left.occursAtAoe) - Date.parse(right.occursAtAoe));
    return html`
      <header><p class="eyebrow">Public directory · verified snapshot</p><h1>Conference deadlines</h1>
        <p class="lede">Upcoming research deadlines in Anywhere on Earth time (UTC−12). Countdowns update every second; each entry links to its official source.</p></header>
      <div class="filters">
        <input type="search" aria-label="Search deadlines" placeholder="Search venue or milestone" .value=${this.query} @input=${(event: Event) => { this.query = (event.target as HTMLInputElement).value; }} />
        <select aria-label="Deadline type" .value=${this.kind} @change=${(event: Event) => { this.kind = (event.target as HTMLSelectElement).value; }}>
          <option value="">All types</option><option value="conference">Conference</option><option value="workshop">Workshop</option><option value="review">Review cycle</option>
        </select>
      </div>
      <section class="board" aria-live="polite">
        ${rows.length === 0 ? html`<div class="empty">No upcoming deadlines match these filters.</div>` : rows.map((deadline) => this.renderDeadline(deadline))}
      </section>
      <p class="provenance">Snapshot verified 8 August 2026. Venue pages remain authoritative; use the source link before acting.</p>
    `;
  }
  private renderDeadline(deadline: CuratedDeadline): TemplateResult {
    const instant = Date.parse(deadline.occursAtAoe);
    return html`<article class="row" style=${`--urgency:${urgency(instant - this.now)}`}>
      <time class="date" datetime=${deadline.occursAtAoe}>${formatAoeDate(deadline.occursAtAoe)} AoE</time>
      <span class="countdown">${countdown(instant - this.now)}</span>
      <span class="name"><strong>${deadline.name}</strong><small>${deadline.label} · ${deadline.group}</small></span>
      ${deadline.sourceUri ? html`<a href=${deadline.sourceUri} target="_blank" rel="noopener noreferrer" aria-label=${`Official source for ${deadline.name}`}>↗</a>` : nothing}
    </article>`;
  }
}

export function countdown(milliseconds: number): string {
  const left = Math.max(0, milliseconds);
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor(left / 3_600_000) % 24;
  const minutes = Math.floor(left / 60_000) % 60;
  const seconds = Math.floor(left / 1_000) % 60;
  return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
function pad(value: number): string { return String(value).padStart(2, "0"); }
function formatAoeDate(value: string): string { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "Etc/GMT+12" }).format(new Date(value)); }
function urgency(left: number): string { const days = left / 86_400_000; return days <= 3 ? "#f28e8e" : days <= 7 ? "#ed9b63" : days <= 30 ? "#e8bd6b" : "var(--accent)"; }
