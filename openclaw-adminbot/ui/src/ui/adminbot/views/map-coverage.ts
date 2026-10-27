// Admin-only "Map coverage" panel: how many active members each signal places, and who is placed
// only by a stored city, a zone, a country or nothing, with the day each was last in AdminBot.
// Self-contained (it fetches GET /member-map/coverage itself) so it stays out of the member map's
// own view and data modules. Collapsed by default, and fetched only once an admin opens it.
import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { memberAuthHeaders } from "../api/device-clock.ts";

export type MapCoverageBucket =
  | "device"
  | "ip"
  | "checkin"
  | "stored_city"
  | "timezone"
  | "country"
  | "unplaced"
  | "hidden";

export type MapCoverageEntry = {
  member_id: string;
  name: string;
  placed_by: "stored_city" | "timezone" | "country" | "unplaced";
  place_label?: string;
  suspected_vpn?: boolean;
  last_seen_at?: string;
};

export type LocationPromptAnswer = "granted" | "denied" | "dismissed" | "not_asked";

export type LocationRefusal = {
  member_id: string;
  name: string;
  state: "denied" | "dismissed";
  at?: string;
  last_seen_at?: string;
};

export type MapCoverage = {
  active: number;
  counts: Record<MapCoverageBucket | "suspected_vpn", number>;
  stale: MapCoverageEntry[];
  /** Absent from a service that predates recording the browser's answer. */
  permission?: Record<LocationPromptAnswer, number>;
  refused: LocationRefusal[];
};

const BUCKETS: ReadonlyArray<{ key: MapCoverageBucket | "suspected_vpn"; label: string }> = [
  { key: "device", label: "Precise location" },
  { key: "ip", label: "Fresh IP" },
  { key: "checkin", label: "Recent check-in" },
  { key: "stored_city", label: "Stored city only" },
  { key: "timezone", label: "Time zone only" },
  { key: "country", label: "Country only" },
  { key: "unplaced", label: "Unplaced" },
  { key: "hidden", label: "Hidden" },
  { key: "suspected_vpn", label: "IP ignored (VPN?)" },
];

const ANSWERS: ReadonlyArray<{ key: LocationPromptAnswer; label: string }> = [
  { key: "granted", label: "Allowed" },
  { key: "denied", label: "Blocked" },
  { key: "dismissed", label: "Closed it" },
  { key: "not_asked", label: "No answer yet" },
];

const REFUSAL: Record<LocationRefusal["state"], string> = {
  denied: "Blocked",
  dismissed: "Closed the prompt",
};

const PLACED_BY: Record<MapCoverageEntry["placed_by"], string> = {
  stored_city: "stored city",
  timezone: "time zone",
  country: "country",
  unplaced: "unplaced",
};

/** Reads the response defensively: an unexpected shape renders as an error, never as zeros. */
export function parseMapCoverage(raw: unknown): MapCoverage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const body = raw as {
    active?: unknown;
    counts?: unknown;
    stale?: unknown;
    permission?: unknown;
    refused?: unknown;
  };
  if (typeof body.active !== "number" || !body.counts || typeof body.counts !== "object") {
    return null;
  }
  const counts = {} as MapCoverage["counts"];
  for (const { key } of BUCKETS) {
    const value = (body.counts as Record<string, unknown>)[key];
    counts[key] = typeof value === "number" ? value : 0;
  }
  const stale = Array.isArray(body.stale)
    ? body.stale.flatMap((item): MapCoverageEntry[] => {
        const entry = item as Partial<MapCoverageEntry> | null;
        if (
          !entry ||
          typeof entry.member_id !== "string" ||
          typeof entry.name !== "string" ||
          !entry.placed_by ||
          !(entry.placed_by in PLACED_BY)
        ) {
          return [];
        }
        return [
          {
            member_id: entry.member_id,
            name: entry.name,
            placed_by: entry.placed_by,
            ...(typeof entry.place_label === "string" ? { place_label: entry.place_label } : {}),
            ...(entry.suspected_vpn === true ? { suspected_vpn: true } : {}),
            ...(typeof entry.last_seen_at === "string" ? { last_seen_at: entry.last_seen_at } : {}),
          },
        ];
      })
    : [];
  let permission: MapCoverage["permission"];
  if (body.permission && typeof body.permission === "object") {
    permission = {} as Record<LocationPromptAnswer, number>;
    for (const { key } of ANSWERS) {
      const value = (body.permission as Record<string, unknown>)[key];
      permission[key] = typeof value === "number" ? value : 0;
    }
  }
  const refused = Array.isArray(body.refused)
    ? body.refused.flatMap((item): LocationRefusal[] => {
        const entry = item as Partial<LocationRefusal> | null;
        if (
          !entry ||
          typeof entry.member_id !== "string" ||
          typeof entry.name !== "string" ||
          !entry.state ||
          !(entry.state in REFUSAL)
        ) {
          return [];
        }
        return [
          {
            member_id: entry.member_id,
            name: entry.name,
            state: entry.state,
            ...(typeof entry.at === "string" ? { at: entry.at } : {}),
            ...(typeof entry.last_seen_at === "string" ? { last_seen_at: entry.last_seen_at } : {}),
          },
        ];
      })
    : [];
  return { active: body.active, counts, stale, ...(permission ? { permission } : {}), refused };
}

