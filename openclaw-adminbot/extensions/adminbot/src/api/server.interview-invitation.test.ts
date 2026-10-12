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

async function setup() {
  const sender = vi.fn(async (request: { preview?: boolean }) => ({
    ok: true as const,
    payload: {
      template_id: "interviewee",
      subject: "Example interview",
      body: "Example task",
      sent: !request.preview,
    },
  }));
  const { mock, baseUrl } = await startService(sender as never);
  for (const [id, slack] of [
    ["one", "UONE"],
    ["two", "UTWO"],
    ["proposer", "UPROPOSER"],
  ]) {
    seedMember(mock, {
      id,
      name: id,
      email: `${id}@example.com`,
      privilege_level: "member",
      slack_user_id: slack,
    });
  }
  const token = await memberToken(mock, baseUrl, "proposer", "proposer@example.com");
  const payload = {
    name: "Example Candidate",
    email: "candidate@example.com",
    interview: {
      project: "Example project",
      task: "Example task",
      interviewer_ids: ["UONE", "UTWO"],
    },
  };
  const post = (body: unknown, auth = token) =>
    fetch(`${baseUrl}/onboarding/interview-invitation`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${auth}` }),
      body: JSON.stringify(body),
    });
  return { mock, post, payload, sender };
}
describe("interview invitation route", () => {
  it("lets a member preview and queue an immutable proposal without sending or enrolling", async () => {
    const { mock, post, payload, sender } = await setup();
    expect((await post({ ...payload, preview: true })).status).toBe(200);
    expect(mock.store.listProposalsByType("onboarding.send_guide")).toHaveLength(0);
    expect((await post(payload)).status).toBe(200);
    const proposal = mock.store.listProposalsByType("onboarding.send_guide")[0];
    expect(proposal.status).toBe("pending");
    expect(proposal.proposed_payload).toMatchObject({ interview: payload.interview });
    expect(sender.mock.calls.every(([request]) => request.preview)).toBe(true);
    expect(mock.store.listLabMembers().some((member) => member.email === payload.email)).toBe(
      false,
    );
    expect((await post(payload)).status).toBe(409);
    expect((await mock.service.execute(proposal.id, { dry_run: false })).ok).toBe(false);
    expect(
      mock.service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "admin",
        approver_id: "test-admin",
      }).ok,
    ).toBe(true);
    expect((await mock.service.execute(proposal.id, { dry_run: false })).ok).toBe(true);
    expect(sender).toHaveBeenLastCalledWith(
      expect.objectContaining({
        interview: payload.interview,
        cc: ["one@example.com", "two@example.com"],
        reply_to: "one@example.com",
      }),
    );
    expect(
      mock.store.listLabMembers().find((member) => member.email === payload.email),
    ).toMatchObject({
      member_type: "interviewee",
      privilege_level: "external_collaborator",
    });
  });
  it("rejects the shared service token and invalid interviewer selections", async () => {
    const { post, payload, sender } = await setup();
    expect((await post(payload, SERVICE_TOKEN)).status).toBe(403);
    expect(
      (
        await post({
          ...payload,
          interview: { ...payload.interview, interviewer_ids: ["UONE", "UUNKNOWN"] },
        })
      ).status,
    ).toBe(400);
    expect(sender).not.toHaveBeenCalled();
  });
});
