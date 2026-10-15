import { describe, expect, it, vi } from "vitest";
import type { TravelResult, TravelSharing } from "../data/lab-travel.ts";
import {
  HEARTBEAT_MS,
  LocationTracker,
  REPORT_EVERY_MS,
  type LocationTrackerDeps,
  type LocationTrackerSnapshot,
} from "./location-tracker.ts";

/** A browser geolocation we can drive by hand. */
function fakeGeolocation() {
  let watcher: { ok: PositionCallback; fail: PositionErrorCallback } | null = null;
  let pending: { ok: PositionCallback; fail: PositionErrorCallback } | null = null;
  const api = {
    watchPosition: vi.fn((ok: PositionCallback, fail?: PositionErrorCallback | null) => {
      watcher = { ok, fail: fail ?? (() => {}) };
      return 7;
    }),
    clearWatch: vi.fn(() => {
      watcher = null;
    }),
    getCurrentPosition: vi.fn((ok: PositionCallback, fail?: PositionErrorCallback | null) => {
      pending = { ok, fail: fail ?? (() => {}) };
    }),
  };
  const position = (lat: number, lon: number, accuracy = 20) =>
    ({ coords: { latitude: lat, longitude: lon, accuracy }, timestamp: 0 }) as GeolocationPosition;
  return {
    api,
    move: (lat: number, lon: number) => watcher?.ok(position(lat, lon)),
    answer: (lat: number, lon: number) => pending?.ok(position(lat, lon)),
    fail: (code: number) => watcher?.fail({ code } as GeolocationPositionError),
    get watching() {
      return watcher !== null;
    },
  };
}

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

function tracker(overrides: Partial<LocationTrackerDeps> = {}) {
  const geo = fakeGeolocation();
  const snapshots: LocationTrackerSnapshot[] = [];
  const sharings: TravelSharing[] = [];
  let clock = Date.parse("2026-10-13T12:00:00Z");
  let heartbeat: (() => void) | null = null;
  const report = vi.fn(
    async (): Promise<TravelResult<TravelSharing>> => ({
      ok: true,
      value: {
        enabled: true,
        location: { label: "Paris", reported_at: new Date(clock).toISOString() },
      },
    }),
  );
  const instance = new LocationTracker({
    geolocation: geo.api,
    permissions: { query: async () => ({ state: "granted" }) },
    isSecureContext: true,
    report,
    onChange: (snapshot, sharing) => {
      snapshots.push(snapshot);
      if (sharing) {
        sharings.push(sharing);
      }
    },
    now: () => clock,
    setInterval: (run) => {
      heartbeat = run;
      return 1;
    },
    clearInterval: () => {
      heartbeat = null;
    },
    ...overrides,
  });
  return {
    instance,
    geo,
    report,
    snapshots,
    sharings,
    advance: (ms: number) => {
      clock += ms;
    },
    beat: () => heartbeat?.(),
    get heartbeatSet() {
      return heartbeat !== null;
    },
  };
}

describe("LocationTracker", () => {
  it("never prompts on its own: an ungranted browser waits for a press", async () => {
    const t = tracker({ permissions: { query: async () => ({ state: "prompt" }) } });
    await t.instance.start({ fromGesture: false });
    expect(t.geo.api.watchPosition).not.toHaveBeenCalled();
    expect(t.instance.state.status).toBe("needs-permission");
    // The member presses the button: now the browser may ask.
    await t.instance.start({ fromGesture: true });
    expect(t.geo.api.watchPosition).toHaveBeenCalledOnce();
    expect(t.instance.state.status).toBe("locating");
  });

  it("resumes silently where permission was already granted", async () => {
    const t = tracker();
    await t.instance.start({ fromGesture: false });
    expect(t.geo.api.watchPosition).toHaveBeenCalledOnce();
    expect(t.heartbeatSet).toBe(true);
  });

  it("reports a fix, then only after moving a kilometre or after the refresh interval", async () => {
    const t = tracker();
    await t.instance.start({ fromGesture: true });
    t.geo.move(48.8566, 2.3522);
    await flush();
    expect(t.report).toHaveBeenCalledTimes(1);
    expect(t.report).toHaveBeenLastCalledWith({ lat: 48.8566, lon: 2.3522, accuracy_m: 20 });
    expect(t.instance.state.status).toBe("watching");
    expect(t.sharings.at(-1)?.location?.label).toBe("Paris");

    t.geo.move(48.8567, 2.3523); // a few metres
    await flush();
    expect(t.report).toHaveBeenCalledTimes(1);

    t.geo.move(48.8766, 2.3522); // ~2 km north
    await flush();
    expect(t.report).toHaveBeenCalledTimes(2);

    t.advance(REPORT_EVERY_MS);
    t.geo.move(48.8766, 2.3522); // same spot, but the last fix is getting old
    await flush();
    expect(t.report).toHaveBeenCalledTimes(3);
  });

  it("asks again on the heartbeat, so a still browser does not go stale", async () => {
    const t = tracker();
    await t.instance.start({ fromGesture: true });
    expect(HEARTBEAT_MS).toBeGreaterThan(0);
    t.beat();
    expect(t.geo.api.getCurrentPosition).toHaveBeenCalledOnce();
    t.geo.answer(48.8566, 2.3522);
    await flush();
    expect(t.report).toHaveBeenCalledOnce();
  });

  it("stops for good when the service says sharing is off", async () => {
    const t = tracker();
    t.report.mockResolvedValueOnce({ ok: false, status: 409, error: "off" });
    await t.instance.start({ fromGesture: true });
    t.geo.move(48.8566, 2.3522);
    await flush();
    expect(t.geo.watching).toBe(false);
    expect(t.instance.state.status).toBe("idle");
    expect(t.sharings.at(-1)).toEqual({ enabled: false });
  });

  it("drops a position that arrives after stopping", async () => {
    const t = tracker();
    await t.instance.start({ fromGesture: true });
    const watcher = t.geo.api.watchPosition.mock.calls[0]![0];
    t.instance.stop();
    watcher({ coords: { latitude: 1, longitude: 1, accuracy: 5 } } as GeolocationPosition);
    await flush();
    expect(t.report).not.toHaveBeenCalled();
    expect(t.heartbeatSet).toBe(false);
  });

  it("explains a blocked permission and stops watching", async () => {
    const t = tracker();
    await t.instance.start({ fromGesture: true });
    t.geo.fail(1);
    expect(t.instance.state.status).toBe("denied");
    expect(t.geo.watching).toBe(false);
  });

  it("refuses to start on an insecure page or without geolocation", async () => {
    const insecure = tracker({ isSecureContext: false });
    await insecure.instance.start({ fromGesture: true });
    expect(insecure.instance.state.status).toBe("insecure");
    expect(insecure.geo.api.watchPosition).not.toHaveBeenCalled();
    const missing = tracker({ geolocation: undefined });
    await missing.instance.start({ fromGesture: true });
    expect(missing.instance.state.status).toBe("unsupported");
  });

  it("keeps watching through a transient failure", async () => {
    const t = tracker();
    await t.instance.start({ fromGesture: true });
    t.geo.fail(3);
    expect(t.instance.state.status).toBe("error");
    expect(t.geo.watching).toBe(true);
  });
});
