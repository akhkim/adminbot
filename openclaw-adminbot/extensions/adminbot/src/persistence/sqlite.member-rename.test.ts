// The SQLite half of a member-id change: the sweep that finds the id in every table and payload,
// matches it only as a whole value, and rolls everything back on a collision.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotSqliteService } from "./sqlite.js";
import { MEMBER_RENAME_HISTORY_TABLES } from "./sqlite.member-columns.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-rename-"));
  tempDirs.push(dir);
  const instance = createAdminBotSqliteService({ databasePath: path.join(dir, "adminbot.sqlite") });
  const { service, store } = instance;
  for (const [id, name] of [
    ["pat", "Pat"],
    ["pat-lee", "Pat Lee"],
  ] as const) {
    const saved = service.upsertLabMember({ id, name, email: `${id}@cs.toronto.edu` });
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
  }
  const paper = service.upsertPaper({
    id: "paper-1",
    title: "Reliable Research Agents",
    authors: ["Pat", "Pat Lee"],
    current_step: "submission",
  });
  if (!paper.ok) {
    throw new Error(paper.error.message);
  }
  const stored = store.getPaper("paper-1");
  if (!stored) {
    throw new Error("paper not saved");
  }
  store.savePaper({
    ...stored,
    first_author_member_id: "pat",
    // "pat" also appears in prose and inside "pat-lee"; neither is the id and neither may move.
    notes: "pat drafted the intro",
    author_links: [
      { name: "Pat", member_id: "pat" },
      { name: "Pat Lee", member_id: "pat-lee" },
    ],
  });
  for (const id of ["pat", "pat-lee"]) {
    store.saveCredential({
      member_id: id,
      email: `${id}@cs.toronto.edu`,
      password_scrypt: "scrypt$test",
      claimed_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    });
  }
  service.updateSettings({ head_professor_member_id: "pat" });
  return instance;
}

