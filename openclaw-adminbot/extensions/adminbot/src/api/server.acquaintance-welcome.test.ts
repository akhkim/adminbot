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

describe("acquaintance welcome preview and approval", () => {
  it("previews the default, queues only the exact reviewed email and suppresses a duplicate", async () => {
    vi.stubEnv("ADMINBOT_CONTACT_EMAILS", "support@example.test");
    const { mock, baseUrl } = await startLab();
    const admin = await memberSession(mock, baseUrl, "admin");
    const member = await memberSession(mock, baseUrl, "member");
    const base = `${baseUrl}/lab/members/member/onboarding/welcome`;
    expect(
      (await fetch(`${base}/preview`, { method: "POST", headers: member, body: "{}" })).status,
    ).toBe(403);
    const preview = await (
      await fetch(`${base}/preview`, { method: "POST", headers: admin, body: "{}" })
    ).json();
    expect(preview.email).toBe("member@lab.test");
    expect(preview.subject).toBe("Getting connected with the Jinesis Lab");
    expect(preview.body).toContain("support@example.test");
    const refused = await fetch(`${base}/queue`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ preview_hash: "stale" }),
    });
    expect(refused.status).toBe(409);
    const queued = await fetch(`${base}/queue`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ preview_hash: preview.preview_hash }),
    });
    expect(queued.status).toBe(200);
    const result = await queued.json();
    expect(result.status).toBe("pending");
    expect(mock.service.getProposal(result.proposal_id)).toMatchObject({
      status: "pending",
      proposed_payload: {
        email: preview.email,
        subject_override: preview.subject,
        body_override: preview.body,
      },
    });
    expect(
      (
        await fetch(`${base}/queue`, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ preview_hash: preview.preview_hash }),
        })
      ).status,
    ).toBe(409);
  });
  it("binds custom copy and the correspondence recipient to the preview", async () => {
    vi.stubEnv("ADMINBOT_CONTACT_EMAILS", "support@example.test");
    const { mock, baseUrl } = await startLab();
    const admin = await memberSession(mock, baseUrl, "admin");
    const base = `${baseUrl}/lab/members/member/onboarding/welcome`;
    const custom = {
      subject: "Hello from our lab",
      body: "Hi Mina, happy to have you in the community.",
    };
    const preview = await (
      await fetch(`${base}/preview`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify(custom),
      })
    ).json();
    expect(preview).toMatchObject(custom);
    expect(
      (
        await fetch(`${base}/preview`, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ email: "slack-only@example.test" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/queue`, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ ...custom, body: "Changed", preview_hash: preview.preview_hash }),
        })
      ).status,
    ).toBe(409);
    expect(
      mock.service.upsertLabMember({
        id: "member",
        name: "Mina Member",
        email: "updated@example.test",
      }).ok,
    ).toBe(true);
    expect(
      (
        await fetch(`${base}/queue`, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ ...custom, preview_hash: preview.preview_hash }),
        })
      ).status,
    ).toBe(409);
  });
  it("requires an explicit reviewed resend after a previous delivered welcome", async () => {
    vi.stubEnv("ADMINBOT_CONTACT_EMAILS", "support@example.test");
    const { mock, baseUrl } = await startLab();
    const admin = await memberSession(mock, baseUrl, "admin");
    mock.service.recordOnboardingGuideSent({
      actor: "synthetic-admin",
      template_id: "welcome",
      email: "member@lab.test",
      sent: true,
    });
    const base = `${baseUrl}/lab/members/member/onboarding/welcome`;
    const preview = await (
      await fetch(`${base}/preview`, { method: "POST", headers: admin, body: "{}" })
    ).json();
    expect(
      (
        await fetch(`${base}/queue`, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ preview_hash: preview.preview_hash }),
        })
      ).status,
    ).toBe(409);
    const resend = await (
      await fetch(`${base}/preview`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ resend: true }),
      })
    ).json();
    expect(resend.resend).toBe(true);
    expect(
      (
        await fetch(`${base}/queue`, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ preview_hash: resend.preview_hash }),
        })
      ).status,
    ).toBe(409);
    const queued = await (
      await fetch(`${base}/queue`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ resend: true, preview_hash: resend.preview_hash }),
      })
    ).json();
    expect(mock.service.getProposal(queued.proposal_id)).toMatchObject({
      status: "pending",
      proposed_payload: { resend: true, add_dcs_roster_row: false },
    });
  });
});
