// The location banners' side of the wire: the "have you moved?" drift question on the profile,
// and the "Are you in Toronto?" check-in that can appear on any page after sign-in.
//
// Answers go through the service, which writes the profile through the ordinary self-edit path, so
// the roster reloads afterwards rather than being patched locally.
import { t } from "../../../i18n/index.ts";
import {
  answerLocationPrompt,
  fetchLocationDrifts,
  fetchLocationPlaces,
  fetchLocationPrompt,
  respondToLocationCheckin,
  type LocationCheckinResponse,
} from "../api/profile.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  bannerFor,
  checkinShownThisSession,
  markCheckinShown,
  nearestPlace,
  type CheckinBanner,
  type CheckinBusy,
} from "../data/location-checkin.ts";
import { loadAdminBot, type AdminBotHost } from "./admin.ts";

let promptInFlight: { token: string; request: ReturnType<typeof fetchLocationPrompt> } | null =
  null;
let driftsInFlight: { token: string; request: ReturnType<typeof fetchLocationDrifts> } | null =
  null;

function sameSession(token: string): boolean {
  return loadStoredMemberSession()?.sessionToken === token;
}

/** Defer the courtesy prompt while blocked and discard any earlier gate-rejected read. */
export function prepareProfileLocationPrompt(
  host: Pick<AdminBotHost, "adminBotLocationDrift">,
  profileBlocked: boolean,
): boolean {
  if (profileBlocked) {
    host.adminBotLocationDrift = undefined;
    return false;
  }
  return host.adminBotLocationDrift === undefined;
}

export async function loadAdminBotLocationPrompt(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  // The render pass asks while the answer is undefined, so every render before it lands would start
  // another identical request. Tracked by token, not on the host, so a member who signs in while
  // the previous one's request is in flight still gets asked.
  //
  // A repeat ask waits on the request in flight rather than returning at once. The render pass
  // re-renders when its ask settles, so an ask that settled immediately would re-render, ask again
  // and settle again -- a microtask loop that starves the very response it is waiting for.
  if (promptInFlight?.token !== stored.sessionToken) {
    const request = fetchLocationPrompt(stored.sessionToken, baseUrl).finally(() => {
      if (promptInFlight?.request === request) promptInFlight = null;
    });
    promptInFlight = { token: stored.sessionToken, request };
  }
  const result = await promptInFlight.request;
  if (!sameSession(stored.sessionToken)) {
    return;
  }
  // Deliberately silent on failure. This banner is an unprompted courtesy; an error notice for a
  // question the member never asked would be worse than not asking it.
  host.adminBotLocationDrift = result.ok ? result.value.drift : null;
  // The check-in is decided once per load of the app: a later read (the profile tab asking for the
  // drift again) must not bring back a banner the member already dismissed.
  if (host.adminBotLocationCheckin === undefined) {
    const memberId = host.memberId ?? "";
    const banner = bannerFor(
      result.ok ? result.value.checkin : null,
      checkinShownThisSession(memberId),
    );
    if (banner) {
      markCheckinShown(memberId);
    }
    host.adminBotLocationCheckin = banner;
  }
}

/** Whether the app-wide check-in still needs its first read. */
export function needsLocationCheckinLoad(
  host: Pick<AdminBotHost, "adminBotLocationCheckin">,
  profileBlocked: boolean,
): boolean {
  return !profileBlocked && host.adminBotLocationCheckin === undefined;
}

function setBanner(host: AdminBotHost, patch: Partial<CheckinBanner>): void {
  if (host.adminBotLocationCheckin) {
    host.adminBotLocationCheckin = { ...host.adminBotLocationCheckin, ...patch };
  }
}

/**
 * Send one response. The banner closes on success whatever the answer was -- it is asked at most
 * once per session -- and an answer reloads the roster, since it changed the member's city.
 */
async function respond(
  host: AdminBotHost,
  response: LocationCheckinResponse,
  busy: CheckinBusy,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored || !host.adminBotLocationCheckin || host.adminBotLocationCheckin.busy) {
    return;
  }
  setBanner(host, { busy, error: undefined });
  const result = await respondToLocationCheckin(
    response,
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (!sameSession(stored.sessionToken)) {
    return;
  }
  if (!result.ok) {
    setBanner(host, { busy: undefined, error: result.message ?? t("locationCheckin.error") });
    return;
  }
  host.adminBotLocationCheckin = null;
  if (response.action !== "snooze") {
    await loadAdminBot(host, "general");
  }
}

/** "Yes" on "Are you in Toronto?", or Save in the picker. */
export function answerLocationCheckin(
  host: AdminBotHost,
  city: string,
  via: "picker" | "text" | "device",
): Promise<void> {
  const trimmed = city.trim();
  if (!trimmed) {
    setBanner(host, { error: t("locationCheckin.errorEmpty") });
    return Promise.resolve();
  }
  return respond(host, { action: "answer", city: trimmed, via }, "answer");
}

