import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adminbotServiceDatabasePath } from "../../scripts/adminbot-service-database.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("AdminBot service database path", () => {
  it("defaults to the database the service host opens", () => {
    // createAdminBotHost opens path.join(repoRoot, "state/adminbot.sqlite"). Read it from the host
    // rather than restating it, so moving the host's database fails here instead of silently
    // splitting the scripts from the service again.
    const host = fs.readFileSync(path.join(repoRoot, "extensions/adminbot/host/main.ts"), "utf8");
    const relative = host.match(/databasePath:\s*path\.join\(repoRoot,\s*"([^"]+)"\)/)?.[1];
    expect(relative).toBeDefined();
    expect(adminbotServiceDatabasePath({})).toBe(path.join(repoRoot, relative!));
  });

  it("honours ADMINBOT_DB_PATH, ignoring a blank one", () => {
    expect(adminbotServiceDatabasePath({ ADMINBOT_DB_PATH: "/srv/state/x.sqlite" })).toBe(
      "/srv/state/x.sqlite",
    );
    expect(adminbotServiceDatabasePath({ ADMINBOT_DB_PATH: "  " })).toBe(
      adminbotServiceDatabasePath({}),
    );
  });
});
