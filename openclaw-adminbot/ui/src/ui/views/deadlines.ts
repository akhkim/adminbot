// Control UI view renders the AdminBot deadline tracker (Output 0 tab).
// Self-contained: reads the bundled DEADLINE_VENUES snapshot and lists upcoming
// conference/workshop deadlines with AoE-correct dates and a LIVE per-second
// countdown (days + HH:MM:SS) that ticks in place. The standalone board served
// at GET /deadlines uses the same data (see docs/tools/adminbot-deadlines.md).
import { html, nothing, LitElement } from "lit";
import { DEADLINE_VENUES, type DeadlineVenue } from "../deadlines-data.ts";

const MS_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// AoE (UTC-12): a wall-clock deadline maps to its UTC instant + 12h.
function aoeInstantMs(aoe: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(aoe);
  if (!m) {
    return Number.NaN;
  }
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) + 12 * 3600 * 1000;
}

// Display the AoE calendar date (not the +12h-shifted UTC date).
function aoeDateLabel(aoe: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/u.exec(aoe);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : "";
}

function urgencyColor(days: number): string {
  if (days <= 3) {
    return "#f2606a";
  }
  if (days <= 7) {
    return "#f5883e";
  }
  if (days <= 30) {
    return "#eab54a";
  }
  return "#34d3a6";
}

const pad = (n: number): string => String(n).padStart(2, "0");

// Remaining time as "Nd HH:MM:SS" (AoE deadlines can be same-day, so we always
// show hours:minutes:seconds instead of collapsing a due-today item to "0d").
function countdownLabel(ms: number): string {
  const left = ms > 0 ? ms : 0;
  const d = Math.floor(left / MS_DAY);
  const h = Math.floor(left / 3_600_000) % 24;
  const m = Math.floor(left / 60_000) % 60;
  const s = Math.floor(left / 1000) % 60;
  return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
}

type Row = { venue: DeadlineVenue; instant: number };

// Custom element so the countdown owns a 1s timer and re-renders itself; a plain
// render function cannot manage the tick lifecycle. Light DOM (createRenderRoot
// returns this) lets the app's theme CSS variables cascade into the rows.
class AdminbotDeadlinesView extends LitElement {
  private timer: number | undefined;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => this.requestUpdate(), 1000);
  }

  disconnectedCallback(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    super.disconnectedCallback();
  }

  render() {
    const now = Date.now();
    const rows: Row[] = DEADLINE_VENUES.map((venue) => ({
      venue,
      instant: aoeInstantMs(venue.deadline_aoe),
    }))
      .filter((r) => Number.isFinite(r.instant) && r.instant > now)
      .sort((a, b) => a.instant - b.instant);

    return html`
      <style>
        .deadlines-view { padding: 4px 2px 24px; }
        .deadlines-view .intro { color: var(--text-muted, #9fb0cc); font-size: 13.5px; margin: 0 0 16px; }
        .deadlines-list { display: flex; flex-direction: column; gap: 8px; }
        .deadline-row {
          display: grid; grid-template-columns: 132px 128px 1fr auto; align-items: center; gap: 12px;
          padding: 11px 14px; border: 1px solid var(--border, #26324a);
          border-left: 4px solid var(--u); border-radius: 10px;
          background: var(--surface, #141b2b);
        }
        .deadline-row .dl-date { font-variant-numeric: tabular-nums; font-size: 13px; }
        .deadline-row .dl-cd {
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
          font-variant-numeric: tabular-nums; font-weight: 600; color: var(--u); font-size: 13px;
        }
        .deadline-row .dl-name { font-size: 13.5px; }
        .deadline-row .dl-note { color: var(--text-muted, #66799a); font-size: 11.5px; }
      </style>
      <section class="deadlines-view">
        <p class="intro">
          Upcoming conference &amp; workshop deadlines (times AoE, UTC&#8209;12). Countdowns update
          live every second.
        </p>
        <div class="deadlines-list">
          ${rows.length === 0
            ? html`<p class="intro">No upcoming deadlines.</p>`
            : rows.map(({ venue, instant }) => {
                const days = Math.floor((instant - now) / MS_DAY);
                return html`
                  <div class="deadline-row" style=${`--u:${urgencyColor(days)}`}>
                    <span class="dl-date">${aoeDateLabel(venue.deadline_aoe)} AoE</span>
                    <span class="dl-cd">${countdownLabel(instant - now)}</span>
                    <span class="dl-name">
                      ${venue.name}
                      ${venue.venue_type === "workshop"
                        ? html`<span class="dl-note"> · ${venue.venue_group}</span>`
                        : nothing}
                    </span>
                    ${venue.link
                      ? html`<a href=${venue.link} target="_blank" rel="noopener">↗</a>`
                      : nothing}
                  </div>
                `;
              })}
        </div>
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
