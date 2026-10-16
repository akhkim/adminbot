import { describe, expect, it } from "vitest";
import type { LocationCheckin, LocationPlace } from "../api/profile.ts";
import {
  bannerFor,
  checkinShownThisSession,
  DEVICE_SNAP_MAX_KM,
  markCheckinShown,
  nearestPlace,
} from "./location-checkin.ts";

const DUE: LocationCheckin = {
  due: true,
  reason: "no_guess",
  suggestion: { city: "Toronto", source: "stored" },
};

// Synthetic, approximate city coordinates.
const PLACES: LocationPlace[] = [
  { key: "toronto", label: "Toronto", country: "Canada", lat: 43.65, lon: -79.38 },
  { key: "montreal", label: "Montréal", country: "Canada", lat: 45.5, lon: -73.57 },
  { key: "berlin", label: "Berlin", country: "Germany", lat: 52.52, lon: 13.4 },
];

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("bannerFor", () => {
  it("shows one-tap confirm when there is a guess, and the picker when there is none", () => {
    expect(bannerFor(DUE, false)).toEqual({ checkin: DUE, mode: "confirm" });
    const { suggestion: _drop, ...noGuess } = DUE;
    expect(bannerFor(noGuess, false)?.mode).toBe("pick");
  });

  it("shows nothing when not due, or when it was already shown this session", () => {
    expect(bannerFor({ due: false, reason: "signals_agree" }, false)).toBeNull();
    expect(bannerFor(null, false)).toBeNull();
    expect(bannerFor(DUE, true)).toBeNull();
  });
});

describe("once per session", () => {
  it("remembers per member", () => {
    const store = memoryStore();
    expect(checkinShownThisSession("m_a", store)).toBe(false);
    markCheckinShown("m_a", store);
    expect(checkinShownThisSession("m_a", store)).toBe(true);
    expect(checkinShownThisSession("m_b", store)).toBe(false);
  });

  it("treats storage that throws as never shown, without throwing", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => markCheckinShown("m_a", broken)).not.toThrow();
    expect(checkinShownThisSession("m_a", broken)).toBe(false);
  });
});

describe("nearestPlace", () => {
  it("snaps a device position to the closest listed city", () => {
    expect(nearestPlace(PLACES, { lat: 43.7, lon: -79.4 })?.label).toBe("Toronto");
    expect(nearestPlace(PLACES, { lat: 45.4, lon: -73.6 })?.label).toBe("Montréal");
  });

  it("names no city when the device is far from all of them", () => {
    expect(DEVICE_SNAP_MAX_KM).toBe(150);
    // Mid-Atlantic.
    expect(nearestPlace(PLACES, { lat: 40, lon: -40 })).toBeUndefined();
    expect(nearestPlace([], { lat: 43.7, lon: -79.4 })).toBeUndefined();
  });
});
