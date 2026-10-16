// Recommendation-letter eligibility, drawn four ways: a badge on the admin's queue row, a panel on
// an open letter request, a note on the member's letters form, and the admin's freeze records.
//
// Every one of them is advisory. Nothing here disables a button or hides a form: the lab decided
// the policy informs a letter writer's judgment rather than replacing it, so the most this file
// does is say where a member stands. What a member may see at all is the service's decision -- the
// member's own read arrives without incident ids or notes, and this file only draws what came.
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { t } from "../../../i18n/index.ts";
import type {
  RecLetterAdminEligibility,
  RecLetterEligibility,
  RecLetterEligibilityGap,
  RecLetterEligibilityStatus,
  RecLetterEligibilitySummary,
  RecLetterFreezeIncident,
} from "../api/rec-letter-eligibility.ts";
import type { RecLetterFreezeForm } from "../controllers/rec-letter-eligibility.ts";

/**
 * A calendar date as the reader's own short date.
 *
 * Noon UTC, rendered in UTC, so the day printed is the day stored whatever the reader's zone:
 * midnight would print as the day before anywhere west of Greenwich.
 */
export function formatRecLetterDay(day: string): string {
  const parsed = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? day
    : parsed.toLocaleDateString([], { dateStyle: "medium", timeZone: "UTC" });
}

function percent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function statusLabel(status: RecLetterEligibilityStatus): string {
  return t(`logistics.eligibility.status.${status}`);
}

function renderStatusPill(status: RecLetterEligibilityStatus, label = statusLabel(status)) {
  return html`<span class="rec-eligibility__pill rec-eligibility__pill--${status}">${label}</span>`;
}

/** The queue row's badge. Absent until the summary has arrived, rather than a guess. */
export function renderRecLetterBadge(summary: RecLetterEligibilitySummary | undefined) {
  if (!summary) {
    return nothing;
  }
  const label =
    summary.status === "frozen" && summary.frozen_until
      ? t("logistics.eligibility.badgeFrozenUntil", {
          date: formatRecLetterDay(summary.frozen_until),
        })
      : statusLabel(summary.status);
  return html`<span
    class="rec-eligibility__pill rec-eligibility__pill--${summary.status} rec-eligibility__badge"
    data-testid="rec-eligibility-badge"
    data-status=${summary.status}
    title=${t("logistics.eligibility.advisory")}
    >${label}</span
  >`;
}

function gapText(gap: RecLetterEligibilityGap, result: RecLetterEligibility): string {
  switch (gap.code) {
    case "frozen":
      return t("logistics.eligibility.frozenUntil", { date: formatRecLetterDay(gap.frozen_until) });
    case "hours_short":
      return t("logistics.eligibility.gap.hours_short", {
        count: String(gap.qualifying_months),
        required: String(gap.required_months),
      });
    case "attendance_below_threshold":
      return t("logistics.eligibility.gap.attendance_below_threshold", {
        window: String(result.attendance.window_months),
        rate: percent(result.attendance.min_rate),
      });
    default:
      return t(`logistics.eligibility.gap.${gap.code}`);
  }
}

function renderHours(result: RecLetterEligibility) {
  const hours = result.hours;
  const qualifying = hours.months.filter((month) => month.qualifies).map((month) => month.month);
  return html`
    <section class="rec-eligibility__criterion" data-testid="rec-eligibility-hours">
      <div class="rec-eligibility__criterion-head">
        <h4>${t("logistics.eligibility.hoursTitle")}</h4>
        <span class="rec-eligibility__criterion-status rec-eligibility__criterion--${hours.status}">
          ${t(`logistics.eligibility.criterion.${hours.status}`)}
        </span>
      </div>
      <p>
        ${hours.months.length === 0
          ? t("logistics.eligibility.hoursNoData")
          : t("logistics.eligibility.hoursSummary", {
              count: String(hours.qualifying_months),
              required: String(hours.required_months),
              hours: String(hours.min_weekly_hours),
            })}
      </p>
      ${qualifying.length
        ? html`<p class="muted">
            ${t("logistics.eligibility.hoursMonths", { months: qualifying.join(", ") })}
          </p>`
        : nothing}
    </section>
  `;
}

function renderAttendance(result: RecLetterEligibility) {
  const attendance = result.attendance;
  const best = attendance.best_window;
  return html`
    <section class="rec-eligibility__criterion" data-testid="rec-eligibility-attendance">
      <div class="rec-eligibility__criterion-head">
        <h4>${t("logistics.eligibility.attendanceTitle")}</h4>
        <span
          class="rec-eligibility__criterion-status rec-eligibility__criterion--${attendance.status}"
        >
          ${t(`logistics.eligibility.criterion.${attendance.status}`)}
        </span>
      </div>
      ${best
        ? html`
            <p>
              ${t("logistics.eligibility.attendanceSummary", {
                months: String(attendance.window_months),
                start: best.start_month,
                end: best.end_month,
                monday: percent(best.monday_rate),
                wednesday: percent(best.wednesday_rate),
                rate: percent(attendance.min_rate),
              })}
            </p>
            <p class="muted">
              ${t("logistics.eligibility.attendanceCounts", {
                mondaysPresent: String(best.mondays_present),
                mondays: String(best.mondays_with_roster),
                weeksPresent: String(best.wednesday_weeks_present),
                weeks: String(best.wednesday_weeks_with_roster),
              })}
            </p>
          `
        : html`<p>
            ${t("logistics.eligibility.attendanceNoWindow", {
              months: String(attendance.window_months),
              coverage: percent(attendance.min_roster_coverage),
            })}
          </p>`}
    </section>
  `;
}

