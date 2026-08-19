// The trips editor on the Time Availability tab, cut out of time-availability.ts.
//
// Logged the way a commitment is, because it is the same act: a member saying in advance what
// their next few weeks look like. It is the fourth entry in the tab's editor stack and is built
// from the same parts as the other three -- one `__editor` section, a `card-title`, a hint, an
// `adminbot-form` grid of fields and a primary submit -- so "add a trip" reads as a sibling of
// "add a commitment" rather than as a different kind of thing bolted on.
//
// Which trip is running right now is deliberately not stated here. It belongs on the chart above,
// beside the capacity pill, where a reader is already looking to answer "what does this person's
// next month look like" -- repeating it down here would be the same fact twice on one screen.
//
// A trip is a range with a place on it, which is the one thing none of the other schedule rows
// carry. A time-off row says a member is unavailable and says nothing about where they are, and
// somebody working normal hours from Berlin is fully available and six hours off the lab's clock.
// That case is what kept producing 10am invites that land at 4pm.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { todayIso, type TripRow, type WhereBin } from "../data/availability.ts";
import { timezoneForLocation } from "../data/timezone-for-location.ts";
import { localTimezone, timezoneOptions } from "../data/timezones.ts";

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

/**
 * A date range as a person reads it: "Sep 1 – Sep 30", or a single day as itself.
 *
 * Takes the two fields rather than a TripRow so the trips list and the where-strip's breakdown
 * format their dates through one function; they are the same fact in two places, and two copies
 * would eventually disagree about whether a one-day trip prints as a range.
 */
function formatRange(row: { start: string; end: string }): string {
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
  return row.start === row.end
    ? format(row.start)
    : `${format(row.start)} – ${format(row.end)}`;
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
                <!-- A select rather than a datalist, for the same reason as the milestone editor:
                   a select's arrow sits where a dropdown's arrow is supposed to, and only the
                   common zones are offered instead of six hundred names. The viewer's own zone
                   shows until a typed city guesses one or a zone is picked. -->
                <select
                  data-testid="time-availability-trip-timezone"
                  .value=${props.draft.timezone || localTimezone()}
                  @change=${(event: Event) => {
                    const zone = (event.currentTarget as HTMLSelectElement).value;
                    props.onDraftChange({ ...props.draft, timezone: zone });
                  }}
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

/**
 * The where-strip that runs under the chart: one cell per period, saying where the member is.
 *
 * Under the chart rather than in the trips box because it is the same question the bars answer,
 * asked about place instead of effort -- and because it has to follow the range switch. At "week"
 * that is a city per day, at "month" per week, at "year" per month, which is the granularity the
 * reader just chose for everything else on the screen.
 *
 * Home periods are drawn quietly. The strip would otherwise be a wall of the member's own city
 * with the interesting weeks hidden inside it, and where somebody lives is already on their
 * profile -- what this is for is the weeks when they are somewhere else.
 *
 * The breakdown is a real element revealed on hover and on keyboard focus, not a `title`. A native
 * tooltip gave a help cursor and then, often, nothing: it is slow, it is suppressed while a pointer
 * is moving, and there is no way to reach it from the keyboard at all -- so the "+2" on a cell
 * pointed at content that could not reliably be read.
 */
export function renderWhereStrip(bins: readonly WhereBin[]) {
  // Any travel at all in the horizon, not just a period that is *mostly* travel: a five-day
  // conference makes no month majority-away, and hiding the strip for it would hide exactly the
  // case the breakdown was added to explain.
  const travels = bins.some(
    (bin) => bin.away || bin.segments.some((segment) => segment.away),
  );
  if (!travels) {
    return nothing;
  }
  return html`
    <div class="adminbot-where-strip" data-testid="time-availability-where-strip">
      ${bins.map((bin) => {
        const detail = bin.segments.length
          ? bin.segments
          : [{ start: "", end: "", city: bin.city, away: bin.away }];
        return html`
          <div
            class="adminbot-where-strip__cell ${bin.away
              ? "adminbot-where-strip__cell--away"
              : ""}"
            tabindex="0"
          >
            <span class="adminbot-where-strip__label">${bin.label}</span>
            <span class="adminbot-where-strip__city">${bin.city}</span>
            <!-- How many other places the period also covers. A count rather than an asterisk:
                 "+2" says there is more here and roughly how much. -->
            ${bin.segments.length > 1
              ? html`<span class="adminbot-where-strip__more"
                  >+${bin.segments.length - 1}</span
                >`
              : nothing}
            <span class="adminbot-where-strip__detail" role="tooltip">
              <span class="adminbot-where-strip__detail-title">${bin.label}</span>
              ${detail.map(
                (segment) => html`
                  <span class="adminbot-where-strip__detail-row">
                    ${segment.start
                      ? html`<span class="adminbot-where-strip__detail-range"
                          >${formatRange(segment)}</span
                        >`
                      : nothing}
                    <span>${segment.city}</span>
                  </span>
                `,
              )}
            </span>
          </div>
        `;
      })}
    </div>
  `;
}
