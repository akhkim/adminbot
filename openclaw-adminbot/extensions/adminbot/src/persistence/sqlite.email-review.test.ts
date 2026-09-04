import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotSqliteService } from "./sqlite.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-email-review-"));
  directories.push(directory);
  return path.join(directory, "adminbot.sqlite");
}

describe("SQLite email review queue", () => {
  it("upgrades the legacy automation table and persists review decisions", () => {
    const target = databasePath();
    const legacy = new DatabaseSync(target);
    legacy.exec(`
      CREATE TABLE adminbot_email_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    legacy.close();

    const first = createAdminBotSqliteService({ databasePath: target });
    first.store.saveEmailReview({
      message_id: "message-1",
      thread_id: "thread-1",
      sender: "venue@example.org",
      subject: "Paper decision",
      category: "paperflow_bcc",
      reason: "sender is not a trusted lab address",
      received_at: "2026-09-03T21:04:00.000Z",
      updated_at: "2026-09-03T21:05:00.000Z",
    });
    expect(first.store.listEmailReviews()).toEqual([
      expect.objectContaining({
        message_id: "message-1",
        subject: "Paper decision",
        received_at: "2026-09-03T21:04:00.000Z",
      }),
    ]);
    expect(
      first.store.resolveEmailReview({
        messageId: "message-1",
        resolution: "dismissed",
        resolvedBy: "admin",
        resolvedAt: "2026-09-04T10:00:00.000Z",
      }),
    ).toBe(true);
    first.close();

    const second = createAdminBotSqliteService({ databasePath: target });
    expect(second.store.listEmailReviews()).toEqual([]);
    second.close();

    const inspect = new DatabaseSync(target);
    expect(
      inspect
        .prepare(
          "SELECT status, resolution, resolved_by, resolved_at FROM adminbot_email_messages WHERE message_id = ?",
        )
        .get("message-1"),
    ).toEqual({
      status: "reviewed",
      resolution: "dismissed",
      resolved_by: "admin",
      resolved_at: "2026-09-04T10:00:00.000Z",
    });
    inspect.close();
  });
});
