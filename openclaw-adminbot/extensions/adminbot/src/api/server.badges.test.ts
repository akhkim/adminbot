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
    `adminbot-badges-sensitive-info-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
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

describe("AdminBot badge routes", () => {
  it("lets members self-nominate and admins approve the nomination", async () => {
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
    const adminToken = await loginToken(baseUrl, "admin@cs.toronto.edu");
    const memberToken = await loginToken(baseUrl, "pat@cs.toronto.edu");

    const nominate = await fetch(`${baseUrl}/badges/nominations`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${memberToken}` }),
      body: JSON.stringify({
        badge_id: "community_building__ambassador",
        evidence: "Organized a conference outreach booth.",
      }),
    });
    expect(nominate.status).toBe(200);
    const nomination = ((await nominate.json()) as { nomination: { id: string; status: string } })
      .nomination;
    expect(nomination.status).toBe("pending");

    const pending = await fetch(`${baseUrl}/badges/nominations?status=pending`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toMatchObject({
      nominations: [expect.objectContaining({ id: nomination.id, member_id: "pat" })],
    });

    const approve = await fetch(`${baseUrl}/badges/nominations/${nomination.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${adminToken}` }),
      body: JSON.stringify({}),
    });
    expect(approve.status).toBe(200);
    await expect(approve.json()).resolves.toMatchObject({
      nomination: expect.objectContaining({ status: "approved" }),
      assignment: expect.objectContaining({ badge_id: "community_building__ambassador" }),
    });

    const members = await fetch(`${baseUrl}/lab/members`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    await expect(members.json()).resolves.toMatchObject({
      members: [
        expect.objectContaining({
          id: "admin",
        }),
        expect.objectContaining({
          id: "pat",
          assigned_badges: [
            expect.objectContaining({ badge_id: "community_building__ambassador" }),
          ],
        }),
      ],
    });
  });

  it("keeps the shared service principal out of member-specific nomination routes", async () => {
    const { baseUrl } = await startService();

    const res = await fetch(`${baseUrl}/badges/nominations`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });

    expect(res.status).toBe(401);
  });

  it("generates a badge id at the backend and rejects nominations without evidence", async () => {
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
    const adminToken = await loginToken(baseUrl, "admin@cs.toronto.edu");
    const memberToken = await loginToken(baseUrl, "pat@cs.toronto.edu");

    const created = await fetch(`${baseUrl}/badges`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${adminToken}` }),
      body: JSON.stringify({
        category: "Team Contributor",
        name: "Docs Champion",
        description: "Wrote the docs.",
      }),
    });
    expect(created.status).toBe(200);
    const badge = ((await created.json()) as { badge: { id: string } }).badge;
    expect(badge.id).toMatch(/^badge_/u);

    const assign = await fetch(`${baseUrl}/badges/assignments`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${adminToken}` }),
      body: JSON.stringify({ member_id: "pat", badge_id: badge.id, evidence: "Shipped the guide." }),
    });
    expect(assign.status).toBe(200);
    await expect(assign.json()).resolves.toMatchObject({
      assignment: expect.objectContaining({ evidence: "Shipped the guide." }),
    });

    const noEvidence = await fetch(`${baseUrl}/badges/nominations`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${memberToken}` }),
      body: JSON.stringify({ badge_id: "community_building__ambassador" }),
    });
    expect(noEvidence.status).toBe(400);
  });
});
