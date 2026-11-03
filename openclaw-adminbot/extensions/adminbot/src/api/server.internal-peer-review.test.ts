import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import type { AdminBotActionExecutor } from "../kernel/service.js";
import type { SlackDirectoryReader } from "../workflows/members/slack-roster-sync.js";
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

async function startLab(
  readSlackDirectory?: SlackDirectoryReader,
  executor?: AdminBotActionExecutor,
) {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    readSlackDirectory,
    executor,
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
      slack_user_id: "UADMIN",
      name: "Ada Admin",
      email: "admin@lab.test",
      privilege_level: "admin",
    },
    {
      id: "member",
      member_type: "acquaintance",
      slack_user_id: "UMEMBER",
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

afterEach(() => vi.unstubAllEnvs());

describe("private internal peer review drafts", () => {
  it("scopes drafts to the authenticated author, requires current revision, and sends nothing", async () => {
    const { mock, baseUrl } = await startLab();
    const author = await memberSession(mock, baseUrl, "member");
    const admin = await memberSession(mock, baseUrl, "admin");
    const url = `${baseUrl}/papers/paper-1/internal-peer-review`;
    expect(
      (await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status,
    ).toBe(401);
    const send = async (data: unknown, revision = 0, mutation_id = "synthetic-save") =>
      fetch(url, {
        method: "PUT",
        headers: author,
        body: JSON.stringify({ data, revision, mutation_id }),
      });
    const value = {
      purpose: "Check the assumptions",
      draft_url: "https://example.test/draft",
      nominee_ids: [],
    };
    const first = await send(value);
    expect(first.status).toBe(200);
    expect((await first.json()).detail).toContain("No invitation sent");
    expect((await send(value)).status).toBe(200);
    expect((await send({ ...value, purpose: "Changed" })).status).toBe(409);
    expect((await (await fetch(url, { headers: admin })).json()).draft).toBeNull();
    const saved = await (await fetch(url, { headers: author })).json();
    expect(saved.draft.data).toEqual(value);
    expect(mock.service.listPending().ok).toBe(true);
    mock.store.savePaper({
      ...mock.store.getPaper("paper-1")!,
      authors: ["Other Person"],
      author_links: [],
      first_author_member_id: undefined,
      submitted_by_member_id: undefined,
      mentor_member_id: undefined,
    });
    expect((await fetch(url, { headers: author })).status).toBe(404);
  });
  it("refuses invalid, conflicting or exempt nominees and request-supplied actor IDs", async () => {
    const { baseUrl } = await startLab();
    const author = await memberSession(running.at(-1)!, baseUrl, "member");
    const url = `${baseUrl}/papers/paper-1/internal-peer-review`;
    for (const data of [
      { purpose: "", draft_url: "http://example.test", nominee_ids: [] },
      { purpose: "", draft_url: "", nominee_ids: ["member"] },
      { purpose: "", draft_url: "", nominee_ids: ["missing"] },
      { purpose: "", draft_url: "", nominee_ids: [], actor: "admin" },
    ]) {
      expect(
        (
          await fetch(url, {
            method: "PUT",
            headers: author,
            body: JSON.stringify({ data, revision: 0, mutation_id: "synthetic" }),
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
  });
});
