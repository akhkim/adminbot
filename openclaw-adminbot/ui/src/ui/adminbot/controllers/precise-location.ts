// "Use my precise location": the one passive control that lets a member's own browser say which
// city they are in, and the silent refresh that keeps it current afterwards.
//
// The rules, each with a test in precise-location.test.ts:
//   - The browser's own permission prompt is raised automatically at most once per device, the
//     first time a signed-in member opens AdminBot there. After that it follows only the member
//     pressing the button: "granted" is read silently, "denied" is never asked again.
//   - The silent refresh is silent: no toast, no banner, no error. A failure is swallowed here and
//     logged server-side only, by the service (and there only without the position).
//   - At most one silent reading per device per hour, on a visit or when the tab comes back into
//     view. The service writes only when the city changed or once a day.
//   - A member who chose to be hidden on the map, or to be shown by the city they typed, is never
//     asked and never read.
//   - The position goes to the service in a POST body and nowhere else: never stored here, never
//     logged, never in a URL. What comes back, and what is kept, is a city.
import type { DeviceLocationResult } from "../api/profile.ts";
import { postDeviceLocation } from "../api/profile.ts";
import {
  type AuthResult,
  loadStoredMemberSession,
  type MemberMapVisibility,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";

/** City-level is the point: high accuracy costs battery and says more than a city. */
export const PRECISE_LOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 10_000,
  maximumAge: 10 * 60_000,
};

/** One silent reading per device per hour, however often the tab is opened. */
export const SILENT_REFRESH_EVERY_MS = 60 * 60_000;

/** Per-device throttle stamp. A time, never a position. */
export const SILENT_REFRESH_KEY = "adminbot.preciseLocation.lastRefreshAt";

/** When this device was asked automatically, so it is asked once and never again. A time only. */
export const AUTO_ASK_KEY = "adminbot.preciseLocation.autoAskedAt";

export type PreciseLocationPlace = { city: string; region?: string; country?: string };

export type PreciseLocationState = {
  /** The city the device last named, this session; falls back to the member record's. */
  place?: PreciseLocationPlace;
  /** The button's own reading is under way. */
  busy?: boolean;
  /**
   * Why the button's reading came back empty. Only ever set from a press -- a silent refresh never
   * touches it -- and shown as a short inline note beside the button, not a toast or banner.
   */
  note?: "denied" | "unavailable" | null;
};

export type PreciseLocationDeps = {
  geolocation?: Pick<Geolocation, "getCurrentPosition">;
  permissions?: { query(descriptor: { name: "geolocation" }): Promise<{ state: string }> };
  isSecureContext: boolean;
  report(fix: { lat: number; lon: number }): Promise<AuthResult<DeviceLocationResult>>;
  storage?: Pick<Storage, "getItem" | "setItem">;
  now?: () => number;
};

/** Whether this member may be asked or read at all. Only the default, automatic placement. */
export function preciseLocationAllowed(
  visibility: MemberMapVisibility | null | undefined,
): boolean {
  return visibility === undefined || visibility === "auto";
}

function readPosition(
  geolocation: Pick<Geolocation, "getCurrentPosition">,
): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      // Only the two numbers leave this callback: no accuracy, altitude, heading or timestamp.
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      (error) => reject(error),
      PRECISE_LOCATION_OPTIONS,
    );
  });
}

function placeOf(result: AuthResult<DeviceLocationResult>): PreciseLocationPlace | undefined {
  if (!result.ok || !result.value.city) {
    return undefined;
  }
  const { city, region, country } = result.value;
  return { city, ...(region ? { region } : {}), ...(country ? { country } : {}) };
}

/**
 * The button: the member asked, so this is the only path that may raise the browser's prompt.
 * Resolves with the city, or why there is none; never throws.
 */
export async function sharePreciseLocation(
  deps: PreciseLocationDeps,
): Promise<{ place: PreciseLocationPlace } | { note: "denied" | "unavailable" }> {
  if (!deps.isSecureContext || !deps.geolocation) {
    return { note: "unavailable" };
  }
  let fix: { lat: number; lon: number };
  try {
    fix = await readPosition(deps.geolocation);
  } catch (error) {
    const denied = (error as { code?: number } | null)?.code === 1;
    return { note: denied ? "denied" : "unavailable" };
  }
  try {
    const place = placeOf(await deps.report(fix));
    return place ? { place } : { note: "unavailable" };
  } catch {
    return { note: "unavailable" };
  }
}

/**
 * The automatic refresh. Where the permission is granted it reads silently, at most once an hour per
 * device. Where the browser has not been asked yet ("prompt", or no Permissions API to tell) it
 * raises the browser's prompt once per device, recorded under AUTO_ASK_KEY; a device that cannot
 * remember having asked (storage blocked) is not asked, so nobody is prompted on every visit.
 * Never for a hidden or stated member, never after "denied". Resolves with the city when one was
 * named, otherwise undefined; never throws and shows nothing of its own.
 */