export type RecLetterDetailPanelProps = {
  value: RecLetterAdminEligibility | null;
  loading: boolean;
  error: string | null;
};

/** The admin's panel on an open letter request: the verdict, then the evidence behind it. */
export function renderRecLetterDetailPanel(props: RecLetterDetailPanelProps) {
  if (props.loading && !props.value) {
    return html`<section class="rec-eligibility" data-testid="rec-eligibility-panel">
      <p class="muted">${t("logistics.eligibility.loading")}</p>
    </section>`;
  }
  if (props.error) {
    return html`<section class="rec-eligibility" data-testid="rec-eligibility-panel">
      <p class="logistics-requests__error" role="alert">${props.error}</p>
    </section>`;
  }
  const result = props.value?.eligibility;
  if (!result) {
    return nothing;
  }
  return html`
    <section
      class="rec-eligibility"
      data-testid="rec-eligibility-panel"
      data-status=${result.status}
      aria-labelledby="rec-eligibility-title"
    >
      <div class="rec-eligibility__head">
        <h3 class="card-title" id="rec-eligibility-title">${t("logistics.eligibility.title")}</h3>
        ${renderStatusPill(result.status)}
      </div>
      <p class="card-sub">
        ${t("logistics.eligibility.advisory")}
        ${t("logistics.eligibility.asOf", { date: formatRecLetterDay(result.as_of) })}
      </p>
      ${result.freeze.frozen && result.freeze.frozen_until
        ? html`<p class="rec-eligibility__frozen" data-testid="rec-eligibility-frozen">
            <strong
              >${t("logistics.eligibility.frozenUntil", {
                date: formatRecLetterDay(result.freeze.frozen_until),
              })}</strong
            >
            ${t("logistics.eligibility.frozenExplain")}
          </p>`
        : nothing}
      ${result.is_alumni
        ? html`<p class="muted">${t("logistics.eligibility.alumni")}</p>`
        : nothing}
      <div class="rec-eligibility__criteria">
        ${renderHours(result)} ${renderAttendance(result)}
      </div>
    </section>
  `;
}

export type RecLetterAdvisoryProps = {
  value: RecLetterEligibility | null;
  loading: boolean;
  error: string | null;
};

/**
 * The note on the member's own letters form.
 *
 * It states the policy whatever the read returned, so a member whose read failed still learns what
 * the lab looks at. A failure is otherwise silent: the form is the member's to submit either way.
 */
export function renderRecLetterAdvisory(props: RecLetterAdvisoryProps) {
  const result = props.value;
  const window = result?.attendance.window_months ?? 3;
  const remaining = result ? result.missing.filter((gap) => gap.code !== "frozen") : [];
  return html`
    <aside
      class="rec-eligibility rec-eligibility--advisory"
      role="note"
      data-testid="rec-eligibility-advisory"
      data-status=${result?.status ?? "unknown"}
    >
      <div class="rec-eligibility__head">
        <h4>${t("logistics.eligibility.title")}</h4>
        ${result ? renderStatusPill(result.status) : nothing}
      </div>
      <p>
        ${t("logistics.eligibility.memberNote", {
          months: String(result?.hours.required_months ?? 5),
          hours: String(result?.hours.min_weekly_hours ?? 20),
          window: String(window),
          rate: percent(result?.attendance.min_rate ?? 0.8),
        })}
      </p>
      ${props.loading && !result
        ? html`<p class="muted">${t("logistics.eligibility.loading")}</p>`
        : nothing}
      ${result?.freeze.frozen && result.freeze.frozen_until
        ? html`<p class="rec-eligibility__frozen" data-testid="rec-eligibility-frozen">
            <strong
              >${t("logistics.eligibility.frozenUntil", {
                date: formatRecLetterDay(result.freeze.frozen_until),
              })}</strong
            >
          </p>`
        : nothing}
      ${result?.status === "not_yet" && remaining.length
        ? html`<p>
            ${t("logistics.eligibility.memberNotYet", {
              items: remaining.map((gap) => gapText(gap, result)).join("; "),
            })}
          </p>`
        : nothing}
      ${result?.status === "insufficient_data"
        ? html`<p class="muted">${t("logistics.eligibility.memberInsufficient")}</p>`
        : nothing}
    </aside>
  `;
}

export type RecLetterFreezeAdminProps = {
  incidents: RecLetterFreezeIncident[];
  members: { id: string; name: string }[];
  loading: boolean;
  error: string | null;
  saving: boolean;
  deletingId: string | null;
  form: RecLetterFreezeForm;
  onFormChange: (change: Partial<RecLetterFreezeForm>) => void;
  onRecord: () => void;
  onDelete: (incidentId: string) => void;
};

