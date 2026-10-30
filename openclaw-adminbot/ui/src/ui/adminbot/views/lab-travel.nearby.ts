import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { t } from "../../../i18n/index.ts";
import type { LabTravelNotice, LookupDraft } from "../controllers/lab-travel.ts";
import type { LocationTrackerSnapshot } from "../controllers/location-tracker.ts";
import type {
  TravelLookup,
  TravelMatch,
  TravelMatchGroup,
  TravelOverview,
  TravelSharing,
} from "../data/lab-travel.ts";
import { renderDateControl } from "../date-control.ts";
import { formatRange } from "./time-availability.trips.ts";
// Events' "Find lab members nearby" card: the location opt-in, this browser's side of it, who else
// from the lab is (or will be) where the member is, and the "Who's in…" lookup by place and dates.
// It was the third card of the Travel tab until Events took that tab over.
//
// Off is the resting state and the card says, before anything is shared, exactly what turning it
// on shares and with whom -- the opt-in is only meaningful if it is informed. On, it says where the
// member was last placed and how this browser is keeping that current, and offers the two ways
// out: stop sharing (which deletes the location), or type a city instead of granting the browser
// permission at all. The lookup only appears while sharing is on, because the service answers it
// only for a member who shares too.

export type TravelNearbyProps = {
  overview: TravelOverview | null;
  loading: boolean;
  error: string | null;
  notice: LabTravelNotice | null;
  /** Which action is in flight; see LabTravelHost.labTravelBusy. */
  busy: string | null;
  onRetry: () => void;
  sharing: TravelSharing | null;
  device: LocationTrackerSnapshot;
  onEnableSharing: () => void;
  onDisableSharing: () => void;
  onShareFromDevice: () => void;
  cityDraft: string;
  onCityDraftChange: (value: string) => void;
  onShareCity: () => void;
  lookupDraft: LookupDraft;
  onLookupDraftChange: (draft: LookupDraft) => void;
  onLookup: () => void;
  lookup: TravelLookup | null;
  lookupError: string | null;
};

