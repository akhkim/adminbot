import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../contracts/actions.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-members-"));
  dirs.push(dir);
  const file = path.join(dir, "adminbot.sqlite");
  return { file, store: new AdminBotSqliteStore(file) };
}

function member(id: string, name: string, extra: Partial<AdminBotLabMember> = {}) {
  return {
    id,
    name,
    privilege_level: "member",
    updated_at: "2026-10-07T00:00:00.000Z",
    ...extra,
  } as AdminBotLabMember;
}

// The roster is ~6MB of JSON on Aurora (base64 avatars, onboarding), read by most requests and
// 40-odd sweeps. It is parsed once and kept until something writes a member.
describe("lab member reads", () => {
  it("serves repeat reads from memory", () => {
    const { store } = openStore();
    store.saveLabMember(member("b", "Bea"));
    store.saveLabMember(member("a", "Ada"));

    const ada = store.getLabMember("a");
    expect(ada?.name).toBe("Ada");
    expect(store.getLabMember("a")).toBe(ada);
    expect(store.listLabMembers().map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(store.listLabMembers()[0]).toBe(ada);
  });

  it("sees every write made through the store", () => {
    const { store } = openStore();
    store.saveLabMember(member("a", "Ada"));
    store.getLabMember("a");

    store.saveLabMember(member("a", "Ada Lovelace"));
    expect(store.getLabMember("a")?.name).toBe("Ada Lovelace");

    store.patchLabMemberAuthFields("a", {
      updated_at: "2026-10-08T00:00:00.000Z",
    } as Parameters<AdminBotSqliteStore["patchLabMemberAuthFields"]>[1]);
    expect(store.getLabMember("a")?.updated_at).toBe("2026-10-08T00:00:00.000Z");

    store.saveLabMember(member("b", "Bea"));
    expect(store.listLabMembers().map((entry) => entry.id)).toEqual(["a", "b"]);

    expect(store.deleteLabMember("a")).toBe(true);
    expect(store.getLabMember("a")).toBeUndefined();
    expect(store.listLabMembers().map((entry) => entry.id)).toEqual(["b"]);
  });

  it("sees a write made by another process", () => {
    const { file, store } = openStore();
    store.saveLabMember(member("a", "Ada"));
    expect(store.getLabMember("a")?.name).toBe("Ada");

    const other = new DatabaseSync(file);
    other
      .prepare("UPDATE adminbot_lab_members SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(member("a", "Ada (renamed elsewhere)")), "a");
    other.close();

    expect(store.getLabMember("a")?.name).toBe("Ada (renamed elsewhere)");
  });

  it("hands callers a list they may reorder without touching the cache", () => {
    const { store } = openStore();
    store.saveLabMember(member("a", "Ada"));
    store.saveLabMember(member("b", "Bea"));

    store.listLabMembers().reverse();
    expect(store.listLabMembers().map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("builds summaries without stripping the cached member", () => {
    const { store } = openStore();
    store.saveLabMember(
      member("a", "Ada", { field_provenance: { name: "roster" } } as Partial<AdminBotLabMember>),
    );
    store.getLabMember("a");

    expect(store.listLabMemberSummaries()[0]).not.toHaveProperty("field_provenance");
    expect(store.getLabMember("a")).toHaveProperty("field_provenance");
  });
});
