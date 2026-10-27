// The lab's talks-and-orals leaderboard, counted by the service from members' linked CVs.
//
// It replaces the list kept by hand in the lab meeting doc, which is why every member can open it:
// the doc was the whole lab's to read. The service ranks the rows (ties share a rank), so this view
// and the CV Updates doc can never disagree about who is level with whom.
import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { memberAuthHeaders } from "../api/device-clock.ts";

/** What GET /cv/talk-leaderboard answers with. Mirrors the service; ui/ cannot import extensions/. */
export type TalkLeaderboard = {
  year: number;
  rows: Array<{
    rank: number;
    member_id: string;
    member_name: string;
    invited: number;
    orals: number;
    total: number;
  }>;
  unscanned: string[];
  // Older services do not send it; the page then just omits the status line.
  sweep?:
    | {
        state: "reading";
        started_at: string;
        done: number;
        total: number;
        eta_seconds: number | null;
      }
    | {
        state: "idle";
        last_completed_at: string | null;
        last_failed_at: string | null;
        next_due_at: string | null;
      };
};

function minutes(seconds: number) {
  const m = Math.max(1, Math.round(seconds / 60));
  return m >= 90 ? `about ${Math.round(m / 60)} hours` : `about ${m} min`;
}

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One line on whether the counts are settled, being refreshed, or waiting for the first read. */
export function sweepStatusText(sweep: TalkLeaderboard["sweep"], now = new Date()): string {
  if (!sweep) {
    return "";
  }
  if (sweep.state === "reading") {
    const eta =
      sweep.eta_seconds === null ? "working out how long" : `${minutes(sweep.eta_seconds)} left`;
    return `Reading CVs now: ${sweep.done} of ${sweep.total} done, ${eta}. Counts update when it finishes.`;
  }
  const failed =
    sweep.last_failed_at &&
    (!sweep.last_completed_at || sweep.last_failed_at > sweep.last_completed_at)
      ? " The last attempt failed and will be retried."
      : "";
  if (!sweep.last_completed_at) {
    return `Waiting for the first full read of everyone's CVs; it starts within the hour.${failed}`;
  }
  const due =
    sweep.next_due_at && Date.parse(sweep.next_due_at) > now.getTime()
      ? `next read ${when(sweep.next_due_at)}`
      : "next read starts within the hour";
  return `Last read ${when(sweep.last_completed_at)}; ${due}.${failed}`;
}

// The guidebook's extra free trip goes to the top two. Ranks, not positions: two people level at
// second are both in line for it, and the page should not pick between them.
const PERK_RANKS = 2;

