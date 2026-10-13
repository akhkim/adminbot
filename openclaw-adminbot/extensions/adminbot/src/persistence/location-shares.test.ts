import { expect, it } from "vitest";
import { AdminBotMemoryStore } from "./memory.js";
import { AdminBotSqliteStore } from "./sqlite.js";

it("stores, overwrites and deletes a location share identically in both service stores", () => {
  const sqlite = new AdminBotSqliteStore(":memory:");
  try {
    for (const store of [new AdminBotMemoryStore(), sqlite]) {
      expect(store.getLocationShare("ada")).toBeUndefined();
      store.saveLocationShare({ member_id: "ada", enabled_at: "2026-10-13T00:00:00Z" });
      // Opted in with no fix yet: no position fields at all, not nulls.
      expect(store.getLocationShare("ada")).toEqual({
        member_id: "ada",
        enabled_at: "2026-10-13T00:00:00Z",
      });
      const fix = {
        member_id: "ada",
        enabled_at: "2026-10-13T00:00:00Z",
        lat: 48.86,
        lon: 2.35,
        accuracy_m: 30,
        place_key: "paris",
        place_label: "Paris",
        place_country: "France",
        place_distance_km: 0.5,
        reported_at: "2026-10-13T12:00:00Z",
      };
      store.saveLocationShare(fix);
      fix.place_label = "Caller changed input";
      expect(store.getLocationShare("ada")?.place_label).toBe("Paris");
      store.saveLocationShare({ member_id: "bob", enabled_at: "2026-10-13T01:00:00Z" });
      expect(store.listLocationShares().map((row) => row.member_id)).toEqual(["ada", "bob"]);
      expect(store.deleteLocationShare("ada")).toBe(true);
      expect(store.deleteLocationShare("ada")).toBe(false);
      expect(store.getLocationShare("ada")).toBeUndefined();
    }
  } finally {
    sqlite.close();
  }
});
