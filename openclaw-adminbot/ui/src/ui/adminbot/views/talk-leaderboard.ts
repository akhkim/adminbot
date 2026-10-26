// The lab's invited-talk leaderboard, counted by the service from members' linked CVs.
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
    total: number;
  }>;
  unscanned: string[];
};

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

  static override styles = css`
    :host {
      display: block;
      max-width: 860px;
      margin: 24px auto;
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
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    h2 {
      margin: 0;
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
    super.disconnectedCallback();
  }

  private async load() {
    this.controller?.abort();
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
          <th class="num">Invited</th>
          <th class="num other">Other talks</th>
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
              <td class="num">${row.invited}</td>
              <td class="num other">${row.total - row.invited}</td>
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
        <h2>Invited talks ${this.year}</h2>
        <div class="controls">
          <select aria-label="Year" @change=${this.chooseYear} ?disabled=${this.loading}>
            ${[thisYear, thisYear - 1, thisYear - 2].map(
              (year) => html`<option value=${year} ?selected=${year === this.year}>${year}</option>`,
            )}
          </select>
          <button type="button" @click=${() => void this.load()} ?disabled=${this.loading}>
            ${this.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>
      <p class="hint">
        Counted once a day from each member's linked CV and ranked by invited talks, then all talks.
        The top two at the end of the year get the guidebook's extra free trip.
      </p>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${board ? this.renderRows(board) : nothing}
      ${board?.unscanned.length
        ? html`<p class="hint" data-testid="talk-leaderboard-unscanned">
            Not counted yet, because their CV has not been read: ${board.unscanned.join(", ")}.
          </p>`
        : nothing}
      <p class="hint">
        A talk counts as invited when the CV presents it that way — under an "Invited talks"
        heading, or as a keynote, seminar or panel. If yours is missing or in the wrong column, make
        that clear on the CV and link it from My Profile; the next daily read picks it up.
      </p>
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
