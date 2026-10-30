import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "lab-sharing-service-token";
const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  while (running.length > 0) {
    const mock = running.pop();
    if (!mock) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
  }
});

async function startLab() {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    allowedOrigins: ["http://127.0.0.1:5197"],
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
    throw new Error("missing server address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  running.push(mock);
  for (const member of [
    {
      id: "admin",
      name: "Ada Admin",
      email: "admin@lab.test",
      privilege_level: "admin",
    },
    {
      id: "member",
      name: "Mina Member",
      email: "member@lab.test",
      privilege_level: "member",
    },
  ]) {
    const saved = mock.service.upsertLabMember(
      withCompleteProfile(member as AdminBotLabMemberInput),
    );
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
  }
  const paper = mock.service.upsertPaper({
    id: "paper-1",
    title: "Reliable Research Agents",
    authors: ["Mina Member"],
    current_step: "submission",
    venue: "ICLR 2027",
  });
  if (!paper.ok) {
    throw new Error(paper.error.message);
  }
  return { mock, baseUrl };
}

async function memberSession(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
  memberId: "admin" | "member",
): Promise<Record<string, string>> {
  const email = `${memberId}@lab.test`;
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ member_id: memberId, email, password: "correcthorse" }),
  });
  const registration = (await mock.auth.listRegistrations("pending")).find(
    (entry) => entry.member_id === memberId,
  );
  if (!registration) {
    throw new Error(`no registration for ${memberId}`);
  }
  const approved = await mock.auth.approveRegistration(registration.id, "test-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  const token = ((await login.json()) as { session_token: string }).session_token;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("Collaborator chat request API", () => {
  it("saves intentions only and enforces the admin boundary", async () => {
    const { mock, baseUrl } = await startLab();
    const admin = await memberSession(mock, baseUrl, "admin");
    const member = await memberSession(mock, baseUrl, "member");
    const url = `${baseUrl}/collaborator-chats`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: member })).status).toBe(403);
    expect(
      (await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status,
    ).toBe(403);
    const saved = await fetch(url, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ context: "Synthetic chat", participant_ids: ["admin", "member"] }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).status).toBe("saved");
    expect((await (await fetch(url, { headers: admin })).json()).requests).toHaveLength(1);
    expect((await fetch(url, { method: "POST", headers: admin, body: "null" })).status).toBe(400);
  });
});
