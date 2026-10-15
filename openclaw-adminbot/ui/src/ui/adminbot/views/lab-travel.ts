// The Travel tab: upcoming conferences to RSVP for (one per site), the member's other trips, and
// opt-in location sharing to find lab members in the same city.
//
// A renderer over props, like Time Availability: app-render wires the controller
// (controllers/lab-travel.ts) in, and the tests draw it with plain objects. The three sections are
// independent cards so one being empty never hides the others.
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { t } from "../../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import {
  rsvpDraftError,
  rsvpDraftFrom,
  type LabTravelNotice,
  type LookupDraft,
  type RsvpDraft,
} from "../controllers/lab-travel.ts";
import type { LocationTrackerSnapshot } from "../controllers/location-tracker.ts";
import { tripRows, type TripRow } from "../data/availability.ts";
import type {
  TravelConference,
  TravelFunding,
  TravelLookup,
  TravelOverview,
  TravelSharing,
} from "../data/lab-travel.ts";
import { renderDateControl } from "../date-control.ts";
import { renderTravelNearby } from "./lab-travel.nearby.ts";
import { renderTravelPlans, type TripDraft } from "./lab-travel.plans.ts";
import { formatRange } from "./time-availability.trips.ts";

export type LabTravelProps = {
  overview: TravelOverview | null;
  loading: boolean;
  error: string | null;
  notice: LabTravelNotice | null;
  /** Which action is in flight; see LabTravelHost.labTravelBusy. */
  busy: string | null;
  onRetry: () => void;
  // Conferences.
  rsvpOpen: string | null;
  rsvpDrafts: Record<string, RsvpDraft>;
  onOpenRsvp: (key: string | null) => void;
  onEditRsvp: (site: TravelConference, patch: Partial<RsvpDraft>) => void;
  onSaveRsvp: (site: TravelConference) => void;
  onWithdrawRsvp: (site: TravelConference) => void;
  // Other travel plans.
  planDraft: TripDraft;
  onPlanDraftChange: (draft: TripDraft) => void;
  onSavePlans: (trips: TripRow[]) => void;
  // Location sharing.
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

const FUNDING_LABEL_KEYS: Record<TravelFunding, string> = {
  none: "labTravel.rsvp.fundingNone",
  fee_only: "labTravel.rsvp.fundingFee",
  flight_only: "labTravel.rsvp.fundingFlight",
  full_travel: "labTravel.rsvp.fundingFull",
};

function statusPill(site: TravelConference) {
  const mine = site.my_rsvp;
  if (!mine) {
    return nothing;
  }
  const text =
    mine.intent === "undecided"
      ? t("labTravel.conferences.statusMaybe")
      : mine.needs_lodging
        ? t("labTravel.conferences.statusAirbnb")
        : t("labTravel.conferences.statusGoing");
  return html`<span
    class="pill lab-travel__status ${mine.intent === "going" ? "lab-travel__status--going" : ""}"
    data-testid=${`lab-travel-status-${site.key}`}
    >${text}</span
  >`;
}

function renderGoing(site: TravelConference, viewerId: string | null) {
  const extras = [
    site.undecided_count
      ? t("labTravel.conferences.undecided", { count: String(site.undecided_count) })
      : "",
    site.airbnb_count
      ? t("labTravel.conferences.airbnbCount", { count: String(site.airbnb_count) })
      : "",
  ].filter(Boolean);
  return html`
    <div class="lab-travel__going" data-testid=${`lab-travel-going-${site.key}`}>
      ${site.going.length
        ? html`<span class="muted">${t("labTravel.conferences.going")}</span>
            <ul class="lab-travel__people">
              ${site.going.map(
                (person) => html`<li class="lab-travel__person">
                  ${person.name}${person.member_id === viewerId
                    ? html` <span class="muted">(${t("labTravel.conferences.you")})</span>`
                    : nothing}
                  ${person.airbnb
                    ? html`<span class="lab-travel__tag"
                        >${t("labTravel.conferences.airbnbTag")}</span
                      >`
                    : nothing}
                </li>`,
              )}
            </ul>`
        : html`<span class="muted">${t("labTravel.conferences.nobody")}</span>`}
      ${extras.length ? html`<span class="muted">· ${extras.join(" · ")}</span>` : nothing}
    </div>
  `;
}

function renderRsvpForm(props: LabTravelProps, site: TravelConference) {
  const draft = props.rsvpDrafts[site.key] ?? rsvpDraftFrom(site);
  const error = rsvpDraftError(draft);
  const saving = props.busy === `rsvp:${site.key}`;
  const edit = (patch: Partial<RsvpDraft>) => props.onEditRsvp(site, patch);
  const going = draft.intent === "going";
  const answered = Boolean(site.my_rsvp || site.unsited_rsvp);
  return html`
    <div class="lab-travel__rsvp" data-testid=${`lab-travel-rsvp-${site.key}`}>
      <div class="lab-travel__intent" role="group" aria-label=${t("labTravel.rsvp.question")}>
        <span>${t("labTravel.rsvp.question")}</span>
        ${(["going", "undecided"] as const).map(
          (intent) => html`<button
            type="button"
            class="btn btn--sm ${draft.intent === intent ? "primary" : ""}"
            aria-pressed=${draft.intent === intent ? "true" : "false"}
            data-testid=${`lab-travel-intent-${intent}-${site.key}`}
            @click=${() => edit({ intent })}
          >
            ${intent === "going" ? t("labTravel.rsvp.going") : t("labTravel.rsvp.maybe")}
          </button>`,
        )}
      </div>
      ${going
        ? html`
            <label class="lab-travel__check">
              <input
                type="checkbox"
                data-testid=${`lab-travel-airbnb-${site.key}`}
                .checked=${draft.airbnb}
                @change=${(event: Event) =>
                  edit({ airbnb: (event.currentTarget as HTMLInputElement).checked })}
              />
              <span
                >${t("labTravel.rsvp.airbnb")}
                <small class="muted">${t("labTravel.rsvp.airbnbHint")}</small></span
              >
            </label>
            ${draft.airbnb
              ? html`<div class="lab-travel__nights">
                  <label class="adminbot-form__field">
                    <span>${t("labTravel.rsvp.arriving")}</span>
                    ${renderDateControl(
                      html`<input
                        type="date"
                        data-testid=${`lab-travel-arrival-${site.key}`}
                        .value=${live(draft.arrival_on)}
                        @input=${(event: Event) =>
                          edit({ arrival_on: (event.currentTarget as HTMLInputElement).value })}
                      />`,
                      draft.arrival_on,
                    )}
                  </label>
                  <label class="adminbot-form__field">
                    <span>${t("labTravel.rsvp.leaving")}</span>
                    ${renderDateControl(
                      html`<input
                        type="date"
                        data-testid=${`lab-travel-departure-${site.key}`}
                        .value=${live(draft.departure_on)}
                        @input=${(event: Event) =>
                          edit({ departure_on: (event.currentTarget as HTMLInputElement).value })}
                      />`,
                      draft.departure_on,
                    )}
                  </label>
                </div>`
              : nothing}
            <label class="adminbot-form__field">
              <span>${t("labTravel.rsvp.funding")}</span>
              <select
                data-testid=${`lab-travel-funding-${site.key}`}
                @change=${(event: Event) =>
                  edit({
                    funding: (event.currentTarget as HTMLSelectElement).value as TravelFunding,
                  })}
              >
                ${(Object.keys(FUNDING_LABEL_KEYS) as TravelFunding[]).map(
                  (value) => html`<option value=${value} ?selected=${value === draft.funding}>
                    ${t(FUNDING_LABEL_KEYS[value])}
                  </option>`,
                )}
              </select>
            </label>
            <label class="lab-travel__check">
              <input
                type="checkbox"
                data-testid=${`lab-travel-visa-${site.key}`}
                .checked=${draft.needs_visa_letter}
                @change=${(event: Event) =>
                  edit({ needs_visa_letter: (event.currentTarget as HTMLInputElement).checked })}
              />
              <span
                >${t("labTravel.rsvp.visa")}
                <small class="muted">${t("labTravel.rsvp.visaHint")}</small></span
              >
            </label>
            <label class="adminbot-form__field">
              <span>${t("labTravel.rsvp.notes")}</span>
              <textarea
                rows="2"
                data-testid=${`lab-travel-notes-${site.key}`}
                placeholder=${t("labTravel.rsvp.notesPlaceholder")}
                .value=${draft.notes}
                @input=${(event: Event) =>
                  edit({ notes: (event.currentTarget as HTMLTextAreaElement).value })}
              ></textarea>
            </label>
            <p class="muted lab-travel__private">${t("labTravel.rsvp.private")}</p>
          `
        : nothing}
      <div class="lab-travel__form-actions">
        ${error && draft.intent
          ? html`<span class="lab-travel__form-error" role="alert">${error}</span>`
          : nothing}
        ${answered
          ? html`<button
              type="button"
              class="btn btn--sm"
              data-testid=${`lab-travel-withdraw-${site.key}`}
              ?disabled=${saving}
              @click=${() => props.onWithdrawRsvp(site)}
            >
              ${t("labTravel.rsvp.withdraw")}
            </button>`
          : nothing}
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${saving}
          @click=${() => props.onOpenRsvp(null)}
        >
          ${t("common.cancel")}
        </button>
        <button
          type="button"
          class="btn btn--sm primary"
          data-testid=${`lab-travel-save-${site.key}`}
          ?disabled=${saving || error !== null}
          @click=${() => props.onSaveRsvp(site)}
        >
          ${saving ? t("labTravel.rsvp.saving") : t("labTravel.rsvp.save")}
        </button>
      </div>
    </div>
  `;
}

function renderConference(props: LabTravelProps, site: TravelConference, viewerId: string | null) {
  const open = props.rsvpOpen === site.key;
  const dates =
    site.starts && site.ends
      ? formatRange({ start: site.starts, end: site.ends })
      : t("labTravel.conferences.datesTba");
  return html`
    <li class="lab-travel__conference" data-testid=${`lab-travel-conference-${site.key}`}>
      <div class="lab-travel__conference-head">
        <div>
          <div class="lab-travel__conference-title">${site.label}</div>
          <div class="muted">
            ${dates} · ${site.location ?? t("labTravel.conferences.locationTba")}
          </div>
        </div>
        ${statusPill(site)}
      </div>
      ${renderGoing(site, viewerId)}
      ${site.unsited_rsvp && !site.my_rsvp
        ? html`<p class="callout info lab-travel__unsited">
            ${t("labTravel.conferences.unsited", { conference: site.conference_label })}
          </p>`
        : nothing}
      ${open
        ? renderRsvpForm(props, site)
        : html`<div class="lab-travel__conference-actions">
            <button
              type="button"
              class="btn btn--sm ${site.my_rsvp ? "" : "primary"}"
              data-testid=${`lab-travel-open-rsvp-${site.key}`}
              @click=${() => props.onOpenRsvp(site.key)}
            >
              ${site.my_rsvp
                ? t("labTravel.conferences.changeRsvp")
                : t("labTravel.conferences.rsvp")}
            </button>
            ${site.homepage_url
              ? html`<a
                  class="btn btn--sm"
                  href=${site.homepage_url}
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                  >${t("labTravel.conferences.website")}</a
                >`
              : nothing}
          </div>`}
    </li>
  `;
}

function renderConferences(
  props: LabTravelProps,
  overview: TravelOverview,
  viewerId: string | null,
) {
  return html`
    <section
      class="card adminbot-card adminbot-card--wide lab-travel__card"
      data-testid="lab-travel-conferences"
    >
      <div class="card-title">${t("labTravel.conferences.title")}</div>
      <p class="card-sub">${t("labTravel.conferences.hint")}</p>
      ${overview.conferences.length
        ? html`<ul class="lab-travel__conferences">
            ${overview.conferences.map((site) => renderConference(props, site, viewerId))}
          </ul>`
        : html`<p class="muted">${t("labTravel.conferences.empty")}</p>`}
    </section>
  `;
}

export function renderLabTravel(props: LabTravelProps, viewerId: string | null = null) {
  const overview = props.overview;
  return html`
    <div class="lab-travel" data-testid="lab-travel">
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
      ${!overview
        ? props.loading
          ? html`<div class="muted">${t("labTravel.loading")}</div>`
          : nothing
        : html`
            ${renderConferences(props, overview, viewerId)}
            ${renderTravelPlans({
              trips: tripRows(overview.plans),
              homeLocation: overview.home ?? null,
              draft: props.planDraft,
              onDraftChange: props.onPlanDraftChange,
              saving: props.busy === "plans",
              onSave: props.onSavePlans,
              today: overview.today,
            })}
            ${renderTravelNearby(props, overview)}
          `}
    </div>
  `;
}
