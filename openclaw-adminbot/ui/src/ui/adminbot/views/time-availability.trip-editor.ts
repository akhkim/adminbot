import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { t } from "../../../i18n/index.ts";
import { todayIso, type TripRow } from "../data/availability.ts";
import { timezoneForLocation } from "../data/timezone-for-location.ts";
import { localTimezone, timezoneOptions } from "../data/timezones.ts";
import { renderDateControl } from "../date-control.ts";
import { formatRange } from "./time-availability.trips.ts";
// The trip editor: where the member is going that is not a conference on the Events list.
//
// Time Availability's "Trip Away" editor. It spent a while on the Travel tab, beside the
// conference RSVPs; when Events took those over and Travel was removed, it came back here, next to
// the where-strip it feeds. The rows are the schedule's `trips` field, which the where-strip, the
// calendar and Events' nearby matches all read.
//
// The strings keep their `adminbotTimeAvailability.trips.*` keys so the shipped translations come
// with the form rather than falling back to English.

export type TripDraft = {
  city: string;
  start: string;
  end: string;
  timezone: string;
  note: string;
  /**
   * Which logged trip this draft is rewriting, or null when it is a new one.
   *
   * Carried on the draft rather than as a second piece of state because the two are always
   * changed together: every path that loads a row into the form also has to say which row it came
   * from, and holding them apart is what lets "editing trip 2" survive a draft reset and overwrite
   * the wrong trip.
   */
  editingIndex: number | null;
};

export const EMPTY_TRIP_DRAFT: TripDraft = {
  city: "",
  start: "",
  end: "",
  timezone: "",
  note: "",
  editingIndex: null,
};

export type TravelPlansProps = {
  trips: TripRow[];
  /** Home, for the line that says what "away" is away from. */
  homeLocation?: string | null;
  draft: TripDraft;
  onDraftChange: (draft: TripDraft) => void;
  saving: boolean;
  onSave: (trips: TripRow[]) => void;
  today?: string;
};

/** Why the draft cannot be saved yet, or null. */
export function tripDraftError(draft: TripDraft): string | null {
  if (!draft.city.trim()) {
    return t("adminbotTimeAvailability.trips.errorCity");
  }
  if (!draft.start || !draft.end) {
    return t("adminbotTimeAvailability.trips.errorDates");
  }
  if (draft.end < draft.start) {
    return t("adminbotTimeAvailability.trips.errorOrder");
  }
  return null;
}

/** A logged trip loaded back into the form that produced it. */
function toDraft(row: TripRow, index: number): TripDraft {
  return {
    city: row.city,
    start: row.start,
    end: row.end,
    timezone: row.timezone ?? "",
    note: row.note ?? "",
    editingIndex: index,
  };
}

