// The passive "Use my precise location" line, shown in two places only: under the map-visibility
// row of My Profile, and as the viewer's own line on the dashboard map card. Never a banner, never
// a toast, never shown unprompted to a member who chose "stated" or "hidden".
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import type { LabMember } from "../auth/session.ts";
import type {
  PreciseLocationPlace,
  PreciseLocationState,
} from "../controllers/precise-location.ts";
import {
  preciseLocationAllowed,
  useAdminBotPreciseLocation,
} from "../controllers/precise-location.ts";
import { findOwnMember } from "./profile-fields.ts";

/** Same window the server uses before a device city stops counting (member-map.ts). */
export const DEVICE_CITY_FRESH_MS = 7 * 24 * 60 * 60_000;

export type PreciseLocationViewProps = {
  member: LabMember | null;
  state: PreciseLocationState | undefined;
  now: number;
  onUse: () => void;
};

/** This session's reading first, else the member record's while it is under a week old. */
export function currentDeviceCity(
  member: LabMember | null,
  state: PreciseLocationState | undefined,
  now: number,
): PreciseLocationPlace | undefined {
  if (state?.place?.city) {
    return state.place;
  }
  const city = typeof member?.device_city === "string" ? member.device_city.trim() : "";
  const at =
    typeof member?.device_located_at === "string" ? Date.parse(member.device_located_at) : NaN;
  if (!city || !Number.isFinite(at) || now - at > DEVICE_CITY_FRESH_MS) {
    return undefined;
  }
  return { city };
}

export function renderPreciseLocation(props: PreciseLocationViewProps) {
  const { member, state } = props;
  if (!member || !preciseLocationAllowed(member.map_visibility)) {
    return nothing;
  }
  const place = currentDeviceCity(member, state, props.now);
  if (place) {
    return html`<span class="precise-location" data-testid="precise-location">
      <span data-testid="precise-location-city">📍 ${place.city}</span> ·
      <button
        type="button"
        class="precise-location__change"
        ?disabled=${state?.busy ?? false}
        @click=${props.onUse}
        data-testid="precise-location-change"
      >
        ${t("preciseLocation.change")}
      </button>
    </span>`;
  }
  return html`<span class="precise-location" data-testid="precise-location">
    <button
      type="button"
      class="btn btn--sm"
      ?disabled=${state?.busy ?? false}
      @click=${props.onUse}
      data-testid="precise-location-use"
    >
      ${state?.busy ? t("preciseLocation.busy") : t("preciseLocation.use")}
    </button>
    <details class="precise-location__why">
      <summary>${t("preciseLocation.why")}</summary>
      <span class="profile__field-hint">${t("preciseLocation.whyBody")}</span>
    </details>
    ${state?.note
      ? html`<span class="profile__field-hint" data-testid="precise-location-note"
          >${t(`preciseLocation.note.${state.note}`)}</span
        >`
      : nothing}
  </span>`;
}

/**
 * The line as both hosts show it, My Profile and the dashboard map card, so the two always name the
 * same city and share one button state. `adminBotPreciseLocation` is reactive state on the app, so
 * the controller's writes re-render without an explicit update; `requestUpdate` is for other hosts.
 */
export function renderOwnPreciseLocation(state: AppViewState, requestUpdate?: () => void) {
  return renderPreciseLocation({
    member: findOwnMember(state),
    state: state.adminBotPreciseLocation,
    now: Date.now(),
    onUse: () => {
      void useAdminBotPreciseLocation(state, () => requestUpdate?.());
    },
  });
}
