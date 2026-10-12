// POST /lab/members/:id/onboarding/guide -- what the Members tab's Add-member button calls once
// the record exists. The service's own refusals are covered in
// kernel/service.member-onboarding-guide.test.ts; what is tested here is the route: who may reach
// it, and that its path is not swallowed by the checklist-step route it sits in front of.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
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

/**
 * Stands in for the Gmail sender. The guide route now sends on the admin's click, so a test that
 * left the production default in place would shell out to the real `gog gmail send` -- harmless
 * only on a machine where gog happens to have no account.
 */
function fakeSender(result: "sent" | "refused" = "refused") {
  return vi.fn(async () =>
    result === "sent"
      ? {
          ok: true as const,
          payload: { template_id: "member", subject: "Welcome", body: "Hello", sent: true },
        }
      : { ok: false as const, error: { status: 503, message: "test sender refuses" } },
  );
}

async function startService(sender: ReturnType<typeof fakeSender> = fakeSender()) {
  const mock = createAdminBotMockService({
    onboardingSender: sender as never,
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
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  running.push(mock);
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function seedMember(
  mock: ReturnType<typeof createAdminBotMockService>,
  input: AdminBotLabMemberInput,
): void {
  const result = mock.service.upsertLabMember(input);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

async function memberToken(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
  memberId: string,
  email: string,
): Promise<string> {
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
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  return ((await res.json()) as { session_token: string }).session_token;
}

function onboard(
  baseUrl: string,
  memberId: string,
  headers: Record<string, string>,
  body: Record<string, unknown> = {},
) {
  return fetch(`${baseUrl}/lab/members/${memberId}/onboarding/guide`, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify(body),
  });
}

async function lab(sender: ReturnType<typeof fakeSender> = fakeSender()) {
  const { baseUrl, mock } = await startService(sender);
  seedMember(mock, {
    id: "admin",
    name: "Admin",
    email: "admin@cs.toronto.edu",
    privilege_level: "admin",
  });
  seedMember(mock, {
    id: "pat",
    name: "Pat",
    email: "pat@cs.toronto.edu",
    privilege_level: "member",
  });
  seedMember(mock, {
    id: "grace",
    name: "Grace Hopper",
    email: "grace@lab.co",
    member_type: "full",
  } as AdminBotLabMemberInput);
  return { baseUrl, mock };
}

const filed = (mock: ReturnType<typeof createAdminBotMockService>) =>
  (
    mock.service as never as {
      store: { listProposalsByType: (type: string) => Array<{ proposed_payload: unknown }> };
    }
  ).store.listProposalsByType("onboarding.send_guide");

describe("onboarding a member from their roster row", () => {
  // A full member's standard guide is approved by the admin's click and sent there and then.
  it("sends a full member's guide on the admin's click", async () => {
    const sender = fakeSender("sent");
    const { baseUrl, mock } = await lab(sender);
    const token = await memberToken(mock, baseUrl, "admin", "admin@cs.toronto.edu");
    const res = await onboard(baseUrl, "grace", { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "done", email: "grace@lab.co" });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(filed(mock)).toHaveLength(1);
  });

  it("reports failure instead of a successful send when the sender refuses", async () => {
    const sender = fakeSender("refused");
    const { baseUrl, mock } = await lab(sender);
    const token = await memberToken(mock, baseUrl, "admin", "admin@cs.toronto.edu");
    const res = await onboard(baseUrl, "grace", { Authorization: `Bearer ${token}` });
    expect(res.ok).toBe(false);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: expect.any(String) },
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(filed(mock)).toHaveLength(1);
  });

  // The path also matches /lab/members/:id/onboarding/:step, which ticks a checklist item. If the
  // step route won, "guide" would be read as a step id -- so this is the regression that keeps the
  // ordering in server.ts deliberate rather than incidental.
  it("is not read as a checklist step called guide", async () => {
    const { baseUrl, mock } = await lab();
    const token = await memberToken(mock, baseUrl, "admin", "admin@cs.toronto.edu");
    await onboard(baseUrl, "grace", { Authorization: `Bearer ${token}` });
    const member = (
      mock.service as never as {
        store: {
          getLabMember: (id: string) => { onboarding?: { steps?: Array<{ id: string }> } };
        };
      }
    ).store.getLabMember("grace");
    expect((member.onboarding?.steps ?? []).some((step) => step.id === "guide")).toBe(false);
  });

  // Approving what this queues mails a stranger and mints a Slack invite, so an ordinary member
  // cannot put one in the queue -- not even for themselves.
  it("refuses a member session that is not an admin", async () => {
    const { baseUrl, mock } = await lab();
    const token = await memberToken(mock, baseUrl, "pat", "pat@cs.toronto.edu");
    expect((await onboard(baseUrl, "grace", { Authorization: `Bearer ${token}` })).status).toBe(
      403,
    );
    expect(filed(mock)).toHaveLength(0);
  });

  // The shared service principal authenticates every agent tool call regardless of who is
  // chatting, which is exactly why it is not enough here.
  it("refuses the service principal", async () => {
    const { baseUrl, mock } = await lab();
    expect(
      (await onboard(baseUrl, "grace", { Authorization: `Bearer ${SERVICE_TOKEN}` })).status,
    ).toBe(403);
    expect(filed(mock)).toHaveLength(0);
  });

  it("refuses an unauthenticated caller", async () => {
    const { baseUrl, mock } = await lab();
    expect([401, 403]).toContain((await onboard(baseUrl, "grace", {})).status);
    expect(filed(mock)).toHaveLength(0);
  });

  // The Members tab's Resend button: the first mail went to spam or was never read.
  describe("resending a guide that already went out", () => {
    async function sentOnce() {
      const sender = fakeSender("sent");
      const { baseUrl, mock } = await lab(sender);
      const token = await memberToken(mock, baseUrl, "admin", "admin@cs.toronto.edu");
      const first = await onboard(baseUrl, "grace", { Authorization: `Bearer ${token}` });
      expect(first.status).toBe(200);
      return { sender, baseUrl, mock, token };
    }

    it("still refuses a plain second send", async () => {
      const { sender, baseUrl, mock, token } = await sentOnce();
      const res = await onboard(baseUrl, "grace", { Authorization: `Bearer ${token}` });
      expect(res.status).toBe(409);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(filed(mock)).toHaveLength(1);
    });

    it("sends again when the admin asks for a resend, without a second DCS request", async () => {
      const { sender, baseUrl, mock, token } = await sentOnce();
      const res = await onboard(
        baseUrl,
        "grace",
        { Authorization: `Bearer ${token}` },
        { resend: true },
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ status: "done", email: "grace@lab.co" });
      expect(sender).toHaveBeenCalledTimes(2);
      expect(sender.mock.calls[1]?.[0]).toMatchObject({
        template_id: "member",
        email: "grace@lab.co",
        add_dcs_roster_row: false,
      });
      expect(filed(mock)).toHaveLength(2);
      expect(filed(mock)[1]?.proposed_payload).toMatchObject({ resend: true });
    });

    it("refuses a resend from a member session that is not an admin", async () => {
      const { sender, baseUrl, mock } = await sentOnce();
      const token = await memberToken(mock, baseUrl, "pat", "pat@cs.toronto.edu");
      const res = await onboard(
        baseUrl,
        "grace",
        { Authorization: `Bearer ${token}` },
        { resend: true },
      );
      expect(res.status).toBe(403);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(filed(mock)).toHaveLength(1);
    });

    it("refuses a resend from the service principal", async () => {
      const { sender, baseUrl, mock } = await sentOnce();
      const res = await onboard(
        baseUrl,
        "grace",
        { Authorization: `Bearer ${SERVICE_TOKEN}` },
        { resend: true },
      );
      expect(res.status).toBe(403);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(filed(mock)).toHaveLength(1);
    });

    it("rejects a resend flag that is not a boolean", async () => {
      const { sender, baseUrl, mock, token } = await sentOnce();
      const res = await onboard(
        baseUrl,
        "grace",
        { Authorization: `Bearer ${token}` },
        { resend: "yes" },
      );
      expect(res.status).toBe(400);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(filed(mock)).toHaveLength(1);
    });
  });

  it("passes the service's reason through when there is no guide to send", async () => {
    const { baseUrl, mock } = await lab();
    const token = await memberToken(mock, baseUrl, "admin", "admin@cs.toronto.edu");
    const res = await onboard(baseUrl, "pat", { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("Member Type") },
    });
  });
});
