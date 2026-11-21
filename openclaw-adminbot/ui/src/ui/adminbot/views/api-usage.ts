// API Usage, for admins: who calls the AdminBot API, through what, and how it went -- plus what the
// automation runs did.
//
// Tab Usage counts what people opened in the browser; this counts every authenticated request,
// which is the only view of the CLI and of API tokens at all. The service keeps the rows for 90
// days and never the bodies, query strings, token values or raw paths (docs/adminbot/usage-telemetry.md).
//
// A self-contained element, like the error log: nothing else reads these numbers, so it loads when
// it is put on screen and is forgotten with it. Two reads in parallel, both off small rollups, so
// the page stays inside the one-second budget however busy the API is.
//
// Rows and hairlines, no cards (ui/DESIGN.md). A section with nothing in it is not drawn.
import { LitElement, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import { renderSkeleton } from "../../loading/skeleton.ts";
import { loadSettings } from "../../storage.ts";
import {
  authedJson,
  calendarFailure,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";

export const API_USAGE_WINDOWS = [7, 30, 90] as const;

export type ApiUsageCount = {
  requests: number;
  client_errors: number;
  server_errors: number;
  avg_ms: number;
  max_ms: number;
};

export type ApiUsageSummary = {
  from: string;
  days: number;
  totals: ApiUsageCount & { members: number };
  by_day: Array<ApiUsageCount & { day: string }>;
  by_member: Array<
    ApiUsageCount & {
      member_id: string;
      name?: string;
      last_at: string;
      cli_requests: number;
      token_requests: number;
    }
  >;
  by_operation: Array<ApiUsageCount & { operation: string; method: string }>;
  by_client: Array<ApiUsageCount & { client: string; client_version?: string }>;
};

export type AutomationRunTotals = {
  runs: number;
  failures: number;
  avg_ms?: number;
  max_ms?: number;
  last_at?: string;
  last_ok_at?: string;
  metrics: Record<string, number>;
};

export type AutomationRunReport = {
  jobs: Array<AutomationRunTotals & { job: string }>;
  sweeps: Array<AutomationRunTotals & { operation: string; method: string }>;
};

/** "4.2%" of requests that failed, or "0%". Client and server errors both count. */
export function errorRate(row: ApiUsageCount): string {
  if (!row.requests) {
    return "0%";
  }
  const share = ((row.client_errors + row.server_errors) / row.requests) * 100;
  return `${share < 10 && share > 0 ? share.toFixed(1) : Math.round(share)}%`;
}

/** "180 ms" / "2.4 s" / "3m 10s". */
export function durationLabel(ms: number | undefined): string {
  if (ms === undefined) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * The slowest operations by average, worst first.
 *
 * Only operations called at least `minRequests` times, so one cold-start request does not top a
 * list that is meant to say where the API is slow for the people using it.
 */
export function slowestOperations(
  rows: ApiUsageSummary["by_operation"],
  limit = 8,
  minRequests = 3,
): ApiUsageSummary["by_operation"] {
  return rows
    .filter((row) => row.requests >= minRequests)
    .toSorted((a, b) => b.avg_ms - a.avg_ms || b.max_ms - a.max_ms)
    .slice(0, limit);
}

/** "nudges_sent.paperflow 3 · emails_status.completed 12", largest first. */
export function metricsLabel(metrics: Record<string, number>): string {
  return Object.entries(metrics)
    .toSorted(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
}

function clientLabel(row: { client: string; client_version?: string }): string {
  const name = t(`apiUsage.client.${row.client}`);
  return row.client_version ? `${name} ${row.client_version}` : name;
}

function share(value: number, busiest: number): string {
  return `--share:${busiest > 0 ? Math.round((value / busiest) * 100) : 0}%`;
}

function wire(): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  return stored
    ? { token: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(loadSettings()) }
    : null;
}

export class AdminBotApiUsage extends LitElement {
  // Light DOM, so the page's own tokens and button styles apply.
  override createRenderRoot() {
    return this;
  }

  @state() private days: number = 30;
  @state() private summary: ApiUsageSummary | null = null;
  @state() private runs: AutomationRunReport | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async read<T>(path: string, token: string, baseUrl: string): Promise<T | string> {
    const result = await authedJson(baseUrl, path, "GET", token);
    if ("unreachable" in result) {
      return t("apiUsage.error.unreachable", { url: baseUrl });
    }
    if (!result.response.ok) {
      return result.response.status === 403
        ? t("apiUsage.error.forbidden")
        : (calendarFailure(result.response, result.body).message ?? t("apiUsage.error.failed"));
    }
    return result.body as T;
  }

  private async load(): Promise<void> {
    const session = wire();
    if (!session) {
      this.error = t("apiUsage.error.signIn");
      return;
    }
    const days = this.days;
    this.loading = true;
    this.error = null;
    try {
      const [summary, runs] = await Promise.all([
        this.read<ApiUsageSummary>(`/usage/summary?days=${days}`, session.token, session.baseUrl),
        this.read<AutomationRunReport>(
          `/usage/automation?days=${days}`,
          session.token,
          session.baseUrl,
        ),
      ]);
      if (days !== this.days) {
        // A newer window was picked while this one was in flight; its own read will land.
        return;
      }
      // What is already on screen stays when a read fails: an unreachable service should not also
      // blank the numbers somebody was reading.
      if (typeof summary === "string") {
        this.error = summary;
      } else {
        this.summary = summary;
      }
      if (typeof runs === "string") {
        this.error ??= runs;
      } else {
        this.runs = runs;
      }
    } finally {
      if (days === this.days) {
        this.loading = false;
      }
    }
  }

  private pick(days: number): void {
    if (days !== this.days) {
      this.days = days;
      void this.load();
    }
  }

  private windowPicker() {
    return html`<div class="tab-usage__windows" role="group" aria-label=${t("apiUsage.window")}>
      ${API_USAGE_WINDOWS.map(
        (days) => html`<button
          class=${`btn btn--sm ${days === this.days ? "" : "btn--ghost"}`}
          type="button"
          aria-pressed=${days === this.days ? "true" : "false"}
          data-testid=${`api-usage-window-${days}`}
          @click=${() => this.pick(days)}
        >
          ${t("apiUsage.days", { count: String(days) })}
        </button>`,
      )}
    </div>`;
  }

  private totals(summary: ApiUsageSummary) {
    const cli = summary.by_client
      .filter((row) => row.client === "cli")
      .reduce((sum, row) => sum + row.requests, 0);
    const total = (value: string | number, label: string, testId?: string) =>
      html`<div class="tab-usage__total" data-testid=${testId ?? nothing}>
        <span class="tab-usage__total-value ab-num">${value}</span>
        <span class="tab-usage__total-label">${label}</span>
      </div>`;
    return html`<div class="tab-usage__totals">
      ${total(summary.totals.requests, t("apiUsage.totals.requests"), "api-usage-requests")}
      ${total(summary.totals.members, t("apiUsage.totals.members"))}
      ${total(cli, t("apiUsage.totals.cli"), "api-usage-cli")}
      ${total(errorRate(summary.totals), t("apiUsage.totals.errors"))}
      ${total(durationLabel(summary.totals.avg_ms), t("apiUsage.totals.avg"))}
    </div>`;
  }

  private people(summary: ApiUsageSummary) {
    const busiest = summary.by_member[0]?.requests ?? 0;
    return html`<h3 class="api-usage__section">${t("apiUsage.people.title")}</h3>
      <div class="tab-usage__scroll">
        <table class="tab-usage__table">
          <thead>
            <tr>
              <th scope="col">${t("apiUsage.column.person")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.requests")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.cli")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.tokens")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.errors")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.last")}</th>
            </tr>
          </thead>
          <tbody>
            ${summary.by_member.map(
              (row) => html`<tr data-testid=${`api-usage-member-${row.member_id}`}>
                <th scope="row" class="tab-usage__tab">
                  <span class="tab-usage__tab-name">${row.name ?? row.member_id}</span>
                  <span
                    class="tab-usage__bar"
                    style=${share(row.requests, busiest)}
                    aria-hidden="true"
                  ></span>
                </th>
                <td class="tab-usage__numeric ab-num">${row.requests}</td>
                <td class="tab-usage__numeric ab-num">${row.cli_requests}</td>
                <td class="tab-usage__numeric ab-num">${row.token_requests}</td>
                <td class="tab-usage__numeric ab-num">${errorRate(row)}</td>
                <td class="tab-usage__numeric muted">${row.last_at.slice(0, 10)}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`;
  }

  private operations(
    title: string,
    rows: ApiUsageSummary["by_operation"],
    testId: string,
    limit: number,
  ) {
    return html`<h3 class="api-usage__section">${title}</h3>
      <div class="tab-usage__scroll">
        <table class="tab-usage__table" data-testid=${testId}>
          <thead>
            <tr>
              <th scope="col">${t("apiUsage.column.operation")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.requests")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.errors")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.avg")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.max")}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.slice(0, limit).map(
              (row) => html`<tr>
                <th scope="row" class="tab-usage__tab">
                  <code class="api-usage__operation">${row.operation}</code>
                  <span class="muted"> ${row.method}</span>
                </th>
                <td class="tab-usage__numeric ab-num">${row.requests}</td>
                <td class="tab-usage__numeric ab-num">${errorRate(row)}</td>
                <td class="tab-usage__numeric ab-num">${durationLabel(row.avg_ms)}</td>
                <td class="tab-usage__numeric ab-num">${durationLabel(row.max_ms)}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`;
  }

  private clientsAndDays(summary: ApiUsageSummary) {
    const busiestDay = Math.max(0, ...summary.by_day.map((row) => row.requests));
    return html`<h3 class="api-usage__section">${t("apiUsage.clients.title")}</h3>
      <ul class="api-usage__list">
        ${summary.by_client.map(
          (row) => html`<li class="api-usage__item">
            <span>${clientLabel(row)}</span>
            <span class="ab-num">${row.requests}</span>
            <span class="muted ab-num">${errorRate(row)}</span>
          </li>`,
        )}
      </ul>
      <h3 class="api-usage__section">${t("apiUsage.byDay.title")}</h3>
      <ul class="api-usage__list" data-testid="api-usage-days">
        ${summary.by_day.toReversed().map(
          (row) => html`<li class="api-usage__item">
            <span class="muted">${row.day}</span>
            <span class="api-usage__day-bar">
              <span
                class="tab-usage__bar"
                style=${share(row.requests, busiestDay)}
                aria-hidden="true"
              ></span>
            </span>
            <span class="ab-num">${row.requests}</span>
            <span class="muted ab-num">${errorRate(row)}</span>
          </li>`,
        )}
      </ul>`;
  }

  private automation(runs: AutomationRunReport) {
    const row = (name: unknown, totals: AutomationRunTotals) =>
      html`<tr>
        <th scope="row" class="tab-usage__tab">
          ${name}
          ${Object.keys(totals.metrics).length
            ? html`<span class="api-usage__metrics muted">${metricsLabel(totals.metrics)}</span>`
            : nothing}
        </th>
        <td class="tab-usage__numeric ab-num">${totals.runs}</td>
        <td class="tab-usage__numeric ab-num">${totals.failures}</td>
        <td class="tab-usage__numeric ab-num">${durationLabel(totals.avg_ms)}</td>
        <td class="tab-usage__numeric muted">
          ${totals.last_ok_at?.slice(0, 16).replace("T", " ") ?? "—"}
        </td>
      </tr>`;
    return html`<h3 class="api-usage__section">${t("apiUsage.automation.title")}</h3>
      <div class="tab-usage__scroll">
        <table class="tab-usage__table" data-testid="api-usage-automation">
          <thead>
            <tr>
              <th scope="col">${t("apiUsage.column.job")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.runs")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.failures")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.avg")}</th>
              <th scope="col" class="tab-usage__numeric">${t("apiUsage.column.lastOk")}</th>
            </tr>
          </thead>
          <tbody>
            ${runs.jobs.map((job) => row(job.job, job))}
            ${runs.sweeps.map((sweep) =>
              row(html`<code class="api-usage__operation">${sweep.operation}</code>`, sweep),
            )}
          </tbody>
        </table>
      </div>`;
  }

  override render() {
    const summary = this.summary;
    const runs = this.runs;
    const hasRequests = Boolean(summary?.totals.requests);
    const hasRuns = Boolean(runs && (runs.jobs.length || runs.sweeps.length));
    const slow = summary ? slowestOperations(summary.by_operation) : [];
    return html`<section class="api-usage" data-testid="api-usage">
      <div class="tab-usage__head">
        <h2 class="error-log__title">${t("apiUsage.title")}</h2>
        ${this.windowPicker()}
      </div>

      ${this.error
        ? html`<p class="tab-usage__error" role="alert" data-testid="api-usage-error">
            ${this.error}
          </p>`
        : nothing}
      ${this.loading && !summary && !runs
        ? renderSkeleton({ count: 5, label: t("apiUsage.loading"), testId: "api-usage-loading" })
        : nothing}
      ${summary && !hasRequests && runs && !hasRuns
        ? html`<p class="tab-usage__empty" data-testid="api-usage-empty">${t("apiUsage.empty")}</p>`
        : nothing}
      ${summary && hasRequests
        ? html`${this.totals(summary)} ${this.people(summary)}
          ${this.operations(
            t("apiUsage.operations.title"),
            summary.by_operation,
            "api-usage-operations",
            15,
          )}
          ${slow.length
            ? this.operations(t("apiUsage.slowest.title"), slow, "api-usage-slowest", slow.length)
            : nothing}
          ${this.clientsAndDays(summary)}`
        : nothing}
      ${runs && hasRuns ? this.automation(runs) : nothing}
    </section>`;
  }
}

if (!customElements.get("adminbot-api-usage")) {
  customElements.define("adminbot-api-usage", AdminBotApiUsage);
}