function toRow(draft: TripDraft, previous?: TripRow): TripRow {
  const city = draft.city.trim();
  // The typed zone wins: a member who corrected the guess has said something more specific than
  // the city did. Falling back to the guess is what keeps the common case one field shorter.
  const timezone = draft.timezone.trim() || timezoneForLocation(city) || "";
  return {
    start: draft.start,
    end: draft.end,
    city,
    ...(timezone ? { timezone } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    // The form has no link field; an edit keeps the one the row already had.
    ...(previous?.link ? { link: previous.link } : {}),
  };
}

function renderRow(props: TravelPlansProps, row: TripRow, index: number, today: string) {
  const active = row.start <= today && row.end >= today;
  const past = row.end < today;
  const isBeingEdited = props.draft.editingIndex === index;
  return html`
    <li
      class="adminbot-trips__row ${active ? "adminbot-trips__row--active" : ""} ${isBeingEdited
        ? "adminbot-trips__row--editing"
        : ""} ${past ? "lab-travel__past" : ""}"
      data-testid=${`lab-travel-plan-${index}`}
    >
      <span class="adminbot-trips__city">${row.city}</span>
      <span class="adminbot-trips__dates">${formatRange(row)}</span>
      ${row.timezone ? html`<span class="muted">${row.timezone}</span>` : nothing}
      ${row.note ? html`<span class="muted">${row.note}</span>` : nothing}
      <button
        type="button"
        class="btn btn--sm"
        data-testid=${`lab-travel-plan-edit-${index}`}
        ?disabled=${props.saving}
        @click=${() => props.onDraftChange(toDraft(row, index))}
      >
        ${t("adminbotTimeAvailability.trips.edit")}
      </button>
      <button
        type="button"
        class="btn btn--sm"
        data-testid=${`lab-travel-plan-remove-${index}`}
        ?disabled=${props.saving}
        @click=${() => {
          // Removing saves straight away, so it asks first.
          if (!globalThis.confirm?.(t("adminbotTimeAvailability.trips.removeConfirm"))) {
            return;
          }
          props.onSave(props.trips.filter((_, at) => at !== index));
          // Removing the row being edited would leave the form pointed at an index that is now a
          // different trip, so the edit is abandoned with it.
          if (props.draft.editingIndex === index) {
            props.onDraftChange(EMPTY_TRIP_DRAFT);
          }
        }}
      >
        ${t("adminbotTimeAvailability.trips.remove")}
      </button>
    </li>
  `;
}

export function renderTravelPlans(props: TravelPlansProps) {
  const today = props.today ?? todayIso();
  const editing = props.draft.editingIndex !== null;
  const error = tripDraftError(props.draft);
  const touched = Boolean(props.draft.city || props.draft.start || props.draft.end);
  const patch = (change: Partial<TripDraft>) => props.onDraftChange({ ...props.draft, ...change });
  const field = (key: keyof TripDraft) => (event: Event) =>
    patch({ [key]: (event.currentTarget as HTMLInputElement).value } as Partial<TripDraft>);
  return html`
    <section
      class="card adminbot-card adminbot-card--wide lab-travel__card"
      data-testid="lab-travel-plans"
    >
      <div class="card-title">${t("labTravel.plans.title")}</div>
      <p class="card-sub">
        ${props.homeLocation
          ? html`${t("adminbotTimeAvailability.trips.home", { location: props.homeLocation })} `
          : nothing}${t("labTravel.plans.hint")}
      </p>
      ${props.trips.length
        ? html`<ul class="adminbot-trips__list" data-testid="lab-travel-plan-list">
            ${props.trips.map((row, index) => renderRow(props, row, index, today))}
          </ul>`
        : html`<p class="muted">${t("adminbotTimeAvailability.trips.empty")}</p>`}
      <form
        class="adminbot-form lab-travel__form"
        data-testid="lab-travel-plan-form"
        @submit=${(event: Event) => {
          event.preventDefault();
          if (tripDraftError(props.draft)) {
            return;
          }
          const replacing = props.draft.editingIndex;
          // Replaced in place when editing, appended otherwise. Kept sorted by start date either
          // way: the list is read as a timeline, and an edit that moves a trip's dates has to
          // re-sort for the same reason.
          const next =
            replacing === null
              ? [...props.trips, toRow(props.draft)]
              : props.trips.map((row, at) => (at === replacing ? toRow(props.draft, row) : row));
          props.onSave(next.toSorted((left, right) => left.start.localeCompare(right.start)));
          props.onDraftChange(EMPTY_TRIP_DRAFT);
        }}
      >
        <div class="card-title lab-travel__form-title">
          ${editing ? t("labTravel.plans.editTitle") : t("adminbotTimeAvailability.form.tripTitle")}
        </div>
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.trips.city")}</span>
          <input
            type="text"
            data-testid="lab-travel-plan-city"
            .value=${props.draft.city}
            @input=${(event: Event) => {
              const city = (event.currentTarget as HTMLInputElement).value;
              const guess = timezoneForLocation(city);
              // The guess fills an untouched zone field and never overwrites a typed one.
              patch({ city, ...(guess && !props.draft.timezone ? { timezone: guess } : {}) });
            }}
          />
        </label>
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.trips.from")}</span>
          ${renderDateControl(
            html`<input
              type="date"
              data-testid="lab-travel-plan-start"
              .value=${live(props.draft.start)}
              @input=${field("start")}
            />`,
            props.draft.start,
          )}
        </label>
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.trips.to")}</span>
          ${renderDateControl(
            html`<input
              type="date"
              data-testid="lab-travel-plan-end"
              .value=${live(props.draft.end)}
              @input=${field("end")}
            />`,
            props.draft.end,
          )}
        </label>
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.trips.timezone")}</span>
          <!-- A select of the common zones rather than six hundred names; the viewer's own zone
               shows until a typed city guesses one or a zone is picked. -->
          <select
            data-testid="lab-travel-plan-timezone"
            .value=${props.draft.timezone || localTimezone()}
            @change=${(event: Event) =>
              patch({ timezone: (event.currentTarget as HTMLSelectElement).value })}
          >
            ${timezoneOptions(props.draft.timezone || localTimezone()).map(
              (group) => html`<optgroup label=${group.label}>
                ${group.options.map(
                  (option) => html`<option value=${option.zone}>${option.label}</option>`,
                )}
              </optgroup>`,
            )}
          </select>
        </label>
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.trips.note")}</span>
          <input
            type="text"
            data-testid="lab-travel-plan-note"
            .value=${props.draft.note}
            @input=${field("note")}
          />
        </label>
        <div class="lab-travel__form-actions">
          ${error && touched
            ? html`<span class="lab-travel__form-error" role="alert">${error}</span>`
            : nothing}
          ${editing
            ? html`<button
                type="button"
                class="btn"
                data-testid="lab-travel-plan-cancel"
                ?disabled=${props.saving}
                @click=${() => props.onDraftChange(EMPTY_TRIP_DRAFT)}
              >
                ${t("common.cancel")}
              </button>`
            : nothing}
          <button
            type="submit"
            class="btn primary"
            data-testid="lab-travel-plan-add"
            ?disabled=${props.saving || error !== null}
          >
            ${editing ? t("common.save") : t("adminbotTimeAvailability.trips.submit")}
          </button>
        </div>
      </form>
    </section>
  `;
}
