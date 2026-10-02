// POST /lab/members/:id/id -- an admin giving a member a new id. What matters is that nothing is
// left behind under the old one: a rename that moved the roster row and not the paper links, the
// login or the head-professor setting would quietly detach the person from their own record.
import { afterEach, describe, expect, it } from "vitest";
import type {
  AdminBotLabMember,
  AdminBotLabMemberInput,
  AdminBotPaperRecord,
} from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

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

type Store = {
  getLabMember: (id: string) => AdminBotLabMember | undefined;
  getPaper: (id: string) => AdminBotPaperRecord | undefined;
  savePaper: (paper: AdminBotPaperRecord) => void;
  listAuditEvents: () => Array<{ type: string; details?: Record<string, unknown> }>;
};

const jsonHeaders = (extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  ...extra,
});

async function lab() {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
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
  running.push(mock);
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const store = (mock.service as never as { store: Store }).store;
  const seed = (input: AdminBotLabMemberInput) => {
    const result = mock.service.upsertLabMember(input);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  };
  const login = async (memberId: string, email: string) => {
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
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
    const approved = await mock.auth.approveRegistration(registration.id, "seed-admin");
    if (!approved.ok) {
      throw new Error(approved.error.message);
    }
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: "correcthorse" }),
    });
    return ((await res.json()) as { session_token: string }).session_token;
  };
  seed({ id: "admin", name: "Admin", email: "admin@cs.toronto.edu", privilege_level: "admin" });
  seed({
    id: "mem_2589c705",
    name: "Terry Zhang",
    email: "terry@cs.toronto.edu",
    privilege_level: "member",
  });
  seed({ id: "pat", name: "Pat", email: "pat@cs.toronto.edu", privilege_level: "member" });
  const admin = await login("admin", "admin@cs.toronto.edu");
  const terry = await login("mem_2589c705", "terry@cs.toronto.edu");
  const rename = (token: string, memberId: string, newId: string) =>
    fetch(`${baseUrl}/lab/members/${encodeURIComponent(memberId)}/id`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
      body: JSON.stringify({ new_id: newId }),
    });
  return { baseUrl, mock, store, admin, terry, rename };
}

describe("changing a member id", () => {
  it("moves the member and everything that named them to the new id", async () => {
    const { baseUrl, mock, store, admin, terry, rename } = await lab();
    const created = mock.service.upsertPaper({
      id: "paper-1",
      title: "Reliable Research Agents",
      authors: ["Terry Zhang", "Pat"],
      current_step: "submission",
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    const paper = store.getPaper("paper-1");
    if (!paper) {
      throw new Error("paper not saved");
    }
    store.savePaper({
      ...paper,
      first_author_member_id: "mem_2589c705",
      author_links: [
        { name: "Terry Zhang", member_id: "mem_2589c705" },
        { name: "Pat", member_id: "pat" },
      ],
    });
    mock.service.updateSettings({ head_professor_member_id: "mem_2589c705" });

    const res = await rename(admin, "mem_2589c705", "terry-zhang");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: AdminBotLabMember }).member).toMatchObject({
      id: "terry-zhang",
      name: "Terry Zhang",
      email: "terry@cs.toronto.edu",
    });

    expect(store.getLabMember("mem_2589c705")).toBeUndefined();
    expect(store.getLabMember("terry-zhang")?.name).toBe("Terry Zhang");
    expect(store.getPaper("paper-1")).toMatchObject({
      first_author_member_id: "terry-zhang",
      author_links: [
        { name: "Terry Zhang", member_id: "terry-zhang" },
        { name: "Pat", member_id: "pat" },
      ],
    });
    expect(mock.service.headProfessorMemberId()).toBe("terry-zhang");

    // Same person under a new key: their open session and their password both still work.
    const session = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${terry}` },
    });
    await expect(session.json()).resolves.toMatchObject({ member: { id: "terry-zhang" } });
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "terry@cs.toronto.edu", password: "correcthorse" }),
    });
    expect(login.status).toBe(200);

    // The audit log is history and keeps the old id; the rename's own line joins the two.
    expect(store.listAuditEvents().find((e) => e.type === "lab_member.id_changed")).toMatchObject({
      details: { from_id: "mem_2589c705", to_id: "terry-zhang" },
    });
  });

  it("is an admin's call", async () => {
    const { terry, rename, baseUrl } = await lab();
    expect((await rename(terry, "pat", "patricia")).status).toBe(403);
    expect((await rename(SERVICE_TOKEN, "pat", "patricia")).status).toBe(403);
    const anonymous = await fetch(`${baseUrl}/lab/members/pat/id`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ new_id: "patricia" }),
    });
    expect(anonymous.status).toBe(401);
  });

  it("refuses a taken, malformed or unchanged id and leaves the member where they were", async () => {
    const { store, admin, rename } = await lab();
    expect((await rename(admin, "pat", "admin")).status).toBe(409);
    expect((await rename(admin, "pat", "Pat Lee")).status).toBe(400);
    expect((await rename(admin, "pat", "../admin")).status).toBe(400);
    expect((await rename(admin, "pat", "pat")).status).toBe(400);
    expect((await rename(admin, "nobody", "somebody")).status).toBe(404);
    expect(store.getLabMember("pat")?.name).toBe("Pat");
  });
});
