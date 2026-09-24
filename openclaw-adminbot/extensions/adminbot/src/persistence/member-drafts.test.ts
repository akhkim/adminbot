import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AdminBotSqliteStore } from "./sqlite.js";
import { createMemberDraftStore } from "./member-drafts.js";

it("keeps private drafts and revision checks across a SQLite restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "member-drafts-"));
  const filename = path.join(directory, "state.sqlite");
  const first = new AdminBotSqliteStore(filename);
  try {
    expect(
      first.memberDraftStore().write("ada", "book-meeting", 0, "first", { purpose: "test" })
        ?.revision,
    ).toBe(1);
  } finally {
    first.close();
  }
  const second = new AdminBotSqliteStore(filename);
  try {
    expect(second.memberDraftStore().read("ada", "book-meeting")?.data).toEqual({
      purpose: "test",
    });
    expect(second.memberDraftStore().read("bob", "book-meeting")).toBeNull();
    expect(second.memberDraftStore().write("ada", "book-meeting", 0, "stale", null)).toBeNull();
  } finally {
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not throw when a stored draft is not JSON", () => {
  const require = createRequire(import.meta.url);
  const sqlite = require("node:sqlite") as typeof import("node:sqlite");
  const db = new sqlite.DatabaseSync(":memory:");
  const store = createMemberDraftStore(db);
  store.write("ada", "book-meeting", 0, "first", { purpose: "test" });
  db.prepare(
    "UPDATE adminbot_member_drafts SET data_json = ? WHERE member_id = ? AND draft_key = ?",
  ).run("not-json", "ada", "book-meeting");
  expect(store.read("ada", "book-meeting")).toEqual({
    revision: 1,
    mutationId: "first",
    data: null,
  });
});