/** The close button and "Ask me later": both put the question off for a week. */
export function snoozeLocationCheckin(host: AdminBotHost): Promise<void> {
  return respond(host, { action: "snooze" }, "snooze");
}

/** "Prefer not to say": logged, and the member is taken off the map. */
export function declineLocationCheckin(host: AdminBotHost): Promise<void> {
  return respond(host, { action: "decline" }, "decline");
}

async function ensurePlaces(host: AdminBotHost): Promise<CheckinBanner["places"]> {
  const existing = host.adminBotLocationCheckin?.places;
  if (existing) {
    return existing;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    return undefined;
  }
  const result = await fetchLocationPlaces(
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (!result.ok || !sameSession(stored.sessionToken)) {
    // The picker still takes free text without the list.
    return undefined;
  }
  setBanner(host, { places: result.value });
  return result.value;
}

/** "No, change": open the picker, and fetch its city list the first time. */
export async function openLocationCheckinPicker(host: AdminBotHost): Promise<void> {
  setBanner(host, { mode: "pick", error: undefined });
  await ensurePlaces(host);
}

type DeviceGeolocation = Pick<Geolocation, "getCurrentPosition">;

function browserGeolocation(): DeviceGeolocation | undefined {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return undefined;
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return undefined;
  }
  return navigator.geolocation;
}

/**
 * "Use this device's location". Only ever called from that button's click, so the browser's
 * permission prompt is always one the member asked for. The position is matched to the nearest
 * listed city here, in the browser; only that city's name is sent, and no coordinate is kept.
 */
export async function useDeviceForLocationCheckin(
  host: AdminBotHost,
  geolocation: DeviceGeolocation | undefined = browserGeolocation(),
): Promise<void> {
  if (!host.adminBotLocationCheckin || host.adminBotLocationCheckin.busy) {
    return;
  }
  if (!geolocation) {
    setBanner(host, { error: t("locationCheckin.deviceUnsupported") });
    return;
  }
  setBanner(host, { busy: "device", error: undefined });
  const placesRequest = ensurePlaces(host);
  const point = await new Promise<{ lat: number; lon: number } | "denied" | "failed">((resolve) => {
    geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      (error) => resolve(error.code === 1 ? "denied" : "failed"),
      { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 15_000 },
    );
  });
  const places = await placesRequest;
  if (typeof point === "string") {
    setBanner(host, {
      busy: undefined,
      error: t(
        point === "denied" ? "locationCheckin.deviceDenied" : "locationCheckin.deviceFailed",
      ),
    });
    return;
  }
  const city = places ? nearestPlace(places, point) : undefined;
  if (!city) {
    setBanner(host, { busy: undefined, error: t("locationCheckin.deviceNoCity") });
    return;
  }
  setBanner(host, { busy: undefined });
  await answerLocationCheckin(host, city.label, "device");
}

export async function answerAdminBotLocationPrompt(
  host: AdminBotHost,
  answer: { current_city?: string; timezone?: string },
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  host.adminBotLocationSaving = true;
  host.adminBotLocationError = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  try {
    const result = await answerLocationPrompt(answer, stored.sessionToken, baseUrl);
    if (!sameSession(stored.sessionToken)) {
      return;
    }
    if (!result.ok) {
      host.adminBotLocationError = result.message ?? "Could not save that. Try again.";
      return;
    }
    // Cleared locally as well as on the server: the banner has been answered, and leaving it on
    // screen until the next reload would invite a second answer.
    host.adminBotLocationDrift = null;
    if (answer.current_city) {
      await loadAdminBot(host, "general");
    }
  } finally {
    if (sameSession(stored.sessionToken)) {
      host.adminBotLocationSaving = false;
    }
  }
}

/**
 * Load the drift list the calendar flags attendees with.
 *
 * Silent on failure for the same reason the banner is: this decorates a screen that works without
 * it, and a member who is not an admin gets a 403 here as a matter of course.
 */
export async function loadAdminBotLocationDrifts(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  // Same render-pass guard as the prompt above, waiting on the request in flight for the same reason.
  if (driftsInFlight?.token !== stored.sessionToken) {
    const request = fetchLocationDrifts(
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    ).finally(() => {
      if (driftsInFlight?.request === request) driftsInFlight = null;
    });
    driftsInFlight = { token: stored.sessionToken, request };
  }
  const result = await driftsInFlight.request;
  if (!sameSession(stored.sessionToken)) {
    return;
  }
  host.adminBotLocationDrifts = result.ok ? result.value : [];
}
