import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminBotSqliteService } from "../../extensions/adminbot/src/persistence/sqlite.js";
import { AdminBotAuthService } from "../../extensions/adminbot/src/workflows/identity/auth.js";
import { parseDevMembers, seedAdminBotDev } from "../../scripts/seed-adminbot-dev.js";

const fixturePath = fileURLToPath(new URL("../../dev/fixtures/members.json", import.meta.url));
const password = "Local-test-password-123!";
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-fixtures-"));
  dirs.push(dir);
  return path.join(dir, "adminbot-dev.sqlite");
}

function open(databasePath: string) {
  const db = createAdminBotSqliteService({ databasePath });
  const auth = new AdminBotAuthService({
    store: db.store,
    prepareMember: (member) => {
      const result = db.service.prepareLabMember(member);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.payload;
    },
    afterMemberCreated: (member) => db.service.afterMemberCreated(member),
  });
  return { ...db, auth };
}

describe("local development member fixtures", () => {
  it("persists all fixture roles and usable logins without external calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Fixture seeding must not fetch anything");
    });
    const databasePath = database();
    const fixture = parseDevMembers(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
    expect(await seedAdminBotDev({ databasePath, fixturePath, password })).toMatchObject({
      members: fixture.length,
      accountsCreated: fixture.length,
    });
    const db = open(databasePath);
    try {
      expect(db.store.listLabMembers()).toHaveLength(fixture.length);
      for (const member of fixture) {
        expect(db.store.getLabMember(member.id)).toMatchObject(member);
        const login = await db.auth.login({ email: member.email, password });
        expect(login.ok).toBe(true);
        if (login.ok) {
          expect(login.payload.member.id).toBe(member.id);
          expect(login.payload.member.privilege_level).toBe(member.privilege_level);
        }
      }
      expect(await db.auth.listRegistrations("pending")).toHaveLength(0);
      expect(
        db.store
          .listAuditEvents()
          .some(
            (event) =>
              event.type === "auth.approval_email_sent" ||
              event.type === "auth.calendar_invite_sent",
          ),
      ).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("updates the same profiles without resetting passwords or removing unrelated members", async () => {
    const databasePath = database();
    await seedAdminBotDev({ databasePath, password });
    const first = open(databasePath);
    let hash: string | undefined;
    try {
      hash = first.store.getCredentialByMemberId("dev-bob")?.password_scrypt;
      expect(first.service.upsertLabMember({ id: "dev-bob", name: "Edited Name" }).ok).toBe(true);
      expect(first.service.upsertLabMember({ id: "unrelated", name: "Unrelated Example" }).ok).toBe(
        true,
      );
    } finally {
      first.close();
    }
    expect(
      (await seedAdminBotDev({ databasePath, password: "Another-local-password!" }))
        .accountsCreated,
    ).toBe(0);
    const second = open(databasePath);
    try {
      expect(second.store.listLabMembers()).toHaveLength(6);
      expect(second.store.getLabMember("dev-bob")?.name).toBe("Bob Example");
      expect(second.store.getCredentialByMemberId("dev-bob")?.password_scrypt).toBe(hash);
      expect((await second.auth.login({ email: "bob@example.test", password })).ok).toBe(true);
    } finally {
      second.close();
    }
  });

  it("rejects invalid fixtures before creating a database", async () => {
    const databasePath = database();
    const invalidFixture = path.join(path.dirname(databasePath), "invalid.json");
    fs.writeFileSync(
      invalidFixture,
      JSON.stringify([
        { id: "dev-valid", name: "Valid Example", email: "valid@example.test" },
        {
          id: "dev-invalid",
          name: "Invalid Example",
          email: "invalid@example.test",
          hours_per_week: 200,
        },
      ]),
    );
    await expect(
      seedAdminBotDev({ databasePath, fixturePath: invalidFixture, password }),
    ).rejects.toThrow(/hours/u);
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it.each([
    [{ id: "real-id", name: "Example", email: "example@example.test" }],
    [{ id: "dev-a", name: "Example", email: "person@real-domain.invalid" }],
    [{ id: "dev-a", name: "Example", email: "a@example.test", privilege_level: "superadmin" }],
    [{ id: "dev-a", name: "Example", email: "a@example.test", password: "embedded-password" }],
    [{ id: "dev-a", name: "Example", email: "a@example.test", access_overrides: [] }],
    [
      { id: "dev-a", name: "Example", email: "a@example.test" },
      { id: "dev-b", name: "Example", email: "a@example.test" },
    ],
  ])("rejects non-fixture identities, privileges and unsupported fields: %j", (...rows) => {
    expect(() => parseDevMembers(rows)).toThrow();
  });

  it("refuses the normal database and a symlink to it", async () => {
    const databasePath = database();
    const normal = path.join(path.dirname(databasePath), "adminbot.sqlite");
    await expect(seedAdminBotDev({ databasePath: normal, password })).rejects.toThrow(
      /development database/u,
    );
    fs.writeFileSync(normal, "leave alone");
    fs.symlinkSync(normal, databasePath);
    await expect(seedAdminBotDev({ databasePath, password })).rejects.toThrow(
      /development database/u,
    );
    expect(fs.readFileSync(normal, "utf8")).toBe("leave alone");
  });

  it("refuses an identity collision before inserting other fixture members", async () => {
    const databasePath = database();
    const first = open(databasePath);
    try {
      expect(
        first.service.upsertLabMember({
          id: "dev-erin",
          name: "Different Example",
          email: "different@example.test",
        }).ok,
      ).toBe(true);
    } finally {
      first.close();
    }
    await expect(seedAdminBotDev({ databasePath, password })).rejects.toThrow(/collision/u);
    const second = open(databasePath);
    try {
      expect(second.store.listLabMembers()).toHaveLength(1);
      expect(second.store.getCredentialByMemberId("dev-alice")).toBeUndefined();
    } finally {
      second.close();
    }
  });

  it("requires a password supplied outside the fixture", async () => {
    const databasePath = database();
    await expect(seedAdminBotDev({ databasePath, password: "short" })).rejects.toThrow(
      /at least 10/u,
    );
    expect(fs.existsSync(databasePath)).toBe(false);
  });
});
