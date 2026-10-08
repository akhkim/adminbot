import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotMemberNotification } from "../contracts/actions.js";
import { AdminBotMemoryStore } from "./memory.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function notifications(): AdminBotMemberNotification[] {
  return Array.from({ length: 40 }, (_, index) => {
    const escalated = index % 3 === 0;
    return {
      id: `n${String(index).padStart(2, "0")}`,
      member_id: `m${index % 5}`,
      kind: "nudge",
      title: `Nudge ${index}`,
      body: "body",
      created_at: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      // Ties on purpose: the order among equal escalation times is the order they were written.
      ...(escalated ? { escalated_at: `2026-04-0${(index % 4) + 1}T00:00:00.000Z` } : {}),
      ...(index % 9 === 0 ? { escalated_at: "" } : {}),
      ...(index % 4 === 0 ? { read_at: "2026-04-20T00:00:00.000Z" } : {}),
      ...(index % 8 === 2 ? { read_at: "" } : {}),
    } as AdminBotMemberNotification;
  });
}

describe("listEscalatedMemberNotifications", () => {
  it("returns what the memory store does, reading only the escalated unread rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-escalated-"));
    dirs.push(dir);
    const sqlite = new AdminBotSqliteStore(path.join(dir, "adminbot.sqlite"));
    const memory = new AdminBotMemoryStore();
    for (const notification of notifications()) {
      sqlite.saveMemberNotification(notification);
      memory.saveMemberNotification(notification);
    }
    // A later write to an older row keeps that row's place, as it does in the memory store.
    const resaved = { ...notifications()[3], title: "edited" } as AdminBotMemberNotification;
    sqlite.saveMemberNotification(resaved);
    memory.saveMemberNotification(resaved);

    const expected = memory.listEscalatedMemberNotifications();
    expect(expected.length).toBeGreaterThan(3);
    expect(JSON.stringify(sqlite.listEscalatedMemberNotifications())).toBe(
      JSON.stringify(expected),
    );
    sqlite.close();
  });
});