/** "5 minutes ago", in the reader's own language. */
function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return iso;
  }
  const minutes = Math.round((then - now) / 60_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) {
    return format.format(minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  return Math.abs(hours) < 48
    ? format.format(hours, "hour")
    : format.format(Math.round(hours / 24), "day");
}

function placeText(place: { label: string; country?: string }): string {
  return place.country ? `${place.label}, ${place.country}` : place.label;
}

function basisText(match: TravelMatch): string {
  switch (match.basis) {
    case "live":
      return typeof match.distance_km === "number" && match.distance_km > 0
        ? t("labTravel.nearby.basisLiveKm", { km: String(match.distance_km) })
        : t("labTravel.nearby.basisLive");
    case "trip":
      return t("labTravel.nearby.basisTrip", {
        dates: match.from && match.to ? formatRange({ start: match.from, end: match.to }) : "",
      });
    case "conference":
      return t("labTravel.nearby.basisConference", { conference: match.conference_label ?? "" });
    case "home":
      return t("labTravel.nearby.basisHome");
  }
}

/**
 * Why a match came back empty. Only members who share their location are matched by home, trips
 * or live location; everyone else only by conference RSVPs, so "no one" needs that context.
 */
export function nobodyText(sharers: number | undefined, place?: string): string {
  const scope =
    sharers === undefined
      ? ""
      : sharers === 0
        ? t("labTravel.nearby.noSharers")
        : t("labTravel.nearby.fewSharers", { count: String(sharers) });
  const head = place ? t("labTravel.nearby.lookupNone", { place }) : t("labTravel.nearby.nobody");
  return scope ? `${head} ${scope}` : head;
}

function renderPeople(people: readonly TravelMatch[], testid: string, sharers?: number) {
  if (!people.length) {
    return html`<p class="muted" data-testid=${testid}>${nobodyText(sharers)}</p>`;
  }
  return html`<ul class="lab-travel__matches" data-testid=${testid}>
    ${people.map(
      (person) => html`<li class="lab-travel__match lab-travel__match--${person.basis}">
        <span class="lab-travel__match-name">${person.name}</span>
        <span class="muted">${basisText(person)}</span>
      </li>`,
    )}
  </ul>`;
}

function renderGroup(group: TravelMatchGroup, sharers?: number) {
  return html`
    <section class="lab-travel__group" data-testid=${`lab-travel-group-${group.id}`}>
      <div class="lab-travel__group-title">
        ${group.title}
        ${group.from && group.to
          ? html`<span class="muted"> · ${formatRange({ start: group.from, end: group.to })}</span>`
          : nothing}
      </div>
      ${renderPeople(group.people, `lab-travel-group-people-${group.id}`, sharers)}
    </section>
  `;
}

function renderDevice(props: TravelNearbyProps) {
  const device = props.device;
  const busy = props.busy !== null;
  const button = (label: string, testid: string) =>
    html`<button
      type="button"
      class="btn btn--sm"
      data-testid=${testid}
      ?disabled=${busy}
      @click=${props.onShareFromDevice}
    >
      ${label}
    </button>`;
  switch (device.status) {
    case "watching":
      return html`<p class="lab-travel__device" data-testid="lab-travel-device">
        ${t("labTravel.nearby.deviceWatching")}
        ${button(t("labTravel.nearby.updateNow"), "lab-travel-update-now")}
      </p>`;
    case "locating":
      return html`<p class="lab-travel__device muted" data-testid="lab-travel-device">
        ${t("labTravel.nearby.deviceLocating")}
      </p>`;
    case "denied":
      return html`<p class="lab-travel__device callout warning" data-testid="lab-travel-device">
        ${t("labTravel.nearby.deviceDenied")}
      </p>`;
    case "insecure":
      return html`<p class="lab-travel__device callout warning" data-testid="lab-travel-device">
        ${t("labTravel.nearby.deviceInsecure")}
      </p>`;
    case "unsupported":
      return html`<p class="lab-travel__device callout warning" data-testid="lab-travel-device">
        ${t("labTravel.nearby.deviceUnsupported")}
      </p>`;
    case "error":
      return html`<p class="lab-travel__device callout warning" data-testid="lab-travel-device">
        ${t("labTravel.nearby.deviceError", { message: device.message ?? "" })}
        ${button(t("labTravel.nearby.updateNow"), "lab-travel-update-now")}
      </p>`;
    case "needs-permission":
    case "idle":
      return html`<p class="lab-travel__device" data-testid="lab-travel-device">
        ${device.status === "needs-permission"
          ? t("labTravel.nearby.deviceNeedsPermission")
          : nothing}
        ${button(t("labTravel.nearby.useDevice"), "lab-travel-use-device")}
      </p>`;
  }
}

function renderLookup(props: TravelNearbyProps) {
  const draft = props.lookupDraft;
  const patch = (change: Partial<typeof draft>) =>
    props.onLookupDraftChange({ ...draft, ...change });
  const result = props.lookup;
  return html`
    <form
      class="adminbot-form lab-travel__form lab-travel__lookup"
      data-testid="lab-travel-lookup"
      @submit=${(event: Event) => {
        event.preventDefault();
        props.onLookup();
      }}
    >
      <div class="card-title lab-travel__form-title">${t("labTravel.nearby.lookupTitle")}</div>
      <label class="adminbot-form__field">
        <span>${t("labTravel.nearby.lookupPlace")}</span>
        <input
          type="text"
          data-testid="lab-travel-lookup-place"
          .value=${draft.place}
          @input=${(event: Event) =>
            patch({ place: (event.currentTarget as HTMLInputElement).value })}
        />
      </label>
      <label class="adminbot-form__field">
        <span>${t("labTravel.nearby.lookupFrom")}</span>
        ${renderDateControl(
          html`<input
            type="date"
            data-testid="lab-travel-lookup-from"
            .value=${live(draft.from)}
            @input=${(event: Event) =>
              patch({ from: (event.currentTarget as HTMLInputElement).value })}
          />`,
          draft.from,
        )}
      </label>
      <label class="adminbot-form__field">
        <span>${t("labTravel.nearby.lookupTo")}</span>
        ${renderDateControl(
          html`<input
            type="date"
            data-testid="lab-travel-lookup-to"
            .value=${live(draft.to)}
            @input=${(event: Event) =>
              patch({ to: (event.currentTarget as HTMLInputElement).value })}
          />`,
          draft.to,
        )}
      </label>
      <div class="lab-travel__form-actions">
        ${props.lookupError
          ? html`<span class="lab-travel__form-error" role="alert">${props.lookupError}</span>`
          : nothing}
        <button
          type="submit"
          class="btn primary"
          data-testid="lab-travel-lookup-submit"
          ?disabled=${props.busy === "lookup"}
        >
          ${t("labTravel.nearby.lookupSubmit")}
        </button>
      </div>
    </form>
    ${result
      ? html`<div class="lab-travel__lookup-result" data-testid="lab-travel-lookup-result">
          ${!result.resolved
            ? html`<p class="muted">
                ${t("labTravel.nearby.lookupUnresolved", { place: result.place.label })}
              </p>`
            : nothing}
          ${result.people.length
            ? renderPeople(result.people, "lab-travel-lookup-people")
            : html`<p class="muted" data-testid="lab-travel-lookup-people">
                ${nobodyText(result.sharing_members, placeText(result.place))}
              </p>`}
        </div>`
      : nothing}
  `;
}

// Folded or open is remembered per browser: a member who has set this up once rarely needs the
// whole card again, and it sits above the events list. Storage can be blocked; then it just opens.
const OPEN_KEY = "adminbot.labTravel.nearbyOpen";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveOpen(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Not remembered; the card still folds for this visit.
  }
}

