import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { DEADLINE_VENUES } from "../workflows/deadlines/generated/dataset.js";
import { createAdminBotMockService } from "./server.js";
const SERVICE_TOKEN = "test-service-token";
const running: Array<{
  mock: ReturnType<typeof createAdminBotMockService>;
  sensitiveInfoPath: string;
}> = [];

afterEach(async () => {
  while (running.length) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    await rm(entry.sensitiveInfoPath, { force: true });
  }
});

async function startService(executed: AdminBotStoredProposal[] = []) {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-workshop-nudges-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    executor: {
      execute: async (proposal) => {
        executed.push(proposal);
        return { handled: proposal.type === "deadline.recommend" };
      },
    },
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
  running.push({ mock, sensitiveInfoPath });
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

async function adminHeaders(baseUrl: string, mock: ReturnType<typeof createAdminBotMockService>) {
  seedMember(
    mock,
    withCompleteProfile({
      id: "admin-1",
      name: "Ada Admin",
      email: "ada@cs.toronto.edu",
      privilege_level: "member",
      slack_user_id: "UADA",
    }),
  );
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      member_id: "admin-1",
      email: "ada@cs.toronto.edu",
      password: "correcthorse",
    }),
  });
  const pending = (
    (await (
      await fetch(`${baseUrl}/auth/registrations?status=pending`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
      })
    ).json()) as { registrations: Array<{ id: string; member_id?: string }> }
  ).registrations.find((entry) => entry.member_id === "admin-1");
  if (!pending) {
    throw new Error("missing pending admin claim");
  }
  const approved = await mock.auth.approveRegistration(pending.id, "test-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ada@cs.toronto.edu", password: "correcthorse" }),
  });
  const token = ((await login.json()) as { session_token: string }).session_token;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function seedMember(
  mock: ReturnType<typeof createAdminBotMockService>,
  member: Parameters<typeof mock.service.upsertLabMember>[0],
) {
  // On the nudge list unless the case overrides it: these fixtures exist to receive nudges.
  const result = mock.service.upsertLabMember({ receives_nudges: true, ...member });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

describe("recommendation HTTP boundary", () => {
  it("denies anonymous and service callers; previews and sends only for the signed-in author", async () => {
    const executed: AdminBotStoredProposal[] = [];
    const { baseUrl, mock } = await startService(executed);
    for (const headers of [{}, { Authorization: `Bearer ${SERVICE_TOKEN}` }]) {
      const response = await fetch(`${baseUrl}/deadline-recommendations`, { headers });
      expect([401, 403]).toContain(response.status);
      expect(await response.text()).not.toContain("members");
    }
    const headers = await adminHeaders(baseUrl, mock);
    seedMember(mock, { id: "bea", name: "Bea", slack_user_id: "UBEA", privilege_level: "member" });
    const directory = await fetch(`${baseUrl}/deadline-recommendations`, { headers });
    expect(directory.status).toBe(200);
    expect(directory.headers.get("cache-control")).toContain("no-store");
    const preview = await fetch(`${baseUrl}/deadline-recommendations/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deadline_id: DEADLINE_VENUES[0].deadline_id,
        recipient_member_id: "bea",
        recommender_member_id: "bea",
      }),
    });
    expect(preview.status).toBe(200);
    const draft = await preview.json();
    expect(draft.recommender_name).toBe("Ada Admin");
    expect(executed).toHaveLength(0);
    const send = await fetch(`${baseUrl}/deadline-recommendations/${draft.id}/send`, {
      method: "POST",
      headers,
      body: JSON.stringify({ payload_hash: draft.payload_hash }),
    });
    expect(send.status).toBe(200);
    expect((await send.json()).status).toBe("sent");
    expect(executed).toHaveLength(1);
    const publicData = await (await fetch(`${baseUrl}/deadlines`)).text();
    expect(publicData).not.toContain("UBEA");
    expect(publicData).not.toContain("recommender_member_id");
  });
});
