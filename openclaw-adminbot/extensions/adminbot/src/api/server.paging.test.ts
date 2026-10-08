import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";
import { pageOf, readPageQuery } from "./server.paging.js";

const SERVICE_TOKEN = "paging-service-token";
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

describe("readPageQuery", () => {
  const bounds = { defaultLimit: 25, maxLimit: 100 };
  const read = (query: string) => readPageQuery(new URL(`http://x/list${query}`), bounds);

  it("defaults, honors and caps the page size", () => {
    expect(read("")).toEqual({ limit: 25, offset: 0 });
    expect(read("?limit=10&offset=30")).toEqual({ limit: 10, offset: 30 });
    expect(read("?limit=5000")).toEqual({ limit: 100, offset: 0 });
  });

  it("clamps a malformed value instead of refusing the page", () => {
    expect(read("?limit=0&offset=-3")).toEqual({ limit: 25, offset: 0 });
    expect(read("?limit=abc&offset=1.5")).toEqual({ limit: 25, offset: 0 });
  });
});

describe("pageOf", () => {
  it("says where the next page starts only while rows remain", () => {
    const rows = Array.from({ length: 7 }, (_, index) => index);
    expect(pageOf(rows, { limit: 3, offset: 0 })).toEqual({
      items: [0, 1, 2],
      total: 7,
      next_offset: 3,
    });
    expect(pageOf(rows, { limit: 3, offset: 6 })).toEqual({ items: [6], total: 7 });
    expect(pageOf(rows, { limit: 3, offset: 9 })).toEqual({ items: [], total: 7 });
  });
});

async function startLab() {
  const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN });
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", () => resolve()));
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing server address");
  }
  running.push(mock);
  for (const member of [
    { id: "admin", name: "Ada Admin", email: "admin@lab.test", privilege_level: "admin" },
    { id: "member", name: "Mina Member", email: "member@lab.test", privilege_level: "member" },
  ]) {
    const saved = mock.service.upsertLabMember(member as AdminBotLabMemberInput);
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
  }
  return { mock, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function adminSession(mock: ReturnType<typeof createAdminBotMockService>, baseUrl: string) {
  const email = "admin@lab.test";
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ member_id: "admin", email, password: "correcthorse" }),
  });
  const registration = (await mock.auth.listRegistrations("pending")).find(
    (entry) => entry.member_id === "admin",
  );
  if (!registration) {
    throw new Error("no registration");
  }
  await mock.auth.approveRegistration(registration.id, "test-admin");
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  const token = ((await login.json()) as { session_token: string }).session_token;
  return { Authorization: `Bearer ${token}` };
}

async function getJson(baseUrl: string, path: string, headers: Record<string, string>) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("list routes page their rows", () => {
  it("pages the approval queue oldest first and counts all of it", async () => {
    const { mock, baseUrl } = await startLab();
    const admin = await adminSession(mock, baseUrl);
    for (let index = 0; index < 30; index += 1) {
      mock.service.createProposal({
        type: "email.send",
        summary: `Send reminder ${index}`,
        target: { to: ["member@lab.test"] },
        proposed_payload: { to: "member@lab.test", subject: `S${index}`, body: "Hello" },
        rationale: "Test",
        undo_plan: "None",
        evidence: [],
      } as never);
    }
    const first = await getJson(baseUrl, "/proposals/pending?view=summary", admin);
    expect((first.proposals as unknown[]).length).toBe(25);
    expect(first).toMatchObject({ total: 30, next_offset: 25 });
    const rest = await getJson(baseUrl, "/proposals/pending?view=summary&offset=25", admin);
    expect((rest.proposals as unknown[]).length).toBe(5);
    expect(rest.total).toBe(30);
    expect(rest).not.toHaveProperty("next_offset");
    const ids = new Set(
      [
        ...(first.proposals as Array<{ id: string }>),
        ...(rest.proposals as Array<{ id: string }>),
      ].map((proposal) => proposal.id),
    );
    expect(ids.size).toBe(30);
    // The dashboard's count is the whole queue, not the 50 it used to stop at.
    expect(await getJson(baseUrl, "/admin/queue-counts", admin)).toMatchObject({
      pending_proposals: 30,
    });
  });

  it("pages held mail newest first with the queue size beside it", async () => {
    const { mock, baseUrl } = await startLab();
    const admin = await adminSession(mock, baseUrl);
    for (let index = 0; index < 3; index += 1) {
      mock.store.saveEmailReview({
        message_id: `m-${index}`,
        thread_id: `t-${index}`,
        sender: "x@example.test",
        subject: `Subject ${index}`,
        category: "paperflow",
        reason: "held",
        received_at: `2026-09-0${index + 1}T00:00:00.000Z`,
        updated_at: `2026-09-0${index + 1}T00:00:00.000Z`,
      });
    }
    const page = await getJson(baseUrl, "/automation/email/review?limit=2", admin);
    expect((page.reviews as Array<{ message_id: string }>).map((row) => row.message_id)).toEqual([
      "m-2",
      "m-1",
    ]);
    expect(page).toMatchObject({ total: 3, next_offset: 2 });
    expect(page).toHaveProperty("paperflow_candidates");
    expect(page).toHaveProperty("recent_resolutions");
  });

  it("pages due paper nudges and sends their total", async () => {
    const { mock, baseUrl } = await startLab();
    const admin = await adminSession(mock, baseUrl);
    for (let index = 0; index < 4; index += 1) {
      mock.service.upsertPaper({
        id: `paper-${index}`,
        title: `Paper ${index}`,
        authors: ["Mina Member"],
        current_step: "submission",
        venue: "ICLR 2027",
        reminder: {
          status: "waiting_on_authors",
          requested_step_at: "2026-01-01T00:00:00Z",
          next_nudge_at: "2026-01-02T00:00:00Z",
        },
      } as never);
    }
    const all = await getJson(baseUrl, "/papers/nudges?limit=100", admin);
    const total = (all.nudges as unknown[]).length;
    expect(all.total).toBe(total);
    expect(all).not.toHaveProperty("next_offset");
    expect(total).toBeGreaterThan(1);
    const page = await getJson(baseUrl, "/papers/nudges?limit=1", admin);
    expect((page.nudges as unknown[]).length).toBe(1);
    expect(page).toMatchObject({ total, next_offset: 1 });
  });

  it("caps the escalation list and sends each item as its title", async () => {
    const { mock, baseUrl } = await startLab();
    const admin = await adminSession(mock, baseUrl);
    mock.store.saveMemberNotification({
      id: "n-1",
      member_id: "member",
      kind: "nudge",
      title: "Upload the poster",
      body: "Your paper still needs a poster PDF.",
      tab: "myWork",
      created_at: "2026-09-01T00:00:00.000Z",
      important: true,
      escalated_at: "2026-09-02T00:00:00.000Z",
    } as never);
    const body = await getJson(baseUrl, "/nudges/escalated", admin);
    expect(body).toMatchObject({ total: 1 });
    expect(body.members).toEqual([
      expect.objectContaining({
        member_id: "member",
        notifications: [
          {
            id: "n-1",
            title: "Upload the poster",
            created_at: "2026-09-01T00:00:00.000Z",
            tab: "myWork",
          },
        ],
      }),
    ]);
  });
});
