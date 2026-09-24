// POST /membership/sheet/rows -- the route in front of addMemberSheetRow. The workflow itself is
// covered in server.member-sheet-add-row.test.ts; what is tested here is who may reach it, and that
// the admin who clicked is the approver of record.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotOnboardingSender } from "../workflows/onboarding/guide-sender.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const HEADER = [
  "Name",
  "Member Type",
  "Email for correspondence (the more professional the better)",
  "Slack email",
];

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

async function startService() {
  const executed: AdminBotStoredProposal[] = [];
  const sent: string[] = [];
  const onboardingSender = (async (request: { email: string }) => {
    sent.push(request.email);
    return { ok: true, payload: { template_id: "member", subject: "Welcome", body: "Hi" } };
  }) as unknown as AdminBotOnboardingSender;
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
    executor: {
      execute: async (proposal) => {
        executed.push(proposal);
        return { handled: true };
      },
    },
    onboardingSender,
    memberSheet: {
      spreadsheetId: "sheet-1",
      tab: "Roster",
      read: vi.fn(async () => [HEADER]),
    },
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
  running.push(mock);
  const admin = mock.service.upsertLabMember({
    id: "admin",
    name: "Admin",
    email: "admin@cs.toronto.edu",
    privilege_level: "admin",
  });
  if (!admin.ok) {
    throw new Error(admin.error.message);
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock, executed, sent };
}

async function adminToken(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
): Promise<string> {
  const headers = { "Content-Type": "application/json" };
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      member_id: "admin",
      email: "admin@cs.toronto.edu",
      password: "correcthorse",
    }),
  });
  const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  const registration = (
    (await pending.json()) as { registrations: Array<{ id: string; member_id?: string }> }
  ).registrations.find((entry) => entry.member_id === "admin");
  if (!registration) {
    throw new Error("no pending registration for admin");
  }
  const approved = await mock.auth.approveRegistration(registration.id, "seed-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "admin@cs.toronto.edu", password: "correcthorse" }),
  });
  return ((await res.json()) as { session_token: string }).session_token;
}

const addRow = (baseUrl: string, headers: Record<string, string>) =>
  fetch(`${baseUrl}/membership/sheet/rows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ name: "Ada Lovelace", member_type: "full", email: "ada@lab.co" }),
  });

describe("POST /membership/sheet/rows", () => {
  it("appends, creates and sends, approved by the signed-in admin", async () => {
    const { baseUrl, mock, executed, sent } = await startService();
    const token = await adminToken(mock, baseUrl);

    const response = await addRow(baseUrl, { Authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, { status: string }>;
    expect(body.sheet?.status).toBe("done");
    expect(body.member?.status).toBe("done");
    expect(body.onboarding?.status).toBe("done");

    expect(executed.map((proposal) => proposal.type)).toContain("sheet.append_rows");
    expect(sent).toEqual(["ada@lab.co"]);
    const append = executed.find((proposal) => proposal.type === "sheet.append_rows");
    expect(append?.approvals.map((approval) => approval.approver_id)).toEqual(["admin"]);
  });

  // The shared service token names nobody, so it cannot be the approver of record.
  it("refuses the service principal", async () => {
    const { baseUrl, executed } = await startService();
    const response = await addRow(baseUrl, { Authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(response.status).toBe(403);
    expect(executed).toEqual([]);
  });

  it("refuses an anonymous caller", async () => {
    const { baseUrl, executed } = await startService();
    const response = await addRow(baseUrl, {});
    expect(response.status).toBe(401);
    expect(executed).toEqual([]);
  });
});
