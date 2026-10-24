import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
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
    `adminbot-collaborators-sensitive-info-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
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
  const result = mock.service.upsertLabMember(withCompleteProfile(input));
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
  const approved = await mock.auth.approveRegistration(registration.id, "seed-admin");
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

describe("collaborator schedule authorization", () => {
  it("requires a member session and derives the viewer from it, ignoring forged IDs", async () => {
    const { baseUrl, mock } = await startService();
    for (const id of ["viewer", "peer", "stranger"]) {
      seedMember(mock, {
        id,
        name: id,
        email: `${id}@example.org`,
        privilege_level: "member",
        hours_per_week: 40,
        availability_notes: "private circumstances",
        availability: [
          {
            start: "2026-10-01",
            end: "2026-10-12",
            project: "Shared project",
            hours_per_week: 20,
            note: "private note",
          },
        ],
      });
    }
    const paper = mock.service.upsertPaper({
      id: "active",
      title: "Active",
      authors: [],
      current_step: "brainstorming_docs",
      author_links: [
        { name: "viewer", member_id: "viewer" },
        { name: "peer", member_id: "peer" },
      ],
    });
    expect(paper.ok).toBe(true);
    const route = `${baseUrl}/lab/members/collaborator-schedules`;
    expect((await fetch(route)).status).toBe(401);
    expect(
      (await fetch(route, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status,
    ).toBe(403);
    for (const id of ["viewer", "stranger"])
      await approveClaim(mock, baseUrl, id, `${id}@example.org`);
    const viewerToken = await loginToken(baseUrl, "viewer@example.org");
    const strangerToken = await loginToken(baseUrl, "stranger@example.org");
    const response = await fetch(`${route}?member_id=stranger`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.members.map((m: { id: string }) => m.id)).toEqual(["peer"]);
    expect(JSON.stringify(body)).not.toMatch(/private|example.org/);
    const unrelated = await fetch(`${route}?member_id=viewer`, {
      headers: { Authorization: `Bearer ${strangerToken}` },
    });
    expect(unrelated.status).toBe(200);
    await expect(unrelated.json()).resolves.toEqual({ members: [] });
    const roster = await fetch(`${baseUrl}/lab/members`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    const peer = (await roster.json()).members.find((m: { id: string }) => m.id === "peer");
    expect(peer.availability).toBeUndefined();
    expect(peer.availability_notes).toBeUndefined();
  });
});
