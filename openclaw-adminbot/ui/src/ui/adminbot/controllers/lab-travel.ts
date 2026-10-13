// The Travel tab's reads and writes, and the one location tracker per page.
//
// The view decides what to show and this decides what to fetch, as with the other AdminBot
// controllers. Every write re-reads the overview afterwards rather than patching it: an RSVP
// changes the conference card, the "who else is going" list and the match groups at once, and a
// hand-patched snapshot is how two of those come to disagree.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  updateOwnSchedule,
  type MemberTripRow,
} from "../auth/session.ts";
import {
  fetchTravelOverview,
  fetchTravelSharing,
  lookupTravellers,
  reportTravelLocation,
  saveTravelRsvp,
  setTravelSharing,
  withdrawTravelRsvp,
  type TravelConference,
  type TravelFunding,
  type TravelLookup,
  type TravelOverview,
  type TravelRsvpIntent,
  type TravelSharing,
} from "../data/lab-travel.ts";
import { EMPTY_TRIP_DRAFT, type TripDraft } from "../views/lab-travel.plans.ts";
import { LocationTracker, type LocationTrackerSnapshot } from "./location-tracker.ts";

/** One conference's RSVP form, as typed. `intent` is blank until the member picks one. */
export type RsvpDraft = {
  intent: TravelRsvpIntent | "";
  airbnb: boolean;
  arrival_on: string;
  departure_on: string;
  funding: TravelFunding;
  needs_visa_letter: boolean;
  notes: string;
};

export type LookupDraft = { place: string; from: string; to: string };

export type LabTravelNotice = { kind: "success" | "error"; text: string };

