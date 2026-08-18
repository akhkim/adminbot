// The trips log on the Time Availability tab, cut out of time-availability.ts.
//
// Logged the way a commitment is, because it is the same act: a member saying in advance what
// their next few weeks look like. A trip is a range with a place on it, which is the one thing
// none of the other schedule rows carry — a time-off row says a member is unavailable and says
// nothing about where they are, and somebody working normal hours from Berlin is fully available
// and six hours off the lab's clock. That case is what kept producing 10am invites landing at 4pm.
//
// Rows are saved through the same schedule write as the other lists, so a trip is stored, dated
// and editable rather than being a status somebody has to remember to unset.
import { html, nothing } from "lit";
import { tripOnDay, todayIso, type TripRow } from "../data/availability.ts";
import { timezoneForLocation } from "../data/timezone-for-location.ts";

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
  /** Home, for the row that says what "away" is away from. */
  homeLocation?: string | null;
  draft: TripDraft;
  onDraftChange: (draft: TripDraft) => void;
  /** Self only. An admin reading someone else's schedule sees the trips and cannot edit them. */
  editable: boolean;
  saving: boolean;
  onSave: (trips: TripRow[]) => void;
  today?: string;
};

/** Why the draft cannot be saved yet, or null. Same shape as the other editors on this tab. */
export function tripDraftError(draft: TripDraft): string | null {
  if (!draft.city.trim()) {
    return "Where are you going?";
  }
  if (!draft.start || !draft.end) {
    return "Add both a start and an end date.";
  }
  if (draft.end < draft.start) {
    return "The end date is before the start date.";
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
    return Number.isFinite(year)
      ? // Built field by field: new Date("2026-09-01") is UTC midnight, which prints as August 31
        // for every reader west of Greenwich.
        new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString([], {
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
    <li class="trips__row ${active ? "trips__row--active" : ""}">
      <span class="trips__city">${row.city}</span>
      <span class="trips__dates">${formatRange(row)}</span>
      ${row.timezone ? html`<span class="muted trips__zone">${row.timezone}</span>` : nothing}
      ${active ? html`<span class="trips__now">now</span>` : nothing}
      ${row.note ? html`<span class="muted trips__note">${row.note}</span>` : nothing}
      ${props.editable
        ? html`<button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.saving}
            title="Remove this trip"
            @click=${() => props.onSave(props.trips.filter((_, at) => at !== index))}
          >
            Remove
          </button>`
        : nothing}
    </li>
  `;
}

export function renderTrips(props: TripsProps) {
  const today = props.today ?? todayIso();
  const current = tripOnDay(props.trips, today);
  const error = tripDraftError(props.draft);
  const patch = (change: Partial<TripDraft>) => props.onDraftChange({ ...props.draft, ...change });
  const submit = (event: Event) => {
    event.preventDefault();
    if (tripDraftError(props.draft)) {
      return;
    }
    // Kept sorted by start date: the list is read as a timeline, and rows appended in entry order
    // put a trip logged today after one that already happened.
    props.onSave(
      [...props.trips, toRow(props.draft)].toSorted((left, right) =>
        left.start.localeCompare(right.start),
      ),
    );
    props.onDraftChange(EMPTY_TRIP_DRAFT);
  };
  return html`
    <section class="card adminbot-card adminbot-card--wide trips">
      <div class="card-title">Trips away from home</div>
      <p class="card-sub">
        ${props.homeLocation
          ? html`Home is ${props.homeLocation}. `
          : nothing}Log a conference, an internship or a term abroad. Meeting times and calendar
        invites follow this while it is running, and go back to home time afterwards.
      </p>
      ${current
        ? html`<p class="trips__current">
            Currently in <strong>${current.city}</strong>${current.timezone
              ? html` (${current.timezone})`
              : nothing}.
          </p>`
        : nothing}
      ${props.trips.length
        ? html`<ul class="trips__list">
            ${props.trips.map((row, index) => renderRow(props, row, index, today))}
          </ul>`
        : html`<p class="muted">No trips logged.</p>`}
      ${props.editable
        ? html`
            <form class="trips__form" @submit=${submit}>
              <label class="trips__field">
                <span>City</span>
                <input
                  name="city"
                  .value=${props.draft.city}
                  placeholder="Berlin"
                  ?disabled=${props.saving}
                  @input=${(event: Event) => {
                    const city = (event.target as HTMLInputElement).value;
                    const guess = timezoneForLocation(city);
                    // The guess fills an untouched zone field and never overwrites a typed one.
                    patch({
                      city,
                      ...(guess && !props.draft.timezone ? { timezone: guess } : {}),
                    });
                  }}
                />
              </label>
              <label class="trips__field">
                <span>From</span>
                <input
                  name="start"
                  type="date"
                  .value=${props.draft.start}
                  ?disabled=${props.saving}
                  @input=${(event: Event) =>
                    patch({ start: (event.target as HTMLInputElement).value })}
                />
              </label>
              <label class="trips__field">
                <span>To</span>
                <input
                  name="end"
                  type="date"
                  .value=${props.draft.end}
                  ?disabled=${props.saving}
                  @input=${(event: Event) =>
                    patch({ end: (event.target as HTMLInputElement).value })}
                />
              </label>
              <label class="trips__field">
                <span>Time zone</span>
                <input
                  name="timezone"
                  .value=${props.draft.timezone}
                  placeholder="Europe/Berlin"
                  ?disabled=${props.saving}
                  @input=${(event: Event) =>
                    patch({ timezone: (event.target as HTMLInputElement).value })}
                />
              </label>
              <label class="trips__field trips__field--wide">
                <span>Note</span>
                <input
                  name="note"
                  .value=${props.draft.note}
                  placeholder="NeurIPS"
                  ?disabled=${props.saving}
                  @input=${(event: Event) =>
                    patch({ note: (event.target as HTMLInputElement).value })}
                />
              </label>
              <button class="btn btn--sm" type="submit" ?disabled=${props.saving || Boolean(error)}>
                ${props.saving ? "Saving…" : "Add trip"}
              </button>
              ${error && (props.draft.city || props.draft.start || props.draft.end)
                ? html`<span class="muted trips__error">${error}</span>`
                : nothing}
            </form>
          `
        : nothing}
    </section>
  `;
}
