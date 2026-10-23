// Recommendation-letter eligibility, drawn four ways: a badge on the admin's queue row, a panel on
// an open letter request (with the admin's confirm-a-criterion controls), a note on the member's
// letters form, and the admin's freeze records.
//
// Only the freeze and hours decide the headline for now. Attendance is drawn for admins as "not
// counted yet", and the member gets one muted line saying it is not tracked.
//
// Every one of them is advisory. Nothing here disables a button or hides a form: the lab decided
// the policy informs a letter writer's judgment rather than replacing it, so the most this file
// does is say where a member stands. What a member may see at all is the service's decision -- the
// member's own read arrives without incident ids or notes, and this file only draws what came.
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { t } from "../../../i18n/index.ts";
import { pathForTab } from "../../navigation.ts";
import {
  isRecLetterEligibility,
  type RecLetterAdminEligibility,
  type RecLetterAttestation,
  type RecLetterAttestationCriterion,
  type RecLetterAttested,
  type RecLetterEligibility,
  type RecLetterEligibilityStatus,
  type RecLetterEligibilitySummary,
  type RecLetterFreezeIncident,
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

/**
 * YYYY-MM months as runs: "2025-01 to 2026-06, 2026-09". A member who joined years before the
 * availability page would otherwise read a list as long as their time in the lab.
 */
export function formatMonthRuns(months: readonly string[]): string {
  const next = (month: string) => {
    const [year, mon] = month.split("-").map(Number);
    return mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
  };
  const runs: [string, string][] = [];
  for (const month of [...months].toSorted()) {
    const last = runs.at(-1);
    if (last && next(last[1]) === month) {
      last[1] = month;
    } else {
      runs.push([month, month]);
    }
  }
  return runs
    .map(([first, last]) =>
      first === last ? first : t("logistics.eligibility.monthRun", { first, last }),
    )
    .join(", ");
}

/** Months the hours had no row for. Derived from the months when an older service left it off. */
function monthsWithoutData(result: RecLetterEligibility): string[] {
  return (
    result.hours.months_without_data ??
    result.hours.months.filter((month) => month.has_data === false).map((month) => month.month)
  );
}

/** Attendance counts only when the service says so; an older body without the flag does not. */
function attendanceCounted(result: RecLetterEligibility): boolean {
  return result.attendance.counted === true;
}

function statusLabel(status: RecLetterEligibilityStatus): string {
  return t(`logistics.eligibility.status.${status}`);
}

/** Offline, or a service that answered with less than a whole result: neither is the member's fault. */
function unavailableText(): string {
  return typeof navigator !== "undefined" && !navigator.onLine
    ? t("logistics.eligibility.unavailableOffline")
    : t("logistics.eligibility.unavailable");
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

function renderAttested(
  attested: RecLetterAttested,
  criterion: RecLetterAttestationCriterion,
  admin: boolean,
) {
  return html`<p
    class="rec-eligibility__attested"
    data-testid="rec-eligibility-attested-${criterion}"
  >
    <strong>${t(`logistics.eligibility.attested.${criterion}`)}</strong>
    <span class="muted">
      ${t("logistics.eligibility.attested.on", {
        date: formatRecLetterDay(attested.at.slice(0, 10)),
      })}
      ${admin && attested.by
        ? t("logistics.eligibility.attested.by", { admin: attested.by })
        : nothing}
    </span>
    ${admin && attested.note
      ? html`<span class="rec-eligibility-admin__item-note">${attested.note}</span>`
      : nothing}
  </p>`;
}

function criterionLabel(status: RecLetterEligibility["hours"]["status"], attested: boolean) {
  return attested
    ? t("logistics.eligibility.criterion.attested")
    : t(`logistics.eligibility.criterion.${status}`);
}

function renderHours(result: RecLetterEligibility) {
  const hours = result.hours;
  const qualifying = hours.months.filter((month) => month.qualifies).map((month) => month.month);
  const unknown = monthsWithoutData(result);
  return html`
    <section class="rec-eligibility__criterion" data-testid="rec-eligibility-hours">
      <div class="rec-eligibility__criterion-head">
        <h4>${t("logistics.eligibility.hoursTitle")}</h4>
        <span class="rec-eligibility__criterion-status rec-eligibility__criterion--${hours.status}">
          ${criterionLabel(hours.status, Boolean(hours.attested))}
        </span>
      </div>
      ${hours.attested ? renderAttested(hours.attested, "hours", true) : nothing}
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
      ${unknown.length && hours.months.length
        ? html`<p class="muted" data-testid="rec-eligibility-hours-unknown">
            ${t("logistics.eligibility.hoursUnknownMonths", { months: formatMonthRuns(unknown) })}
          </p>`
        : nothing}
    </section>
  `;
}

function renderAttendance(result: RecLetterEligibility) {
  const attendance = result.attendance;
  const best = attendance.best_window;
  const counted = attendanceCounted(result);
  return html`
    <section
      class="rec-eligibility__criterion ${counted ? "" : "rec-eligibility__criterion--uncounted"}"
      data-testid="rec-eligibility-attendance"
      data-counted=${counted ? "true" : "false"}
    >
      <div class="rec-eligibility__criterion-head">
        <h4>${t("logistics.eligibility.attendanceTitle")}</h4>
        <span
          class="rec-eligibility__criterion-status rec-eligibility__criterion--${counted
            ? attendance.status
            : "insufficient_data"}"
        >
          ${counted
            ? criterionLabel(attendance.status, Boolean(attendance.attested))
            : t("logistics.eligibility.criterion.notCounted")}
        </span>
      </div>
      ${counted
        ? nothing
        : html`<p class="muted">${t("logistics.eligibility.attendanceNotCounted")}</p>`}
      ${attendance.attested ? renderAttested(attendance.attested, "attendance", true) : nothing}
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

/** The admin's confirm-a-criterion controls. Present only when the surface wires them. */
export type RecLetterAttestControls = {
  attestations: RecLetterAttestation[];
  note: string;
  saving: RecLetterAttestationCriterion | null;
  removingId: string | null;
  error: string | null;
  onNoteChange: (note: string) => void;
  onAttest: (criterion: RecLetterAttestationCriterion) => void;
  onRemove: (attestationId: string) => void;
};

function renderAttestControls(controls: RecLetterAttestControls, result: RecLetterEligibility) {
  const busy = controls.saving !== null;
  const button = (criterion: RecLetterAttestationCriterion, attested: boolean) =>
    html`<button
      class="btn btn--sm"
      type="button"
      data-testid="rec-eligibility-attest-${criterion}"
      ?disabled=${busy || attested}
      @click=${() => controls.onAttest(criterion)}
    >
      ${controls.saving === criterion
        ? t("logistics.eligibility.attest.saving")
        : t(`logistics.eligibility.attest.${criterion}`)}
    </button>`;
  return html`
    <section class="rec-eligibility__attest" data-testid="rec-eligibility-attest">
      <h4>${t("logistics.eligibility.attest.title")}</h4>
      <p class="muted">${t("logistics.eligibility.attest.sub")}</p>
      <label class="adminbot-form__field">
        <span>${t("logistics.eligibility.attest.note")}</span>
        <textarea
          rows="2"
          maxlength="2000"
          data-testid="rec-eligibility-attest-note"
          .value=${live(controls.note)}
          @input=${(event: Event) =>
            controls.onNoteChange((event.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
      </label>
      <div class="rec-eligibility-admin__actions">
        ${button("hours", Boolean(result.hours.attested))}
        ${attendanceCounted(result)
          ? button("attendance", Boolean(result.attendance.attested))
          : nothing}
      </div>
      ${controls.error
        ? html`<p class="logistics-requests__error" role="alert">${controls.error}</p>`
        : nothing}
      ${controls.attestations.length
        ? html`<ul class="rec-eligibility-admin__list">
            ${controls.attestations.map(
              (entry) => html`<li
                class="rec-eligibility-admin__item"
                data-testid="rec-eligibility-attestation"
              >
                <div class="rec-eligibility-admin__item-body">
                  <strong>${t(`logistics.eligibility.attested.${entry.criterion}`)}</strong>
                  <span class="muted">
                    ${t("logistics.eligibility.attested.on", {
                      date: formatRecLetterDay(entry.created_at.slice(0, 10)),
                    })}
                    ${t("logistics.eligibility.attested.by", { admin: entry.created_by })}
                  </span>
                  ${entry.note
                    ? html`<span class="rec-eligibility-admin__item-note">${entry.note}</span>`
                    : nothing}
                </div>
                <button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${controls.removingId === entry.id}
                  @click=${() => controls.onRemove(entry.id)}
                >
                  ${controls.removingId === entry.id
                    ? t("logistics.eligibility.incidents.deleting")
                    : t("logistics.eligibility.attest.remove")}
                </button>
              </li>`,
            )}
          </ul>`
        : nothing}
    </section>
  `;
}

export type RecLetterDetailPanelProps = {
  value: RecLetterAdminEligibility | null;
  loading: boolean;
  error: string | null;
  attest?: Omit<RecLetterAttestControls, "attestations">;
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
  if (!isRecLetterEligibility(result)) {
    return html`<section
      class="rec-eligibility"
      data-testid="rec-eligibility-panel"
      data-status="unavailable"
    >
      <p class="muted">${unavailableText()}</p>
    </section>`;
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
      ${props.attest
        ? renderAttestControls(
            { ...props.attest, attestations: props.value?.attestations ?? [] },
            result,
          )
        : nothing}
    </section>
  `;
}

export type RecLetterAdvisoryProps = {
  value: RecLetterEligibility | null;
  loading: boolean;
  error: string | null;
  /** Where the app is mounted, so "add past months" reaches the availability page. */
  basePath?: string;
};

type ReadinessMark = "met" | "todo" | "unknown" | "paused" | "off";

function renderReadinessItem(mark: ReadinessMark, body: unknown, testId?: string) {
  const glyph = mark === "met" ? "✓" : mark === "paused" ? "‖" : "";
  return html`<li
    class="rec-readiness__item rec-readiness__item--${mark}"
    data-testid=${testId ?? nothing}
  >
    <span class="rec-readiness__mark" aria-hidden="true">${glyph}</span>
    <span class="rec-readiness__body">${body}</span>
  </li>`;
}

/**
 * One segment per required month: filled for a qualifying month, hatched for a month with no
 * record (unknown, not zero), empty for the rest. Purely a picture -- the checklist says it in words.
 */
function renderReadinessBar(result: RecLetterEligibility, unknown: number) {
  const required = Math.max(1, result.hours.required_months);
  const met = Math.min(result.hours.qualifying_months, required);
  const hatched = Math.min(unknown, required - met);
  return html`<div class="rec-readiness__bar" aria-hidden="true">
    ${Array.from({ length: required }, (_, index) => {
      const kind = index < met ? "met" : index < met + hatched ? "unknown" : "open";
      return html`<i class="rec-readiness__segment rec-readiness__segment--${kind}"></i>`;
    })}
  </div>`;
}

function readinessChip(result: RecLetterEligibility): string {
  if (result.status === "frozen" && result.freeze.frozen_until) {
    return t("logistics.eligibility.readiness.chipFrozen", {
      date: formatRecLetterDay(result.freeze.frozen_until),
    });
  }
  if (result.status === "not_yet") {
    const left = Math.max(0, result.hours.required_months - result.hours.qualifying_months);
    if (left > 0) {
      return t(
        left === 1
          ? "logistics.eligibility.readiness.chipMonthLeft"
          : "logistics.eligibility.readiness.chipMonthsLeft",
        { count: String(left) },
      );
    }
  }
  return t(`logistics.eligibility.readiness.chip.${result.status}`);
}

/** Whole days from the result's own date to the end of the freeze, so the count never drifts. */
function daysUntil(asOf: string, until: string): number | null {
  const from = Date.parse(`${asOf}T12:00:00Z`);
  const to = Date.parse(`${until}T12:00:00Z`);
  return Number.isNaN(from) || Number.isNaN(to)
    ? null
    : Math.max(0, Math.round((to - from) / 864e5));
}

/**
 * The readiness card on the member's own letters form.
 *
 * It reads as progress, not as a verdict: a headline, a bar of the months, and a checklist where
 * every open item says what the member can do about it. Nothing here is red and nothing disables
 * Submit -- the policy guides the letter writer, it does not gate the request, and a member who is
 * short of it is usually just early. A failed read still states the policy in one line, so the
 * member learns what the lab looks at either way.
 */
export function renderRecLetterAdvisory(props: RecLetterAdvisoryProps) {
  const result = isRecLetterEligibility(props.value) ? props.value : null;
  const counted = result ? attendanceCounted(result) : false;
  const unknown = result ? monthsWithoutData(result) : [];
  const availability = pathForTab("adminbotTimeAvailability", props.basePath ?? "");
  const policy = t("logistics.eligibility.memberNote", {
    months: String(result?.hours.required_months ?? 5),
    hours: String(result?.hours.min_weekly_hours ?? 20),
  });
  if (!result) {
    return html`<aside
      class="rec-eligibility rec-readiness"
      role="note"
      data-testid="rec-eligibility-advisory"
      data-status="unknown"
    >
      <div class="rec-readiness__head"><h4>${t("logistics.eligibility.title")}</h4></div>
      <p class="muted">${policy}</p>
      ${props.loading
        ? html`<p class="muted">${t("logistics.eligibility.loading")}</p>`
        : html`<p class="muted" data-testid="rec-eligibility-unavailable">${unavailableText()}</p>`}
    </aside>`;
  }

  const hours = result.hours;
  const frozenUntil = result.freeze.frozen ? result.freeze.frozen_until : undefined;
  const addMonths = html`<a href=${availability}
    >${t("logistics.eligibility.readiness.addMonths")}</a
  >`;
  const hoursLine = t("logistics.eligibility.readiness.hours", {
    // "6 of 5" reads as a typo; past the bar the count only needs to say the bar is cleared.
    count: String(Math.min(hours.qualifying_months, hours.required_months)),
    required: String(hours.required_months),
    hours: String(hours.min_weekly_hours),
  });
  // Each open item carries one short next step, and that is the only place it is said.
  const hoursItem = hours.attested
    ? renderReadinessItem("met", renderAttested(hours.attested, "hours", false))
    : hours.status === "met"
      ? renderReadinessItem("met", hoursLine)
      : renderReadinessItem(
          hours.status === "insufficient_data" ? "unknown" : "todo",
          html`${hoursLine}
            <span
              class="rec-readiness__hint"
              data-testid=${hours.status === "insufficient_data"
                ? "rec-eligibility-hours-unknown"
                : nothing}
            >
              ${hours.status === "insufficient_data"
                ? t("logistics.eligibility.readiness.blankMonths", {
                    months: formatMonthRuns(unknown),
                  })
                : t("logistics.eligibility.readiness.workedMore")}
              ${addMonths}
            </span>`,
        );
  // Attendance gets a row only once it counts; until then it is not the member's concern.
  const attendanceItem = !counted
    ? nothing
    : result.attendance.attested
      ? renderReadinessItem("met", renderAttested(result.attendance.attested, "attendance", false))
      : renderReadinessItem(
          result.attendance.status === "met"
            ? "met"
            : result.attendance.status === "insufficient_data"
              ? "unknown"
              : "todo",
          t("logistics.eligibility.memberNoteAttendance", {
            window: String(result.attendance.window_months),
            rate: percent(result.attendance.min_rate),
          }),
        );
  const days = frozenUntil ? daysUntil(result.as_of, frozenUntil) : null;

  return html`
    <aside
      class="rec-eligibility rec-readiness rec-readiness--${result.status}"
      role="note"
      data-testid="rec-eligibility-advisory"
      data-status=${result.status}
    >
      <div class="rec-readiness__head">
        <h4>${t(`logistics.eligibility.readiness.title.${result.status}`)}</h4>
        <span class="rec-readiness__chip">
          ${frozenUntil && days !== null
            ? t("logistics.eligibility.readiness.chipDaysLeft", { count: String(days) })
            : readinessChip(result)}
        </span>
      </div>
      ${frozenUntil
        ? html`<p class="rec-eligibility__frozen" data-testid="rec-eligibility-frozen">
            ${t("logistics.eligibility.readiness.frozenExplain", {
              date: formatRecLetterDay(frozenUntil),
            })}
          </p>`
        : html`${renderReadinessBar(result, unknown.length)}
            <ul class="rec-readiness__list">
              ${renderReadinessItem("met", t("logistics.eligibility.readiness.noFreeze"))}
              ${hoursItem} ${attendanceItem}
            </ul>`}
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
