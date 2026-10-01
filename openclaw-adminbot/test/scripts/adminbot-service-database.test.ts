import path from "node:path";
import { describe, expect, it } from "vitest";
import { adminbotServiceDatabasePath } from "../../scripts/adminbot-service-database.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("AdminBot service database path", () => {
  it("defaults to the database the service host opens", () => {
    // createAdminBotHost opens path.join(repoRoot, "state/adminbot.sqlite"); a script filing
    // meetings anywhere else files them where the Meetings tab cannot see them.
    expect(adminbotServiceDatabasePath({})).toBe(path.join(repoRoot, "state/adminbot.sqlite"));
  });

  it("never falls back to the home-directory copy", () => {
    expect(adminbotServiceDatabasePath({ HOME: "/home/someone" })).not.toContain(".openclaw");
  });

  it("honours ADMINBOT_DB_PATH, ignoring a blank one", () => {
    expect(adminbotServiceDatabasePath({ ADMINBOT_DB_PATH: "/srv/state/x.sqlite" })).toBe(
      "/srv/state/x.sqlite",
    );
    expect(adminbotServiceDatabasePath({ ADMINBOT_DB_PATH: "  " })).toBe(
      path.join(repoRoot, "state/adminbot.sqlite"),
    );
  });
});