export type LabTravelHost = {
  settings: UiSettings;
  memberId?: string | null;
  memberPrivilegeLevel?: string | null;
  adminBotData?: { members: Array<{ id: string; trips?: unknown }> };
  labTravel?: TravelOverview;
  /** The session token the overview was read with, so a different member never sees it. */
  labTravelLoadedFor?: string | null;
  labTravelLoading?: boolean;
  labTravelError?: string | null;
  labTravelNotice?: LabTravelNotice | null;
  /** Which action is in flight: "sharing", "city", "plans", "lookup" or "rsvp:<key>". */
  labTravelBusy?: string | null;
  labTravelRsvpOpen?: string | null;
  labTravelRsvpDrafts?: Record<string, RsvpDraft>;
  labTravelPlanDraft?: TripDraft;
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

const RSVP_FALLBACK: RsvpDraft = {
  intent: "",
  airbnb: false,
  arrival_on: "",
  departure_on: "",
  funding: "none",
  needs_visa_letter: false,
  notes: "",
};

/** Whether this viewer may use the tab at all. The service checks the same thing. */
export function isTravelViewer(privilegeLevel: string | null | undefined): boolean {
  return privilegeLevel === "member" || privilegeLevel === "admin";
}

/** The form's starting point: the member's own answer, else an earlier whole-conference one. */
export function rsvpDraftFrom(site: TravelConference): RsvpDraft {
  const answer = site.my_rsvp ?? site.unsited_rsvp;
  if (!answer) {
    return { ...RSVP_FALLBACK };
  }
  return {
    intent: answer.intent,
    airbnb: answer.needs_lodging,
    arrival_on: answer.arrival_on ?? "",
    departure_on: answer.departure_on ?? "",
    funding: answer.funding,
    needs_visa_letter: answer.needs_visa_letter,
    notes: answer.notes ?? "",
  };
}

/** Why this RSVP cannot be saved yet, or null. */
export function rsvpDraftError(draft: RsvpDraft): string | null {
  if (!draft.intent) {
    return t("labTravel.rsvp.errorIntent");
  }
  if (
    draft.airbnb &&
    draft.arrival_on &&
    draft.departure_on &&
    draft.departure_on < draft.arrival_on
  ) {
    return t("labTravel.rsvp.errorNights");
  }
  return null;
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

export function editRsvpDraft(
  host: LabTravelHost,
  site: TravelConference,
  patch: Partial<RsvpDraft>,
) {
  const current = host.labTravelRsvpDrafts?.[site.key] ?? rsvpDraftFrom(site);
  const next = { ...current, ...patch };
  // Choosing the Airbnb fills in the conference's own days, which is what most people need and
  // what the service would assume anyway; an edited night is never overwritten.
  if (patch.airbnb && !current.airbnb) {
    next.arrival_on ||= site.starts ?? "";
    next.departure_on ||= site.ends ?? "";
  }
  host.labTravelRsvpDrafts = { ...host.labTravelRsvpDrafts, [site.key]: next };
}

export function openRsvp(host: LabTravelHost, key: string | null): void {
  host.labTravelRsvpOpen = key;
}

export async function saveRsvp(host: LabTravelHost, site: TravelConference): Promise<boolean> {
  const draft = host.labTravelRsvpDrafts?.[site.key] ?? rsvpDraftFrom(site);
  const error = rsvpDraftError(draft);
  if (error || !draft.intent) {
    host.labTravelNotice = { kind: "error", text: error ?? t("labTravel.rsvp.errorIntent") };
    return false;
  }
  const intent = draft.intent;
  const saved = await act(
    host,
    `rsvp:${site.key}`,
    async (baseUrl) => {
      const result = await saveTravelRsvp(baseUrl, site.key, {
        intent,
        funding: draft.funding,
        needs_lodging: draft.airbnb,
        needs_visa_letter: draft.needs_visa_letter,
        ...(draft.airbnb && draft.arrival_on ? { arrival_on: draft.arrival_on } : {}),
        ...(draft.airbnb && draft.departure_on ? { departure_on: draft.departure_on } : {}),
        ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
      });
      return result.ok ? { ok: true } : result;
    },
    t("labTravel.notice.rsvpSaved", { conference: site.label }),
  );
  if (saved) {
    const drafts = { ...host.labTravelRsvpDrafts };
    delete drafts[site.key];
    host.labTravelRsvpDrafts = drafts;
    host.labTravelRsvpOpen = null;
  }
  return saved;
}

export async function withdrawRsvp(host: LabTravelHost, site: TravelConference): Promise<boolean> {
  // The key the answer is stored under: the site's own, or the whole conference's for an answer
  // given before it was split.
  const key = site.my_rsvp ? site.key : site.unsited_rsvp ? site.group_key : site.key;
  const done = await act(
    host,
    `rsvp:${site.key}`,
    async (baseUrl) => {
      const result = await withdrawTravelRsvp(baseUrl, key);
      return result.ok ? { ok: true } : result;
    },
    t("labTravel.notice.rsvpWithdrawn", { conference: site.label }),
  );
  if (done) {
    const drafts = { ...host.labTravelRsvpDrafts };
    delete drafts[site.key];
    host.labTravelRsvpDrafts = drafts;
    host.labTravelRsvpOpen = null;
  }
  return done;
}

/** Save the member's own trips. Same write Time Availability's chart reads back. */
export async function savePlans(host: LabTravelHost, trips: MemberTripRow[]): Promise<boolean> {
  const memberId = host.memberId;
  const token = sessionToken();
  if (!memberId || !token) {
    host.labTravelNotice = { kind: "error", text: t("labTravel.notice.signIn") };
    return false;
  }
  return act(
    host,
    "plans",
    async (baseUrl) => {
      const result = await updateOwnSchedule(memberId, { trips }, token, baseUrl);
      if (!result.ok) {
        return { ok: false, error: result.message ?? t("labTravel.notice.plansFailed") };
      }
      // Keep the roster copy current too: the Time Availability chart draws its where-strip from
      // it, and it would otherwise show the old trips until the roster next reloads.
      if (host.adminBotData) {
        host.adminBotData = {
          ...host.adminBotData,
          members: host.adminBotData.members.map((member) =>
            member.id === memberId ? { ...member, trips: result.value.trips ?? trips } : member,
          ),
        };
      }
      return { ok: true };
    },
    t("labTravel.notice.plansSaved"),
  );
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
export type LabTravelState = Omit<
  LabTravelHost,
  "settings" | "memberId" | "memberPrivilegeLevel" | "adminBotData"
>;

/** Forget everything this tab holds. Signing out, or becoming somebody else. */
export function clearLabTravel(host: LabTravelState): void {
  stopLocationTracking();
  host.labTravel = undefined;
  host.labTravelLoadedFor = null;
  host.labTravelLoading = false;
  host.labTravelError = null;
  host.labTravelNotice = null;
  host.labTravelBusy = null;
  host.labTravelRsvpOpen = null;
  host.labTravelRsvpDrafts = {};
  host.labTravelPlanDraft = EMPTY_TRIP_DRAFT;
  host.labTravelLookupDraft = { place: "", from: "", to: "" };
  host.labTravelLookup = null;
  host.labTravelLookupError = null;
  host.labTravelCityDraft = "";
  host.labTravelSharing = null;
  host.labTravelSharingCheckedFor = null;
  host.labTravelDevice = { status: "idle" };
}
