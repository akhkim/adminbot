// The SQLite half of a member-id change: the sweep that finds the id in every table and payload,
// matches it only as a whole value, and rolls everything back on a collision.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotSqliteService } from "./sqlite.js";

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
});