export class TalkLeaderboardView extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @property() memberId = "";
  @state() private year = new Date().getFullYear();
  @state() private board: TalkLeaderboard | null = null;
  @state() private loading = false;
  @state() private error = "";
  private controller?: AbortController;
  // While the service is reading CVs the counts and progress move, so the page re-asks each minute.
  private refreshTimer?: ReturnType<typeof setTimeout>;

  static override styles = css`
    :host {
      display: block;
      max-width: 860px;
      color: var(--text);
    }
    section {
      border: 1px solid var(--border, #8885);
      border-radius: 16px;
      padding: 24px 28px;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    header .hint {
      margin: 0;
      flex: 1 1 18rem;
    }
    details {
      margin-top: 16px;
    }
    summary {
      cursor: pointer;
      min-height: 44px;
      display: flex;
      align-items: center;
      font-weight: 600;
      list-style: none;
    }
    summary::-webkit-details-marker {
      display: none;
    }
    /* The same chevron as the light DOM's .adminbot-fold, so every fold in the app reads alike. */
    summary::after {
      content: "";
      width: 7px;
      height: 7px;
      margin-left: 10px;
      border-right: 2px solid var(--muted);
      border-bottom: 2px solid var(--muted);
      transform: rotate(45deg);
      transition: transform 0.15s ease;
    }
    details[open] > summary::after {
      transform: rotate(225deg);
    }
    p {
      line-height: 1.6;
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
    }
    select,
    button {
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid var(--border, #8885);
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
    }
    .controls {
      display: flex;
      gap: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
      font-variant-numeric: tabular-nums;
    }
    th,
    td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--border, #8885);
    }
    th {
      color: var(--muted);
      font-weight: 500;
      font-size: 13px;
    }
    td.num,
    th.num {
      text-align: right;
    }
    td.total {
      font-weight: 600;
    }
    td.rank {
      width: 3em;
      font-weight: 600;
    }
    tr.you td {
      background: color-mix(in srgb, var(--accent, #486bdf) 10%, transparent);
    }
    .pill {
      display: inline-block;
      margin-left: 8px;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid var(--accent, #486bdf);
      color: var(--accent, #486bdf);
    }
    .status {
      font-size: 13px;
      padding: 8px 12px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--accent, #486bdf) 8%, transparent);
    }
    .error {
      color: var(--danger, #c0392b);
    }
    :focus-visible {
      outline: 2px solid var(--accent, #486bdf);
      outline-offset: 3px;
    }
    @media (max-width: 560px) {
      section {
        padding: 18px 16px;
      }
      .other {
        display: none;
      }
    }
  `;

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.controller?.abort();
    clearTimeout(this.refreshTimer);
    super.disconnectedCallback();
  }

  private async load() {
    this.controller?.abort();
    clearTimeout(this.refreshTimer);
    if (!this.sessionToken) {
      this.board = null;
      this.error = "Sign in to see the leaderboard.";
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.loading = true;
    this.error = "";
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/, "")}/cv/talk-leaderboard?year=${this.year}`,
        { headers: memberAuthHeaders(this.sessionToken), signal: controller.signal },
      );
      const body = (await response.json().catch(() => null)) as
        | (TalkLeaderboard & { error?: { message?: string } })
        | null;
      if (!response.ok || !body) {
        this.board = null;
        this.error = body?.error?.message ?? `The leaderboard could not load (${response.status}).`;
        return;
      }
      this.board = body;
      if (body.sweep?.state === "reading") {
        this.refreshTimer = setTimeout(() => void this.load(), 60_000);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      this.board = null;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.controller === controller) {
        this.loading = false;
      }
    }
  }

  private chooseYear(event: Event) {
    this.year = Number((event.target as HTMLSelectElement).value);
    void this.load();
  }

  private renderRows(board: TalkLeaderboard) {
    if (!board.rows.length) {
      return html`<p data-testid="talk-leaderboard-empty">
        No talks dated ${board.year} on any CV AdminBot has read yet.
      </p>`;
    }
    return html`<table data-testid="talk-leaderboard-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Member</th>
          <th class="num">Talks</th>
          <th class="num">Invited</th>
          <th class="num other">Orals</th>
          <th class="num other">Other</th>
        </tr>
      </thead>
      <tbody>
        ${board.rows.map(
          (row) =>
            html`<tr class=${row.member_id === this.memberId ? "you" : ""}>
              <td class="rank">${row.rank}</td>
              <td>
                ${row.member_name}${row.member_id === this.memberId ? " (you)" : ""}
                ${row.rank <= PERK_RANKS && board.year === new Date().getFullYear()
                  ? html`<span class="pill">Top two</span>`
                  : nothing}
              </td>
              <td class="num total">${row.total}</td>
              <td class="num">${row.invited}</td>
              <td class="num other orals">${row.orals}</td>
              <td class="num other rest">${row.total - row.invited - row.orals}</td>
            </tr>`,
        )}
      </tbody>
    </table>`;
  }

  override render() {
    const thisYear = new Date().getFullYear();
    const board = this.board;
    return html`<section>
      <header>
        <p class="hint">
          Ranked by all talks, then invited ones. The top two at the end of the year get the
          guidebook's extra free trip.
        </p>
        <div class="controls">
          <select aria-label="Year" @change=${this.chooseYear} ?disabled=${this.loading}>
            ${[thisYear, thisYear - 1, thisYear - 2].map(
              (year) =>
                html`<option value=${year} ?selected=${year === this.year}>${year}</option>`,
            )}
          </select>
          <button type="button" @click=${() => void this.load()} ?disabled=${this.loading}>
            ${this.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>
      ${board?.sweep
        ? html`<p class="status" role="status" data-testid="talk-leaderboard-status">
            ${sweepStatusText(board.sweep)}
          </p>`
        : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${board
        ? this.renderRows(board)
        : this.loading
          ? html`<p class="hint" data-testid="talk-leaderboard-loading">Loading the board…</p>`
          : nothing}
      ${board?.unscanned.length
        ? html`<p class="hint" data-testid="talk-leaderboard-unscanned">
            Not counted yet, because their CV has not been read: ${board.unscanned.join(", ")}.
          </p>`
        : nothing}
      <details>
        <summary>What counts as a talk</summary>
        <p class="hint">
          Counted once a day from each member's linked CV, generously: invited talks, keynotes,
          seminars, panels and guest lectures; contributed talks; and any paper the CV marks as an
          oral or spotlight. A talk listed twice counts once. If one of yours is missing, make it
          clear on the CV (for example "(Oral)" after the venue) and link it from My Profile; the
          next daily read picks it up.
        </p>
      </details>
    </section>`;
  }
}

if (!customElements.get("adminbot-talk-leaderboard")) {
  customElements.define("adminbot-talk-leaderboard", TalkLeaderboardView);
}

export function renderTalkLeaderboard(baseUrl: string, sessionToken: string, memberId: string) {
  return html`<adminbot-talk-leaderboard
    .baseUrl=${baseUrl}
    .sessionToken=${sessionToken}
    .memberId=${memberId}
  ></adminbot-talk-leaderboard>`;
}
