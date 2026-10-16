// The check-in banner's state, kept pure so the rules are testable without a browser.
//
// The service decides *whether* a member is due (extensions/adminbot/src/workflows/members/
// location-checkin.ts). This side decides only how little to show: at most once per browser
// session, a one-tap "Yes" when there is a guess, and the picker only after "No, change".
import type { LocationCheckin, LocationPlace } from "../api/profile.ts";

export type CheckinBusy = "answer" | "snooze" | "decline" | "device" | "places";

export type CheckinBanner = {
  checkin: LocationCheckin;
  /** "confirm": "Are you in Toronto?" with Yes. "pick": the picker, after "No, change" or with no guess. */
  mode: "confirm" | "pick";
  busy?: CheckinBusy;
  error?: string;
  /** Loaded when the picker first opens; the datalist and the device snap both read it. */
  places?: LocationPlace[];
};

/** The banner for a freshly loaded check-in, or null when there is nothing to show. */
export function bannerFor(
  checkin: LocationCheckin | null,
  shownThisSession: boolean,
): CheckinBanner | null {
  if (!checkin?.due || shownThisSession) {
    return null;
  }
  return { checkin, mode: checkin.suggestion ? "confirm" : "pick" };
}

// --- once per session ---------------------------------------------------------------------------

type SessionStore = Pick<Storage, "getItem" | "setItem">;

const SHOWN_KEY = "adminbot.locationCheckin.shown";

function sessionStore(): SessionStore | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    // A sandboxed frame or blocked site data throws on access. Without storage the banner can
    // only show once per page load, which still never repeats within one visit.
    return undefined;
  }
}

export function checkinShownThisSession(
  memberId: string,
  store: SessionStore | undefined = sessionStore(),
): boolean {
  try {
    return store?.getItem(`${SHOWN_KEY}:${memberId}`) === "1";
  } catch {
    return false;
  }
}

export function markCheckinShown(
  memberId: string,
  store: SessionStore | undefined = sessionStore(),
): void {
  try {
    store?.setItem(`${SHOWN_KEY}:${memberId}`, "1");
  } catch {
    // Same as above: without storage, the in-memory banner state still keeps it to one showing.
  }
}

// --- "Use this device's location" ----------------------------------------------------------------

/** Farther than this from every listed city, the device position names no city: type it instead. */
export const DEVICE_SNAP_MAX_KM = 150;

const EARTH_KM = 6371;

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The listed city nearest a device position, within DEVICE_SNAP_MAX_KM. Runs in the browser so
 * the position itself never leaves it: only the city's name is sent, as the member's answer.
 */
export function nearestPlace(
  places: readonly LocationPlace[],
  point: { lat: number; lon: number },
  maxKm: number = DEVICE_SNAP_MAX_KM,
): LocationPlace | undefined {
  let best: { place: LocationPlace; km: number } | undefined;
  for (const place of places) {
    const km = distanceKm(point, place);
    if (km <= maxKm && (!best || km < best.km)) {
      best = { place, km };
    }
  }
  return best?.place;
}
