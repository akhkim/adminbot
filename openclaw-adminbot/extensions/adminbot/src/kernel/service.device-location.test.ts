// Device readings in the location history, at the service boundary. Synthetic member, fake
// geocoder: nothing is downloaded and no real position is used.
import { describe, expect, it } from "vitest";
import type { ReverseGeocodedPlace } from "../connectors/reverse-geocode.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function lab(start: string) {
  const clock = { now: new Date(start) };
  const answer: { place: ReverseGeocodedPlace } = {
    place: { city: "Reggio Emilia", region: "Emilia-Romagna", country: "IT" },
  };
  const service = new AdminBotService(undefined, {
    now: () => clock.now,
    reverseGeocoder: {
      nearest: async () => answer.place,
      centroid: () => undefined,
      version: () => 1,
    },
  });
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Example",
      privilege_level: "member",
      member_type: "full",
    } as never),
  );
  const history = () =>
    unwrap(service.listMemberLocations("ada")).locations.filter(
      (entry) => entry.source === "device",
    );
  return { service, clock, answer, history };
}

describe("device readings in the location history", () => {
  it("logs city, region and country under source device, and never the coordinates", async () => {
    const { service, history } = lab("2026-10-15T08:00:00Z");
    unwrap(await service.recordDeviceLocation("ada", { lat: 44.70123, lon: 10.62987 }));
    const [entry] = history();
    expect(entry).toMatchObject({
      source: "device",
      raw: "Reggio Emilia, Emilia-Romagna, Italy",
      place_label: "Reggio Emilia",
      country: "Italy",
    });
    expect(JSON.stringify(history())).not.toMatch(/44\.70|10\.62/u);
    expect(Object.keys(entry!).filter((key) => /lat|lon|coord/u.test(key))).toEqual([]);
  });

  it("writes on a new city at once and otherwise once per UTC day", async () => {
    const { service, clock, answer, history } = lab("2026-10-15T08:00:00Z");
    unwrap(await service.recordDeviceLocation("ada", { lat: 44.7, lon: 10.63 }));
    clock.now = new Date("2026-10-15T15:00:00Z");
    unwrap(await service.recordDeviceLocation("ada", { lat: 44.69, lon: 10.64 }));
    expect(history()).toHaveLength(1);

    // Still here the next day: one dated row.
    clock.now = new Date("2026-10-16T09:00:00Z");
    unwrap(await service.recordDeviceLocation("ada", { lat: 44.7, lon: 10.63 }));
    expect(history()).toHaveLength(2);

    // A new city the same day: logged straight away.
    answer.place = { city: "Rome", region: "Lazio", country: "IT" };
    clock.now = new Date("2026-10-16T18:00:00Z");
    unwrap(await service.recordDeviceLocation("ada", { lat: 41.9, lon: 12.5 }));
    expect(
      history()
        .map((entry) => entry.place_label)
        .toSorted(),
    ).toEqual(["Reggio Emilia", "Reggio Emilia", "Rome"]);
  });

  it("logs nothing for a member who keeps their device off the map", async () => {
    const { service, history } = lab("2026-10-15T08:00:00Z");
    unwrap(service.updateOwnProfile("ada", { map_visibility: "hidden" } as never));
    unwrap(await service.recordDeviceLocation("ada", { lat: 44.7, lon: 10.63 }));
    expect(history()).toEqual([]);
  });
});
