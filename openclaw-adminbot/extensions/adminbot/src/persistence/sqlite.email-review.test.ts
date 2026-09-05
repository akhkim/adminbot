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
  it.each([null, "", "   ", "paper match was ambiguous; queued for review"])(
    "shows the processing failure when present, falling back for %j",
    (failure) => {
      const target = databasePath();
      const service = createAdminBotSqliteService({ databasePath: target });
      const db = new DatabaseSync(target);
      try {
        db.prepare(`INSERT INTO adminbot_email_messages
          (message_id, thread_id, sender, category, status, reason, last_error, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "held",
          "thread",
          "venue@example.org",
          "paperflow_bcc",
          "needs_review",
          "classified as venue evidence",
          failure,
          "2026-09-05T00:00:00.000Z",
        );
        const expected = failure?.trim() || "classified as venue evidence";
        expect(service.store.listEmailReviews()[0]?.reason).toBe(expected);
        expect(service.store.getEmailReview("held")?.reason).toBe(expected);
        expect(
          db.prepare("SELECT reason FROM adminbot_email_messages WHERE message_id = ?").get("held"),
        ).toEqual({ reason: "classified as venue evidence" });
      } finally {
        db.close();
        service.close();
      }
    },
  );

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
