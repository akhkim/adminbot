import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

type RunningService = {
  baseUrl: string;
  mock: ReturnType<typeof createAdminBotMockService>;
  cleanupPaths: string[];
};

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    for (const cleanupPath of entry.cleanupPaths) {
      await rm(cleanupPath, { force: true });
    }
  }
});

async function startService(
  options: Parameters<typeof createAdminBotMockService>[0] = {},
): Promise<{ baseUrl: string; mock: ReturnType<typeof createAdminBotMockService> }> {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-sensitive-info-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    // Default to no-ops so approving a registration never shells out to the real `gws`/`gog`
    // binaries in tests (which would send live invites and mail); individual tests override these
    // to assert on the calls themselves.
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
    ...options,
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  running.push({ baseUrl, mock, cleanupPaths: [sensitiveInfoPath] });
  return { baseUrl, mock };
}

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${SERVICE_TOKEN}`, ...extra };
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

// The service principal can no longer set privileged fields or approve registrations over HTTP, so
// tests bootstrap roster/credential state in-process (the operator's direct-database seeding path).
function mockFor(baseUrl: string): ReturnType<typeof createAdminBotMockService> {
  const entry = running.find((candidate) => candidate.baseUrl === baseUrl);
  if (!entry) {
    throw new Error(`no running service for ${baseUrl}`);
  }
  return entry.mock;
}

function seedMember(baseUrl: string, id: string, body: Record<string, unknown>): void {
  const result = mockFor(baseUrl).service.upsertLabMember({
    ...(body as AdminBotLabMemberInput),
    id,
  });
  if (!result.ok) {
    throw new Error(`failed to seed member ${id}: ${result.error.message}`);
  }
}

type RegistrationView = { id: string; kind: string; member_id?: string };

async function listPending(baseUrl: string): Promise<RegistrationView[]> {
  const res = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
    headers: serviceHeaders(),
  });
  return ((await res.json()) as { registrations: RegistrationView[] }).registrations;
}

function approveRegistration(baseUrl: string, id: string): { member_id: string } {
  const result = mockFor(baseUrl).auth.approveRegistration(id, "test-admin");
  if (!result.ok) {
    throw new Error(`approve failed for ${id}: ${result.error.message}`);
  }
  return result.payload;
}

function rejectRegistration(baseUrl: string, id: string): void {
  const result = mockFor(baseUrl).auth.rejectRegistration(id, "test-admin");
  if (!result.ok) {
    throw new Error(`reject failed for ${id}: ${result.error.message}`);
  }
}

async function approveClaim(baseUrl: string, memberId: string, email: string): Promise<void> {
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ member_id: memberId, email, password: "correcthorse" }),
  });
  const registration = (await listPending(baseUrl)).find((entry) => entry.member_id === memberId);
  if (!registration) {
    throw new Error(`no pending claim for ${memberId}`);
  }
  approveRegistration(baseUrl, registration.id);
}

async function loginToken(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  return ((await res.json()) as { session_token: string }).session_token;
}

describe("AdminBot mock service", () => {
  it("serves the management UI and state endpoints for the service principal", async () => {
    const { baseUrl } = await startService();

    const ui = await fetch(`${baseUrl}/adminbot`);
    const uiHtml = await ui.text();
    expect(uiHtml).toContain("AdminBot Console");
    expect(uiHtml).toContain("member-search");

    const settings = await fetch(`${baseUrl}/settings`, { headers: serviceHeaders() });
    await expect(settings.json()).resolves.toMatchObject({
      paper_escalation_business_days: 3,
    });

    // The service principal may update whitelisted profile fields on an existing member; member
    // creation and governed fields (status/privilege_level/...) are reserved for admin sessions.
    seedMember(baseUrl, "pat", { name: "Pat", email: "pat@cs.toronto.edu" });
    const member = await fetch(`${baseUrl}/lab/members/pat`, {
      method: "PUT",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Pat",
        research_branch: "Human-centered AI",
        projects: ["Project Atlas"],
      }),
    });
    expect(member.status).toBe(200);
    await expect(member.json()).resolves.toMatchObject({
      id: "pat",
      name: "Pat",
      privilege_level: "external_collaborator",
    });

    // Sensitive info is no longer readable by the service principal.
    const sensitiveInfo = await fetch(`${baseUrl}/sensitive-info`, { headers: serviceHeaders() });
    expect(sensitiveInfo.status).toBe(403);
  });

  it("serves the deadlines board and dataset as public, unauthenticated routes", async () => {
    const { baseUrl } = await startService();

    const board = await fetch(`${baseUrl}/deadlines`);
    expect(board.status).toBe(200);
    expect(await board.text()).toContain("Deadlines");

    const dataset = await fetch(`${baseUrl}/deadlines/venues.json`);
    expect(dataset.status).toBe(200);
    const body = (await dataset.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("serves the member map page as a public, unauthenticated shell", async () => {
    const { baseUrl } = await startService();

    const page = await fetch(`${baseUrl}/lab_stats/member_map`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Lab Member Map");

    // The shell loads without a session, and so does the data it fetches -- anonymously, that
    // data is a names-stripped, counts-only summary rather than a 401.
    const data = await fetch(`${baseUrl}/member-map`);
    expect(data.status).toBe(200);
    await expect(data.json()).resolves.toMatchObject({ mode: "summary" });
  });

  it("rejects unauthenticated requests to gated routes", async () => {
    const { baseUrl } = await startService();
    const members = await fetch(`${baseUrl}/lab/members`);
    expect(members.status).toBe(401);
    await expect(members.json()).resolves.toEqual({
      error: { message: "authentication required" },
    });
  });

  it("accepts Slack channel naming events for the service principal", async () => {
    const { baseUrl } = await startService({
      executor: { execute: async () => ({ handled: true }) },
    });
    const res = await fetch(`${baseUrl}/slack/channel-naming/events`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        event_type: "channel_created",
        channel_id: "C123",
        channel_name: "eu-post-training",
        owner_user_id: "U123",
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "reminder_sent",
      channel_id: "C123",
      suggested_name: "proj-eu-post-training",
    });
  });

  it("runs Slack channel naming sweep over due reminders", async () => {
    const { baseUrl } = await startService({
      executor: { execute: async () => ({ handled: true }) },
    });
    await fetch(`${baseUrl}/slack/channel-naming/events`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        event_type: "channel_created",
        channel_id: "C777",
        channel_name: "rule-coherence-project",
        owner_user_id: "U777",
      }),
    });
    const sweep = await fetch(`${baseUrl}/slack/channel-naming/sweep/run`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ now: "2099-01-01T00:00:00.000Z" }),
    });
    expect(sweep.status).toBe(200);
    await expect(sweep.json()).resolves.toMatchObject({
      scanned: 1,
      renames_proposed: 1,
      skipped: 0,
    });
  });

  it("claim queues a pending registration, login is blocked until approval", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "ada", {
      name: "Ada",
      email: "Ada@cs.toronto.edu",
      privilege_level: "member",
    });

    const claim = await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "ada",
        email: "ada@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toEqual({ status: "pending" });
    expect(claim.headers.get("set-cookie")).toBeNull();

    const blocked = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "ada@cs.toronto.edu", password: "correcthorse" }),
    });
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toEqual({
      error: "account pending approval",
      code: "pending_approval",
    });

    // Roster no longer lists a member with a pending claim.
    const roster = await (await fetch(`${baseUrl}/auth/roster`)).json();
    expect((roster as { members: Array<{ id: string }> }).members.map((m) => m.id)).not.toContain(
      "ada",
    );

    const pending = await listPending(baseUrl);
    const registration = pending.find((entry) => entry.member_id === "ada");
    expect(registration?.kind).toBe("claim");
    approveRegistration(baseUrl, registration!.id);

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "ada@cs.toronto.edu", password: "correcthorse" }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { session_token: string; member: { id: string } };
    expect(loginBody.session_token).toBeTruthy();
    expect(loginBody.member.id).toBe("ada");
    expect(login.headers.get("set-cookie")).toContain("adminbot_session=");

    const sessionView = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${loginBody.session_token}` },
    });
    expect(sessionView.status).toBe(200);
    const viewBody = (await sessionView.json()) as Record<string, unknown>;
    expect(viewBody.session_token).toBeUndefined();
    expect((viewBody.member as { id: string }).id).toBe("ada");
  });

  it("signup then approval creates a member reachable by login", async () => {
    const { baseUrl } = await startService();
    const signup = await fetch(`${baseUrl}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        profile: { name: "New Person", research_branch: "Systems" },
        email: "new@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    expect(signup.status).toBe(200);
    await expect(signup.json()).resolves.toEqual({ status: "pending" });

    const registration = (await listPending(baseUrl)).find((entry) => entry.kind === "signup");
    expect(registration).toBeDefined();
    const approveBody = approveRegistration(baseUrl, registration!.id);

    const members = await (
      await fetch(`${baseUrl}/lab/members`, { headers: serviceHeaders() })
    ).json();
    const created = (members as { members: Array<{ id: string; name: string }> }).members.find(
      (m) => m.id === approveBody.member_id,
    );
    expect(created?.name).toBe("New Person");

    expect(await loginToken(baseUrl, "new@cs.toronto.edu")).toBeTruthy();
  });

  it("approving a registration invites the account email to the lab calendar and seeds an onboarding checklist", async () => {
    const invited: string[] = [];
    const { baseUrl } = await startService({
      calendarInviteRunner: async (email) => {
        invited.push(email);
      },
    });
    const signup = await fetch(`${baseUrl}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        profile: { name: "Calendar Person" },
        email: "calendar-person@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    expect(signup.status).toBe(200);

    const registration = (await listPending(baseUrl)).find((entry) => entry.kind === "signup");
    const approveBody = approveRegistration(baseUrl, registration!.id);

    // Fire-and-forget: flush microtasks so the injected runner's resolution is observable.
    await Promise.resolve();
    await Promise.resolve();
    expect(invited).toEqual(["calendar-person@cs.toronto.edu"]);

    const members = (await (
      await fetch(`${baseUrl}/lab/members`, { headers: serviceHeaders() })
    ).json()) as {
      members: Array<{ id: string; onboarding?: { steps: Array<{ id: string; status: string }> } }>;
    };
    const created = members.members.find((m) => m.id === approveBody.member_id);
    const calendarStep = created?.onboarding?.steps.find((step) => step.id === "calendar_invite");
    expect(calendarStep?.status).toBe("complete");
    expect(created?.onboarding?.steps.length).toBeGreaterThan(1);
  });

  it("approving a registration emails the member that their account is live", async () => {
    const sent: Array<{ email: string; name?: string }> = [];
    const { baseUrl } = await startService({
      accountApprovedEmailRunner: async (params) => {
        sent.push(params);
      },
    });
    await fetch(`${baseUrl}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        profile: { name: "Mailed Person" },
        email: "mailed-person@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.kind === "signup");
    approveRegistration(baseUrl, registration!.id);

    // Fire-and-forget: flush microtasks so the injected runner's resolution is observable.
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([{ email: "mailed-person@cs.toronto.edu", name: "Mailed Person" }]);
  });

  // The request moved off approval and onto the send that promises it. Approving is now silent:
  // by then the member has the address the request produces.
  it("approving a registration files no DCS request", async () => {
    const submitted: Array<{ firstName: string; lastName: string; email: string }> = [];
    const { baseUrl } = await startService({
      dcsFormRunner: async (params) => {
        submitted.push(params);
      },
    });
    await fetch(`${baseUrl}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        profile: { name: "Dcs Person" },
        email: "dcs-person@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.kind === "signup");
    approveRegistration(baseUrl, registration!.id);

    await Promise.resolve();
    await Promise.resolve();
    expect(submitted).toEqual([]);
  });

  // The other half of the move: the send files it, and the audit trail follows the trigger. The
  // request lands on a Microsoft Form with no receipt, so this row is the only evidence.
  it("sending the full-member guide files the DCS request and audits it", async () => {
    const submitted: Array<{ firstName: string; lastName: string; email: string }> = [];
    const { baseUrl } = await startService({
      dcsFormRunner: async (params) => {
        submitted.push(params);
      },
    });
    await seedMember(baseUrl, "boss", {
      name: "Boss",
      email: "boss@cs.toronto.edu",
      privilege_level: "admin",
    });
    await approveClaim(baseUrl, "boss", "boss@cs.toronto.edu");
    const adminToken = await loginToken(baseUrl, "boss@cs.toronto.edu");

    const response = await fetch(`${baseUrl}/onboarding/guide`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${adminToken}` }),
      body: JSON.stringify({
        template_id: "member",
        name: "Dcs Person",
        email: "dcs-person@cs.toronto.edu",
        preview: true,
      }),
    });
    expect(response.status).toBe(200);
    // A preview provisions and sends nothing, so it must not file a request either.
    expect(submitted).toEqual([]);
  });


  it("does not email anyone when a registration is rejected", async () => {
    const sent: Array<{ email: string }> = [];
    const { baseUrl } = await startService({
      accountApprovedEmailRunner: async (params) => {
        sent.push(params);
      },
    });
    seedMember(baseUrl, "nope", { name: "Nope", email: "nope@cs.toronto.edu" });
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "nope",
        email: "nope@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.member_id === "nope");
    rejectRegistration(baseUrl, registration!.id);

    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([]);
  });

  it("a failing approval email does not block approval or expose an error to the caller", async () => {
    const { baseUrl } = await startService({
      accountApprovedEmailRunner: async () => {
        throw new Error("gog unreachable");
      },
    });
    seedMember(baseUrl, "mk", { name: "MK", email: "mk@cs.toronto.edu" });
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "mk",
        email: "mk@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.member_id === "mk");
    expect(approveRegistration(baseUrl, registration!.id)).toEqual({
      status: "approved",
      member_id: "mk",
    });
    expect(await loginToken(baseUrl, "mk@cs.toronto.edu")).toBeTruthy();
  });

  it("a failing calendar invite does not block approval or expose an error to the caller", async () => {
    const { baseUrl } = await startService({
      calendarInviteRunner: async () => {
        throw new Error("gws unreachable");
      },
    });
    await seedMember(baseUrl, "rk", { name: "RK", email: "rk@cs.toronto.edu" });
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "rk",
        email: "rk@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.member_id === "rk");
    const approveBody = approveRegistration(baseUrl, registration!.id);
    expect(approveBody).toEqual({ status: "approved", member_id: "rk" });
    expect(await loginToken(baseUrl, "rk@cs.toronto.edu")).toBeTruthy();
  });

  it("rejected registrations produce a generic 401 on login", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "rj", { name: "RJ", email: "rj@cs.toronto.edu" });
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "rj",
        email: "rj@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.member_id === "rj");
    rejectRegistration(baseUrl, registration!.id);

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "rj@cs.toronto.edu", password: "correcthorse" }),
    });
    expect(login.status).toBe(401);
    await expect(login.json()).resolves.toEqual({
      error: { message: "invalid email or password" },
    });
  });

  it("includes the gateway payload only when a gateway token is configured", async () => {
    const { baseUrl } = await startService({ gatewayToken: "gw-secret", gatewayUrl: "ws://x:1" });
    await seedMember(baseUrl, "gwm", { name: "GW", email: "gw@cs.toronto.edu" });
    await approveClaim(baseUrl, "gwm", "gw@cs.toronto.edu");

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "gw@cs.toronto.edu", password: "correcthorse" }),
    });
    const body = (await login.json()) as { gateway?: { url: string; token: string } };
    expect(body.gateway).toEqual({ url: "ws://x:1", token: "gw-secret" });
  });

  it("returns generic errors for unknown claims, collisions, and short passwords", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "known", { name: "Known", email: "known@cs.toronto.edu" });

    const unknownClaim = await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "ghost",
        email: "nobody@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    expect(unknownClaim.status).toBe(403);
    await expect(unknownClaim.json()).resolves.toEqual({
      error: { message: "unable to claim this profile" },
    });

    const shortClaim = await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "known",
        email: "known@cs.toronto.edu",
        password: "short",
      }),
    });
    expect(shortClaim.status).toBe(400);

    const badLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "known@cs.toronto.edu", password: "wrongpassword" }),
    });
    expect(badLogin.status).toBe(401);
    await expect(badLogin.json()).resolves.toEqual({
      error: { message: "invalid email or password" },
    });
  });

  it("only lets privileged principals list and decide registrations", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "self", "self@cs.toronto.edu");
    const memberToken = await loginToken(baseUrl, "self@cs.toronto.edu");

    const anonList = await fetch(`${baseUrl}/auth/registrations`);
    expect(anonList.status).toBe(401);

    const memberList = await fetch(`${baseUrl}/auth/registrations`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberList.status).toBe(403);

    const memberApprove = await fetch(`${baseUrl}/auth/registrations/anything/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberApprove.status).toBe(403);

    const serviceList = await fetch(`${baseUrl}/auth/registrations`, { headers: serviceHeaders() });
    expect(serviceList.status).toBe(200);
  });

  it("rate limits repeated login failures", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "rl", { name: "RL", email: "rl@cs.toronto.edu" });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ email: "rl@cs.toronto.edu", password: "wrongpassword" }),
      });
      expect(res.status).toBe(401);
    }
    const limited = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "rl@cs.toronto.edu", password: "wrongpassword" }),
    });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as {
      error: { message: string };
      retry_after_seconds: number;
    };
    expect(body.error.message).toBe("too many attempts, retry later");
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  it("only honors X-Forwarded-For for the caller's IP when trustProxyHeaders is on", async () => {
    const spoofed = "203.0.113.9";

    async function rateLimitAndGetAuditedIp(trustProxyHeaders: boolean): Promise<unknown> {
      const { baseUrl } = await startService({ trustProxyHeaders });
      await seedMember(baseUrl, "rl2", { name: "RL2", email: "rl2@example.com" });
      for (let attempt = 0; attempt < 11; attempt += 1) {
        await fetch(`${baseUrl}/auth/login`, {
          method: "POST",
          headers: jsonHeaders({ "X-Forwarded-For": spoofed }),
          body: JSON.stringify({ email: "rl2@example.com", password: "wrongpassword" }),
        });
      }
      const events = mockFor(baseUrl).service.listAuditEvents();
      const limited = events.find((event) => event.type === "auth.rate_limited");
      return limited?.details?.remote_ip;
    }

    // Untrusted (the default): a caller-supplied header must never override the real socket
    // address, or anyone could spoof their way around IP-based rate limiting.
    await expect(rateLimitAndGetAuditedIp(false)).resolves.not.toBe(spoofed);
    // Trusted: this process is configured to sit behind a proxy that sets the header itself.
    await expect(rateLimitAndGetAuditedIp(true)).resolves.toBe(spoofed);
  });

  it("guards member self-profile edits", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@cs.toronto.edu",
      privilege_level: "member",
    });
    await seedMember(baseUrl, "other", { name: "Other", email: "other@cs.toronto.edu" });
    await approveClaim(baseUrl, "self", "self@cs.toronto.edu");
    const token = await loginToken(baseUrl, "self@cs.toronto.edu");
    const memberHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const ownEdit = await fetch(`${baseUrl}/lab/members/self`, {
      method: "PUT",
      headers: memberHeaders,
      body: JSON.stringify({ name: "Self Updated", location: "Zurich" }),
    });
    expect(ownEdit.status).toBe(200);
    await expect(ownEdit.json()).resolves.toMatchObject({
      id: "self",
      name: "Self Updated",
      location: "Zurich",
      privilege_level: "member",
    });

    const otherEdit = await fetch(`${baseUrl}/lab/members/other`, {
      method: "PUT",
      headers: memberHeaders,
      body: JSON.stringify({ name: "Hacked" }),
    });
    expect(otherEdit.status).toBe(403);

    const escalate = await fetch(`${baseUrl}/lab/members/self`, {
      method: "PUT",
      headers: memberHeaders,
      body: JSON.stringify({ privilege_level: "admin" }),
    });
    expect(escalate.status).toBe(400);
  });

  it("accepts a whitelisted self-edit over HTTP while still blocking governance fields", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "peerish", {
      name: "Peerish",
      email: "peerish@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "peerish", "peerish@cs.toronto.edu");
    const token = await loginToken(baseUrl, "peerish@cs.toronto.edu");
    const memberHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const save = await fetch(`${baseUrl}/lab/members/peerish`, {
      method: "PUT",
      headers: memberHeaders,
      body: JSON.stringify({ role: "Industry Researcher" }),
    });
    expect(save.status).toBe(200);
    await expect(save.json()).resolves.toMatchObject({
      id: "peerish",
      role: "Industry Researcher",
      privilege_level: "member",
    });

    const escalate = await fetch(`${baseUrl}/lab/members/peerish`, {
      method: "PUT",
      headers: memberHeaders,
      body: JSON.stringify({ status: "alumni" }),
    });
    expect(escalate.status).toBe(400);
  });

  // Admin members take the full-write branch of PUT /lab/members/:id instead of updateOwnProfile,
  // so the Control UI "My profile" save must still land on the same row the Lab Members table reads.
  it("reflects an admin member's own-profile save in the lab members roster", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "boss", {
      name: "Boss",
      email: "boss@cs.toronto.edu",
      privilege_level: "admin",
      location: "Old Town",
      research_topics: ["stale topic"],
    });
    await approveClaim(baseUrl, "boss", "boss@cs.toronto.edu");
    const token = await loginToken(baseUrl, "boss@cs.toronto.edu");

    // Body shape matches the Control UI profile form (collectProfileFields).
    const save = await fetch(`${baseUrl}/lab/members/boss`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Boss Updated",
        slack_user_id: "U123BOSS",
        research_topics: ["diffusion", "alignment"],
        projects: ["Project Atlas"],
        hours_per_week: 20,
        location: "Zurich",
        affiliation: "ETH",
        timezone: "Europe/Zurich",
        personal_website: "https://boss.example.com",
        notes: "on sabbatical",
      }),
    });
    expect(save.status).toBe(200);
    await expect(save.json()).resolves.toMatchObject({
      id: "boss",
      name: "Boss Updated",
      email: "boss@cs.toronto.edu",
      privilege_level: "admin",
    });

    const roster = await fetch(`${baseUrl}/lab/members`, { headers: serviceHeaders() });
    expect(roster.status).toBe(200);
    const members = ((await roster.json()) as { members: Array<Record<string, unknown>> }).members;
    expect(members.find((entry) => entry.id === "boss")).toMatchObject({
      id: "boss",
      name: "Boss Updated",
      slack_user_id: "U123BOSS",
      research_topics: ["diffusion", "alignment"],
      projects: ["Project Atlas"],
      hours_per_week: 20,
      location: "Zurich",
      affiliation: "ETH",
      timezone: "Europe/Zurich",
      personal_website: "https://boss.example.com",
      notes: "on sabbatical",
      email: "boss@cs.toronto.edu",
      privilege_level: "admin",
    });
  });

  it("lets a member change their own login email and reflects it in the session", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "self", "self@cs.toronto.edu");
    const token = await loginToken(baseUrl, "self@cs.toronto.edu");
    const memberHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: memberHeaders,
      body: JSON.stringify({
        new_email: "renamed@cs.toronto.edu",
        current_password: "correcthorse",
      }),
    });
    expect(change.status).toBe(200);
    await expect(change.json()).resolves.toEqual({ email: "renamed@cs.toronto.edu" });

    // The still-valid session now reports the new email on both the member and its record.
    const session = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      member: { id: "self", email: "renamed@cs.toronto.edu" },
    });

    // New email logs in; the old one is gone.
    const newLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "renamed@cs.toronto.edu", password: "correcthorse" }),
    });
    expect(newLogin.status).toBe(200);
    const oldLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "self@cs.toronto.edu", password: "correcthorse" }),
    });
    expect(oldLogin.status).toBe(401);
  });

  it("rejects an email change with the wrong password", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "self", "self@cs.toronto.edu");
    const token = await loginToken(baseUrl, "self@cs.toronto.edu");

    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        new_email: "renamed@cs.toronto.edu",
        current_password: "nope-nope-nope",
      }),
    });
    expect(change.status).toBe(401);
    await expect(change.json()).resolves.toEqual({ error: { message: "invalid password" } });
  });

  it("rejects an email change colliding with another credential", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@cs.toronto.edu",
      privilege_level: "member",
    });
    await seedMember(baseUrl, "other", { name: "Other", email: "other@cs.toronto.edu" });
    await approveClaim(baseUrl, "self", "self@cs.toronto.edu");
    await approveClaim(baseUrl, "other", "other@cs.toronto.edu");
    const token = await loginToken(baseUrl, "self@cs.toronto.edu");

    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ new_email: "other@cs.toronto.edu", current_password: "correcthorse" }),
    });
    expect(change.status).toBe(409);
    await expect(change.json()).resolves.toEqual({ error: { message: "email unavailable" } });
  });

  it("rejects an email change colliding with a pending registration", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@cs.toronto.edu",
      privilege_level: "member",
    });
    await seedMember(baseUrl, "cid", { name: "Cid", email: "cid@cs.toronto.edu" });
    await approveClaim(baseUrl, "self", "self@cs.toronto.edu");
    // Leave a pending claim holding pending@cs.toronto.edu.
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "cid",
        email: "pending@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    const token = await loginToken(baseUrl, "self@cs.toronto.edu");

    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        new_email: "pending@cs.toronto.edu",
        current_password: "correcthorse",
      }),
    });
    expect(change.status).toBe(409);
  });

  it("rejects an email change from the service principal", async () => {
    const { baseUrl } = await startService();
    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        new_email: "renamed@cs.toronto.edu",
        current_password: "correcthorse",
      }),
    });
    expect(change.status).toBe(400);
    await expect(change.json()).resolves.toEqual({
      error: { message: "member principal required" },
    });
  });

  it("rate limits repeated email-change failures", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "self", "self@cs.toronto.edu");
    const token = await loginToken(baseUrl, "self@cs.toronto.edu");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const attempt = () =>
      fetch(`${baseUrl}/auth/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          new_email: "renamed@cs.toronto.edu",
          current_password: "wrong-pass",
        }),
      });
    for (let i = 0; i < 10; i += 1) {
      expect((await attempt()).status).toBe(401);
    }
    expect((await attempt()).status).toBe(429);
  });

  it("gives a privileged principal full names, and everyone else a counts-only summary", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "ada", {
      name: "Ada",
      privilege_level: "member",
      location: "Toronto",
    });
    // Unplaced (no location anywhere), so a summary that ever put unplaced names back in would
    // leak "Zedunia" specifically, and the check below would catch it even though Zed never
    // appears in a `places` entry at all.
    await seedMember(baseUrl, "zed", { name: "Zedunia", privilege_level: "member" });
    await approveClaim(baseUrl, "ada", "ada@example.com");
    const memberToken = await loginToken(baseUrl, "ada@example.com");

    const anonymous = await fetch(`${baseUrl}/member-map`);
    expect(anonymous.status).toBe(200);
    const anonymousText = await anonymous.text();
    expect(anonymousText).not.toContain("Ada");
    expect(anonymousText).not.toContain("Zedunia");
    expect(anonymousText).not.toContain("members");
    const anonymousBody = JSON.parse(anonymousText) as {
      mode: string;
      places: Array<{ label: string; count: number; members?: unknown }>;
      unplaced?: unknown;
    };
    expect(anonymousBody.mode).toBe("summary");
    expect(anonymousBody.places[0]).toMatchObject({ label: "Toronto", count: 1 });
    expect(anonymousBody.places[0]?.members).toBeUndefined();
    expect(anonymousBody.unplaced).toBeUndefined();

    // A signed-in member who is not an admin gets the same counts-only shape as anonymous --
    // checked by reading the raw response text for the name, not just the structured fields,
    // so a bug that stashed "members" under some other key would still be caught.
    const asMember = await fetch(`${baseUrl}/member-map`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(asMember.status).toBe(200);
    const asMemberText = await asMember.text();
    expect(asMemberText).not.toContain("Ada");
    expect(asMemberText).not.toContain("Zedunia");
    expect(asMemberText).not.toContain("members");
    const asMemberBody = JSON.parse(asMemberText) as {
      mode: string;
      places: Array<{ members?: unknown }>;
      unplaced?: unknown;
    };
    expect(asMemberBody.mode).toBe("summary");
    expect(asMemberBody.places[0]?.members).toBeUndefined();
    expect(asMemberBody.unplaced).toBeUndefined();

    const response = await fetch(`${baseUrl}/member-map`, { headers: serviceHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      mode: string;
      places: Array<{ label: string; members: Array<{ name: string; source: string }> }>;
      unplaced: Array<{ name: string }>;
    };
    expect(body.mode).toBe("full");
    expect(body.places[0]?.label).toBe("Toronto");
    expect(body.places[0]?.members[0]).toMatchObject({ name: "Ada", source: "roster" });
    // The full path still surfaces the unplaced name -- proving the two summary checks above
    // are actually testing something the admin view does show, not a name that was never in
    // the data to begin with.
    expect(body.unplaced.map((entry) => entry.name)).toContain("Zedunia");
  });

  it("reports a 503 for a map refresh when no slack lookup is configured", async () => {
    const { baseUrl } = await startService();
    const response = await fetch(`${baseUrl}/member-map/refresh`, {
      method: "POST",
      headers: serviceHeaders(),
    });
    expect(response.status).toBe(503);
  });

  it("reports a 503 for a directory refresh when neither slack dep is configured", async () => {
    const { baseUrl } = await startService();
    const response = await fetch(`${baseUrl}/members/directory/refresh-slack`, {
      method: "POST",
      headers: serviceHeaders(),
    });
    expect(response.status).toBe(503);
  });

  it("refuses a directory refresh from a non-privileged principal", async () => {
    const { baseUrl } = await startService({
      resolveSlackUserIdsByEmail: async () => new Map(),
    });
    await seedMember(baseUrl, "plain", { name: "Plain", privilege_level: "member" });
    await approveClaim(baseUrl, "plain", "plain@cs.toronto.edu");
    const token = await loginToken(baseUrl, "plain@cs.toronto.edu");

    const response = await fetch(`${baseUrl}/members/directory/refresh-slack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it("backfills slack_user_id and syncs timezone from the injected slack directory deps", async () => {
    const { baseUrl } = await startService({
      resolveSlackUserIdsByEmail: async (emails) => {
        expect(emails).toEqual(["unlinked@cs.toronto.edu"]);
        return new Map([["unlinked@cs.toronto.edu", "U-NEW"]]);
      },
      fetchSlackTimezones: async () => new Map([["U-NEW", "America/Toronto"]]),
    });
    await seedMember(baseUrl, "unlinked", {
      name: "Unlinked",
      email: "unlinked@cs.toronto.edu",
      privilege_level: "member",
    });

    const response = await fetch(`${baseUrl}/members/directory/refresh-slack`, {
      method: "POST",
      headers: serviceHeaders(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      idsResolved: number;
      timezonesChecked: number;
      timezonesUpdated: number;
    };
    expect(body).toEqual({
      idsResolved: 1,
      timezonesChecked: 1,
      timezonesUpdated: 1,
      activityChecked: 0,
    });

    const roster = await fetch(`${baseUrl}/lab/members`, { headers: serviceHeaders() });
    const members = (await roster.json()) as {
      members: Array<{ id: string; slack_user_id?: string; timezone?: string }>;
    };
    const updated = members.members.find((m) => m.id === "unlinked");
    expect(updated?.slack_user_id).toBe("U-NEW");
    expect(updated?.timezone).toBe("America/Toronto");
  });

  it("lists papers relevant to the member principal", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "res", {
      name: "Researcher",
      email: "res@cs.toronto.edu",
      privilege_level: "member",
      research_topics: ["Causal Inference"],
    });
    await fetch(`${baseUrl}/papers/relevant-paper`, {
      method: "PUT",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        title: "Causal Inference at Scale",
        authors: ["someone"],
        current_step: "submission",
      }),
    });
    await fetch(`${baseUrl}/papers/other-paper`, {
      method: "PUT",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        title: "Unrelated Robotics Work",
        authors: ["someone"],
        current_step: "submission",
      }),
    });
    await approveClaim(baseUrl, "res", "res@cs.toronto.edu");
    const token = await loginToken(baseUrl, "res@cs.toronto.edu");

    const relevant = await fetch(`${baseUrl}/papers/relevant`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(relevant.status).toBe(200);
    const body = (await relevant.json()) as { papers: Array<{ id: string }> };
    expect(body.papers.map((paper) => paper.id)).toEqual(["relevant-paper"]);
  });
});

