// Keeps an opted-in member's shared location current while AdminBot is open.
//
// The point of the Travel tab's sharing is "I just landed in Paris -- who else from the lab is
// here?", which only works if the location follows the member without them re-entering it. So once
// they opt in, this watches the browser's position for as long as a page is open and posts a fix
// whenever they have moved a kilometre or the last one is getting old. It never runs for a member
// who has not opted in, it stops the moment they opt out (or sign out), and it never prompts for
// the browser permission on its own: the first prompt comes from the member pressing the button,
// and a device that has not granted it waits for a press there too.
//
// What leaves the browser is the fix and its accuracy, nothing else; the service coarsens it to
// ~1 km and names the nearest city (extensions/adminbot/src/kernel/service.lab-travel.ts).

import { t } from "../../../i18n/index.ts";
import type { TravelResult, TravelSharing } from "../data/lab-travel.ts";

export type LocationTrackerStatus =
  /** Not sharing, or not started on this device. */
  | "idle"
  /** Sharing is on for the account, but this browser has not been given permission yet. */
  | "needs-permission"
  /** Waiting on the first position from the browser. */
  | "locating"
  /** Watching, and the last fix reached the service. */
  | "watching"
  | "denied"
  | "unsupported"
  /** Browsers only offer location to HTTPS pages (and localhost). */
  | "insecure"
  | "error";

export type LocationTrackerSnapshot = {
  status: LocationTrackerStatus;
  /** When the last fix was accepted, ISO-8601. */
  lastSentAt?: string;
  message?: string;
};

type Fix = { lat: number; lon: number; accuracy_m?: number };

export type LocationTrackerDeps = {
  geolocation?: Pick<Geolocation, "watchPosition" | "clearWatch" | "getCurrentPosition">;
  permissions?: { query(descriptor: { name: "geolocation" }): Promise<{ state: string }> };
  isSecureContext: boolean;
  report(fix: Fix): Promise<TravelResult<TravelSharing>>;
  /** Every status change, plus the service's view of sharing after each accepted fix. */
  onChange(snapshot: LocationTrackerSnapshot, sharing?: TravelSharing): void;
  now?: () => number;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Subscribe to "the page became visible again"; returns the unsubscribe. */
  onVisible?: (run: () => void) => () => void;
};

/** Post a new fix after moving this far, even if the last one is recent. */
export const REPORT_MOVE_KM = 1;
/** Post a new fix at least this often while the page is open, so it never goes stale. */
export const REPORT_EVERY_MS = 20 * 60_000;
/** How often to ask the browser again when it has not volunteered a position. */
export const HEARTBEAT_MS = 30 * 60_000;

const POSITION_OPTIONS: PositionOptions = {
  // City-level is the whole point; high accuracy only costs battery.
  enableHighAccuracy: false,
  maximumAge: 10 * 60_000,
  timeout: 60_000,
};

