// Profile Overview: how far along every member's own record is, as a spreadsheet.
//
// The question this answers is the one Zhijing asks on a sweep -- who has not filled their profile
// in, and who has not told us when they are working. Both are things only the member can do, so
// the output of this page is a list of names to talk to, not a number to watch.
//
// A page of its own rather than a section of Lab Members: that page is for looking one person up
// and editing their record, and a scoreboard buried inside it is a scoreboard nobody sweeps.
//
// Read-only. The single button runs the reminder the daily cron already sends; it composes nothing
// and picks nobody -- the service does both.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { MemberProfileOverviewRow } from "../auth/session.ts";

export type AdminBotProfileOverviewProps = {
  members: MemberProfileOverviewRow[];
  mandatoryFieldCount: number;
  loading: boolean;
  error: string | null;
  notice: string | null;
  reminding: boolean;
  onRemind: () => void;
  onOpenMember: (memberId: string) => void;
  /** Hides the rows that are already finished, which is most of them on a good week. */
  incompleteOnly: boolean;
  onIncompleteOnlyChange: (incompleteOnly: boolean) => void;
};

/**
 * How many timeline entries count as "has actually planned their term".
 *
 * Two is the threshold from the brainstorming doc: one row is somebody trying the page out, and
 * the people this sweep is looking for are the ones who never came back to it.
 */
const TIMELINE_ENTRY_TARGET = 2;

function completionPercent(row: MemberProfileOverviewRow, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((row.filled_field_count / total) * 100);
}

/**
 * The plain-English name of a field, from its key.
 *
 * Derived rather than translated: these are the same keys the profile form uses, and a locale
 * table that had to be kept in step with the mandatory-field list would be one more thing to
 * forget when a field is added.
 */
function fieldLabel(key: string): string {
  return key
    .replace(/_url$/u, "")
    .replace(/_/gu, " ")
    .replace(/\burn\b/u, "URN")
    .replace(/^\w/u, (first) => first.toUpperCase());
}

function formatDay(instant: string | undefined): string {
  if (!instant) {
    return "";
  }
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime())
    ? instant
    : parsed.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderProgressCell(row: MemberProfileOverviewRow, total: number) {
  const percent = completionPercent(row, total);
  const complete = row.missing_fields.length === 0;
  return html`
    <div class="profile-overview__progress" title=${`${row.filled_field_count}/${total}`}>
      <div
        class="profile-overview__bar ${complete ? "is-complete" : ""}"
        role="img"
        aria-label=${t("profileOverview.progressLabel", {
          filled: String(row.filled_field_count),
          total: String(total),
        })}
      >
        <span class="profile-overview__bar-fill" style="width: ${percent}%"></span>
      </div>
      <span class="profile-overview__percent ab-num">${percent}%</span>
    </div>
  `;
}

function renderMissingCell(row: MemberProfileOverviewRow) {
  if (!row.missing_fields.length) {
    return html`<span class="profile-overview__done">${t("profileOverview.allFilled")}</span>`;
  }
  return html`
    <ul class="profile-overview__missing">
      ${row.missing_fields.map((field) => html`<li>${fieldLabel(field)}</li>`)}
    </ul>
  `;
}

/**
 * The timeline column: the total, and what it is made of.
 *
 * The breakdown is in the tooltip rather than four more columns -- the number is what gets scanned,
 * and "which kind" only matters once somebody has stopped on a row.
 */
function renderTimelineCell(row: MemberProfileOverviewRow) {
  const short = row.timeline.total < TIMELINE_ENTRY_TARGET;
  return html`
    <span
      class="profile-overview__timeline ${short ? "is-short" : ""}"
      title=${t("profileOverview.timelineBreakdown", {
        availability: String(row.timeline.availability),
        timeOff: String(row.timeline.time_off),
        milestones: String(row.timeline.milestones),
        trips: String(row.timeline.trips),
      })}
    >
      <span class="ab-num">${row.timeline.total}</span>
      ${short
        ? html`<span class="profile-overview__flag">${t("profileOverview.timelineShort")}</span>`
        : nothing}
    </span>
  `;
}

function renderRow(props: AdminBotProfileOverviewProps, row: MemberProfileOverviewRow) {
  return html`
    <tr class="profile-overview__row" data-complete=${row.missing_fields.length === 0}>
      <td class="profile-overview__cell">
        <button
          class="logistics-requests__open"
          type="button"
          @click=${() => props.onOpenMember(row.id)}
        >
          ${row.name}
        </button>
        ${row.status ? html`<span class="profile-overview__status">${row.status}</span>` : nothing}
      </td>
      <td class="profile-overview__cell">${renderProgressCell(row, props.mandatoryFieldCount)}</td>
      <td class="profile-overview__cell profile-overview__cell--missing">
        ${renderMissingCell(row)}
      </td>
      <td class="profile-overview__cell">${renderTimelineCell(row)}</td>
      <td class="profile-overview__cell ab-num">
        ${row.last_reminded_at
          ? formatDay(row.last_reminded_at)
          : html`<span class="muted">${t("profileOverview.neverReminded")}</span>`}
      </td>
    </tr>
  `;
}

export function renderAdminBotProfileOverview(props: AdminBotProfileOverviewProps) {
  const rows = props.incompleteOnly
    ? props.members.filter(
        (row) => row.missing_fields.length > 0 || row.timeline.total < TIMELINE_ENTRY_TARGET,
      )
    : props.members;
  const outstanding = props.members.filter((row) => row.missing_fields.length > 0).length;
  return html`
    <section class="adminbot-shell profile-overview" data-testid="adminbot-profile-overview">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="profile-overview__heading">
          <div>
            <div class="card-title">${t("profileOverview.title")}</div>
            <div class="card-sub">${t("profileOverview.sub")}</div>
          </div>
          <div class="profile-overview__actions">
            <label class="profile-overview__toggle">
              <input
                type="checkbox"
                .checked=${props.incompleteOnly}
                @change=${(event: Event) => {
                  const box = event.currentTarget;
                  if (box instanceof HTMLInputElement) {
                    props.onIncompleteOnlyChange(box.checked);
                  }
                }}
              />
              ${t("profileOverview.incompleteOnly")}
            </label>
            <button
              class="btn btn--sm"
              type="button"
              data-testid="profile-overview-remind"
              ?disabled=${props.reminding || outstanding === 0}
              @click=${props.onRemind}
            >
              <span aria-hidden="true">${icons.send}</span>
              ${props.reminding
                ? t("profileOverview.reminding")
                : t("profileOverview.remind", { count: String(outstanding) })}
            </button>
          </div>
        </div>

        ${props.notice
          ? html`<p class="profile-overview__notice" role="status">${props.notice}</p>`
          : nothing}
        ${props.error
          ? html`<p class="logistics-requests__error" role="alert">${props.error}</p>`
          : nothing}
        ${props.loading
          ? html`<p class="logistics-requests__empty">${t("profileOverview.loading")}</p>`
          : rows.length
            ? html`
                <div class="profile-overview__scroll">
                  <table class="profile-overview__table">
                    <thead>
                      <tr>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.member")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.profile")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.missing")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.timeline")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.lastReminded")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      ${rows.map((row) => renderRow(props, row))}
                    </tbody>
                  </table>
                </div>
              `
            : html`<p class="logistics-requests__empty">
                ${props.incompleteOnly
                  ? t("profileOverview.allCaughtUp")
                  : t("profileOverview.empty")}
              </p>`}
      </div>
    </section>
  `;
}
