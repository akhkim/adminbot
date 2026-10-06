// The shared onboarding (server.member-onboarding.ts) as the routes run it: the weekly sweep creates
// joiners least-privileged and files their enrollment for an admin, approving that runs the same
// steps every other path runs, and an approved guide carries the project channels the admin
// picked.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotLabMemberInput, AdminBotStoredProposal } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import type { AdminBotOnboardingSender } from "../workflows/onboarding/guide-sender.js";
import { createAdminBotMockService } from "./server.js";
import { queueNewMemberGuide } from "./server.member-onboarding.js";

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

async function startService(options: { sheetRows?: string[][] } = {}) {
  const executed: AdminBotStoredProposal[] = [];
  const guides: Array<Record<string, unknown>> = [];
  const calendarShares: string[] = [];
  const connectInvites: string[] = [];
  const onboardingSender = (async (request: Record<string, unknown>) => {
    guides.push(request);
    return { ok: true, payload: { template_id: "member", subject: "Hi", body: "Hi" } };
  }) as unknown as AdminBotOnboardingSender;
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async (email: string) => {
      calendarShares.push(email);
    },
    accountApprovedEmailRunner: async () => {},
    inviteToSlackConnect: async ({ email }) => {
      connectInvites.push(email);
      return { url: `https://join.slack.example/${email}` };
    },
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
      read: vi.fn(async () => [HEADER, ...(options.sheetRows ?? [])]),
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
  const admin = mock.service.upsertLabMember(
    withCompleteProfile({
      id: "admin",
      name: "Admin",
      email: "admin@cs.toronto.edu",
      privilege_level: "admin",
      member_type: "full",
    } as AdminBotLabMemberInput),
  );
  if (!admin.ok) {
    throw new Error(admin.error.message);
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    mock,
    executed,
    guides,
    calendarShares,
    connectInvites,
  };
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
  const registrations = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  const registration = (
    (await registrations.json()) as { registrations: Array<{ id: string; member_id?: string }> }
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

function pending(mock: ReturnType<typeof createAdminBotMockService>) {
  const listed = mock.service.listPending();
  return listed.ok ? listed.payload.proposals : [];
}

async function approveAndRun(
  baseUrl: string,
  token: string,
  proposal: AdminBotStoredProposal,
): Promise<void> {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const approved = await fetch(`${baseUrl}/approvals/${proposal.id}/approve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ payload_hash: proposal.payload_hash }),
  });
  expect(approved.status).toBe(200);
  const executed = await fetch(`${baseUrl}/actions/${proposal.id}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dry_run: false, idempotency_key: `test-${proposal.id}` }),
  });
  expect(executed.status).toBe(200);
}