function kmBetween(a: Fix, b: Fix): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class LocationTracker {
  private watchId: number | null = null;
  private heartbeat: unknown = null;
  private unsubscribeVisible: (() => void) | null = null;
  private last: { fix: Fix; at: number } | null = null;
  private inflight = false;
  private stopped = true;
  private snapshot: LocationTrackerSnapshot = { status: "idle" };

  constructor(private deps: LocationTrackerDeps) {}

  get state(): LocationTrackerSnapshot {
    return this.snapshot;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private set(next: LocationTrackerSnapshot, sharing?: TravelSharing): void {
    this.snapshot = next;
    this.deps.onChange(next, sharing);
  }

  /**
   * Begin watching.
   *
   * `fromGesture` is true when the member just pressed a button. Without it, a device whose
   * permission is still "prompt" is left alone and reported as needing permission: a location
   * prompt that appears on page load, unasked, is how members learn to click "Block".
   */
  async start(options: { fromGesture: boolean }): Promise<void> {
    this.stopped = false;
    const geolocation = this.deps.geolocation;
    if (!this.deps.isSecureContext) {
      this.set({ status: "insecure" });
      return;
    }
    if (!geolocation) {
      this.set({ status: "unsupported" });
      return;
    }
    if (!options.fromGesture && this.deps.permissions) {
      const permission = await this.deps.permissions
        .query({ name: "geolocation" })
        .then((result) => result.state)
        .catch(() => "prompt");
      if (this.stopped) {
        return;
      }
      if (permission === "denied") {
        this.set({ status: "denied" });
        return;
      }
      if (permission !== "granted") {
        this.set({ status: "needs-permission" });
        return;
      }
    } else if (!options.fromGesture) {
      // No Permissions API to ask, so no way to know whether watching would prompt.
      this.set({ status: "needs-permission" });
      return;
    }
    if (this.watchId !== null) {
      return;
    }
    this.set({
      status: "locating",
      ...(this.snapshot.lastSentAt ? { lastSentAt: this.snapshot.lastSentAt } : {}),
    });
    this.watchId = geolocation.watchPosition(
      (position) => void this.onPosition(position),
      (error) => this.onError(error),
      POSITION_OPTIONS,
    );
    const every = this.deps.setInterval ?? ((run, ms) => setInterval(run, ms));
    this.heartbeat = every(() => this.poll(), HEARTBEAT_MS);
    this.unsubscribeVisible =
      this.deps.onVisible?.(() => {
        if (!this.last || this.now() - this.last.at > 5 * 60_000) {
          this.poll();
        }
      }) ?? null;
  }

  /** Ask the browser for a position right now, e.g. from an "Update now" button. */
  poll(): void {
    if (this.stopped || !this.deps.geolocation) {
      return;
    }
    this.deps.geolocation.getCurrentPosition(
      (position) => void this.onPosition(position, true),
      (error) => this.onError(error),
      POSITION_OPTIONS,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.watchId !== null) {
      this.deps.geolocation?.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.heartbeat !== null) {
      (this.deps.clearInterval ?? ((handle) => clearInterval(handle as number)))(this.heartbeat);
      this.heartbeat = null;
    }
    this.unsubscribeVisible?.();
    this.unsubscribeVisible = null;
    this.last = null;
    if (this.snapshot.status !== "idle") {
      this.set({ status: "idle" });
    }
  }

  private async onPosition(position: GeolocationPosition, force = false): Promise<void> {
    if (this.stopped || this.inflight) {
      return;
    }
    const fix: Fix = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      ...(Number.isFinite(position.coords.accuracy)
        ? { accuracy_m: position.coords.accuracy }
        : {}),
    };
    const now = this.now();
    const due =
      force ||
      !this.last ||
      now - this.last.at >= REPORT_EVERY_MS ||
      kmBetween(this.last.fix, fix) >= REPORT_MOVE_KM;
    if (!due) {
      return;
    }
    this.inflight = true;
    try {
      const result = await this.deps.report(fix);
      if (this.stopped) {
        return;
      }
      if (result.ok) {
        this.last = { fix, at: now };
        this.set({ status: "watching", lastSentAt: new Date(now).toISOString() }, result.value);
        return;
      }
      if (result.status === 409 || result.status === 403 || result.status === 401) {
        // Sharing was switched off somewhere else, or the session can no longer share. Stop
        // rather than keep offering positions the service will refuse.
        this.stop();
        this.deps.onChange(this.snapshot, { enabled: false });
        return;
      }
      this.set({
        status: "error",
        message: result.error,
        ...(this.snapshot.lastSentAt ? { lastSentAt: this.snapshot.lastSentAt } : {}),
      });
    } finally {
      this.inflight = false;
    }
  }

  private onError(error: GeolocationPositionError): void {
    if (this.stopped) {
      return;
    }
    if (error.code === 1) {
      // PERMISSION_DENIED. Watching further would only fail again; the member has to change it in
      // the browser, and the tab says how.
      if (this.watchId !== null) {
        this.deps.geolocation?.clearWatch(this.watchId);
        this.watchId = null;
      }
      this.set({ status: "denied" });
      return;
    }
    // Unavailable or timed out: transient. Keep the watch; the heartbeat will ask again.
    this.set({
      status: this.snapshot.lastSentAt ? "watching" : "error",
      message:
        error.code === 3
          ? t("labTravel.nearby.deviceTimeout")
          : t("labTravel.nearby.deviceUnavailable"),
      ...(this.snapshot.lastSentAt ? { lastSentAt: this.snapshot.lastSentAt } : {}),
    });
  }
}
