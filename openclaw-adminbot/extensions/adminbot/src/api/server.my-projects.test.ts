import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

const running: Array<{ mock: ReturnType<typeof createAdminBotMockService>; cleanup: string }> = [];

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

async function startService() {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-my-projects-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
  });
  await new Promise<void>((resolve) => {
    mock.server.listen(0, "127.0.0.1", resolve);
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  running.push({ mock, cleanup: sensitiveInfoPath });
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

async function memberToken(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
  memberId: string,
): Promise<string> {
  const email = `${memberId}@example.test`;
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ member_id: memberId, email, password: "correcthorse" }),
  });
  const pending = (await (
    await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    })
  ).json()) as { registrations: Array<{ id: string; member_id?: string }> };
  const registration = pending.registrations.find((entry) => entry.member_id === memberId);
  if (!registration) {
    throw new Error(`no pending registration for ${memberId}`);
  }
  await mock.auth.approveRegistration(registration.id, "seed-admin");
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  return ((await login.json()) as { session_token: string }).session_token;
}

describe("GET /my/projects", () => {
  it("lists only the signed-in member's active papers, whatever the query says", async () => {
    const { baseUrl, mock } = await startService();
    for (const id of ["viewer", "stranger"]) {
      const seeded = mock.service.upsertLabMember({
        id,
        name: id === "viewer" ? "Viewer Person" : "Stranger Person",
        email: `${id}@example.test`,
        privilege_level: "member",
      });
      expect(seeded.ok).toBe(true);
    }
    const link = (id: string) => [{ name: id, member_id: id }];
    for (const input of [
      { id: "mine", title: "Mine", author_links: link("viewer") },
      { id: "rejected", title: "Rejected", author_links: link("viewer"), venue_decision: "reject" },
      { id: "theirs", title: "Theirs", author_links: link("stranger") },
    ] as const) {
      const saved = mock.service.upsertPaper({
        authors: [],
        current_step: "overleaf_writing",
        ...input,
      });
      expect(saved.ok).toBe(true);
    }

    const route = `${baseUrl}/my/projects`;
    expect((await fetch(route)).status).toBe(401);
    expect(
      (await fetch(route, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status,
    ).toBe(403);

    const token = await memberToken(mock, baseUrl, "viewer");
    const response = await fetch(`${route}?member_id=stranger`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      projects: Array<{ paper_id: string; lanes: Record<string, { open: number }> }>;
    };
    expect(body.projects.map((project) => project.paper_id)).toEqual(["mine"]);
    expect(Object.keys(body.projects[0]?.lanes ?? {}).toSorted()).toEqual([
      "archive",
      "core",
      "social",
      "talk",
      "venue",
    ]);
  });
});
