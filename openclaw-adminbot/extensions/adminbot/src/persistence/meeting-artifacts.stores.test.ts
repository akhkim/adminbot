import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AdminBotMemoryStore } from "./memory.js";
import { AdminBotSqliteStore } from "./sqlite.js";

describe.each(["memory", "sqlite"] as const)("meeting artifact tracking (%s)", (kind) => {
  it("retries unmatched files but skips attached files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-artifacts-"));
    const store =
      kind === "sqlite"
        ? new AdminBotSqliteStore(path.join(dir, "state.sqlite"))
        : new AdminBotMemoryStore();
    try {
      const record = {
        file_id: "drive-file-1",
        file_name: "participants.csv",
        meeting_id: "meeting-1",
        processed_at: "2026-09-24T00:00:00.000Z",
      };
      expect(store.hasAttachedMeetingArtifact(record.file_id)).toBe(false);
      store.recordMeetingArtifact({ ...record, status: "unmatched" });
      expect(store.hasAttachedMeetingArtifact(record.file_id)).toBe(false);
      store.recordMeetingArtifact({ ...record, status: "empty" });
      expect(store.hasAttachedMeetingArtifact(record.file_id)).toBe(false);
      store.recordMeetingArtifact({ ...record, status: "attached" });
      expect(store.hasAttachedMeetingArtifact(record.file_id)).toBe(true);
    } finally {
      if (store instanceof AdminBotSqliteStore) {
        store.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("reads artifact rows written by the old standalone SQLite connection", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-artifacts-legacy-"));
  const databasePath = path.join(dir, "state.sqlite");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE adminbot_meeting_artifacts (
      file_id TEXT PRIMARY KEY, file_name TEXT NOT NULL, meeting_id TEXT,
      status TEXT NOT NULL, processed_at TEXT NOT NULL
    )`);
    legacy
      .prepare("INSERT INTO adminbot_meeting_artifacts VALUES (?, ?, ?, ?, ?)")
      .run("old-file", "transcript.vtt", "meeting-1", "attached", "2026-09-24T00:00:00.000Z");
    legacy.close();

    const store = new AdminBotSqliteStore(databasePath);
    try {
      expect(store.hasAttachedMeetingArtifact("old-file")).toBe(true);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
