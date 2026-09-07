import { expect, it } from "vitest";
import { AdminBotMemoryStore } from "./memory.js";
import { AdminBotSqliteStore } from "./sqlite.js";

it("exposes equivalent isolated status storage through both service stores", () => {
  const sqlite = new AdminBotSqliteStore(":memory:");
  try {
    for (const store of [new AdminBotMemoryStore(), sqlite]) {
      const status = {
        availability: "away" as const,
        message: "Synthetic status",
        expires_at: "2026-09-08T00:00:00Z",
        updated_at: "2026-09-07T00:00:00Z",
        updated_by: "test-admin",
      };
      expect(store.readDirectorStatus()).toBeNull();
      store.saveDirectorStatus(status);
      status.message = "Caller changed input";
      expect(store.readDirectorStatus()?.message).toBe("Synthetic status");
      const read = store.readDirectorStatus()!;
      read.message = "Caller changed output";
      expect(store.readDirectorStatus()?.message).toBe("Synthetic status");
      store.saveDirectorStatus(null);
      expect(store.readDirectorStatus()).toBeNull();
    }
  } finally {
    sqlite.close();
  }
});
