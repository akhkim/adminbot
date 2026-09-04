import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "email-review-service-token";
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
  mock.store.savePaperSlot({
    paper_id: "paper-1",
    slot: "submission",
    status: "provided",
    url: "https://openreview.net/forum?id=paper-1",
  });
  mock.store.saveEmailReview({
    message_id: "gmail-message-1",
    thread_id: "gmail-thread-1",
    sender: "notifications@openreview.net",
    subject: "Reviews released for Reliable Research Agents",
    category: "paperflow_bcc",
    reason: "paperflow bcc from notifications@openreview.net is not a lab address",
    received_at: "2026-09-03T21:04:00.000Z",
    updated_at: "2026-09-03T21:05:00.000Z",
  });
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

describe("email review routes", () => {
  it("shows held mail and current PaperFlow targets only to an administrator", async () => {
    const { mock, baseUrl } = await startLab();
    const admin = await memberSession(mock, baseUrl, "admin");
    const member = await memberSession(mock, baseUrl, "member");

    expect(
      await fetch(`${baseUrl}/automation/email/review`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
      }),
    ).toMatchObject({ status: 403 });
    expect(await fetch(`${baseUrl}/automation/email/review`, { headers: member })).toMatchObject({
      status: 403,
    });

    const response = await fetch(`${baseUrl}/automation/email/review`, { headers: admin });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reviews: [
        expect.objectContaining({
          message_id: "gmail-message-1",
          subject: "Reviews released for Reliable Research Agents",
          sender: "notifications@openreview.net",
        }),
      ],
      paperflow_candidates: [
        expect.objectContaining({
          paper_id: "paper-1",
          title: "Reliable Research Agents",
          stage: "reviews_out",
          stage_label: "Reviews",
        }),
      ],
    });
  });

  it("attaches the original email as evidence and removes it from the queue", async () => {
    const { mock, baseUrl } = await startLab();
    const admin = await memberSession(mock, baseUrl, "admin");
    const staleTarget = await fetch(`${baseUrl}/automation/email/review/gmail-message-1`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        kind: "paperflow_evidence",
        paper_id: "paper-1",
        stage: "decision",
      }),
    });
    expect(staleTarget.status).toBe(409);
    expect(mock.store.listEmailReviews()).toHaveLength(1);
    expect(mock.store.listPaperflowEvidence("paper-1")).toEqual([]);

    const response = await fetch(`${baseUrl}/automation/email/review/gmail-message-1`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        kind: "paperflow_evidence",
        paper_id: "paper-1",
        stage: "reviews_out",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resolution: "paperflow_evidence",
      evidence_recorded: true,
    });
    expect(mock.store.listEmailReviews()).toEqual([]);
    expect(mock.store.listPaperflowEvidence("paper-1")).toEqual([
      expect.objectContaining({
        message_id: "gmail-message-1",
        sender: "notifications@openreview.net",
        stage: "reviews_out",
        recorded_by: "admin",
      }),
    ]);
    expect(
      mock.store.listAuditEvents().some((event) => event.type === "email_review.resolved"),
    ).toBe(true);
  });

  it("dismisses unrelated mail without changing a paper", async () => {
    const { mock, baseUrl } = await startLab();
    const admin = await memberSession(mock, baseUrl, "admin");
    const response = await fetch(`${baseUrl}/automation/email/review/gmail-message-1`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ kind: "dismissed" }),
    });

    expect(response.status).toBe(200);
    expect(mock.store.listEmailReviews()).toEqual([]);
    expect(mock.store.listPaperflowEvidence("paper-1")).toEqual([]);
  });
});
