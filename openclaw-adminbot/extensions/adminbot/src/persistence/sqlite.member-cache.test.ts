import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../contracts/actions.js";
import { buildInitialOnboarding } from "../workflows/onboarding/onboarding.js";
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

// A member row keeps per-step state and the cycle clock; the step copy is the catalog's, attached
// on read. Rows written before that, with the full copy and the derived lists, read the same way.
describe("stored onboarding", () => {
  const storedRow = (file: string, id: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT payload_json FROM adminbot_lab_members WHERE id = ?")
        .get(id) as { payload_json: string };
      return JSON.parse(row.payload_json) as Record<string, unknown>;
    } finally {
      db.close();
    }
  };

  it("writes step state only and reads the catalog text back", () => {
    const { file, store } = openStore();
    const onboarding = {
      ...buildInitialOnboarding("2026-10-01T00:00:00.000Z"),
      last_nudged_at: "2026-10-05T00:00:00.000Z",
    };
    const linkedin = onboarding.steps.find((step) => step.id === "linkedin")!;
    Object.assign(linkedin, { status: "complete", acknowledged_at: "2026-10-02T00:00:00.000Z" });
    store.saveLabMember(member("a", "Ada", { onboarding }));

    const stored = storedRow(file, "a").onboarding as {
      steps: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    expect(Object.keys(stored).toSorted()).toEqual([
      "last_nudged_at",
      "opened_at",
      "reason",
      "steps",
    ]);
    for (const step of stored.steps) {
      expect(
        Object.keys(step).every((key) => ["id", "status", "acknowledged_at"].includes(key)),
      ).toBe(true);
    }
    expect(stored.steps.find((step) => step.id === "linkedin")).toEqual({
      id: "linkedin",
      status: "complete",
      acknowledged_at: "2026-10-02T00:00:00.000Z",
    });

    const read = new AdminBotSqliteStore(file).getLabMember("a")!.onboarding!;
    expect(read).toMatchObject({
      opened_at: "2026-10-01T00:00:00.000Z",
      reason: "registration",
      last_nudged_at: "2026-10-05T00:00:00.000Z",
    });
    expect(read.steps.map((step) => step.id)).toEqual(onboarding.steps.map((step) => step.id));
    expect(read.steps.find((step) => step.id === "linkedin")).toMatchObject({
      label: linkedin.label,
      status: "complete",
      acknowledged_at: "2026-10-02T00:00:00.000Z",
    });
  });

  it("reads a legacy full-text row without rewriting it at open", () => {
    const { file, store } = openStore();
    store.saveLabMember(member("a", "Ada"));
    const legacyStep = {
      id: "linkedin",
      label: "Stale label",
      category: "Stale",
      status: "complete",
      required: true,
      detail: "Stale copy from signup day.",
      acknowledged_at: "2026-07-29T10:00:00Z",
    };
    const legacy = JSON.stringify(
      member("a", "Ada", {
        onboarding: {
          current_step: legacyStep,
          completed: [legacyStep],
          remaining: [],
          steps: [legacyStep],
          opened_at: "2026-07-01T00:00:00.000Z",
        } as never,
      }),
    );
    const db = new DatabaseSync(file);
    db.prepare("UPDATE adminbot_lab_members SET payload_json = ? WHERE id = 'a'").run(legacy);
    db.close();

    const reopened = new AdminBotSqliteStore(file);
    const read = reopened.getLabMember("a")!.onboarding!;
    expect(Object.keys(read).toSorted()).toEqual(["opened_at", "steps"]);
    expect(read.steps.find((step) => step.id === "linkedin")).toMatchObject({
      status: "complete",
      acknowledged_at: "2026-07-29T10:00:00Z",
    });
    expect(read.steps.find((step) => step.id === "linkedin")?.label).not.toBe("Stale label");
    expect(read.steps.length).toBeGreaterThan(1);
    // Opening the store reads the old shape; only the next save writes the new one.
    expect(JSON.stringify(storedRow(file, "a"))).toBe(legacy);
  });
});