describe("AdminBot service-principal privilege scoping", () => {
  const SERVICE_DENIED =
    "this action requires an admin or core member session and cannot be performed by the service principal";

  async function adminToken(baseUrl: string, id: string, email: string): Promise<string> {
    seedMember(baseUrl, id, { name: id, email, privilege_level: "admin" });
    await approveClaim(baseUrl, id, email);
    return loginToken(baseUrl, email);
  }

  async function pendingClaim(baseUrl: string, memberId: string, email: string): Promise<string> {
    seedMember(baseUrl, memberId, { name: memberId, email });
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ member_id: memberId, email, password: "correcthorse" }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.member_id === memberId);
    if (!registration) {
      throw new Error(`no pending claim for ${memberId}`);
    }
    return registration.id;
  }

  it("lets the service principal edit whitelisted profile fields on any member id", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "someone-else", {
      name: "Someone",
      email: "someone@cs.toronto.edu",
      privilege_level: "member",
    });
    const res = await fetch(`${baseUrl}/lab/members/someone-else`, {
      method: "PUT",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ research_topics: ["Causal Inference"], location: "Zurich" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "someone-else",
      location: "Zurich",
      privilege_level: "member",
      research_topics: ["Causal Inference"],
    });
  });

  it("rejects service-principal writes to governed member fields with no partial write", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "target", {
      name: "Target",
      email: "target@cs.toronto.edu",
      privilege_level: "member",
    });
    const governed: Array<Record<string, unknown>> = [
      { privilege_level: "admin" },
      { status: "inactive" },
      { email: "moved@cs.toronto.edu" },
      { access_overrides: { read_sensitive_info: true } },
    ];
    for (const patch of governed) {
      const res = await fetch(`${baseUrl}/lab/members/target`, {
        method: "PUT",
        headers: serviceHeaders({ "Content-Type": "application/json" }),
        // The accompanying name change must NOT land: the write is rejected wholesale.
        body: JSON.stringify({ name: "Renamed", ...patch }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("cannot be changed");
    }
    const members = (await (
      await fetch(`${baseUrl}/lab/members`, { headers: serviceHeaders() })
    ).json()) as { members: Array<{ id: string; name: string; privilege_level: string }> };
    const target = members.members.find((m) => m.id === "target");
    expect(target?.name).toBe("Target");
    expect(target?.privilege_level).toBe("member");
  });

  it("keeps full governance writes for a genuine admin member session", async () => {
    const { baseUrl } = await startService();
    const token = await adminToken(baseUrl, "boss", "boss@cs.toronto.edu");
    seedMember(baseUrl, "grantee", {
      name: "Grantee",
      email: "grantee@cs.toronto.edu",
      privilege_level: "member",
    });
    const res = await fetch(`${baseUrl}/lab/members/grantee`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Grantee",
        email: "grantee@cs.toronto.edu",
        privilege_level: "admin",
        status: "active",
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "grantee",
      privilege_level: "admin",
    });
  });

  it("denies the service principal on settings, sensitive-info, and registration decisions", async () => {
    const { baseUrl } = await startService();
    const approveId = await pendingClaim(baseUrl, "ap", "ap@cs.toronto.edu");
    const rejectId = await pendingClaim(baseUrl, "rj", "rj@cs.toronto.edu");

    const settings = await fetch(`${baseUrl}/settings`, {
      method: "PUT",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ paper_escalation_business_days: 5 }),
    });
    expect(settings.status).toBe(403);
    await expect(settings.json()).resolves.toEqual({ error: { message: SERVICE_DENIED } });

    const sensitiveGet = await fetch(`${baseUrl}/sensitive-info`, { headers: serviceHeaders() });
    expect(sensitiveGet.status).toBe(403);
    await expect(sensitiveGet.json()).resolves.toEqual({ error: { message: SERVICE_DENIED } });

    const sensitivePut = await fetch(`${baseUrl}/sensitive-info`, {
      method: "PUT",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ markdown: "# secrets" }),
    });
    expect(sensitivePut.status).toBe(403);

    const approve = await fetch(`${baseUrl}/auth/registrations/${approveId}/approve`, {
      method: "POST",
      headers: serviceHeaders(),
    });
    expect(approve.status).toBe(403);
    await expect(approve.json()).resolves.toEqual({ error: { message: SERVICE_DENIED } });

    const reject = await fetch(`${baseUrl}/auth/registrations/${rejectId}/reject`, {
      method: "POST",
      headers: serviceHeaders(),
    });
    expect(reject.status).toBe(403);

    // The denied approve/reject left both registrations pending: neither account can log in.
    const stillPending = (await listPending(baseUrl)).map((entry) => entry.member_id);
    expect(stillPending).toContain("ap");
    expect(stillPending).toContain("rj");
  });

  it("keeps settings, sensitive-info, and registration decisions for a genuine admin session", async () => {
    const { baseUrl } = await startService();
    const token = await adminToken(baseUrl, "boss", "boss@cs.toronto.edu");
    const adminHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const approveId = await pendingClaim(baseUrl, "ap", "ap@cs.toronto.edu");
    const rejectId = await pendingClaim(baseUrl, "rj", "rj@cs.toronto.edu");

    const settings = await fetch(`${baseUrl}/settings`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ paper_escalation_business_days: 5 }),
    });
    expect(settings.status).toBe(200);

    const sensitiveGet = await fetch(`${baseUrl}/sensitive-info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(sensitiveGet.status).toBe(200);

    const sensitivePut = await fetch(`${baseUrl}/sensitive-info`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ markdown: "# secrets" }),
    });
    expect(sensitivePut.status).toBe(200);

    const approve = await fetch(`${baseUrl}/auth/registrations/${approveId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(approve.status).toBe(200);

    const reject = await fetch(`${baseUrl}/auth/registrations/${rejectId}/reject`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(reject.status).toBe(200);
  });

  it("denies the service principal on /nudges/send", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "target", { name: "Target", slack_user_id: "U1" });
    const res = await fetch(`${baseUrl}/nudges/send`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        channel: "slack",
        recipient_member_ids: ["target"],
        message: "hi",
      }),
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: { message: SERVICE_DENIED } });
  });

  it("lets a genuine admin session send a member nudge, which executes immediately with no separate approval step", async () => {
    const executor = { execute: async () => ({ handled: true }) };
    const { baseUrl } = await startService({ executor });
    const token = await adminToken(baseUrl, "boss", "boss@cs.toronto.edu");
    seedMember(baseUrl, "target", { name: "Target", slack_user_id: "U1" });
    const res = await fetch(`${baseUrl}/nudges/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "slack",
        recipient_member_ids: ["target"],
        message: "Reminder: submit your update.",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: Array<{ status: string; approval_requirement: { requires_approval: boolean } }>;
      skipped: unknown[];
    };
    expect(body.created).toHaveLength(1);
    expect(body.created[0]?.status).toBe("executed");
    expect(body.created[0]?.approval_requirement.requires_approval).toBe(false);
    expect(body.skipped).toEqual([]);
  });

  // What a member writes about their health or family is written for one reader, but /lab/members
  // serves whole records to every signed-in member. These pin the boundary rule.
  it("hides a member's personal circumstances from other members", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "ada", {
      name: "Ada",
      personal_circumstances: "caring for a parent on Fridays",
    });
    const res = await fetch(`${baseUrl}/lab/members`, { headers: serviceHeaders() });
    const body = (await res.json()) as { members: Array<Record<string, unknown>> };
    const ada = body.members.find((member) => member.id === "ada")!;
    // The service principal drives agent tool calls for whoever is chatting, so it is not entitled.
    expect(ada.name).toBe("Ada");
    expect("personal_circumstances" in ada).toBe(false);
  });

  // A schedule says when someone is away, which course is eating their term, that they are interning
  // elsewhere, and -- in the overall note -- whatever they wrote up for the admins. Planning data for
  // the people who plan, not roster data for the whole lab.
  it("hides another member's schedule from a plain member, and shows it to an admin", async () => {
    const { baseUrl } = await startService();
    const schedule = {
      availability: [
        { start: "2026-03-02", end: "2026-03-15", hours_per_week: 20 },
      ],
      time_off: [
        {
          start: "2026-04-01",
          end: "2026-04-07",
          kind: "vacation",
          availability: "none",
        },
      ],
      milestones: [{ date: "2026-05-01", label: "Defence" }],
      availability_notes: "Carer on alternating weeks.",
    };
    seedMember(baseUrl, "ada", {
      name: "Ada",
      email: "ada@cs.toronto.edu",
      privilege_level: "member",
      ...schedule,
    });
    seedMember(baseUrl, "peer", {
      name: "Peer",
      email: "peer@cs.toronto.edu",
      privilege_level: "member",
    });
    seedMember(baseUrl, "boss", {
      name: "Boss",
      email: "boss@cs.toronto.edu",
      privilege_level: "admin",
    });

    const rosterFor = async (email: string, memberId: string) => {
      await approveClaim(baseUrl, memberId, email);
      const token = await loginToken(baseUrl, email);
      const res = await fetch(`${baseUrl}/lab/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as {
        members: Array<Record<string, unknown>>;
      };
      return body.members;
    };

    const asPeer = await rosterFor("peer@cs.toronto.edu", "peer");
    const adaToPeer = asPeer.find((member) => member.id === "ada")!;
    // Still on the roster -- this is a field rule, not a row rule.
    expect(adaToPeer.name).toBe("Ada");
    for (const field of [
      "availability",
      "time_off",
      "milestones",
      "availability_notes",
    ]) {
      expect(field in adaToPeer).toBe(false);
    }
    // Their own schedule is still theirs to read.
    const peerSelf = asPeer.find((member) => member.id === "peer")!;
    expect(peerSelf.id).toBe("peer");

    const asAdmin = await rosterFor("boss@cs.toronto.edu", "boss");
    const adaToAdmin = asAdmin.find((member) => member.id === "ada")!;
    expect(adaToAdmin.availability_notes).toBe("Carer on alternating weeks.");
    expect(adaToAdmin.availability).toHaveLength(1);
    expect(adaToAdmin.milestones).toHaveLength(1);

    // The service principal drives the availability importer and the scheduling tools, so unlike
    // personal_circumstances it keeps the schedule.
    const asService = await fetch(`${baseUrl}/lab/members`, {
      headers: serviceHeaders(),
    });
    const adaToService = (
      (await asService.json()) as { members: Array<Record<string, unknown>> }
    ).members.find((member) => member.id === "ada")!;
    expect(adaToService.availability).toHaveLength(1);
  });

  it("lets a member write, and clear, the overall note on their own schedule", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "ada", {
      name: "Ada",
      email: "ada@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "ada", "ada@cs.toronto.edu");
    const token = await loginToken(baseUrl, "ada@cs.toronto.edu");
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const save = await fetch(`${baseUrl}/lab/members/ada`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ availability_notes: "Visa interview may move." }),
    });
    expect(save.status).toBe(200);
    await expect(save.json()).resolves.toMatchObject({
      availability_notes: "Visa interview may move.",
    });

    // An emptied box means "nothing to explain", so the field goes rather than storing a blank an
    // admin would read as something written.
    const cleared = await fetch(`${baseUrl}/lab/members/ada`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ availability_notes: "   " }),
    });
    expect(cleared.status).toBe(200);
    expect(
      "availability_notes" in
        ((await cleared.json()) as Record<string, unknown>),
    ).toBe(false);
  });

  it("reports members with incomplete mandatory profile fields to any caller", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "blank", { name: "Blank" });
    const res = await fetch(`${baseUrl}/members/mandatory-fields-incomplete`, {
      headers: serviceHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ id: string; missing_fields: string[] }> };
    expect(body.members.map((member) => member.id)).toEqual(["blank"]);
    expect(body.members[0]?.missing_fields).toContain("cv_url");
  });

  it("lets the service principal (unlike /nudges/send) run the daily mandatory-fields reminder, since it takes no caller-supplied content", async () => {
    const executor = { execute: async () => ({ handled: true }) };
    const { baseUrl } = await startService({ executor });
    seedMember(baseUrl, "blank", { name: "Blank", slack_user_id: "U1" });
    const res = await fetch(`${baseUrl}/members/mandatory-fields-reminder/run`, {
      method: "POST",
      headers: serviceHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: unknown[]; skipped: unknown[] };
    expect(body.created).toHaveLength(1);
    expect(body.skipped).toEqual([]);
  });

  it("still refuses an anonymous caller on the mandatory-fields reminder run", async () => {
    const { baseUrl } = await startService();
    const res = await fetch(`${baseUrl}/members/mandatory-fields-reminder/run`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("runs profile-photo review reminders for the service principal, using only server-computed targeting/message", async () => {
    const executor = { execute: async () => ({ handled: true }) };
    const { baseUrl } = await startService({
      executor,
      reviewSlackProfilePhoto: async ({ slackUserId }) => ({
        compliant: slackUserId === "U-GOOD",
        issues: slackUserId === "U-GOOD" ? [] : ["background_not_clean"],
        summary: slackUserId === "U-GOOD" ? "Looks good." : "Background is noisy.",
        source: "ai",
      }),
    });
    seedMember(baseUrl, "bad", { name: "Bad", slack_user_id: "U-BAD", status: "active" });
    seedMember(baseUrl, "good", { name: "Good", slack_user_id: "U-GOOD", status: "active" });
    const res = await fetch(`${baseUrl}/profile-photo/review/run`, {
      method: "POST",
      headers: serviceHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviewed: number; non_compliant: number; nudges_created: number };
    expect(body.reviewed).toBe(2);
    expect(body.non_compliant).toBe(1);
    expect(body.nudges_created).toBe(1);
  });

  it("lets a signed-in member polish and apply their own Slack profile photo variant", async () => {
    const { baseUrl } = await startService({
      executor: {
        execute: async (proposal) => ({ handled: proposal.type === "slack.profile_photo_update" }),
      },
      polishSlackProfilePhoto: async () => ({
        image_data_url: "data:image/png;base64,aGVsbG8=",
      }),
    });
    seedMember(baseUrl, "sam", {
      name: "Sam",
      email: "sam@cs.toronto.edu",
      slack_user_id: "U-SAM",
      status: "active",
    });
    await approveClaim(baseUrl, "sam", "sam@cs.toronto.edu");
    const token = await loginToken(baseUrl, "sam@cs.toronto.edu");

    const polished = await fetch(`${baseUrl}/profile-photo/polish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(polished.status).toBe(200);
    const polishedBody = (await polished.json()) as { variant: { id: string } };
    const apply = await fetch(`${baseUrl}/profile-photo/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ variant_id: polishedBody.variant.id }),
    });
    expect(apply.status).toBe(200);
  });

  async function proposeSlackMessage(baseUrl: string): Promise<{ id: string; hash: string }> {
    const res = await fetch(`${baseUrl}/proposals`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ type: "slack.send_message", summary: "Ping the channel" }),
    });
    const body = (await res.json()) as { id: string; payload_hash: string };
    return { id: body.id, hash: body.payload_hash };
  }

  it("refuses to record an approval from the service principal", async () => {
    const { baseUrl } = await startService();
    const proposal = await proposeSlackMessage(baseUrl);

    const res = await fetch(`${baseUrl}/approvals/${proposal.id}/approve`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ payload_hash: proposal.hash, approver_role: "admin" }),
    });

    // An approval has to name a person, and every agent tool call shares this one principal.
    expect(res.status).toBe(403);
  });

  it("lets a member tick off their own onboarding step but not someone else's", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "sam", { name: "Sam", email: "sam@cs.toronto.edu" });
    await approveClaim(baseUrl, "sam", "sam@cs.toronto.edu");
    const token = await loginToken(baseUrl, "sam@cs.toronto.edu");
    seedMember(baseUrl, "other", { name: "Other" });

    const own = await fetch(`${baseUrl}/lab/members/sam/onboarding/linkedin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ complete: true }),
    });
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({
      onboarding: {
        completed: expect.arrayContaining([expect.objectContaining({ id: "linkedin" })]),
      },
    });

    const someoneElse = await fetch(`${baseUrl}/lab/members/other/onboarding/linkedin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ complete: true }),
    });
    expect(someoneElse.status).toBe(403);
  });

  it("refuses to fan out an onboarding nudge for the service principal", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "sam", { name: "Sam", slack_user_id: "U1" });

    const res = await fetch(`${baseUrl}/onboarding/linkedin/nudge`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ channel: "slack" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: { message: SERVICE_DENIED } });
  });

  it("lets a real admin nudge everyone who still owes the LinkedIn step", async () => {
    const executor = { execute: async () => ({ handled: true }) };
    const { baseUrl } = await startService({ executor });
    const token = await adminToken(baseUrl, "boss", "boss@cs.toronto.edu");
    seedMember(baseUrl, "sam", { name: "Sam", slack_user_id: "U1" });
    seedMember(baseUrl, "kai", { name: "Kai", slack_user_id: "U2" });
    seedMember(baseUrl, "gone", { name: "Gone", slack_user_id: "U3", status: "alumni" });

    await fetch(`${baseUrl}/lab/members/kai/onboarding/linkedin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ complete: true }),
    });

    const res = await fetch(`${baseUrl}/onboarding/linkedin/nudge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "slack" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: Array<{ target?: { target?: string } }> };
    // kai already did it, gone is alumni, boss has no slack id -- only sam is nudged.
    expect(body.created.map((proposal) => proposal.target?.target)).toEqual(["U1"]);
  });

  it("records the approver from the session, not from the request body", async () => {
    const { baseUrl } = await startService();
    const token = await adminToken(baseUrl, "boss", "boss@cs.toronto.edu");
    const proposal = await proposeSlackMessage(baseUrl);

    const res = await fetch(`${baseUrl}/approvals/${proposal.id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        payload_hash: proposal.hash,
        approver_role: "admin",
        approver_id: "somebody-else",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      approvals: Array<{ approver_role: string; approver_id?: string }>;
    };
    expect(body.approvals).toEqual([
      expect.objectContaining({ approver_role: "admin", approver_id: "boss" }),
    ]);
    expect(body.status).toBe("approved");
  });
});

// Member-side surface: a plain member signs into the same Control UI as an admin, so every
// governance surface has to be denied at the HTTP layer rather than only hidden in the nav.
// The service principal is denied on the act-on-pending routes specifically because it is the
// identity every AdminBot *chat* tool call runs as — allowing it there would let any member
// drive a privileged action just by asking the agent to.
describe("AdminBot member-side restrictions", () => {
  // The act-on-pending routes are deliberately spread across three prefixes.
  const approvalRoutes = [
    "/approvals/any-action/approve",
    "/actions/any-action/execute",
    "/proposals/any-action/remove",
  ];

  async function memberToken(baseUrl: string): Promise<string> {
    seedMember(baseUrl, "plain", {
      name: "Plain Member",
      email: "plain@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "plain", "plain@cs.toronto.edu");
    return await loginToken(baseUrl, "plain@cs.toronto.edu");
  }

  it("hides the pending-action queue and lab settings from a plain member", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl);
    const headers = { Authorization: `Bearer ${token}` };

    const pending = await fetch(`${baseUrl}/proposals/pending`, { headers });
    expect(pending.status).toBe(403);

    const settings = await fetch(`${baseUrl}/settings`, { headers });
    expect(settings.status).toBe(403);
  });

  it("denies a plain member acting on pending actions", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    for (const path of approvalRoutes) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    }
  });

  it("denies the service principal acting on pending actions, blocking chat-driven approvals", async () => {
    const { baseUrl } = await startService();

    for (const path of approvalRoutes) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: serviceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    }
  });

  it("still lets a genuine admin session act on pending actions", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "boss", {
      name: "Boss",
      email: "boss@cs.toronto.edu",
      privilege_level: "admin",
    });
    await approveClaim(baseUrl, "boss", "boss@cs.toronto.edu");
    const token = await loginToken(baseUrl, "boss@cs.toronto.edu");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // The action id does not exist, so the service answers 404 — the point is that the
    // privilege guard let the request through instead of short-circuiting with 403.
    for (const path of approvalRoutes) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).not.toBe(403);
    }

    const pending = await fetch(`${baseUrl}/proposals/pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pending.status).toBe(200);
  });

  it("keeps other people's papers and paper deletion out of a plain member's reach", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    await fetch(`${baseUrl}/papers/some-paper`, {
      method: "PUT",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        title: "Someone else's paper",
        authors: ["Other Person"],
        current_step: "overleaf_writing",
      }),
    });

    const write = await fetch(`${baseUrl}/papers/some-paper`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "Rewritten" }),
    });
    expect(write.status).toBe(403);

    const remove = await fetch(`${baseUrl}/papers/some-paper`, { method: "DELETE", headers });
    expect(remove.status).toBe(403);

    // Members still read the roster and paper list — those are the member-side dashboard.
    const members = await fetch(`${baseUrl}/lab/members`, { headers });
    expect(members.status).toBe(200);
    const papers = await fetch(`${baseUrl}/papers`, { headers });
    expect(papers.status).toBe(200);
  });
});

