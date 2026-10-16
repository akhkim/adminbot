// "Use my precise location": the one passive control that lets a member's own browser say which
// city they are in, and the silent refresh that keeps it current afterwards.
//
// The rules, each with a test in precise-location.test.ts:
//   - The browser's own permission prompt is raised automatically on sign-in (each app load with a
//     session), on each arrival at the dashboard and each return to the tab, whenever location is
//     not currently granted.
//     "granted" is read silently instead; "denied" (blocked for the site) is never asked -- the
//     browser would refuse anyway, and Chrome also mutes a prompt dismissed repeatedly.
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
 * device. Where it is not ("prompt", or no Permissions API to tell) and `ask` is set -- sign-in and
 * arriving at the dashboard -- it raises the browser's prompt; without `ask` (the tab coming back
 * into view) it leaves it alone. Never for a hidden or stated member, never on "denied". Resolves
 * with the city when one was named, otherwise undefined; never throws and shows nothing of its own.
 */
export async function refreshPreciseLocationSilently(
  deps: PreciseLocationDeps,
  visibility: MemberMapVisibility | null | undefined,
  options: { ask?: boolean } = {},
): Promise<PreciseLocationPlace | undefined> {
  try {
    if (!preciseLocationAllowed(visibility)) {
      return undefined;
    }
    if (!deps.isSecureContext || !deps.geolocation) {
      return undefined;
    }
    const now = deps.now?.() ?? Date.now();
    // No Permissions API (older Safari) means the answer is unknown until asked: treat it as "prompt".
    const permission = deps.permissions
      ? (await deps.permissions.query({ name: "geolocation" })).state
      : "prompt";
    if (permission === "denied") {
      return undefined;
    }
    if (permission !== "granted") {
      if (!options.ask) {
        return undefined;
      }
      // Asking is not throttled: the member is shown the prompt each time they sign in or open the
      // dashboard until they answer it. Only an actual reading stamps the hourly throttle below.
      return placeOf(await deps.report(await readPosition(deps.geolocation)));
    }
    let last = Number.NaN;
    try {
      last = Number(deps.storage?.getItem(SILENT_REFRESH_KEY) ?? Number.NaN);
    } catch {
      // Storage blocked: fall through and read anyway; the service still writes at most daily.
    }
    if (Number.isFinite(last) && now - last >= 0 && now - last < SILENT_REFRESH_EVERY_MS) {
      return undefined;
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

let refreshing: { token: string; ask: () => void; detach: () => void } | null = null;
/** One reading at a time, so a sign-in and a dashboard arrival never stack two prompts. */
let reading = false;

/**
 * Starts the refresh for this session: once now (sign-in), and again whenever the tab comes back into
 * view. Each pass asks the browser for location if it is not granted, and reads silently (at most
 * hourly) if it is. Idempotent per session; a new session replaces it.
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
  const run = (ask: boolean) => {
    if (loadStoredMemberSession()?.sessionToken !== token || reading) {
      return;
    }
    reading = true;
    void refreshPreciseLocationSilently(browserDeps(host, token), ownVisibility(host), {
      ask,
    }).then((place) => {
      if (place && loadStoredMemberSession()?.sessionToken === token) {
        host.adminBotPreciseLocation = { ...host.adminBotPreciseLocation, place };
        requestUpdate();
      }
      reading = false;
    });
  };
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      run(true);
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }
  refreshing = {
    token,
    ask: () => run(true),
    detach: () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    },
  };
  // Sign-in, or opening AdminBot with a session: ask if location is not granted.
  run(true);
}

let lastTab: string | undefined;

/**
 * Called on every render with the current tab: arriving at the dashboard (from another tab, or on
 * load) asks again if location is not granted. Staying on the dashboard does not re-ask.
 */
export function noteAdminBotTabForPreciseLocation(tab: string): void {
  const arrived = tab === "dashboard" && lastTab !== "dashboard";
  const firstRender = lastTab === undefined;
  lastTab = tab;
  // The first render is the sign-in itself, which startAdminBotPreciseLocationRefresh already asks.
  if (arrived && !firstRender) {
    refreshing?.ask();
  }
}

/** Sign-out: stop listening. Safe when nothing is running. */
export function stopAdminBotPreciseLocationRefresh(): void {
  refreshing?.detach();
  refreshing = null;
}