export async function refreshPreciseLocationSilently(
  deps: PreciseLocationDeps,
  visibility: MemberMapVisibility | null | undefined,
): Promise<PreciseLocationPlace | undefined> {
  try {
    if (!preciseLocationAllowed(visibility)) {
      return undefined;
    }
    if (!deps.isSecureContext || !deps.geolocation) {
      return undefined;
    }
    const now = deps.now?.() ?? Date.now();
    let last = Number.NaN;
    try {
      last = Number(deps.storage?.getItem(SILENT_REFRESH_KEY) ?? Number.NaN);
    } catch {
      // Storage blocked: fall through and read anyway; the service still writes at most daily.
    }
    if (Number.isFinite(last) && now - last >= 0 && now - last < SILENT_REFRESH_EVERY_MS) {
      return undefined;
    }
    // No Permissions API (older Safari) means the answer is unknown until asked: treat it as "prompt".
    const permission = deps.permissions
      ? (await deps.permissions.query({ name: "geolocation" })).state
      : "prompt";
    if (permission === "denied") {
      return undefined;
    }
    if (permission !== "granted") {
      try {
        if (!deps.storage || deps.storage.getItem(AUTO_ASK_KEY) !== null) {
          return undefined;
        }
        deps.storage.setItem(AUTO_ASK_KEY, String(now));
      } catch {
        return undefined;
      }
    }
    try {
      deps.storage?.setItem(SILENT_REFRESH_KEY, String(now));
    } catch {
      // As above.
    }
    return placeOf(await deps.report(await readPosition(deps.geolocation)));
  } catch {
    return undefined;
  }
}

// --- the app's side ---------------------------------------------------------------------------

export type PreciseLocationHost = {
  memberId?: string | null;
  settings: Parameters<typeof resolveAdminBotBaseUrl>[0];
  adminBotData?: { members?: ReadonlyArray<{ id: string; map_visibility?: unknown }> } | null;
  adminBotPreciseLocation?: PreciseLocationState;
};

/** The member's own choice; null while their record has not loaded, which is never "auto". */
function ownVisibility(host: PreciseLocationHost): MemberMapVisibility | null {
  const member = host.adminBotData?.members?.find((entry) => entry.id === host.memberId);
  if (!member) {
    return null;
  }
  const value = member.map_visibility;
  return value === "stated" || value === "hidden" ? value : "auto";
}

function browserDeps(host: PreciseLocationHost, sessionToken: string): PreciseLocationDeps {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  let storage: PreciseLocationDeps["storage"];
  try {
    storage = typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    storage = undefined;
  }
  return {
    ...(nav?.geolocation ? { geolocation: nav.geolocation } : {}),
    ...(nav?.permissions
      ? {
          permissions: {
            query: (descriptor) =>
              nav.permissions
                .query(descriptor as PermissionDescriptor)
                .then((status) => ({ state: status.state })),
          },
        }
      : {}),
    isSecureContext: typeof window !== "undefined" ? window.isSecureContext !== false : false,
    report: (fix) => postDeviceLocation(fix, sessionToken, resolveAdminBotBaseUrl(host.settings)),
    ...(storage ? { storage } : {}),
  };
}

/** The button's handler. */
export async function useAdminBotPreciseLocation(
  host: PreciseLocationHost,
  requestUpdate: () => void,
  deps?: PreciseLocationDeps,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored || !preciseLocationAllowed(ownVisibility(host))) {
    return;
  }
  host.adminBotPreciseLocation = { ...host.adminBotPreciseLocation, busy: true, note: null };
  requestUpdate();
  const outcome = await sharePreciseLocation(deps ?? browserDeps(host, stored.sessionToken));
  if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
    return;
  }
  host.adminBotPreciseLocation =
    "place" in outcome
      ? { place: outcome.place, busy: false, note: null }
      : { ...host.adminBotPreciseLocation, busy: false, note: outcome.note };
  requestUpdate();
}

let refreshing: { token: string; detach: () => void } | null = null;

/**
 * Starts the silent refresh for this session: once now, and again whenever the tab comes back into
 * view (each throttled to one reading an hour). Idempotent per session; a new session replaces it.
 */
export function startAdminBotPreciseLocationRefresh(
  host: PreciseLocationHost,
  requestUpdate: () => void,
): void {
  const stored = loadStoredMemberSession();
  if (!stored || refreshing?.token === stored.sessionToken) {
    return;
  }
  refreshing?.detach();
  const token = stored.sessionToken;
  const run = () => {
    if (loadStoredMemberSession()?.sessionToken !== token) {
      return;
    }
    void refreshPreciseLocationSilently(browserDeps(host, token), ownVisibility(host)).then(
      (place) => {
        if (place && loadStoredMemberSession()?.sessionToken === token) {
          host.adminBotPreciseLocation = { ...host.adminBotPreciseLocation, place };
          requestUpdate();
        }
      },
    );
  };
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      run();
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }
  refreshing = {
    token,
    detach: () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    },
  };
  run();
}

/** Sign-out: stop listening. Safe when nothing is running. */
export function stopAdminBotPreciseLocationRefresh(): void {
  refreshing?.detach();
  refreshing = null;
}
