// The trips editor on the Time Availability tab, cut out of time-availability.ts.
//
// Logged the way a commitment is, because it is the same act: a member saying in advance what
// their next few weeks look like. It is the fourth entry in the tab's editor stack and is built
// from the same parts as the other three -- one `__editor` section, a `card-title`, a hint, an
// `adminbot-form` grid of fields and a primary submit -- so "add a trip" reads as a sibling of
// "add a commitment" rather than as a different kind of thing bolted on.
//
// A trip is a range with a place on it, which is the one thing none of the other schedule rows
// carry. A time-off row says a member is unavailable and says nothing about where they are, and
// somebody working normal hours from Berlin is fully available and six hours off the lab's clock.
// That case is what kept producing 10am invites that land at 4pm.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { tripOnDay, todayIso, type TripRow } from "../data/availability.ts";
import { timezoneForLocation } from "../data/timezone-for-location.ts";
import { TIMEZONE_LIST_ID, timezoneSuggestions } from "../data/timezones.ts";

export type TripDraft = {
  city: string;
  start: string;
  end: string;
  timezone: string;
  note: string;
};

export const EMPTY_TRIP_DRAFT: TripDraft = {
  city: "",
  start: "",
  end: "",
  timezone: "",
  note: "",
};

export type TripsProps = {
  trips: TripRow[];
  /** Home, for the line that says what "away" is away from. */
  homeLocation?: string | null;
  draft: TripDraft;
  onDraftChange: (draft: TripDraft) => void;
  /** Self only. An admin reading someone else's schedule sees the trips and no form. */
  editable: boolean;
  saving: boolean;
  onSave: (trips: TripRow[]) => void;
  today?: string;
};

/** Why the draft cannot be saved yet, or null. Same contract as the other editors on this tab. */
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

function toRow(draft: TripDraft): TripRow {
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
  };
}

function formatRange(row: TripRow): string {
  const format = (value: string): string => {
    const [year, month, day] = value.split("-").map(Number);
    // Built field by field: new Date("2026-09-01") is UTC midnight, which prints as August 31 for
    // every reader west of Greenwich.
    return Number.isFinite(year)
      ? new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString([], {
          month: "short",
          day: "numeric",
        })
      : value;
  };
  return `${format(row.start)} – ${format(row.end)}`;
}

function renderRow(props: TripsProps, row: TripRow, index: number, today: string) {
  const active = row.start <= today && row.end >= today;
  return html`
    <li class="adminbot-trips__row ${active ? "adminbot-trips__row--active" : ""}">
      <span class="adminbot-trips__city">${row.city}</span>
      <span class="adminbot-trips__dates">${formatRange(row)}</span>
      ${row.timezone ? html`<span class="muted">${row.timezone}</span>` : nothing}
      ${row.note ? html`<span class="muted">${row.note}</span>` : nothing}
      ${props.editable
        ? html`<button
            type="button"
            class="btn btn--sm"
            data-testid=${`time-availability-trip-remove-${index}`}
            ?disabled=${props.saving}
            @click=${() => props.onSave(props.trips.filter((_, at) => at !== index))}
          >
            ${t("adminbotTimeAvailability.trips.remove")}
          </button>`
        : nothing}
    </li>
  `;
}

export function renderTrips(props: TripsProps) {
  const today = props.today ?? todayIso();
  const current = tripOnDay(props.trips, today);
  const error = tripDraftError(props.draft);
  const touched = Boolean(props.draft.city || props.draft.start || props.draft.end);
  const patch = (change: Partial<TripDraft>) => props.onDraftChange({ ...props.draft, ...change });
  const field = (key: keyof TripDraft) => (event: Event) =>
    patch({ [key]: (event.currentTarget as HTMLInputElement).value } as Partial<TripDraft>);
  return html`
    <section
      class="adminbot-time-availability__editor"
      data-testid="time-availability-trip-editor"
    >
      <div class="card-title">${t("adminbotTimeAvailability.form.tripTitle")}</div>
      <p class="adminbot-time-availability__form-hint">
        ${props.homeLocation
          ? html`${t("adminbotTimeAvailability.trips.home", { location: props.homeLocation })} `
          : nothing}${t("adminbotTimeAvailability.trips.formHint")}
      </p>
      ${current
        ? html`<p class="adminbot-trips__current" data-testid="time-availability-trip-current">
            ${t("adminbotTimeAvailability.trips.current", { city: current.city })}
          </p>`
        : nothing}
      ${props.trips.length
        ? html`<ul class="adminbot-trips__list" data-testid="time-availability-trip-list">
            ${props.trips.map((row, index) => renderRow(props, row, index, today))}
          </ul>`
        : html`<p class="muted">${t("adminbotTimeAvailability.trips.empty")}</p>`}
      ${props.editable
        ? html`
            <form
              class="adminbot-form adminbot-time-availability__form"
              data-testid="time-availability-trip-form"
              @submit=${(event: Event) => {
                event.preventDefault();
                if (tripDraftError(props.draft)) {
                  return;
                }
                // Kept sorted by start date: the list is read as a timeline, and appending in entry
                // order puts a trip logged today after one that already happened.
                props.onSave(
                  [...props.trips, toRow(props.draft)].toSorted((left, right) =>
                    left.start.localeCompare(right.start),
                  ),
                );
                props.onDraftChange(EMPTY_TRIP_DRAFT);
              }}
            >
              <label class="adminbot-form__field">
                <span>${t("adminbotTimeAvailability.trips.city")}</span>
                <input
                  type="text"
                  data-testid="time-availability-trip-city"
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
                <input type="date" .value=${props.draft.start} @input=${field("start")} />
              </label>
              <label class="adminbot-form__field">
                <span>${t("adminbotTimeAvailability.trips.to")}</span>
                <input type="date" .value=${props.draft.end} @input=${field("end")} />
              </label>
              <label class="adminbot-form__field">
                <span>${t("adminbotTimeAvailability.trips.timezone")}</span>
                <!-- Free text against the same shared datalist the milestone editor uses: six
                   hundred zones is six hundred DOM nodes per control, and typing "berl" is how
                   anyone finds theirs. -->
                <input
                  type="text"
                  list=${TIMEZONE_LIST_ID}
                  data-testid="time-availability-trip-timezone"
                  .value=${props.draft.timezone}
                  @input=${field("timezone")}
                />
                <datalist id=${TIMEZONE_LIST_ID}>
                  ${timezoneSuggestions().map((zone) => html`<option value=${zone}></option>`)}
                </datalist>
              </label>
              <label class="adminbot-form__field">
                <span>${t("adminbotTimeAvailability.trips.note")}</span>
                <input
                  type="text"
                  data-testid="time-availability-trip-note"
                  .value=${props.draft.note}
                  @input=${field("note")}
                />
              </label>
              <div class="adminbot-time-availability__form-actions">
                ${error && touched
                  ? html`<span class="adminbot-time-availability__form-error" role="alert"
                      >${error}</span
                    >`
                  : nothing}
                <button
                  type="submit"
                  class="btn primary"
                  data-testid="time-availability-trip-add"
                  ?disabled=${props.saving || error !== null}
                >
                  ${t("adminbotTimeAvailability.trips.submit")}
                </button>
              </div>
            </form>
          `
        : nothing}
    </section>
  `;
}
