// Which parts of AdminBot the lab actually opens.
//
// Every other page in the Admin group counts what members produced. This one counts what they came
// to look at, which is the question those pages cannot answer: a column of blanks next to a tab
// nobody has opened is a different problem from a column of blanks next to a busy one, and until now
// there was no way to tell which of the two the lab had.
//
// It reads and exports; it records nothing. The writing happens on every tab switch
// (controllers/tab-visits.ts), which is the only way a usage log can be complete.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { TabVisitRate, TabVisitReport } from "../auth/session.ts";
import { TAB_USAGE_WINDOWS } from "../controllers/tab-usage.ts";

export type TabUsageViewProps = {
  report: TabVisitReport | null;
  days: number;
  loading: boolean;
  exporting: boolean;
  error: string | null;
  onDaysChange: (days: number) => void;
  onExport: () => void;
  onRefresh: () => void;
};

/**
 * A tab's own name, or its raw id when this build has never heard of it.
 *
 * `t()` answers a missing key with the key itself, so the fallback is a comparison rather than a
 * lookup table. A visit to a tab that has since been renamed or removed is still data -- it is the
 * one row that says a tab existed and somebody used it -- so it is shown as the id rather than
 * dropped or drawn as a blank.
 */
export function tabLabel(tab: string): string {
  const key = `tabs.${tab}`;
  const label = t(key);
  return label === key ? tab : label;
}

/** "4m 12s" / "38s" / "--". Seconds, because a median dwell is usually under ten minutes. */
export function dwellLabel(seconds: number, samples: number): string {
  if (!samples) {
    return t("tabUsage.untimed");
  }
  if (seconds < 60) {
    return t("tabUsage.seconds", { count: String(Math.round(seconds)) });
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest
    ? t("tabUsage.minutesSeconds", { minutes: String(minutes), seconds: String(rest) })
    : t("tabUsage.minutes", { count: String(minutes) });
}

function shareOfBusiest(row: TabVisitRate, busiest: number): number {
  return busiest > 0 ? Math.round((row.visits / busiest) * 100) : 0;
}

function windowPicker(props: TabUsageViewProps) {
  return html`<div class="tab-usage__windows" role="group" aria-label=${t("tabUsage.window")}>
    ${TAB_USAGE_WINDOWS.map(
      (days) => html`<button
        class=${`btn btn--sm ${days === props.days ? "" : "btn--ghost"}`}
        type="button"
        aria-pressed=${days === props.days ? "true" : "false"}
        data-testid=${`tab-usage-window-${days}`}
        @click=${() => props.onDaysChange(days)}
      >
        ${t("tabUsage.days", { count: String(days) })}
      </button>`,
    )}
  </div>`;
}

function totals(report: TabVisitReport) {
  return html`<div class="tab-usage__totals">
    <div class="tab-usage__total">
      <span class="tab-usage__total-value ab-num">${report.visits}</span>
      <span class="tab-usage__total-label">${t("tabUsage.totals.visits")}</span>
    </div>
    <div class="tab-usage__total">
      <span class="tab-usage__total-value ab-num">${report.members}</span>
      <span class="tab-usage__total-label">${t("tabUsage.totals.members")}</span>
    </div>
    <div class="tab-usage__total">
      <span class="tab-usage__total-value ab-num">${report.tabs.length}</span>
      <span class="tab-usage__total-label">${t("tabUsage.totals.tabs")}</span>
    </div>
    ${report.impersonatedVisits
      ? html`<div class="tab-usage__total" data-testid="tab-usage-impersonated">
          <span class="tab-usage__total-value ab-num">${report.impersonatedVisits}</span>
          <span class="tab-usage__total-label">${t("tabUsage.totals.impersonated")}</span>
        </div>`
      : nothing}
  </div>`;
}

function table(report: TabVisitReport) {
  const busiest = report.tabs[0]?.visits ?? 0;
  return html`<table class="tab-usage__table">
    <thead>
      <tr>
        <th scope="col">${t("tabUsage.column.tab")}</th>
        <th scope="col" class="tab-usage__numeric">${t("tabUsage.column.visits")}</th>
        <th scope="col" class="tab-usage__numeric">${t("tabUsage.column.members")}</th>
        <th scope="col" class="tab-usage__numeric">${t("tabUsage.column.perDay")}</th>
        <th scope="col" class="tab-usage__numeric">${t("tabUsage.column.dwell")}</th>
        <th scope="col" class="tab-usage__numeric">${t("tabUsage.column.last")}</th>
      </tr>
    </thead>
    <tbody>
      ${report.tabs.map(
        (row) => html`<tr data-testid=${`tab-usage-row-${row.tab}`}>
          <th scope="row" class="tab-usage__tab">
            <span class="tab-usage__tab-name">${tabLabel(row.tab)}</span>
            <!-- The bar is the column: a reader comparing eleven tabs is comparing shapes, and
                 reads the exact count off the cell beside it only when one looks wrong. -->
            <span
              class="tab-usage__bar"
              style=${`--share:${shareOfBusiest(row, busiest)}%`}
              aria-hidden="true"
            ></span>
          </th>
          <td class="tab-usage__numeric ab-num">${row.visits}</td>
          <td class="tab-usage__numeric ab-num">${row.members}</td>
          <td class="tab-usage__numeric ab-num">${row.visitsPerDay}</td>
          <td class="tab-usage__numeric ab-num">
            ${dwellLabel(row.dwellSecondsMedian, row.dwellSamples)}
          </td>
          <td class="tab-usage__numeric muted">${row.lastAt.slice(0, 10)}</td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

export function renderAdminBotTabUsage(props: TabUsageViewProps) {
  const report = props.report;
  return html`
    <section class="card tab-usage" data-testid="tab-usage">
      <div class="tab-usage__head">
        <div>
          <div class="card-title">${t("tabUsage.title")}</div>
          <p class="tab-usage__blurb">${t("tabUsage.blurb")}</p>
        </div>
        ${windowPicker(props)}
      </div>

      ${props.error
        ? html`<p class="tab-usage__error" role="alert" data-testid="tab-usage-error">
            ${props.error}
          </p>`
        : nothing}
      ${props.loading && !report
        ? html`<p class="tab-usage__empty">${t("tabUsage.loading")}</p>`
        : nothing}
      ${report && !report.tabs.length
        ? html`<p class="tab-usage__empty" data-testid="tab-usage-empty">${t("tabUsage.empty")}</p>`
        : nothing}
      ${report && report.tabs.length ? html`${totals(report)} ${table(report)}` : nothing}

      <div class="tab-usage__actions">
        <button
          class="btn btn--sm btn--ghost"
          type="button"
          data-testid="tab-usage-refresh"
          ?disabled=${props.loading}
          @click=${props.onRefresh}
        >
          ${t("tabUsage.refresh")}
        </button>
        <button
          class="btn btn--sm"
          type="button"
          data-testid="tab-usage-export"
          ?disabled=${props.exporting || !report?.visits}
          @click=${props.onExport}
        >
          <span aria-hidden="true">${icons.download}</span>
          ${props.exporting ? t("tabUsage.exporting") : t("tabUsage.export")}
        </button>
      </div>

      <!-- Said on the page rather than left to whoever reads the numbers later: every one of these
           is a way to over-read this table, and the export is what a real analysis should use. -->
      <p class="tab-usage__caveat">${t("tabUsage.caveat")}</p>
    </section>
  `;
}
