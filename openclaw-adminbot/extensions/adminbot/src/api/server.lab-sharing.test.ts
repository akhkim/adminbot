import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
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
  const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN });
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
    const saved = mock.service.upsertLabMember(member as AdminBotLabMemberInput);
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
  const registration = mock.auth
    .listRegistrations("pending")
    .find((entry) => entry.member_id === memberId);
  if (!registration) {
    throw new Error(`no registration for ${memberId}`);
  }
  const approved = mock.auth.approveRegistration(registration.id, "test-admin");
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

const draft = {
  description: "Review synthetic agent traces",
  tags: ["QA"],
  members_needed: 2,
  hours_per_week: 3,
  timeline: "September",
};
describe("Lab Sharing routes", () => {
  it("persists a request, scopes writes, and closes it without contacting anybody", async () => {
    const { mock, baseUrl } = await startLab();
    const member = await memberSession(mock, baseUrl, "member");
    const admin = await memberSession(mock, baseUrl, "admin");
    const url = `${baseUrl}/lab-sharing`;
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status,
    ).toBe(403);
    const save = (headers: Record<string, string>, body: unknown, paper = "paper-1") =>
      fetch(`${url}/requests/${paper}`, { method: "PUT", headers, body: JSON.stringify(body) });
    const first = await save(member, { ...draft, owner_id: "admin", status: "closed" });
    expect(first.status).toBe(200);
    const payload = await first.json();
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests[0]).toMatchObject({ owner_id: "member", status: "open", tags: ["qa"] });
    expect(payload.requests[0]).not.toHaveProperty("authors");
    expect((await save(member, draft)).status).toBe(200);
    expect(mock.store.listHelpRequests()).toHaveLength(1);
    mock.service.upsertPaper({
      id: "other",
      title: "Other project",
      authors: ["Unrelated Author"],
      current_step: "brainstorming",
    });
    expect((await save(member, draft, "other")).status).toBe(403);
    expect((await save(admin, draft, "other")).status).toBe(200);
    const visible = await (await fetch(url, { headers: member })).json();
    expect(
      visible.requests.find((row: { paper_id: string }) => row.paper_id === "other"),
    ).toMatchObject({ can_manage: false });
    expect(
      (await fetch(`${url}/requests/other/close`, { method: "POST", headers: admin })).status,
    ).toBe(200);
    const closed = await (await fetch(url, { headers: member })).json();
    expect(closed.requests.some((row: { paper_id: string }) => row.paper_id === "other")).toBe(
      false,
    );

    expect(
      (await fetch(`${url}/requests/other/close`, { method: "POST", headers: member })).status,
    ).toBe(403);
    expect((await save(member, { ...draft, members_needed: 0 })).status).toBe(400);
    expect((await save(member, { ...draft, tags: [23] })).status).toBe(400);
    expect((await save(member, { ...draft, description: " " })).status).toBe(400);
    expect((await save(member, draft, "missing")).status).toBe(404);
    expect(
      (await fetch(`${url}/requests/paper-1/close`, { method: "POST", headers: member })).status,
    ).toBe(200);
    expect(mock.store.listHelpRequests().find((row) => row.paper_id === "paper-1")?.status).toBe(
      "closed",
    );
    const audit = mock.store.listAuditEvents();
    expect(audit.some((row) => row.type === "lab_help.saved" && row.actor === "member")).toBe(true);
  });
});