/** The folded card's one-line state, so closing it never hides whether you are sharing. */
function statusText(props: TravelNearbyProps): string {
  const sharing = props.sharing ?? props.overview?.sharing;
  if (!sharing) {
    return "";
  }
  if (!sharing.enabled) {
    return t("labTravel.nearby.statusOff");
  }
  return sharing.location
    ? t("labTravel.nearby.statusOn", { place: sharing.location.label })
    : t("labTravel.nearby.statusOnNoFix");
}

export function renderTravelNearby(props: TravelNearbyProps) {
  const overview = props.overview;
  const status = statusText(props);
  return html`
    <details
      class="card adminbot-card adminbot-card--wide adminbot-fold lab-travel__card"
      data-testid="lab-travel-nearby"
      ?open=${readOpen()}
      @toggle=${(event: Event) => saveOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        ${t("labTravel.nearby.title")}
        ${status
          ? html`<span class="muted lab-travel__status" data-testid="lab-travel-status"
              >${status}</span
            >`
          : nothing}
      </summary>
      ${props.notice
        ? html`<div
            class="callout ${props.notice.kind === "error" ? "danger" : "success"}"
            role=${props.notice.kind === "error" ? "alert" : "status"}
          >
            ${props.notice.text}
          </div>`
        : nothing}
      ${props.error
        ? html`<div class="callout danger" role="alert">
            ${props.error}
            <button type="button" class="btn btn--sm" @click=${props.onRetry}>
              ${t("labTravel.retry")}
            </button>
          </div>`
        : nothing}
      ${overview
        ? renderSharing(props, overview)
        : props.loading
          ? html`<p class="muted">${t("labTravel.loading")}</p>`
          : nothing}
    </details>
  `;
}

function renderSharing(props: TravelNearbyProps, overview: TravelOverview) {
  const sharing = props.sharing ?? overview.sharing;
  const busy = props.busy !== null;
  return html`
    ${!sharing.enabled
      ? html`
          <p class="card-sub" data-testid="lab-travel-sharing-off">
            ${t("labTravel.nearby.offHint")}
          </p>
          <button
            type="button"
            class="btn primary"
            data-testid="lab-travel-enable-sharing"
            ?disabled=${busy}
            @click=${props.onEnableSharing}
          >
            ${t("labTravel.nearby.enable")}
          </button>
        `
      : html`
          <div class="lab-travel__sharing" data-testid="lab-travel-sharing-on">
            <p>
              <strong>${t("labTravel.nearby.on")}</strong>
              ${sharing.location
                ? t("labTravel.nearby.lastLocation", {
                    place: placeText(sharing.location),
                    when: relativeTime(sharing.location.reported_at),
                  })
                : t("labTravel.nearby.noFix")}
            </p>
            ${renderDevice(props)}
            <form
              class="lab-travel__city"
              data-testid="lab-travel-city"
              @submit=${(event: Event) => {
                event.preventDefault();
                props.onShareCity();
              }}
            >
              <label class="adminbot-form__field">
                <span>${t("labTravel.nearby.cityLabel")}</span>
                <input
                  type="text"
                  data-testid="lab-travel-city-input"
                  .value=${props.cityDraft}
                  @input=${(event: Event) =>
                    props.onCityDraftChange((event.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <button
                type="submit"
                class="btn btn--sm"
                ?disabled=${busy || !props.cityDraft.trim()}
              >
                ${t("labTravel.nearby.citySubmit")}
              </button>
            </form>
            <button
              type="button"
              class="btn btn--sm danger"
              data-testid="lab-travel-disable-sharing"
              ?disabled=${busy}
              @click=${props.onDisableSharing}
            >
              ${t("labTravel.nearby.disable")}
            </button>
          </div>
          <div class="lab-travel__groups">
            ${overview.matches.length
              ? overview.matches.map((group) => renderGroup(group, overview.sharing_members))
              : html`<p class="muted">${t("labTravel.nearby.groupsEmpty")}</p>`}
          </div>
          ${renderLookup(props)}
        `}
  `;
}