function addOneYear(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) {
    return day;
  }
  // Same roll-over as the service: Feb 29 plus a year is Mar 1.
  const next = new Date(Date.UTC(year + 1, month - 1, date));
  return next.toISOString().slice(0, 10);
}

/** The admin's record of freezes: add one, read them, delete one recorded in error. */
export function renderRecLetterFreezeAdmin(props: RecLetterFreezeAdminProps) {
  const nameOf = (memberId: string) =>
    props.members.find((member) => member.id === memberId)?.name ?? memberId;
  const input = (field: keyof RecLetterFreezeForm) => (event: Event) =>
    props.onFormChange({ [field]: (event.currentTarget as HTMLInputElement).value });
  return html`
    <section
      class="card adminbot-card adminbot-card--wide rec-eligibility-admin"
      data-testid="rec-eligibility-incidents"
      aria-labelledby="rec-eligibility-incidents-title"
    >
      <h3 class="card-title" id="rec-eligibility-incidents-title">
        ${t("logistics.eligibility.incidents.title")}
      </h3>
      <p class="card-sub">${t("logistics.eligibility.incidents.sub")}</p>
      <form
        class="rec-eligibility-admin__form"
        @submit=${(event: Event) => {
          event.preventDefault();
          props.onRecord();
        }}
      >
        <label class="adminbot-form__field">
          <span>${t("logistics.eligibility.incidents.member")}</span>
          ${props.members.length
            ? html`<select
                required
                data-testid="rec-eligibility-incident-member"
                .value=${live(props.form.memberId)}
                @change=${input("memberId")}
              >
                <option value="">${t("logistics.eligibility.incidents.memberPlaceholder")}</option>
                ${props.members.map(
                  (member) =>
                    html`<option value=${member.id} ?selected=${member.id === props.form.memberId}>
                      ${member.name}
                    </option>`,
                )}
              </select>`
            : html`<input
                required
                data-testid="rec-eligibility-incident-member"
                .value=${live(props.form.memberId)}
                @input=${input("memberId")}
              />`}
        </label>
        <label class="adminbot-form__field">
          <span>${t("logistics.eligibility.incidents.occurredOn")}</span>
          <input
            type="date"
            required
            data-testid="rec-eligibility-incident-date"
            .value=${live(props.form.occurredOn)}
            @input=${input("occurredOn")}
          />
        </label>
        <label class="adminbot-form__field">
          <span>${t("logistics.eligibility.incidents.paperId")}</span>
          <input maxlength="200" .value=${live(props.form.paperId)} @input=${input("paperId")} />
        </label>
        <label class="adminbot-form__field rec-eligibility-admin__note">
          <span>${t("logistics.eligibility.incidents.note")}</span>
          <textarea
            rows="2"
            maxlength="2000"
            .value=${live(props.form.note)}
            @input=${input("note")}
          ></textarea>
        </label>
        <div class="rec-eligibility-admin__actions">
          <button
            class="btn primary"
            type="submit"
            ?disabled=${props.saving}
            data-testid="rec-eligibility-incident-record"
          >
            ${props.saving
              ? t("logistics.eligibility.incidents.recording")
              : t("logistics.eligibility.incidents.record")}
          </button>
        </div>
      </form>
      ${props.error
        ? html`<p class="logistics-requests__error" role="alert">${props.error}</p>`
        : nothing}
      ${props.loading && props.incidents.length === 0
        ? html`<p class="muted">${t("logistics.eligibility.incidents.loading")}</p>`
        : props.incidents.length === 0
          ? html`<p class="muted">${t("logistics.eligibility.incidents.empty")}</p>`
          : html`<ul class="rec-eligibility-admin__list">
              ${props.incidents.map((incident) => {
                const busy = props.deletingId === incident.id;
                const day = formatRecLetterDay(incident.occurred_on);
                return html`<li
                  class="rec-eligibility-admin__item"
                  data-testid="rec-eligibility-incident"
                >
                  <div class="rec-eligibility-admin__item-body">
                    <strong>${nameOf(incident.member_id)}</strong>
                    <span class="ab-num">
                      ${day} ·
                      ${t("logistics.eligibility.incidents.until", {
                        date: formatRecLetterDay(addOneYear(incident.occurred_on)),
                      })}
                    </span>
                    ${incident.paper_id
                      ? html`<span class="muted">${incident.paper_id}</span>`
                      : nothing}
                    ${incident.note
                      ? html`<span class="rec-eligibility-admin__item-note">${incident.note}</span>`
                      : nothing}
                  </div>
                  <button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${busy}
                    aria-label=${t("logistics.eligibility.incidents.deleteFor", {
                      member: nameOf(incident.member_id),
                      date: day,
                    })}
                    @click=${() => props.onDelete(incident.id)}
                  >
                    ${busy
                      ? t("logistics.eligibility.incidents.deleting")
                      : t("logistics.eligibility.incidents.delete")}
                  </button>
                </li>`;
              })}
            </ul>`}
    </section>
  `;
}
