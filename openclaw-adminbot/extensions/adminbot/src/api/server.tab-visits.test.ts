// The usage log over HTTP: who may write it, and who may read it.
//
// The split is the whole point of having routes at all here. Writing is something any signed-in
// member does constantly and only ever about themselves; reading is everybody's browsing at once,
// which is the lab's data and a governance read. A hidden tab is not what enforces that -- this is.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

type RunningService = {
  baseUrl: string;
  mock: ReturnType<typeof createAdminBotMockService>;
  cleanupPaths: string[];
};

const running: RunningService[] = [];

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
    for (const cleanupPath of entry.cleanupPaths) {
      await rm(cleanupPath, { force: true });
    }
  }
});

async function startService() {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-tab-visits-sensitive-info-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsRosterRecorder: async () => ({
      username: "stub@cs.toronto.edu",
      password: "stub",
      candidates: ["stub@cs.toronto.edu"],
    }),
  });
  await new Promise<void>((resolve, reject) => {
    mock.server.once("error", reject);
    mock.server.listen(0, "127.0.0.1", () => {
      mock.server.off("error", reject);
      resolve();
    });
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  running.push({ baseUrl, mock, cleanupPaths: [sensitiveInfoPath] });
  return { baseUrl, mock };
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function seedMember(
  mock: ReturnType<typeof createAdminBotMockService>,
  input: AdminBotLabMemberInput,
): void {
  const result = mock.service.upsertLabMember(input);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

async function approveClaim(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
  memberId: string,
  email: string,
): Promise<void> {
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ member_id: memberId, email, password: "correcthorse" }),
  });
  const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  const registration = (
    (await pending.json()) as { registrations: Array<{ id: string; member_id?: string }> }
  ).registrations.find((entry) => entry.member_id === memberId);
  if (!registration) {
    throw new Error(`no pending registration for ${memberId}`);
  }
  const approved = mock.auth.approveRegistration(registration.id, "seed-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
}

async function loginToken(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  return ((await res.json()) as { session_token: string }).session_token;
}

async function seedSignedIn(): Promise<{
  baseUrl: string;
  mock: ReturnType<typeof createAdminBotMockService>;
  adminToken: string;
  memberToken: string;
}> {
  const { baseUrl, mock } = await startService();
  seedMember(mock, {
    id: "admin",
    name: "Admin",
    email: "admin@cs.toronto.edu",
    privilege_level: "admin",
  });
  seedMember(mock, {
    id: "pat",
    name: "Pat",
    email: "pat@cs.toronto.edu",
    privilege_level: "member",
  });
  await approveClaim(mock, baseUrl, "admin", "admin@cs.toronto.edu");
  await approveClaim(mock, baseUrl, "pat", "pat@cs.toronto.edu");
  return {
    baseUrl,
    mock,
    adminToken: await loginToken(baseUrl, "admin@cs.toronto.edu"),
    memberToken: await loginToken(baseUrl, "pat@cs.toronto.edu"),
  };
}

function postVisit(baseUrl: string, token: string | null, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/ui/tab-visits`, {
    method: "POST",
    headers: jsonHeaders(token ? { Authorization: `Bearer ${token}` } : {}),
    body: JSON.stringify(body),
  });
}

describe("AdminBot tab visit routes", () => {
  it("records a signed-in member's own visit", async () => {
    const { baseUrl, memberToken, adminToken } = await seedSignedIn();
    expect((await postVisit(baseUrl, memberToken, { tab: "adminbotPapers" })).status).toBe(200);

    const read = await fetch(`${baseUrl}/ui/tab-visits?days=7`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const report = (await read.json()) as {
      visits: number;
      tabs: Array<{ tab: string; visits: number; members: number }>;
    };
    expect(report.visits).toBe(1);
    expect(report.tabs).toEqual([
      expect.objectContaining({ tab: "adminbotPapers", visits: 1, members: 1 }),
    ]);
  });

  it("files the visit against the session, not against whatever the body claims", async () => {
    // The body is member-supplied. If it could name the member, any signed-in account could write
    // somebody else's browsing history, and the log would be worthless as evidence of anything.
    const { baseUrl, memberToken, adminToken } = await seedSignedIn();
    await postVisit(baseUrl, memberToken, { tab: "profile", member_id: "admin" });

    const rows = await fetch(`${baseUrl}/ui/tab-visits/rows?days=7`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const { visits } = (await rows.json()) as { visits: Array<{ member_id: string }> };
    expect(visits.map((row) => row.member_id)).toEqual(["pat"]);
  });

  it("refuses a visit from a caller with no session", async () => {
    const { baseUrl } = await seedSignedIn();
    expect((await postVisit(baseUrl, null, { tab: "dashboard" })).status).toBe(401);
  });

  it("refuses a visit with no tab", async () => {
    const { baseUrl, memberToken } = await seedSignedIn();
    expect((await postVisit(baseUrl, memberToken, {})).status).toBe(400);
  });

  it("keeps the lab-wide read to admins", async () => {
    // The member may write their own visits all day and still may not read the lab's.
    const { baseUrl, memberToken } = await seedSignedIn();
    await postVisit(baseUrl, memberToken, { tab: "dashboard" });
    for (const route of ["/ui/tab-visits", "/ui/tab-visits/rows"]) {
      const res = await fetch(`${baseUrl}${route}`, {
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      expect(res.status, route).toBe(403);
    }
  });

  it("reports the window it measured, clamped", async () => {
    const { baseUrl, adminToken } = await seedSignedIn();
    const res = await fetch(`${baseUrl}/ui/tab-visits?days=99999`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const report = (await res.json()) as { days: number; from: string; to: string };
    expect(report.days).toBe(365);
    expect(Date.parse(report.from)).toBeLessThan(Date.parse(report.to));
  });

  it("treats a nonsense window as the default rather than as an error", async () => {
    const { baseUrl, adminToken } = await seedSignedIn();
    const res = await fetch(`${baseUrl}/ui/tab-visits?days=lots`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { days: number }).days).toBe(30);
  });
});
