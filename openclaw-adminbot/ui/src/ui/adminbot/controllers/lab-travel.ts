// The /travel reads and writes behind Events' nearby card, and the one location tracker per page.
//
// The view decides what to show and this decides what to fetch, as with the other AdminBot
// controllers. Every write re-reads the overview afterwards rather than patching it: a sharing
// change moves the viewer's place and the match groups at once, and a hand-patched snapshot is how
// the two come to disagree.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  fetchTravelOverview,
  fetchTravelSharing,
  lookupTravellers,
  reportTravelLocation,
  setTravelSharing,
  type TravelLookup,
  type TravelOverview,
  type TravelSharing,
} from "../data/lab-travel.ts";
import { LocationTracker, type LocationTrackerSnapshot } from "./location-tracker.ts";

export type LookupDraft = { place: string; from: string; to: string };

export type LabTravelNotice = { kind: "success" | "error"; text: string };

export type LabTravelHost = {
  settings: UiSettings;
  memberId?: string | null;
  memberPrivilegeLevel?: string | null;
  labTravel?: TravelOverview;
  /** The session token the overview was read with, so a different member never sees it. */
  labTravelLoadedFor?: string | null;
  labTravelLoading?: boolean;
  labTravelError?: string | null;
  labTravelNotice?: LabTravelNotice | null;
  /** Which action is in flight: "sharing", "city" or "lookup". */
  labTravelBusy?: string | null;
  labTravelLookupDraft?: LookupDraft;
  labTravelLookup?: TravelLookup | null;
  labTravelLookupError?: string | null;
  labTravelCityDraft?: string;
  /** The account's opt-in, known before the tab is ever opened so tracking can resume on load. */
  labTravelSharing?: TravelSharing | null;
  labTravelSharingCheckedFor?: string | null;
  /** This browser's side of sharing: permission, last fix sent. */
  labTravelDevice?: LocationTrackerSnapshot;
};

/** Whether this viewer may read /travel at all. The service checks the same thing. */
export function isTravelViewer(privilegeLevel: string | null | undefined): boolean {
  return privilegeLevel === "member" || privilegeLevel === "admin";
}

function baseUrlOf(host: LabTravelHost): string {
  return resolveAdminBotBaseUrl(host.settings);
}

function sessionToken(): string | null {
  return loadStoredMemberSession()?.sessionToken ?? null;
}

export async function loadLabTravel(host: LabTravelHost): Promise<void> {
  const token = sessionToken();
  if (!token) {
    return;
  }
  host.labTravelLoading = true;
  try {
    const result = await fetchTravelOverview(baseUrlOf(host));
    if (sessionToken() !== token) {
      return; // signed out or switched member while this was in flight
    }
    if (!result.ok) {
      host.labTravelError = result.error;
      return;
    }
    host.labTravel = result.value;
    host.labTravelLoadedFor = token;
    host.labTravelError = null;
    host.labTravelSharing = result.value.sharing;
    host.labTravelSharingCheckedFor = token;
  } finally {
    host.labTravelLoading = false;
  }
}

/** Whether the tab has to read before it can draw. */
export function needsLabTravelLoad(host: LabTravelHost): boolean {
  const token = sessionToken();
  return Boolean(
    token &&
    isTravelViewer(host.memberPrivilegeLevel) &&
    !host.labTravelLoading &&
    !host.labTravelError &&
    (!host.labTravel || host.labTravelLoadedFor !== token),
  );
}

async function act(
  host: LabTravelHost,
  busy: string,
  run: (baseUrl: string) => Promise<{ ok: true } | { ok: false; error: string }>,
  done?: string,
): Promise<boolean> {
  host.labTravelBusy = busy;
  host.labTravelNotice = null;
  try {
    const result = await run(baseUrlOf(host));
    if (!result.ok) {
      host.labTravelNotice = { kind: "error", text: result.error };
      return false;
    }
    await loadLabTravel(host);
    if (done) {
      host.labTravelNotice = { kind: "success", text: done };
    }
    return true;
  } finally {
    host.labTravelBusy = null;
  }
}