describe("renaming a member id in SQLite", () => {
  it("moves the roster row, credential, paper links and settings, and only the exact id", () => {
    const { service, store } = lab();
    const result = service.renameLabMember({
      memberId: "pat",
      newId: "patricia",
      actorId: "admin",
    });
    expect(result.ok).toBe(true);

    expect(store.getLabMember("pat")).toBeUndefined();
    expect(store.getLabMember("patricia")).toMatchObject({ id: "patricia", name: "Pat" });
    expect(store.getLabMember("pat-lee")).toMatchObject({ id: "pat-lee", name: "Pat Lee" });
    expect(store.getCredentialByMemberId("patricia")?.email).toBe("pat@cs.toronto.edu");
    expect(store.getCredentialByMemberId("pat-lee")?.email).toBe("pat-lee@cs.toronto.edu");
    expect(store.getPaper("paper-1")).toMatchObject({
      first_author_member_id: "patricia",
      notes: "pat drafted the intro",
      author_links: [
        { name: "Pat", member_id: "patricia" },
        { name: "Pat Lee", member_id: "pat-lee" },
      ],
    });
    expect(service.headProfessorMemberId()).toBe("patricia");
    store.close();
  });

  it("changes nothing when a row is already keyed on the new id", () => {
    const { service, store } = lab();
    // A credential left behind by a member who is no longer on the roster.
    store.saveCredential({
      member_id: "ghost",
      email: "ghost@cs.toronto.edu",
      password_scrypt: "scrypt$test",
      claimed_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    });
    const result = service.renameLabMember({ memberId: "pat", newId: "ghost", actorId: "admin" });
    expect(result).toMatchObject({ ok: false, status: 409 });

    expect(store.getLabMember("pat")?.name).toBe("Pat");
    expect(store.getLabMember("ghost")).toBeUndefined();
    expect(store.getPaper("paper-1")?.first_author_member_id).toBe("pat");
    expect(service.headProfessorMemberId()).toBe("pat");
    store.close();
  });

  // The rename discovers tables rather than listing them, and this is the test that holds it to
  // that: one row naming "pat" goes into every table that will take a generic row -- the sessions,
  // notifications, weekly updates, logistics, location shares and the rest added since the rename
  // was written -- and afterwards no table outside the history ones may still name "pat".
  it("re-keys the member in every table that holds a row for them, history aside", () => {
    const { service, store } = lab();
    const db = (store as unknown as { db: DatabaseSync }).db;
    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const textColumns = (table: string) =>
      (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>)
        .filter((column) => column.type === "" || /TEXT|CHAR|CLOB/iu.test(column.type))
        .map((column) => column.name);
    const namesPat = (table: string) =>
      textColumns(table).reduce(
        (count, column) =>
          count +
          Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS n FROM "${table}"
                    WHERE "${column}" = 'pat' OR instr("${column}", '"pat"') > 0`,
                )
                .get() as { n: number }
            ).n,
          ),
        0,
      );
    const seeded: string[] = [];
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
        type: string;
      }>;
      const values = columns.map((column, index) => {
        if (/INT|REAL|NUM|BOOL/iu.test(column.type)) {
          return index + 1;
        }
        if (column.name.endsWith("_json")) {
          return JSON.stringify({ member_id: "pat", attendees: { pat: "yes" }, note: "pat said" });
        }
        if (/member_id$|_by$|^actor/u.test(column.name)) {
          return "pat";
        }
        return `${table}.${column.name}.seed`;
      });
      try {
        db.prepare(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c.name}"`).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})`,
        ).run(...values);
        seeded.push(table);
      } catch {
        // A CHECK, a foreign key or a row "pat" already has: lab() seeded those tables itself.
      }
    }
    // The newer tables are the point; each of these has to have been exercised.
    expect(seeded).toEqual(
      expect.arrayContaining([
        "adminbot_sessions",
        "adminbot_member_notifications",
        "adminbot_paper_weekly_updates",
        "adminbot_logistics_requests",
        "adminbot_tab_visits",
        "adminbot_update_events",
        "adminbot_login_events",
        "adminbot_proposals",
      ]),
    );
    const papersBefore = store.paperVersion();

    const result = service.renameLabMember({
      memberId: "pat",
      newId: "patricia",
      actorId: "admin",
    });
    expect(result.ok).toBe(true);

    const stillNamingPat = tables
      .filter((table) => !MEMBER_RENAME_HISTORY_TABLES.has(table))
      .filter((table) => namesPat(table) > 0);
    expect(stillNamingPat).toEqual([]);
    // The ledger row (status "…seed", so neither pending nor approved) is history and keeps the id.
    expect(namesPat("adminbot_proposals")).toBe(1);
    // Written past the store's own methods, so the roster cache and the ETag counters had to hear.
    expect(store.getLabMember("patricia")?.name).toBe("Pat");
    expect(store.paperVersion()).not.toBe(papersBefore);
    store.close();
  });

  it("waits for an open action that names the member, then leaves the ledger as history", () => {
    const { service, store } = lab();
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare(
      `INSERT INTO adminbot_proposals
        (id, status, action_type, risk_tier, payload_hash, created_at, updated_at, payload_json)
        VALUES ('act_guide', 'pending', 'onboarding.send_guide', 'low', 'hash',
                '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`,
    ).run(JSON.stringify({ id: "act_guide", status: "pending", target: { member_id: "pat" } }));

    const blocked = service.renameLabMember({
      memberId: "pat",
      newId: "patricia",
      actorId: "admin",
    });
    expect(blocked).toMatchObject({ ok: false, status: 409 });
    expect(blocked.ok ? "" : blocked.error.message).toContain("act_guide");
    expect(store.getLabMember("pat")?.name).toBe("Pat");
    expect(store.getLabMember("patricia")).toBeUndefined();

    // Once it has run, its payload is a record of what was approved and stays as it was.
    db.prepare(`UPDATE adminbot_proposals SET status = 'executed' WHERE id = 'act_guide'`).run();
    expect(
      service.renameLabMember({ memberId: "pat", newId: "patricia", actorId: "admin" }).ok,
    ).toBe(true);
    const { payload_json } = db
      .prepare(`SELECT payload_json FROM adminbot_proposals WHERE id = 'act_guide'`)
      .get() as { payload_json: string };
    expect(JSON.parse(payload_json)).toMatchObject({ target: { member_id: "pat" } });
    store.close();
  });
});
