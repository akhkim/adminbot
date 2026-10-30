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
  it("binds approval to verified participants and prevents replay after partial success", async () => {
    const directory = vi.fn().mockResolvedValue(
      ["UADMIN", "UMEMBER"].map((id) => ({
        id,
        deleted: false,
        is_bot: false,
        is_app_user: false,
        is_restricted: false,
        is_ultra_restricted: false,
      })),
    );
    const execute = vi.fn().mockResolvedValue({
      handled: true,
      delivered: false,
      artifacts: { outcome: "message_unknown", slack_channel: "GEXAMPLE" },
    });
    const { mock, baseUrl } = await startLab(directory, { execute });
    const admin = await memberSession(mock, baseUrl, "admin");
    const response = await fetch(`${baseUrl}/collaborator-chats`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        context: "Synthetic opening message",
        participant_ids: ["admin", "member"],
      }),
    });
    const { request } = await response.json();
    const prepare = await fetch(`${baseUrl}/collaborator-chats/${request.id}/prepare`, {
      method: "POST",
      headers: admin,
    });
    expect(prepare.status).toBe(200);
    const { action } = await prepare.json();
    expect(action.status).toBe("pending");
    expect((await mock.service.execute(action.id, { dry_run: false })).status).toBe(409);
    expect(
      mock.service.approve(action.id, {
        payload_hash: "altered",
        approver_role: "admin",
        approver_id: "admin",
      }).status,
    ).toBe(409);
    expect(
      mock.service.approve(action.id, {
        payload_hash: action.payload_hash,
        approver_role: "admin",
        approver_id: "admin",
      }).ok,
    ).toBe(true);
    expect((await mock.service.execute(action.id, { dry_run: false })).status).toBe(409);
    expect((await mock.service.execute(action.id, { dry_run: false })).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
    const saved = await (await fetch(`${baseUrl}/collaborator-chats`, { headers: admin })).json();
    expect(saved.requests[0].receipt).toMatchObject({
      outcome: "message_unknown",
      slack_channel: "GEXAMPLE",
    });
  });
  it("requires a new approval after relinking a Slack identity", async () => {
    const directory = vi
      .fn()
      .mockResolvedValue(
        ["UADMIN", "UMEMBER", "UNEW"].map((id) => ({
          id,
          deleted: false,
          is_bot: false,
          is_app_user: false,
          is_restricted: false,
          is_ultra_restricted: false,
        })),
      );
    const execute = vi
      .fn()
      .mockResolvedValue({
        handled: true,
        artifacts: { outcome: "message_accepted", slack_channel: "GEXAMPLE", slack_ts: "1.2" },
      });
    const { mock, baseUrl } = await startLab(directory, { execute });
    const admin = await memberSession(mock, baseUrl, "admin");
    const saved = await (
      await fetch(`${baseUrl}/collaborator-chats`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          context: "Synthetic project",
          participant_ids: ["admin", "member"],
        }),
      })
    ).json();
    const url = `${baseUrl}/collaborator-chats/${saved.request.id}/prepare`;
    const { action } = await (await fetch(url, { method: "POST", headers: admin })).json();
    mock.service.approve(action.id, {
      payload_hash: action.payload_hash,
      approver_role: "admin",
      approver_id: "admin",
    });
    expect(
      mock.service.upsertLabMember({ id: "member", name: "Mina Member", slack_user_id: "UNEW" }).ok,
    ).toBe(true);
    expect((await mock.service.execute(action.id, { dry_run: false })).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
    const { action: refreshed } = await (
      await fetch(url, { method: "POST", headers: admin })
    ).json();
    expect(refreshed.status).toBe("pending");
    expect(refreshed.payload_hash).not.toBe(action.payload_hash);
    expect(mock.service.getProposal(action.id)?.status).toBe("rejected");
    mock.service.approve(refreshed.id, {
      payload_hash: refreshed.payload_hash,
      approver_role: "admin",
      approver_id: "admin",
    });
    expect((await mock.service.execute(refreshed.id, { dry_run: false })).ok).toBe(true);
    expect((await mock.service.execute(refreshed.id, { dry_run: false })).ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("does not prepare an action for a pending Slack invitation", async () => {
    const { mock, baseUrl } = await startLab(async () => [
      {
        id: "UADMIN",
        deleted: false,
        is_bot: false,
        is_app_user: false,
        is_restricted: false,
        is_ultra_restricted: false,
      },
      {
        id: "UMEMBER",
        deleted: false,
        is_bot: false,
        is_app_user: false,
        is_invited_user: true,
        is_restricted: false,
        is_ultra_restricted: false,
      },
    ]);
    const admin = await memberSession(mock, baseUrl, "admin");
    const saved = await (
      await fetch(`${baseUrl}/collaborator-chats`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          context: "Synthetic pending invite",
          participant_ids: ["admin", "member"],
        }),
      })
    ).json();
    expect(
      (
        await fetch(`${baseUrl}/collaborator-chats/${saved.request.id}/prepare`, {
          method: "POST",
          headers: admin,
        })
      ).status,
    ).toBe(409);
  });
});