/** "today", "yesterday", "12d ago" by UTC day, or "never" with no record. */
export function lastSeenText(at: string | undefined, now: number): string {
  const ms = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(ms)) {
    return "never";
  }
  const days = Math.max(0, Math.floor(now / 86_400_000) - Math.floor(ms / 86_400_000));
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
}

export class AdminBotMapCoverage extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private coverage: MapCoverage | null = null;
  @state() private error = "";
  @state() private busy = false;
  @state() private open = false;
  private generation = 0;

  protected override createRenderRoot() {
    return this;
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.coverage = null;
      this.error = "";
      if (this.open) {
        void this.load();
      }
    }
  }

  private onToggle(event: Event) {
    this.open = (event.currentTarget as HTMLDetailsElement).open;
    if (this.open && !this.coverage && !this.busy) {
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }

  private async load() {
    if (!this.sessionToken) {
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}/member-map/coverage`, {
        headers: memberAuthHeaders(this.sessionToken),
      });
      const parsed = response.ok ? parseMapCoverage(await response.json()) : null;
      if (generation !== this.generation) {
        return;
      }
      if (!parsed) {
        throw new Error("unavailable");
      }
      this.coverage = parsed;
      this.error = "";
    } catch {
      if (generation === this.generation) {
        this.error = "Map coverage could not be loaded.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private renderPrompt(coverage: MapCoverage, now: number) {
    const permission = coverage.permission!;
    return html`<p class="muted">Answer to the browser's location prompt:</p>
      <dl class="map-coverage__counts" data-testid="location-prompt">
        ${ANSWERS.map(
          ({ key, label }) =>
            html`<div data-answer=${key}>
              <dt>${label}</dt>
              <dd>${permission[key]}</dd>
            </div>`,
        )}
      </dl>
      ${coverage.refused.length === 0
        ? nothing
        : html`<details class="map-coverage__refused" data-testid="location-refused">
            <summary>${coverage.refused.length} said no</summary>
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Answer</th>
                  <th>When</th>
                  <th>Last seen in AdminBot</th>
                </tr>
              </thead>
              <tbody>
                ${coverage.refused.map(
                  (entry) =>
                    html`<tr data-member=${entry.member_id}>
                      <td>${entry.name}</td>
                      <td>${REFUSAL[entry.state]}</td>
                      <td>${lastSeenText(entry.at, now)}</td>
                      <td>${lastSeenText(entry.last_seen_at, now)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </details>`}`;
  }

  override render() {
    if (!this.sessionToken) {
      return nothing;
    }
    const coverage = this.coverage;
    const now = Date.now();
    return html`<details
      class="card adminbot-fold map-coverage"
      data-testid="map-coverage"
      ?open=${this.open}
      @toggle=${this.onToggle}
    >
      <summary class="card-title">Map coverage</summary>
      ${!this.open
        ? nothing
        : this.error
          ? html`<p class="muted" role="alert">${this.error}</p>`
          : !coverage
            ? html`<p class="muted" role="status">${this.busy ? "Loading…" : ""}</p>`
            : html`<p class="muted">${coverage.active} active members, placed by:</p>
                <dl class="map-coverage__counts">
                  ${BUCKETS.map(
                    ({ key, label }) =>
                      html`<div data-bucket=${key}>
                        <dt>${label}</dt>
                        <dd>${coverage.counts[key]}</dd>
                      </div>`,
                  )}
                </dl>
                ${coverage.permission ? this.renderPrompt(coverage, now) : nothing}
                ${coverage.stale.length === 0
                  ? html`<p class="muted">
                      Everyone has a precise location, a fresh IP or a recent check-in.
                    </p>`
                  : html`<details class="map-coverage__stale">
                      <summary>
                        ${coverage.stale.length} without a precise location, fresh IP or recent
                        check-in
                      </summary>
                      <table>
                        <thead>
                          <tr>
                            <th>Member</th>
                            <th>Placed by</th>
                            <th>Last seen in AdminBot</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${coverage.stale.map(
                            (entry) =>
                              html`<tr data-member=${entry.member_id}>
                                <td>${entry.name}</td>
                                <td>
                                  ${PLACED_BY[entry.placed_by]}${entry.place_label
                                    ? html` · ${entry.place_label}`
                                    : nothing}${entry.suspected_vpn
                                    ? html` · IP ignored (VPN?)`
                                    : nothing}
                                </td>
                                <td>${lastSeenText(entry.last_seen_at, now)}</td>
                              </tr>`,
                          )}
                        </tbody>
                      </table>
                    </details>`}`}
    </details>`;
  }
}

if (!customElements.get("adminbot-map-coverage")) {
  customElements.define("adminbot-map-coverage", AdminBotMapCoverage);
}
