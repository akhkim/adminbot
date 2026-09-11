import { expect, it } from "vitest";
import { AdminBotMemoryStore } from "./memory.js";
import { AdminBotSqliteStore } from "./sqlite.js";

it("exposes equivalent isolated broadcast storage through both service stores", () => {
  const sqlite = new AdminBotSqliteStore(":memory:");
  try {
    for (const store of [new AdminBotMemoryStore(), sqlite]) {
      const status = {
        id: "bcast_one",
        availability: "away" as const,
        message: "Synthetic status",
        expires_at: "2026-09-08T00:00:00Z",
        updated_at: "2026-09-07T00:00:00Z",
        updated_by: "test-admin",
      };
      expect(store.readDirectorStatus()).toBeNull();
      expect(store.listDirectorStatusHistory()).toEqual([]);
      store.saveDirectorStatus(status);
      status.message = "Caller changed input";
      expect(store.readDirectorStatus()?.message).toBe("Synthetic status");
      const read = store.readDirectorStatus()!;
      read.message = "Caller changed output";
      expect(store.readDirectorStatus()?.message).toBe("Synthetic status");

      store.saveDirectorStatus({
        ...status,
        id: "bcast_two",
        message: "Newer status",
        updated_at: "2026-09-09T00:00:00Z",
      });
      expect(store.listDirectorStatusHistory().map((row) => row.message)).toEqual([
        "Newer status",
        "Synthetic status",
      ]);

      // Clearing retracts the newest rather than emptying the archive.
      store.saveDirectorStatus(null);
      expect(store.readDirectorStatus()?.retracted_at).toBeTruthy();
      expect(store.listDirectorStatusHistory()).toHaveLength(2);
    }
  } finally {
    sqlite.close();
  }
});
