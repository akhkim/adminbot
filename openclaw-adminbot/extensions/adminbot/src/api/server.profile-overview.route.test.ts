// GET /members/profile-overview over HTTP: the Lab Overview rows leave out what the page fills in.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

const running: { mock: ReturnType<typeof createAdminBotMockService>; cleanup: string }[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    await rm(entry.cleanup, { force: true });
  }
});

describe("GET /members/profile-overview", () => {
  it("sends a dormant member as the fields that tell them apart, and the roll-up in full", async () => {
    const sensitiveInfoPath = path.join(
      os.tmpdir(),
      `adminbot-profile-overview-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    );
    const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN, sensitiveInfoPath });
    await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
    running.push({ mock, cleanup: sensitiveInfoPath });
    const address = mock.server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing mock service address");
    }
    for (const [id, privilege_level] of [
      ["ada", "member"],
      ["zhijing", "admin"],
    ] as const) {
      expect(mock.service.upsertLabMember({ id, name: id, privilege_level }).ok).toBe(true);
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/members/profile-overview`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Record<string, unknown>[];
      mandatory_field_count: number;
      adoption: { members: number };
    };
    const full = mock.service.listMemberProfileOverview();
    if (!full.ok) {
      throw new Error("overview failed");
    }
    expect(body.adoption).toEqual(full.payload.adoption);
    expect(body.mandatory_field_count).toBe(full.payload.mandatory_field_count);

    const ada = body.members.find((row) => row.id === "ada");
    const admin = body.members.find((row) => row.id === "zhijing");
    // Creating the record is itself an audited edit, so `activity` is sent; the unit test covers
    // a row whose activity is all zero.
    for (const key of ["privilege_level", "projects", "timeline"]) {
      expect(ada).not.toHaveProperty(key);
    }
    expect(admin?.privilege_level).toBe("admin");
    // Gaps are what the page is for: a member who owes fields still lists them.
    const fullAda = full.payload.members.find((row) => row.id === "ada");
    expect(ada?.missing_fields ?? []).toEqual(fullAda?.missing_fields);
  });
});