async function runSweep(baseUrl: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/onboarding/sheet-sweep/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_TOKEN}` },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    created: string[];
    enrollments: Array<{ member_id: string; proposal_id?: string }>;
  };
}

function rosterEntry(mock: ReturnType<typeof createAdminBotMockService>, id: string) {
  const roster = mock.service.listLabMembers();
  return roster.ok ? roster.payload.members.find((member) => member.id === id) : undefined;
}

describe("the weekly sheet sweep", () => {
  it("creates joiners at the least-privileged level and files their enrollment for approval", async () => {
    const { baseUrl, mock, executed, calendarShares } = await startService({
      sheetRows: [
        ["Ada Lovelace", "full", "ada@cs.toronto.edu", ""],
        ["Acq Person", "acquaintance", "acq@example.org", ""],
      ],
    });
    const body = await runSweep(baseUrl);

    // The no-mail acquaintance is a joiner too now, not a row the sweep leaves behind.
    expect(body.created.toSorted()).toEqual(["acq-person", "ada-lovelace"]);
    // The sheet is not an authorization surface: nobody is raised by a cron job.
    expect(rosterEntry(mock, "ada-lovelace")).toMatchObject({
      privilege_level: "external_collaborator",
    });
    expect(executed).toEqual([]);
    expect(calendarShares).toEqual([]);
    const waiting = pending(mock).map((proposal) => [proposal.type, proposal.target?.target]);
    expect(waiting).toEqual(
      expect.arrayContaining([
        ["lab_member.enroll", "ada-lovelace"],
        ["lab_member.enroll", "acq-person"],
        ["onboarding.send_guide", "ada@cs.toronto.edu"],
      ]),
    );
    expect(body.enrollments.map((entry) => entry.member_id).toSorted()).toEqual([
      "acq-person",
      "ada-lovelace",
    ]);
  });

  it("files nothing on a dry run", async () => {
    const { baseUrl, mock } = await startService({
      sheetRows: [["Ada Lovelace", "full", "ada@cs.toronto.edu", ""]],
    });
    await runSweep(baseUrl, { dry_run: true });
    expect(pending(mock)).toEqual([]);
  });
});

describe("approving a sweep joiner's enrollment", () => {
  it("sets the level their type implies and runs the same enrollment, approved by that admin", async () => {
    const { baseUrl, mock, executed, calendarShares } = await startService({
      sheetRows: [["Ada Lovelace", "full", "ada@cs.toronto.edu", ""]],
    });
    await runSweep(baseUrl);
    const token = await adminToken(mock, baseUrl);
    const enroll = pending(mock).find((proposal) => proposal.type === "lab_member.enroll");

    await approveAndRun(baseUrl, token, enroll!);

    expect(rosterEntry(mock, "ada-lovelace")).toMatchObject({ privilege_level: "member" });
    // Granted through the gate, approved by the admin who approved the enrollment, and recorded
    // where the calendar backfill looks.
    expect(calendarShares).toEqual(["ada@cs.toronto.edu"]);
    // The grant runs in-process rather than through the injected connector, so read it off the ledger.
    expect(executed.map((proposal) => proposal.type)).not.toContain("calendar.grant_lab_calendar");
    const [grant] = mock.store.listProposalsByType("calendar.grant_lab_calendar");
    expect(grant?.status).toBe("executed");
    expect(grant?.approvals.map((approval) => approval.approver_id)).toEqual(["admin"]);
    const audit = mock.store
      .listAuditEvents()
      .find((event) => event.type === "auth.calendar_invite_sent");
    expect(audit?.details).toMatchObject({
      member_id: "ada-lovelace",
      email: "ada@cs.toronto.edu",
    });
  });

  it("refuses a card whose Member Type changed after it was filed", async () => {
    const { baseUrl, mock, calendarShares } = await startService({
      sheetRows: [["Ada Lovelace", "full", "ada@cs.toronto.edu", ""]],
    });
    await runSweep(baseUrl);
    const token = await adminToken(mock, baseUrl);
    const enroll = pending(mock).find((proposal) => proposal.type === "lab_member.enroll");
    mock.service.upsertLabMember({ id: "ada-lovelace", member_type: "acquaintance" } as never);

    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    await fetch(`${baseUrl}/approvals/${enroll!.id}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ payload_hash: enroll!.payload_hash }),
    });
    const executed = await fetch(`${baseUrl}/actions/${enroll!.id}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dry_run: false, idempotency_key: `test-${enroll!.id}` }),
    });
    // Refused, not performed: recorded like a dry run and never stored as executed.
    expect(((await executed.json()) as { status: string }).status).toBe("simulated");
    expect(mock.store.listProposalsByType("lab_member.enroll")[0]?.status).toBe("approved");
    expect(rosterEntry(mock, "ada-lovelace")).toMatchObject({
      privilege_level: "external_collaborator",
    });
    expect(calendarShares).toEqual([]);
  });

  it("invites a no-mail joiner through Slack Connect once, and not again while it is fresh", async () => {
    const { baseUrl, mock, connectInvites } = await startService({
      sheetRows: [["Acq Person", "acquaintance", "acq@example.org", ""]],
    });
    await runSweep(baseUrl);
    const token = await adminToken(mock, baseUrl);
    process.env.ADMINBOT_ONBOARDING_CHANNEL_ID = "CFRIENDS";
    try {
      const enroll = pending(mock).find((proposal) => proposal.type === "lab_member.enroll");
      await approveAndRun(baseUrl, token, enroll!);
      expect(connectInvites).toEqual(["acq@example.org"]);

      // The same person reached again: the cached link is reused rather than a second invite.
      const again = mock.service.createProposal({
        type: "slack.connect_invite",
        summary: "again",
        target: { service: "slack", channel: "slack", target: "acq@example.org" },
        proposed_payload: { email: "acq@example.org", member_id: "acq-person" },
      });
      if (!again.ok) {
        throw new Error(again.error.message);
      }
      await approveAndRun(baseUrl, token, again.payload);
    } finally {
      delete process.env.ADMINBOT_ONBOARDING_CHANNEL_ID;
    }
    expect(connectInvites).toEqual(["acq@example.org"]);
  });
});

describe("the guide action", () => {
  it("leaves an unattended full-member import pending without an approving admin", async () => {
    const { mock, guides } = await startService();
    mock.service.upsertLabMember(
      withCompleteProfile({
        id: "unreviewed",
        name: "Unreviewed",
        email: "unreviewed@lab.test",
        member_type: "full",
      } as AdminBotLabMemberInput),
    );
    const result = await queueNewMemberGuide(
      { service: mock.service, actor: "sheet-sweep" },
      "unreviewed",
    );
    expect(result.status).toBe("queued");
    expect(guides).toHaveLength(0);
    if (result.status !== "queued") throw new Error("expected pending guide");
    expect(mock.service.getProposal(result.proposal_id)?.status).toBe("pending");
  });

  it("sends a full-member guide immediately on the admin's click and refuses a second send", async () => {
    const { baseUrl, mock, guides } = await startService();
    const token = await adminToken(mock, baseUrl);
    mock.service.upsertLabMember(
      withCompleteProfile({
        id: "full-joiner",
        name: "Full Joiner",
        email: "joiner@lab.test",
        member_type: "full",
      } as AdminBotLabMemberInput),
    );
    const send = () =>
      fetch(`${baseUrl}/lab/members/full-joiner/onboarding/guide`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ slack_project_channels: ["#proj-example"] }),
      });
    const response = await send();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      status: "done",
      template_id: "member",
      email: "joiner@lab.test",
    });
    expect(guides).toHaveLength(1);
    expect(guides[0]).toMatchObject({
      template_id: "member",
      slack_project_channels: ["#proj-example"],
    });
    const proposal = mock.service.getProposal(result.proposal_id);
    expect(proposal?.status).toBe("executed");
    expect(proposal?.approvals).toEqual([
      expect.objectContaining({ approver_id: "admin", approver_role: "admin" }),
    ]);
    expect((await send()).status).toBe(409);
    expect(guides).toHaveLength(1);
  });
  it("sends an approved guide with the project channels the admin picked", async () => {
    const { baseUrl, mock, guides } = await startService();
    const token = await adminToken(mock, baseUrl);
    const saved = mock.service.upsertLabMember(
      withCompleteProfile({
        id: "cora",
        name: "Cora",
        email: "cora@lab.test",
        member_type: "coauthor-minor",
      } as AdminBotLabMemberInput),
    );
    expect(saved.ok).toBe(true);

    const queued = await fetch(`${baseUrl}/lab/members/cora/onboarding/guide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ slack_project_channels: ["proj-alg-circuit"] }),
    });
    expect(queued.status).toBe(200);
    const guide = pending(mock).find((proposal) => proposal.type === "onboarding.send_guide");
    await approveAndRun(baseUrl, token, guide!);

    expect(guides).toHaveLength(1);
    expect(guides[0]).toMatchObject({
      email: "cora@lab.test",
      slack_project_channels: ["proj-alg-circuit"],
    });
  });
});