export async function lookup(host: LabTravelHost): Promise<void> {
  const draft = host.labTravelLookupDraft ?? { place: "", from: "", to: "" };
  if (!draft.place.trim()) {
    host.labTravelLookupError = t("labTravel.nearby.lookupErrorPlace");
    return;
  }
  host.labTravelBusy = "lookup";
  host.labTravelLookupError = null;
  try {
    const result = await lookupTravellers(baseUrlOf(host), {
      place: draft.place,
      ...(draft.from ? { from: draft.from } : {}),
      ...(draft.to || draft.from ? { to: draft.to || draft.from } : {}),
    });
    if (!result.ok) {
      host.labTravelLookup = null;
      host.labTravelLookupError = result.error;
      return;
    }
    host.labTravelLookup = result.value;
  } finally {
    host.labTravelBusy = null;
  }
}

// --- location sharing and the tracker -----------------------------------------------------------

let active: { token: string; tracker: LocationTracker } | null = null;

function browserTracker(host: LabTravelHost, requestUpdate: () => void): LocationTracker {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return new LocationTracker({
    ...(nav?.geolocation ? { geolocation: nav.geolocation } : {}),
    ...(nav?.permissions
      ? {
          permissions: {
            query: (descriptor) =>
              nav.permissions.query(descriptor as PermissionDescriptor).then((status) => ({
                state: status.state,
              })),
          },
        }
      : {}),
    isSecureContext: typeof window !== "undefined" ? window.isSecureContext !== false : false,
    report: (fix) => reportTravelLocation(baseUrlOf(host), fix),
    onVisible: (run) => {
      if (typeof document === "undefined") {
        return () => {};
      }
      const listener = () => {
        if (document.visibilityState === "visible") {
          run();
        }
      };
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    onChange: (snapshot, sharing) => {
      host.labTravelDevice = snapshot;
      if (sharing) {
        const movedCity = sharing.location?.key !== host.labTravelSharing?.location?.key;
        host.labTravelSharing = sharing;
        if (host.labTravel) {
          host.labTravel = { ...host.labTravel, sharing };
          // A new city changes who is "near you now"; re-read quietly, keeping the page drawn.
          if (movedCity || !sharing.enabled) {
            void loadLabTravel(host).finally(requestUpdate);
          }
        }
      }
      requestUpdate();
    },
  });
}

/** Stop watching this browser's location. Safe to call when nothing is running. */
export function stopLocationTracking(): void {
  active?.tracker.stop();
  active = null;
}

function startTracking(
  host: LabTravelHost,
  token: string,
  requestUpdate: () => void,
  fromGesture: boolean,
): LocationTracker {
  if (active && active.token !== token) {
    stopLocationTracking();
  }
  if (!active) {
    active = { token, tracker: browserTracker(host, requestUpdate) };
  }
  void active.tracker.start({ fromGesture });
  return active.tracker;
}

/**
 * Called on every render: makes the tracker match the account's opt-in.
 *
 * Cheap when nothing changed. On a new session it reads the opt-in once (the tab may never be
 * opened), starts watching for a sharing member whose browser already granted permission, and
 * stops everything when the session goes away or belongs to somebody else.
 */
export function syncLocationTracking(host: LabTravelHost, requestUpdate: () => void): void {
  const token = sessionToken();
  if (!token || !isTravelViewer(host.memberPrivilegeLevel)) {
    if (active) {
      stopLocationTracking();
      host.labTravelDevice = { status: "idle" };
    }
    return;
  }
  if (active && active.token !== token) {
    stopLocationTracking();
    host.labTravelDevice = { status: "idle" };
  }
  if (host.labTravelSharingCheckedFor !== token) {
    host.labTravelSharingCheckedFor = token;
    host.labTravelSharing = null;
    void fetchTravelSharing(baseUrlOf(host)).then((result) => {
      if (sessionToken() !== token) {
        return;
      }
      host.labTravelSharing = result.ok ? result.value : null;
      requestUpdate();
    });
    return;
  }
  if (host.labTravelSharing?.enabled && !active) {
    startTracking(host, token, requestUpdate, false);
  } else if (host.labTravelSharing && !host.labTravelSharing.enabled && active) {
    stopLocationTracking();
    host.labTravelDevice = { status: "idle" };
  }
}

/** The member pressed "Share my location": opt in, then ask the browser (a real gesture). */
export async function enableSharing(host: LabTravelHost, requestUpdate: () => void): Promise<void> {
  const token = sessionToken();
  if (!token) {
    return;
  }
  const ok = await act(
    host,
    "sharing",
    async (baseUrl) => {
      const result = await setTravelSharing(baseUrl, true);
      if (!result.ok) {
        return result;
      }
      host.labTravelSharing = result.value;
      return { ok: true };
    },
    t("labTravel.notice.sharingOn"),
  );
  if (ok) {
    startTracking(host, token, requestUpdate, true);
  }
}

/** Opt out. The tracker stops first so no fix can be in flight once the service forgets. */
export async function disableSharing(host: LabTravelHost): Promise<void> {
  stopLocationTracking();
  host.labTravelDevice = { status: "idle" };
  host.labTravelLookup = null;
  await act(
    host,
    "sharing",
    async (baseUrl) => {
      const result = await setTravelSharing(baseUrl, false);
      if (!result.ok) {
        return result;
      }
      host.labTravelSharing = result.value;
      return { ok: true };
    },
    t("labTravel.notice.sharingOff"),
  );
}

/** "Use this device's location" / "Update now": always from a press, so prompting is fine. */
export function shareFromThisDevice(host: LabTravelHost, requestUpdate: () => void): void {
  const token = sessionToken();
  if (!token || !host.labTravelSharing?.enabled) {
    return;
  }
  const running = active?.token === token && active.tracker.state.status === "watching";
  if (running) {
    active!.tracker.poll();
    return;
  }
  startTracking(host, token, requestUpdate, true);
}

/** "I'm in Lisbon": the typed fallback for a browser that cannot give a position. */
export async function shareTypedCity(host: LabTravelHost): Promise<boolean> {
  const city = host.labTravelCityDraft?.trim() ?? "";
  if (!city) {
    host.labTravelNotice = { kind: "error", text: t("labTravel.nearby.cityErrorEmpty") };
    return false;
  }
  const done = await act(
    host,
    "city",
    async (baseUrl) => {
      const result = await reportTravelLocation(baseUrl, { place: city });
      if (!result.ok) {
        return result;
      }
      host.labTravelSharing = result.value;
      return { ok: true };
    },
    t("labTravel.notice.citySaved", { city }),
  );
  if (done) {
    host.labTravelCityDraft = "";
  }
  return done;
}

/** The fields this tab owns on the host, without the ones it only reads. */
export type LabTravelState = Omit<LabTravelHost, "settings" | "memberId" | "memberPrivilegeLevel">;

/** Forget everything this tab holds. Signing out, or becoming somebody else. */
export function clearLabTravel(host: LabTravelState): void {
  stopLocationTracking();
  host.labTravel = undefined;
  host.labTravelLoadedFor = null;
  host.labTravelLoading = false;
  host.labTravelError = null;
  host.labTravelNotice = null;
  host.labTravelBusy = null;
  host.labTravelLookupDraft = { place: "", from: "", to: "" };
  host.labTravelLookup = null;
  host.labTravelLookupError = null;
  host.labTravelCityDraft = "";
  host.labTravelSharing = null;
  host.labTravelSharingCheckedFor = null;
  host.labTravelDevice = { status: "idle" };
}
