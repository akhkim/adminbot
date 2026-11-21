// The Lab Projects list is cached until one of its tables changes, and the change counters are
// kept by SQLite triggers, so the cache must notice every write: through the store, and straight
// to the file from another connection (a script, a second process).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotSqliteService } from "./sqlite.js";

// The store batches a turn's reads in one transaction, so another process's write shows from the
// next turn of the event loop.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-row-versions-"));
  tempDirs.push(dir);
  const databasePath = path.join(dir, "adminbot.sqlite");
  const instance = createAdminBotSqliteService({ databasePath });
  const member = instance.service.upsertLabMember({
    id: "pat",
    name: "Pat",
    email: "pat@cs.toronto.edu",
  });
  if (!member.ok) {
    throw new Error(member.error.message);
  }
  const paper = instance.service.upsertPaper({
    id: "paper-1",
    title: "Reliable Research Agents",
    authors: ["Pat"],
    current_step: "submission",
  });
  if (!paper.ok) {
    throw new Error(paper.error.message);
  }
  return { ...instance, databasePath };
}

function projects(service: ReturnType<typeof lab>["service"], now?: string) {
  const result = service.listLabProjects(now);
  if (!result.ok) {
    throw new Error("listLabProjects failed");
  }
  return result.payload.projects;
}

describe("row versions", () => {
  it("move on insert, update and delete, and stay put on reads", () => {
    const { store } = lab();
    const tables = ["adminbot_paper_slots"] as const;
    const before = store.rowVersion(tables);
    store.listPaperSlots();
    expect(store.rowVersion(tables)).toBe(before);

    const slot = { paper_id: "paper-1", slot: "slides", status: "provided" } as const;
    store.savePaperSlot({ ...slot, url: "https://docs.google.com/presentation/d/a" });
    const inserted = store.rowVersion(tables);
    expect(inserted).not.toBe(before);
    store.savePaperSlot({ ...slot, url: "https://docs.google.com/presentation/d/b" });
    expect(store.rowVersion(tables)).not.toBe(inserted);
  });

  it("see writes made to the file by another connection", async () => {
    const { store, databasePath } = lab();
    const tables = ["adminbot_papers"] as const;
    const before = store.rowVersion(tables);
    const other = new DatabaseSync(databasePath);
    try {
      other.prepare("UPDATE adminbot_papers SET updated_at = '2026-11-20T00:00:00.000Z' WHERE id = 'paper-1'").run();
    } finally {
      other.close();
      await nextTurn();
    }
    expect(store.rowVersion(tables)).not.toBe(before);
  });
});

describe("the cached Lab Projects list", () => {
  it("is built once while its tables are unchanged", () => {
    const { service } = lab();
    const first = projects(service);
    const second = projects(service);
    expect(second[0]).toBe(first[0]);
  });

  it("is rebuilt after a slot is filed", () => {
    const { service, store } = lab();
    expect(projects(service)[0]?.links.slides).toBeNull();
    store.savePaperSlot({
      paper_id: "paper-1",
      slot: "slides",
      status: "provided",
      url: "https://docs.google.com/presentation/d/new",
    });
    expect(projects(service)[0]?.links.slides).toEqual({
      url: "https://docs.google.com/presentation/d/new",
    });
  });

  it("re-dates status on every read, without rebuilding", () => {
    const { service } = lab();
    const today = projects(service)[0];
    expect(today?.status).toBe("active");
    // Thirty years on, the same cached row reads as dormant.
    const later = projects(service, "2056-01-01T00:00:00.000Z")[0];
    expect(later?.status).toBe("dormant");
    expect(later?.title).toBe(today?.title);
    expect(projects(service)[0]).toBe(today);
  });
});