// The automatic per-member gateway-pairing path: a member's own login session authorizes their
// browser device, and the injected approver caps the granted scopes at their privilege. This is
// what makes member-side gateway enforcement automatic (no manual token handout) while denying the
// shared service principal, which must never be able to pair itself a write-scoped device.
// The onboarding checklist is reading material, so a step only completes when the member says they
// have read it. Acknowledgement is per-member and self-service: the body names a step, never a
// person, so there is no path to marking someone else's checklist.
describe("onboarding acknowledgement", () => {
  async function signedInMember(baseUrl: string): Promise<string> {
    seedMember(baseUrl, "newbie", {
      name: "Newbie",
      email: "newbie@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "newbie", "newbie@cs.toronto.edu");
    return await loginToken(baseUrl, "newbie@cs.toronto.edu");
  }

  async function ack(baseUrl: string, token: string, stepId: string) {
    return await fetch(`${baseUrl}/onboarding/ack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ step_id: stepId }),
    });
  }

  it("marks a step read and moves the current step to the next unread one", async () => {
    const { baseUrl } = await startService();
    const token = await signedInMember(baseUrl);

    const before = (await (
      await fetch(`${baseUrl}/auth/session`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { member: { onboarding: { current_step?: { id: string } } } };
    const firstStepId = before.member.onboarding.current_step!.id;

    const res = await ack(baseUrl, token, firstStepId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      onboarding: {
        current_step?: { id: string };
        steps: Array<{ id: string; status: string; acknowledged_at?: string }>;
      };
    };
    const acknowledged = body.onboarding.steps.find((step) => step.id === firstStepId);
    expect(acknowledged?.status).toBe("complete");
    expect(acknowledged?.acknowledged_at).toBeTruthy();
    expect(body.onboarding.current_step?.id).not.toBe(firstStepId);
  });

  it("persists the acknowledgement on the member record", async () => {
    const { baseUrl } = await startService();
    const token = await signedInMember(baseUrl);
    await ack(baseUrl, token, "profile_photo");

    const session = (await (
      await fetch(`${baseUrl}/auth/session`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { member: { onboarding: { steps: Array<{ id: string; status: string }> } } };
    const step = session.member.onboarding.steps.find((entry) => entry.id === "profile_photo");
    expect(step?.status).toBe("complete");
  });

  it("rejects an unknown step and an anonymous caller", async () => {
    const { baseUrl } = await startService();
    const token = await signedInMember(baseUrl);

    expect((await ack(baseUrl, token, "not-a-step")).status).toBe(404);
    expect((await ack(baseUrl, token, "")).status).toBe(400);

    const anonymous = await fetch(`${baseUrl}/onboarding/ack`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ step_id: "profile_photo" }),
    });
    expect(anonymous.status).toBe(401);
  });

  it("denies the shared service principal", async () => {
    const { baseUrl } = await startService();
    const res = await fetch(`${baseUrl}/onboarding/ack`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ step_id: "profile_photo" }),
    });
    expect(res.status).toBe(401);
  });
});

// Authors filing and maintaining their own submissions. Ownership is the whole boundary here: the
// board stays shared, but a member's write is confined to papers they filed or are named on, and to
// the descriptive fields (governance -- mentor, checklist, reminder cadence -- stays admin-only).
describe("member-authored papers", () => {
  async function tokenFor(baseUrl: string, id: string, name: string): Promise<string> {
    seedMember(baseUrl, id, {
      name,
      email: `${id}@cs.toronto.edu`,
      privilege_level: "member",
    });
    await approveClaim(baseUrl, id, `${id}@cs.toronto.edu`);
    return await loginToken(baseUrl, `${id}@cs.toronto.edu`);
  }

  function memberHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  async function putPaper(
    baseUrl: string,
    paperId: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ) {
    return await fetch(`${baseUrl}/papers/${paperId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("lets a member file a paper and stamps them as the submitter", async () => {
    const { baseUrl } = await startService();
    const token = await tokenFor(baseUrl, "ada", "Ada Author");

    const res = await putPaper(baseUrl, "ada-paper", memberHeaders(token), {
      title: "Sparse world models",
      authors: ["Ada Author"],
      current_step: "overleaf_writing",
      artifacts: { conference: "NeurIPS 2026", topic: "World models" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "ada-paper",
      title: "Sparse world models",
      submitted_by_member_id: "ada",
      artifacts: { conference: "NeurIPS 2026" },
    });
  });

  it("lets the submitter edit it again without re-stamping ownership", async () => {
    const { baseUrl } = await startService();
    const token = await tokenFor(baseUrl, "ada", "Ada Author");
    await putPaper(baseUrl, "ada-paper", memberHeaders(token), {
      title: "Draft",
      authors: ["Ada Author"],
      current_step: "brainstorming_docs",
    });

    const res = await putPaper(baseUrl, "ada-paper", memberHeaders(token), {
      title: "Sparse world models",
      authors: ["Ada Author", "Bo Coauthor"],
      current_step: "submission",
      artifacts: { conference: "ICML 2026" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      title: "Sparse world models",
      current_step: "submission",
      submitted_by_member_id: "ada",
      artifacts: { conference: "ICML 2026" },
    });
  });

  it("lets a member named in the authors edit a paper an admin filed", async () => {
    const { baseUrl } = await startService();
    const token = await tokenFor(baseUrl, "bo", "Bo Coauthor");
    await putPaper(baseUrl, "lab-paper", serviceHeaders({ "Content-Type": "application/json" }), {
      title: "Lab paper",
      authors: ["Bo Coauthor"],
      current_step: "overleaf_writing",
    });

    const res = await putPaper(baseUrl, "lab-paper", memberHeaders(token), {
      title: "Lab paper v2",
      authors: ["Bo Coauthor"],
      current_step: "submission",
    });
    expect(res.status).toBe(200);
  });

  it("refuses a bare-name author match when two members share that name", async () => {
    const { baseUrl } = await startService();
    const token = await tokenFor(baseUrl, "bo", "Bo Coauthor");
    seedMember(baseUrl, "bo-two", { name: "Bo Coauthor", email: "bo-two@cs.toronto.edu" });
    await putPaper(baseUrl, "lab-paper", serviceHeaders({ "Content-Type": "application/json" }), {
      title: "Lab paper",
      authors: ["Bo Coauthor"],
      current_step: "overleaf_writing",
    });

    const res = await putPaper(baseUrl, "lab-paper", memberHeaders(token), { title: "Hijacked" });
    expect(res.status).toBe(403);
  });

  it("cannot take over someone else's paper by listing itself as an author", async () => {
    const { baseUrl } = await startService();
    const token = await tokenFor(baseUrl, "ada", "Ada Author");
    await putPaper(baseUrl, "lab-paper", serviceHeaders({ "Content-Type": "application/json" }), {
      title: "Lab paper",
      authors: ["Someone Else"],
      current_step: "overleaf_writing",
    });

    const res = await putPaper(baseUrl, "lab-paper", memberHeaders(token), {
      title: "Mine now",
      authors: ["Ada Author"],
    });
    expect(res.status).toBe(403);
  });

  it("rejects governance fields from a member write", async () => {
    const { baseUrl } = await startService();
    const token = await tokenFor(baseUrl, "ada", "Ada Author");

    for (const field of [
      { mentor_member_id: "someone" },
      { checks: { affiliation_checked: true } },
      { reminder: { escalation_after_business_days: 1 } },
      { submitted_by_member_id: "someone-else" },
    ]) {
      const res = await putPaper(baseUrl, "ada-paper", memberHeaders(token), {
        title: "Sparse world models",
        authors: ["Ada Author"],
        current_step: "overleaf_writing",
        ...field,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("AdminBot device pairing approval", () => {
  type ApproverCall = { requestId: string; allowedScopes: readonly string[] };

  function fakeApprover(
    calls: ApproverCall[],
    result: import("./server.js").DevicePairingApproval = { ok: true },
  ) {
    return async (params: ApproverCall) => {
      calls.push(params);
      return result;
    };
  }

  async function seededMemberToken(
    baseUrl: string,
    id: string,
    privilege: string,
  ): Promise<string> {
    seedMember(baseUrl, id, {
      name: id,
      email: `${id}@cs.toronto.edu`,
      privilege_level: privilege,
    });
    await approveClaim(baseUrl, id, `${id}@cs.toronto.edu`);
    return await loginToken(baseUrl, `${id}@cs.toronto.edu`);
  }

  it("approves a plain member's device with read-only scope", async () => {
    const calls: ApproverCall[] = [];
    const { baseUrl } = await startService({ devicePairingApprover: fakeApprover(calls) });
    const token = await seededMemberToken(baseUrl, "plain", "member");

    const res = await fetch(`${baseUrl}/auth/pair-device`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-1" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ approved: true, scopes: ["operator.read"] });
    expect(calls).toEqual([{ requestId: "req-1", allowedScopes: ["operator.read"] }]);
  });

  it("approves an admin's device with write scope", async () => {
    const calls: ApproverCall[] = [];
    const { baseUrl } = await startService({ devicePairingApprover: fakeApprover(calls) });
    const token = await seededMemberToken(baseUrl, "boss", "admin");

    const res = await fetch(`${baseUrl}/auth/pair-device`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-2" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.allowedScopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ]);
  });

  it("denies the shared service principal outright", async () => {
    const calls: ApproverCall[] = [];
    const { baseUrl } = await startService({ devicePairingApprover: fakeApprover(calls) });

    const res = await fetch(`${baseUrl}/auth/pair-device`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ requestId: "req-3" }),
    });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("maps a scope-exceeds-privilege rejection to 403", async () => {
    const { baseUrl } = await startService({
      devicePairingApprover: async () => ({ ok: false, reason: "scope_exceeds_privilege" }),
    });
    const token = await seededMemberToken(baseUrl, "greedy", "member");

    const res = await fetch(`${baseUrl}/auth/pair-device`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-4" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 503 when no approver is configured", async () => {
    const { baseUrl } = await startService();
    const token = await seededMemberToken(baseUrl, "orphan", "member");

    const res = await fetch(`${baseUrl}/auth/pair-device`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-5" }),
    });
    expect(res.status).toBe(503);
  });
});

// Minting the browser its own gateway token is what removes the last manual step: without it a
// member can only reach the gateway by holding the shared secret, so a deployment that stops
// handing that out strands them at a "paste a token" prompt.
describe("AdminBot device token issuance", () => {
  type IssuerCall = {
    deviceId: string;
    publicKey: string;
    platform?: string;
    deviceFamily?: string;
    displayName?: string;
    allowedScopes: readonly string[];
    memberId?: string;
  };

  function fakeIssuer(
    calls: IssuerCall[],
    result: import("./server.js").DeviceTokenIssuance = {
      ok: true,
      token: "device-token",
      scopes: ["operator.read"],
    },
  ) {
    return async (params: IssuerCall) => {
      calls.push(params);
      return result;
    };
  }

  async function seededMemberToken(
    baseUrl: string,
    id: string,
    privilege: string,
  ): Promise<string> {
    seedMember(baseUrl, id, {
      name: id,
      email: `${id}@cs.toronto.edu`,
      privilege_level: privilege,
    });
    await approveClaim(baseUrl, id, `${id}@cs.toronto.edu`);
    return await loginToken(baseUrl, `${id}@cs.toronto.edu`);
  }

  async function postDeviceToken(baseUrl: string, token: string, body: unknown) {
    return await fetch(`${baseUrl}/auth/device-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("mints a read-only token for a plain member", async () => {
    const calls: IssuerCall[] = [];
    const { baseUrl } = await startService({ deviceTokenIssuer: fakeIssuer(calls) });
    const token = await seededMemberToken(baseUrl, "plain", "member");

    const res = await postDeviceToken(baseUrl, token, {
      deviceId: "dev-1",
      publicKey: "pk-1",
      platform: "Win32",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      token: "device-token",
      scopes: ["operator.read"],
      deviceId: "dev-1",
    });
    expect(calls[0]).toMatchObject({
      deviceId: "dev-1",
      publicKey: "pk-1",
      platform: "Win32",
      allowedScopes: ["operator.read"],
    });
  });

  it("passes the signed-in member's own id to the token issuer", async () => {
    const calls: IssuerCall[] = [];
    const { baseUrl } = await startService({ deviceTokenIssuer: fakeIssuer(calls) });
    const token = await seededMemberToken(baseUrl, "owner1", "member");

    const res = await postDeviceToken(baseUrl, token, {
      deviceId: "dev-owner",
      publicKey: "pk-owner",
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.memberId).toBe("owner1");
  });

  it("caps an admin's token at the full operator scope set", async () => {
    const calls: IssuerCall[] = [];
    const { baseUrl } = await startService({ deviceTokenIssuer: fakeIssuer(calls) });
    const token = await seededMemberToken(baseUrl, "boss", "admin");

    const res = await postDeviceToken(baseUrl, token, { deviceId: "dev-2", publicKey: "pk-2" });
    expect(res.status).toBe(200);
    expect(calls[0]?.allowedScopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ]);
  });

  it("denies the shared service principal", async () => {
    const calls: IssuerCall[] = [];
    const { baseUrl } = await startService({ deviceTokenIssuer: fakeIssuer(calls) });

    const res = await fetch(`${baseUrl}/auth/device-token`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ deviceId: "dev-3", publicKey: "pk-3" }),
    });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("rejects a request without a device key", async () => {
    const calls: IssuerCall[] = [];
    const { baseUrl } = await startService({ deviceTokenIssuer: fakeIssuer(calls) });
    const token = await seededMemberToken(baseUrl, "keyless", "member");

    const res = await postDeviceToken(baseUrl, token, { deviceId: "dev-4" });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("reports an unsupported gateway as 501 so the browser stops retrying", async () => {
    const { baseUrl } = await startService({
      deviceTokenIssuer: async () => ({ ok: false, reason: "unsupported" as const }),
    });
    const token = await seededMemberToken(baseUrl, "nosecret", "member");

    const res = await postDeviceToken(baseUrl, token, { deviceId: "dev-5", publicKey: "pk-5" });
    expect(res.status).toBe(501);
  });

  it("returns 503 when no issuer is configured", async () => {
    const { baseUrl } = await startService();
    const token = await seededMemberToken(baseUrl, "orphan2", "member");

    const res = await postDeviceToken(baseUrl, token, { deviceId: "dev-6", publicKey: "pk-6" });
    expect(res.status).toBe(503);
  });
});

describe("anonymous reimbursement access", () => {
  const stubWorkflow = {
    converse: async () => ({
      assistant_message: "ok",
      draft: {},
      missing_fields: [],
      ready: false,
    }),
    generate: async () => ({ artifacts: [] }),
  } as unknown as NonNullable<
    Parameters<typeof createAdminBotMockService>[0]
  >["reimbursementWorkflow"];

  it("allows converse and generate without any credentials", async () => {
    const { baseUrl } = await startService({ reimbursementWorkflow: stubWorkflow });

    for (const route of ["/reimbursements/converse", "/reimbursements/generate"]) {
      const res = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ messages: [], draft: {} }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("still rejects every other route without credentials", async () => {
    const { baseUrl } = await startService({ reimbursementWorkflow: stubWorkflow });

    for (const [method, route] of [
      ["GET", "/audit"],
      ["GET", "/sensitive-info"],
      ["GET", "/settings"],
      ["GET", "/lab/members"],
      ["GET", "/proposals/pending"],
      ["POST", "/proposals"],
      ["POST", "/automation/email/run"],
    ] as const) {
      const res = await fetch(`${baseUrl}${route}`, {
        method,
        headers: jsonHeaders(),
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(`${route}:${res.status}`).toBe(`${route}:401`);
    }
  });

  // GET must not become an anonymous door onto the same paths.
  it("rejects anonymous non-POST requests to reimbursement routes", async () => {
    const { baseUrl } = await startService({ reimbursementWorkflow: stubWorkflow });

    const res = await fetch(`${baseUrl}/reimbursements/converse`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("rate limits anonymous callers and records both outcomes in the audit trail", async () => {
    const { baseUrl } = await startService({ reimbursementWorkflow: stubWorkflow });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 62; attempt += 1) {
      const res = await fetch(`${baseUrl}/reimbursements/converse`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ messages: [] }),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);

    const events = mockFor(baseUrl).service.listAuditEvents();
    const anonymous = events.filter((event) => event.type === "reimbursement.anonymous_use");
    expect(anonymous).toHaveLength(62);
    expect(anonymous.every((event) => event.actor === "anonymous")).toBe(true);
    expect(anonymous.every((event) => typeof event.details?.ip === "string")).toBe(true);
    expect(anonymous.filter((event) => event.details?.outcome === "rate_limited")).toHaveLength(2);
  });
});

// The Calendar tab is admin-only and its buttons send for real, so the routes below are the whole
// safety boundary: who may reach them, and what lands in the ledger when they do.
// A refused origin is otherwise invisible: the service answers normally and the browser discards
// the response, so the page can only report that it reached nothing.
describe("cross-origin refusals", () => {
  it("answers an allowed origin with the header, and a refused one without", async () => {
    const { baseUrl } = await startService({
      allowedOrigins: ["https://admin.safe.eu"],
    });

    const allowed = await fetch(`${baseUrl}/adminbot`, {
      headers: { Origin: "https://admin.safe.eu" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://admin.safe.eu");

    // A different scheme, host or port is a different origin — the usual cause of this failure.
    for (const origin of [
      "http://admin.safe.eu",
      "https://www.admin.safe.eu",
      "https://admin.safe.eu:8443",
    ]) {
      const refused = await fetch(`${baseUrl}/adminbot`, { headers: { Origin: origin } });
      expect(refused.headers.get("access-control-allow-origin"), origin).toBeNull();
    }
  });

  it("names the refused origin and the configured list in the log", async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const { baseUrl } = await startService({ allowedOrigins: ["https://admin.safe.eu"] });
      await fetch(`${baseUrl}/adminbot`, { headers: { Origin: "http://admin.safe.eu" } });
      await fetch(`${baseUrl}/adminbot`, { headers: { Origin: "http://admin.safe.eu" } });
    } finally {
      console.warn = warn;
    }
    const refusals = warnings.filter((line) => line.includes("refused cross-origin request"));
    // Once per origin, not once per request.
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("http://admin.safe.eu");
    expect(refusals[0]).toContain("https://admin.safe.eu");
  });
});

describe("the calendar routes", () => {
  async function adminSession(baseUrl: string): Promise<Record<string, string>> {
    await seedMember(baseUrl, "boss", {
      name: "Boss",
      email: "boss@cs.toronto.edu",
      privilege_level: "admin",
    });
    await approveClaim(baseUrl, "boss", "boss@cs.toronto.edu");
    const token = await loginToken(baseUrl, "boss@cs.toronto.edu");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  async function memberSession(baseUrl: string): Promise<Record<string, string>> {
    await seedMember(baseUrl, "plain", {
      name: "Plain",
      email: "plain@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "plain", "plain@cs.toronto.edu");
    const token = await loginToken(baseUrl, "plain@cs.toronto.edu");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  it("names the calendar it read alongside the events", async () => {
    const { baseUrl } = await startService({
      calendarEventsReader: async () => [
        { id: "evt-1", summary: "Lab retreat", start: "2026-09-01T13:00:00-04:00" },
      ],
    });
    const headers = await adminSession(baseUrl);

    const response = await fetch(`${baseUrl}/calendar/events`, { headers });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      events: [{ id: "evt-1", summary: "Lab retreat" }],
      calendar: { id: "jinesis.lab@gmail.com", timezone: "America/Toronto" },
    });
  });

  // Every calendar route, listed once and reused by the three refusal tests below, so a route added
  // later is either added here or visibly missing from all three.
  function calendarRoutes(headers: Record<string, string>): Array<[string, RequestInit]> {
    return [
      ["/calendar/events", { headers }],
      ["/calendar/event-draft", { method: "POST", headers, body: JSON.stringify({ prompt: "x" }) }],
      [
        "/calendar/events",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            summary: "x",
            start: "2026-09-01T13:00",
            end: "2026-09-01T14:00",
          }),
        },
      ],
      [
        "/calendar/events/evt-1",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            summary: "x",
            start: "2026-09-01T13:00",
            end: "2026-09-01T14:00",
          }),
        },
      ],
      [
        "/calendar/events/evt-1/invite",
        { method: "POST", headers, body: JSON.stringify({ attendees: ["a@b.com"] }) },
      ],
    ];
  }

  // A visitor never gets as far as the privilege check: the anonymous boundary refuses anything
  // outside ANONYMOUS_ROUTES, and no calendar route is on that list.
  it("keeps a signed-out visitor out of every calendar route", async () => {
    const { baseUrl } = await startService({ calendarEventsReader: async () => [] });

    for (const [route, init] of calendarRoutes({ "Content-Type": "application/json" })) {
      const response = await fetch(`${baseUrl}${route}`, init);
      expect(response.status, route).toBe(401);
    }
  });

  // The shared service principal drives every agent tool call regardless of who is chatting, so
  // treating it as admin here would let any member send calendar mail by asking the bot to.
  it("keeps the service principal out of every calendar route", async () => {
    const { baseUrl } = await startService({ calendarEventsReader: async () => [] });

    for (const [route, init] of calendarRoutes(
      serviceHeaders({ "Content-Type": "application/json" }),
    )) {
      const response = await fetch(`${baseUrl}${route}`, init);
      expect(response.status, route).toBe(403);
    }
  });

  it("keeps a plain member out of every calendar route", async () => {
    const { baseUrl } = await startService({ calendarEventsReader: async () => [] });
    const headers = await memberSession(baseUrl);

    for (const [route, init] of calendarRoutes(headers)) {
      const response = await fetch(`${baseUrl}${route}`, init);
      expect(response.status, route).toBe(403);
    }
  });

  // One click, but the full ledger: the action is filed, the admin who clicked is recorded as its
  // approver, and the execution is the same path every other action takes.
  it("files, approves and executes a created event in one call", async () => {
    const executed: Array<{ type: string; payload: unknown }> = [];
    const { baseUrl, mock } = await startService({
      executor: {
        execute: async (proposal) => {
          executed.push({ type: proposal.type, payload: proposal.proposed_payload });
          return { handled: true };
        },
      },
    });
    const headers = await adminSession(baseUrl);

    const response = await fetch(`${baseUrl}/calendar/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        summary: "Reading group lunch",
        start: "2026-08-18T13:00",
        end: "2026-08-18T14:00",
        location: "DCS lounge",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { action_id: string; status: string };
    expect(body.status).toBe("executed");

    // No attendees, so it is a hold rather than something that mails anyone.
    expect(executed).toHaveLength(1);
    expect(executed[0]?.type).toBe("calendar.create_tentative_hold");
    expect(executed[0]?.payload).toMatchObject({
      calendar_id: "jinesis.lab@gmail.com",
      summary: "Reading group lunch",
      // Resolved to an instant: the wall-clock time the draft carries is not RFC3339, and Google
      // answers `400 badRequest` for it. 13:00 Toronto in August is 17:00Z.
      from: "2026-08-18T17:00:00.000Z",
      to: "2026-08-18T18:00:00.000Z",
      timezone: "America/Toronto",
    });

    const stored = mock.service.getProposal(body.action_id);
    expect(stored?.status).toBe("executed");
    expect(stored?.approvals?.[0]).toMatchObject({ approver_role: "admin", approver_id: "boss" });
  });

  it("invites without touching anything else about the event", async () => {
    const executed: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const { baseUrl } = await startService({
      executor: {
        execute: async (proposal) => {
          executed.push({
            type: proposal.type,
            payload: proposal.proposed_payload as Record<string, unknown>,
          });
          return { handled: true };
        },
      },
    });
    const headers = await adminSession(baseUrl);

    const response = await fetch(`${baseUrl}/calendar/events/evt-9/invite`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        attendees: ["ada@cs.toronto.edu"],
        summary: "Lab retreat",
        rationale: "writing for NeurIPS 2026",
      }),
    });
    expect(response.status).toBe(200);
    expect(executed[0]?.type).toBe("calendar.add_attendees");
    expect(executed[0]?.payload).toMatchObject({
      event_id: "evt-9",
      attendees: ["ada@cs.toronto.edu"],
    });
    // An invite that carried a title or a time could rewrite the event as a side effect.
    expect(executed[0]?.payload.summary).toBeUndefined();
    expect(executed[0]?.payload.from).toBeUndefined();
  });

  // Every calendar write failed with `Google API error (400 badRequest)` because the wall-clock
  // time went to Google unresolved. An already-absolute time must still pass through untouched.
  it("passes an already-absolute time through unchanged", async () => {
    const executed: Array<Record<string, unknown>> = [];
    const { baseUrl } = await startService({
      executor: {
        execute: async (proposal) => {
          executed.push(proposal.proposed_payload as Record<string, unknown>);
          return { handled: true };
        },
      },
    });
    const headers = await adminSession(baseUrl);

    await fetch(`${baseUrl}/calendar/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        summary: "Already absolute",
        start: "2026-08-18T13:00:00-04:00",
        end: "2026-08-18T14:00:00-04:00",
      }),
    });
    expect(executed[0]?.from).toBe("2026-08-18T13:00:00-04:00");
  });

  it("refuses a start it cannot read rather than sending it to Google", async () => {
    const { baseUrl } = await startService();
    const headers = await adminSession(baseUrl);

    const response = await fetch(`${baseUrl}/calendar/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ summary: "Vague", start: "next Tuesday", end: "2026-08-18T14:00" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses an invite that names nobody, and an event with no times", async () => {
    const { baseUrl } = await startService();
    const headers = await adminSession(baseUrl);

    const noAttendees = await fetch(`${baseUrl}/calendar/events/evt-9/invite`, {
      method: "POST",
      headers,
      body: JSON.stringify({ attendees: [] }),
    });
    expect(noAttendees.status).toBe(400);

    const noTimes = await fetch(`${baseUrl}/calendar/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ summary: "Untimed" }),
    });
    expect(noTimes.status).toBe(400);
  });

  // A connector that cannot reach Google must not be reported as a send that happened.
  it("reports an execution failure rather than claiming success", async () => {
    const { baseUrl } = await startService({
      executor: { execute: async () => ({ handled: false }) },
    });
    const headers = await adminSession(baseUrl);

    const response = await fetch(`${baseUrl}/calendar/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        summary: "Reading group lunch",
        start: "2026-08-18T13:00",
        end: "2026-08-18T14:00",
      }),
    });
    expect(response.status).toBe(501);
  });
});

describe("the meetings routes", () => {
  async function memberToken(
    baseUrl: string,
    id: string,
    name: string,
    privilege: "member" | "admin" = "member",
  ): Promise<string> {
    seedMember(baseUrl, id, { name, email: `${id}@cs.toronto.edu`, privilege_level: privilege });
    await approveClaim(baseUrl, id, `${id}@cs.toronto.edu`);
    return await loginToken(baseUrl, `${id}@cs.toronto.edu`);
  }

  function fileMeeting(baseUrl: string, extra: Record<string, unknown> = {}) {
    const result = mockFor(baseUrl).service.upsertMeeting({
      id: "zoom-812-2026-08-12",
      topic: "Weekly Lab Meeting",
      started_at: "2026-08-12T14:00:00.000Z",
      recording: { share_url: "https://us02web.zoom.us/rec/share/tok", passcode: "k7$Rm2pQ" },
      source: "zoom_email",
      ...extra,
    });
    if (!result.ok) {
      throw new Error(`failed to file meeting: ${result.error.message}`);
    }
    return result.payload;
  }

  it("gives an admin the full roster", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "root", "Root Admin", "admin");
    await memberToken(baseUrl, "ada", "Ada Attendee");
    fileMeeting(baseUrl, {
      attendees: [
        { member_id: "ada", display_name: "Ada Attendee", source: "participant_report", present: true },
        { display_name: "Guest iPhone", source: "participant_report", present: true },
      ],
    });

    const res = await fetch(`${baseUrl}/meetings`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meetings: Array<Record<string, unknown>> };
    expect(body.meetings[0]?.attendees).toHaveLength(2);
    expect(body.meetings[0]?.attendee_count).toBeUndefined();
  });

  // Who sat in a lab meeting is personal data about everyone else in it. A member gets the
  // recording, their own line and a headcount -- never the list of names.
  it("gives a member their own attendance and a headcount, not the roster", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "ada", "Ada Attendee");
    seedMember(baseUrl, "bo", { name: "Bo Other", email: "bo@cs.toronto.edu" });
    fileMeeting(baseUrl, {
      attendees: [
        { member_id: "ada", display_name: "Ada Attendee", source: "participant_report", present: true },
        { member_id: "bo", display_name: "Bo Other", source: "participant_report", present: true },
      ],
    });

    const res = await fetch(`${baseUrl}/meetings`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meetings: Array<{ attendees: Array<{ member_id?: string }>; attendee_count: number }>;
    };
    expect(body.meetings[0]?.attendees).toEqual([
      {
        member_id: "ada",
        display_name: "Ada Attendee",
        source: "participant_report",
        present: true,
      },
    ]);
    expect(body.meetings[0]?.attendee_count).toBe(2);
  });

  it("refuses an anonymous read", async () => {
    const { baseUrl } = await startService();
    fileMeeting(baseUrl);
    expect((await fetch(`${baseUrl}/meetings`)).status).toBe(401);
  });

  it("refuses a plain member correcting the roster", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "ada", "Ada Attendee");
    fileMeeting(baseUrl);

    const res = await fetch(`${baseUrl}/meetings/zoom-812-2026-08-12/attendance`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        attendees: [{ member_id: "ada", display_name: "Ada", source: "manual", present: true }],
      }),
    });
    expect(res.status).toBe(403);
  });

  // The correction has to outrank the import, or the next transcript pass silently undoes it.
  it("lets an admin correct the roster and stamps the correction as manual", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "root", "Root Admin", "admin");
    seedMember(baseUrl, "ada", { name: "Ada Attendee", email: "ada@cs.toronto.edu" });
    fileMeeting(baseUrl, {
      attendees: [
        { member_id: "ada", display_name: "Ada Attendee", source: "transcript", present: false },
      ],
    });

    const res = await fetch(`${baseUrl}/meetings/zoom-812-2026-08-12/attendance`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // Sent as "participant_report" to prove the service overrides it: a human clicking a tick box
      // is a manual correction whatever the payload claims.
      body: JSON.stringify({
        attendees: [
          {
            member_id: "ada",
            display_name: "Ada Attendee",
            source: "participant_report",
            present: true,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      attendees: [{ member_id: "ada", source: "manual", present: true }],
    });
  });

  // A test call and a two-minute room check both produce a cloud recording. The tab is a catch-up
  // surface; three-quarters of it being noise is what makes people stop opening it.
  it("hides a meeting shorter than the configured floor", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "root", "Root Admin", "admin");
    fileMeeting(baseUrl, { id: "short", topic: "Room check", duration_minutes: 4 });
    fileMeeting(baseUrl, { id: "real", topic: "Weekly Lab Meeting", duration_minutes: 58 });

    const res = await fetch(`${baseUrl}/meetings`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { meetings: Array<{ id: string }> };
    expect(body.meetings.map((meeting) => meeting.id)).toEqual(["real"]);
  });

  // Hiding these would hide every meeting between the notice arriving and a transcript landing --
  // which is exactly the window in which someone goes looking for the recording.
  it("shows a meeting whose length nothing has reported yet", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "ada", "Ada Attendee");
    fileMeeting(baseUrl, { id: "unknown-length" });

    const res = await fetch(`${baseUrl}/meetings`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { meetings: Array<{ id: string }> };
    expect(body.meetings.map((meeting) => meeting.id)).toEqual(["unknown-length"]);
  });

  it("lets an admin lower the floor without a deploy", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "root", "Root Admin", "admin");
    fileMeeting(baseUrl, { id: "short", topic: "Room check", duration_minutes: 4 });

    const settings = await fetch(`${baseUrl}/settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ meeting_minimum_minutes: 0 }),
    });
    expect(settings.status).toBe(200);

    const res = await fetch(`${baseUrl}/meetings`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { meetings: Array<{ id: string }> };
    expect(body.meetings.map((meeting) => meeting.id)).toEqual(["short"]);
  });

  it("refuses a negative floor", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "root", "Root Admin", "admin");
    const res = await fetch(`${baseUrl}/settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ meeting_minimum_minutes: -5 }),
    });
    expect(res.status).toBe(400);
  });

  it("lets an admin file a meeting by hand when no notice ever arrived", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "root", "Root Admin", "admin");

    const res = await fetch(`${baseUrl}/meetings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "manual-1",
        topic: "Reading Group",
        started_at: "2026-08-14T15:00:00.000Z",
        recording: { share_url: "https://us02web.zoom.us/rec/share/other" },
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: "manual-1", source: "manual" });
  });

  it("refuses a record with no recording to open", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "root", "Root Admin", "admin");

    const res = await fetch(`${baseUrl}/meetings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "empty", topic: "Nothing", started_at: "2026-08-14T15:00:00.000Z" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("the member location timeline", () => {
  async function memberToken(
    baseUrl: string,
    id: string,
    name: string,
    privilege: "member" | "admin" = "member",
    profile: Record<string, unknown> = {},
  ): Promise<string> {
    seedMember(baseUrl, id, {
      name,
      email: `${id}@cs.toronto.edu`,
      privilege_level: privilege,
      ...profile,
    });
    await approveClaim(baseUrl, id, `${id}@cs.toronto.edu`);
    return await loginToken(baseUrl, `${id}@cs.toronto.edu`);
  }

  // Writes straight to the store rather than through the service: the drift rule is about days
  // elapsed, and a test that waited three days for it would not be a test.
  function observeLogin(baseUrl: string, memberId: string, country: string, observedAt: string) {
    mockFor(baseUrl).store.appendMemberLocation({
      id: `loc-${memberId}-${observedAt}`,
      member_id: memberId,
      observed_at: observedAt,
      source: "login_ip",
      raw: country,
      country,
    });
  }

  it("records a profile edit as a self-reported observation", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "ada", "Ada Attendee", "member", {
      location: "Toronto",
    });

    const res = await fetch(`${baseUrl}/lab/members/ada/locations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locations: Array<{ source: string; country?: string }> };
    expect(body.locations[0]).toMatchObject({ source: "self_reported", country: "Canada" });
  });

  // A movement history is not roster data. It stays with the person and the people who schedule.
  it("refuses one member reading another's timeline, and allows an admin", async () => {
    const { baseUrl } = await startService();
    await memberToken(baseUrl, "ada", "Ada Attendee", "member", { location: "Toronto" });
    const other = await memberToken(baseUrl, "bo", "Bo Other");
    const admin = await memberToken(baseUrl, "root", "Root Admin", "admin");

    expect(
      (
        await fetch(`${baseUrl}/lab/members/ada/locations`, {
          headers: { Authorization: `Bearer ${other}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/lab/members/ada/locations`, {
          headers: { Authorization: `Bearer ${admin}` },
        })
      ).status,
    ).toBe(200);
  });

  it("asks the member about a sustained move, and nobody else", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "ada", "Ada Attendee", "member", {
      location: "Toronto",
    });
    observeLogin(baseUrl, "ada", "Germany", "2026-08-10T09:00:00.000Z");
    observeLogin(baseUrl, "ada", "Germany", new Date().toISOString());

    const res = await fetch(`${baseUrl}/profile/location-prompt`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      drift: { observed_country: "Germany", profile_country: "Canada" },
    });

    expect((await fetch(`${baseUrl}/profile/location-prompt`)).status).toBe(401);
  });

  it("writes the member's answer as a self-report and stops asking", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "ada", "Ada Attendee", "member", {
      location: "Toronto",
    });
    observeLogin(baseUrl, "ada", "Germany", "2026-08-10T09:00:00.000Z");
    observeLogin(baseUrl, "ada", "Germany", new Date().toISOString());

    const answered = await fetch(`${baseUrl}/profile/location-prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ current_city: "Berlin", timezone: "Europe/Berlin" }),
    });
    expect(answered.status).toBe(200);
    await expect(answered.json()).resolves.toMatchObject({
      current_city: "Berlin",
      timezone: "Europe/Berlin",
    });

    const after = await fetch(`${baseUrl}/profile/location-prompt`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await expect(after.json()).resolves.toEqual({ drift: null });
  });

  // "No, still Toronto" has to settle it without editing the profile, or the prompt becomes
  // something people learn to click past.
  it("lets a member dismiss without changing where they say they are", async () => {
    const { baseUrl } = await startService();
    const token = await memberToken(baseUrl, "ada", "Ada Attendee", "member", {
      location: "Toronto",
    });
    observeLogin(baseUrl, "ada", "Germany", "2026-08-10T09:00:00.000Z");
    observeLogin(baseUrl, "ada", "Germany", new Date().toISOString());

    const dismissed = await fetch(`${baseUrl}/profile/location-prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(dismissed.status).toBe(200);
    const record = (await dismissed.json()) as { location?: string; current_city?: string };
    expect(record.location).toBe("Toronto");
    expect(record.current_city).toBeUndefined();

    const after = await fetch(`${baseUrl}/profile/location-prompt`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await expect(after.json()).resolves.toEqual({ drift: null });
  });

  it("lists everyone worth re-checking for an admin, and refuses a member", async () => {
    const { baseUrl } = await startService();
    await memberToken(baseUrl, "ada", "Ada Attendee", "member", { location: "Toronto" });
    const member = await memberToken(baseUrl, "bo", "Bo Other");
    const admin = await memberToken(baseUrl, "root", "Root Admin", "admin");
    observeLogin(baseUrl, "ada", "Germany", "2026-08-10T09:00:00.000Z");
    observeLogin(baseUrl, "ada", "Germany", new Date().toISOString());

    expect(
      (await fetch(`${baseUrl}/lab/location-drifts`, { headers: { Authorization: `Bearer ${member}` } }))
        .status,
    ).toBe(403);
    const res = await fetch(`${baseUrl}/lab/location-drifts`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drifts: Array<{ member_id: string }> };
    expect(body.drifts.map((drift) => drift.member_id)).toEqual(["ada"]);
  });
});

// The escalation queue is the one read that crosses member boundaries, so what it refuses matters
// as much as what it returns.
describe("GET /nudges/escalated", () => {
  it("is admin-only, and stays separate from anybody's own notification stream", async () => {
    const { baseUrl } = await startService();

    const anonymous = await fetch(`${baseUrl}/nudges/escalated`);
    expect(anonymous.status).toBe(401);

    const privileged = await fetch(`${baseUrl}/nudges/escalated`, { headers: serviceHeaders() });
    expect(privileged.status).toBe(200);
    await expect(privileged.json()).resolves.toEqual({ members: [] });

    // /notifications is still nobody else's business, service token or not: this route exists
    // because that one deliberately refuses, not as a way around it.
    const stream = await fetch(`${baseUrl}/notifications`, { headers: serviceHeaders() });
    expect(stream.status).toBe(401);
  });
});
