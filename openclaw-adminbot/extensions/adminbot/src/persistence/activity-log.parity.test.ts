// The two event logs, asserted against both stores at once.
//
// They are separate implementations of one interface, and the service is written on the assumption
// that it cannot tell them apart. Every case below is one where a plausible implementation of one
// store diverges from the other: the same-millisecond tie-break, an absent optional column coming
// back as SQL NULL rather than absent, and survival across a restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotUpdateEvent } from "../contracts/activity-log.js";
import type { AdminBotServiceStore } from "../kernel/service.js";
import { AdminBotMemoryStore } from "./memory.js";
import { createAdminBotSqliteService } from "./sqlite.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-activity-"));
  tempDirs.push(dir);
  return path.join(dir, "adminbot.sqlite");
}

// The SQLite store is reached through the service factory, which is the only exported way in; the
// store itself is what these assertions are about.
function sqliteStore(databasePath = tempDbPath()): AdminBotServiceStore {
  return createAdminBotSqliteService({ databasePath }).store;
}

const stores: Array<[string, () => AdminBotServiceStore]> = [
  ["memory", () => new AdminBotMemoryStore()],
  ["sqlite", () => sqliteStore()],
];

function updateEvent(overrides: Partial<AdminBotUpdateEvent> = {}): AdminBotUpdateEvent {
  return {
    id: `event-${Math.random().toString(36).slice(2)}`,
    subject: "profile",
    slot_id: "profile:location",
    member_id: "ada",
    at: "2026-08-26T10:00:00.000Z",
    source: "member",
    ...overrides,
  };
}

describe.each(stores)("%s store: activity log", (_name, makeStore) => {
  it("returns sign-ins newest first", () => {
    const store = makeStore();
    store.appendLoginEvent({
      id: "a",
      member_id: "ada",
      at: "2026-08-01T00:00:00.000Z",
    });
    store.appendLoginEvent({
      id: "b",
      member_id: "ada",
      at: "2026-08-03T00:00:00.000Z",
    });
    store.appendLoginEvent({
      id: "c",
      member_id: "grace",
      at: "2026-08-02T00:00:00.000Z",
    });
    expect(store.listLoginEvents("ada").map((event) => event.id)).toEqual(["b", "a"]);
  });

  it("honors a limit and keeps the newest rows, not the first ones written", () => {
    const store = makeStore();
    store.appendLoginEvent({
      id: "old",
      member_id: "ada",
      at: "2026-08-01T00:00:00.000Z",
    });
    store.appendLoginEvent({
      id: "new",
      member_id: "ada",
      at: "2026-08-09T00:00:00.000Z",
    });
    expect(store.listLoginEvents("ada", 1).map((event) => event.id)).toEqual(["new"]);
  });

  it("orders same-millisecond rows by insertion, newest first", () => {
    // One profile save stamps every changed field with a single `now`, so this is the ordinary
    // case rather than a contrived one -- and timestamp alone cannot resolve it.
    const store = makeStore();
    const at = "2026-08-26T10:00:00.000Z";
    store.appendUpdateEvent(updateEvent({ id: "first", at }));
    store.appendUpdateEvent(updateEvent({ id: "second", at }));
    expect(store.listUpdateEventsBySlot("profile:location").map((e) => e.id)).toEqual([
      "second",
      "first",
    ]);
  });

  it("leaves subject_member_id absent rather than null when the edit was a self-edit", () => {
    const store = makeStore();
    store.appendUpdateEvent(updateEvent({ id: "self" }));
    const [event] = store.listUpdateEventsByMember("ada");
    // `in`, not a truthiness check: SQL NULL round-tripping as an own property is exactly the
    // divergence this asserts against, and it would pass a `?? undefined` test.
    expect(event && "subject_member_id" in event).toBe(false);
  });

  it("round-trips subject_member_id when an admin edited somebody else", () => {
    const store = makeStore();
    store.appendUpdateEvent(
      updateEvent({
        id: "byAdmin",
        member_id: "grace",
        source: "admin",
        subject_member_id: "ada",
      }),
    );
    expect(store.listUpdateEventsByMember("grace")[0]?.subject_member_id).toBe("ada");
  });

  it("separates the two logs' since-queries by their own timestamps", () => {
    const store = makeStore();
    store.appendLoginEvent({
      id: "old",
      member_id: "ada",
      at: "2026-07-01T00:00:00.000Z",
    });
    store.appendLoginEvent({
      id: "recent",
      member_id: "ada",
      at: "2026-08-26T00:00:00.000Z",
    });
    store.appendUpdateEvent(updateEvent({ id: "recent-update" }));
    expect(store.listLoginEventsSince("2026-08-01T00:00:00.000Z").map((e) => e.id)).toEqual([
      "recent",
    ]);
    expect(store.listUpdateEventsSince("2026-09-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("sqlite store: activity log durability", () => {
  it("keeps both logs across a restart", () => {
    const databasePath = tempDbPath();
    const first = sqliteStore(databasePath);
    first.appendLoginEvent({
      id: "login",
      member_id: "ada",
      at: "2026-08-26T10:00:00.000Z",
    });
    first.appendUpdateEvent(updateEvent({ id: "update" }));

    const second = sqliteStore(databasePath);
    expect(second.listLoginEvents("ada").map((event) => event.id)).toEqual(["login"]);
    expect(second.listUpdateEventsByMember("ada").map((event) => event.id)).toEqual(["update"]);
  });
});

// The lab-wide read, asserted against both stores for the same reason as the rest of this file:
// the service cannot tell them apart, and "newest first" is exactly the kind of thing an array
// filter and an ORDER BY disagree about.
describe.each(stores)("%s store: the recent-edits feed", (_name, makeStore) => {
  it("returns the newest edits first, across every member", () => {
    const store = makeStore();
    store.appendUpdateEvent(updateEvent({ id: "a", at: "2026-03-01T10:00:00.000Z" }));
    store.appendUpdateEvent(
      updateEvent({ id: "b", at: "2026-03-03T10:00:00.000Z", member_id: "grace" }),
    );
    store.appendUpdateEvent(updateEvent({ id: "c", at: "2026-03-02T10:00:00.000Z" }));
    expect(store.listRecentUpdateEvents(10).map((row) => row.id)).toEqual(["b", "c", "a"]);
  });

  it("honours the cap", () => {
    const store = makeStore();
    store.appendUpdateEvent(updateEvent({ id: "a", at: "2026-03-01T10:00:00.000Z" }));
    store.appendUpdateEvent(updateEvent({ id: "b", at: "2026-03-02T10:00:00.000Z" }));
    expect(store.listRecentUpdateEvents(1).map((row) => row.id)).toEqual(["b"]);
  });

  // One save writes a row per changed field, so a whole page of these shares a timestamp.
  it("keeps a stable order for edits made in the same millisecond", () => {
    const store = makeStore();
    const at = "2026-03-01T10:00:00.000Z";
    store.appendUpdateEvent(updateEvent({ id: "a", at }));
    store.appendUpdateEvent(updateEvent({ id: "b", at }));
    expect(store.listRecentUpdateEvents(10).map((row) => row.id)).toEqual(["b", "a"]);
  });
});
