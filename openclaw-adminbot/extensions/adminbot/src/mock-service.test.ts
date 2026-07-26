import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "./contracts.js";
import { createAdminBotMockService } from "./mock-service.js";

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
    // Default to a no-op so approving a registration never shells out to the real `gws` binary
    // in tests; individual tests override this to assert on the calendar-invite call itself.
    calendarInviteRunner: async () => {},
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
    seedMember(baseUrl, "pat", { name: "Pat", email: "pat@example.com" });
    const member = await fetch(`${baseUrl}/lab/members/pat`, {
      method: "PUT",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Pat",
        research_branch: "Human-centered AI",
        projects: ["Project Atlas"],
        capacity_percent: 80,
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

  it("rejects unauthenticated requests to gated routes", async () => {
    const { baseUrl } = await startService();
    const members = await fetch(`${baseUrl}/lab/members`);
    expect(members.status).toBe(401);
    await expect(members.json()).resolves.toEqual({
      error: { message: "authentication required" },
    });
  });

  it("claim queues a pending registration, login is blocked until approval", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "ada", {
      name: "Ada",
      email: "Ada@example.com",
      privilege_level: "member",
    });

    const claim = await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "ada",
        email: "ada@example.com",
        password: "correcthorse",
      }),
    });
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toEqual({ status: "pending" });
    expect(claim.headers.get("set-cookie")).toBeNull();

    const blocked = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "ada@example.com", password: "correcthorse" }),
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
      body: JSON.stringify({ email: "ada@example.com", password: "correcthorse" }),
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
        email: "new@example.com",
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

    expect(await loginToken(baseUrl, "new@example.com")).toBeTruthy();
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
        email: "calendar-person@example.com",
        password: "correcthorse",
      }),
    });
    expect(signup.status).toBe(200);

    const registration = (await listPending(baseUrl)).find((entry) => entry.kind === "signup");
    const approveBody = approveRegistration(baseUrl, registration!.id);

    // Fire-and-forget: flush microtasks so the injected runner's resolution is observable.
    await Promise.resolve();
    await Promise.resolve();
    expect(invited).toEqual(["calendar-person@example.com"]);

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

  it("a failing calendar invite does not block approval or expose an error to the caller", async () => {
    const { baseUrl } = await startService({
      calendarInviteRunner: async () => {
        throw new Error("gws unreachable");
      },
    });
    await seedMember(baseUrl, "rk", { name: "RK", email: "rk@example.com" });
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ member_id: "rk", email: "rk@example.com", password: "correcthorse" }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.member_id === "rk");
    const approveBody = approveRegistration(baseUrl, registration!.id);
    expect(approveBody).toEqual({ status: "approved", member_id: "rk" });
    expect(await loginToken(baseUrl, "rk@example.com")).toBeTruthy();
  });

  it("rejected registrations produce a generic 401 on login", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "rj", { name: "RJ", email: "rj@example.com" });
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ member_id: "rj", email: "rj@example.com", password: "correcthorse" }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.member_id === "rj");
    rejectRegistration(baseUrl, registration!.id);

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "rj@example.com", password: "correcthorse" }),
    });
    expect(login.status).toBe(401);
    await expect(login.json()).resolves.toEqual({
      error: { message: "invalid email or password" },
    });
  });

  it("includes the gateway payload only when a gateway token is configured", async () => {
    const { baseUrl } = await startService({ gatewayToken: "gw-secret", gatewayUrl: "ws://x:1" });
    await seedMember(baseUrl, "gwm", { name: "GW", email: "gw@example.com" });
    await approveClaim(baseUrl, "gwm", "gw@example.com");

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "gw@example.com", password: "correcthorse" }),
    });
    const body = (await login.json()) as { gateway?: { url: string; token: string } };
    expect(body.gateway).toEqual({ url: "ws://x:1", token: "gw-secret" });
  });

  it("returns generic errors for unknown claims, collisions, and short passwords", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "known", { name: "Known", email: "known@example.com" });

    const unknownClaim = await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "ghost",
        email: "nobody@example.com",
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
      body: JSON.stringify({ member_id: "known", email: "known@example.com", password: "short" }),
    });
    expect(shortClaim.status).toBe(400);

    const badLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "known@example.com", password: "wrongpassword" }),
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
      email: "self@example.com",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "self", "self@example.com");
    const memberToken = await loginToken(baseUrl, "self@example.com");

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
    await seedMember(baseUrl, "rl", { name: "RL", email: "rl@example.com" });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ email: "rl@example.com", password: "wrongpassword" }),
      });
      expect(res.status).toBe(401);
    }
    const limited = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "rl@example.com", password: "wrongpassword" }),
    });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as {
      error: { message: string };
      retry_after_seconds: number;
    };
    expect(body.error.message).toBe("too many attempts, retry later");
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  it("guards member self-profile edits", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@example.com",
      privilege_level: "member",
    });
    await seedMember(baseUrl, "other", { name: "Other", email: "other@example.com" });
    await approveClaim(baseUrl, "self", "self@example.com");
    const token = await loginToken(baseUrl, "self@example.com");
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
      email: "peerish@example.com",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "peerish", "peerish@example.com");
    const token = await loginToken(baseUrl, "peerish@example.com");
    const memberHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const save = await fetch(`${baseUrl}/lab/members/peerish`, {
      method: "PUT",
      headers: memberHeaders,
      body: JSON.stringify({ role: "Research scientist" }),
    });
    expect(save.status).toBe(200);
    await expect(save.json()).resolves.toMatchObject({
      id: "peerish",
      role: "Research scientist",
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
      email: "boss@example.com",
      privilege_level: "admin",
      location: "Old Town",
      research_topics: ["stale topic"],
    });
    await approveClaim(baseUrl, "boss", "boss@example.com");
    const token = await loginToken(baseUrl, "boss@example.com");

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
        capacity_percent: 50,
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
      email: "boss@example.com",
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
      capacity_percent: 50,
      location: "Zurich",
      affiliation: "ETH",
      timezone: "Europe/Zurich",
      personal_website: "https://boss.example.com",
      notes: "on sabbatical",
      email: "boss@example.com",
      privilege_level: "admin",
    });
  });

  it("lets a member change their own login email and reflects it in the session", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@example.com",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "self", "self@example.com");
    const token = await loginToken(baseUrl, "self@example.com");
    const memberHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: memberHeaders,
      body: JSON.stringify({ new_email: "renamed@example.com", current_password: "correcthorse" }),
    });
    expect(change.status).toBe(200);
    await expect(change.json()).resolves.toEqual({ email: "renamed@example.com" });

    // The still-valid session now reports the new email on both the member and its record.
    const session = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      member: { id: "self", email: "renamed@example.com" },
    });

    // New email logs in; the old one is gone.
    const newLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "renamed@example.com", password: "correcthorse" }),
    });
    expect(newLogin.status).toBe(200);
    const oldLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "self@example.com", password: "correcthorse" }),
    });
    expect(oldLogin.status).toBe(401);
  });

  it("rejects an email change with the wrong password", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@example.com",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "self", "self@example.com");
    const token = await loginToken(baseUrl, "self@example.com");

    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        new_email: "renamed@example.com",
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
      email: "self@example.com",
      privilege_level: "member",
    });
    await seedMember(baseUrl, "other", { name: "Other", email: "other@example.com" });
    await approveClaim(baseUrl, "self", "self@example.com");
    await approveClaim(baseUrl, "other", "other@example.com");
    const token = await loginToken(baseUrl, "self@example.com");

    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ new_email: "other@example.com", current_password: "correcthorse" }),
    });
    expect(change.status).toBe(409);
    await expect(change.json()).resolves.toEqual({ error: { message: "email unavailable" } });
  });

  it("rejects an email change colliding with a pending registration", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "self", {
      name: "Self",
      email: "self@example.com",
      privilege_level: "member",
    });
    await seedMember(baseUrl, "cid", { name: "Cid", email: "cid@example.com" });
    await approveClaim(baseUrl, "self", "self@example.com");
    // Leave a pending claim holding pending@example.com.
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "cid",
        email: "pending@example.com",
        password: "correcthorse",
      }),
    });
    const token = await loginToken(baseUrl, "self@example.com");

    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ new_email: "pending@example.com", current_password: "correcthorse" }),
    });
    expect(change.status).toBe(409);
  });

  it("rejects an email change from the service principal", async () => {
    const { baseUrl } = await startService();
    const change = await fetch(`${baseUrl}/auth/email`, {
      method: "POST",
      headers: serviceHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ new_email: "renamed@example.com", current_password: "correcthorse" }),
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
      email: "self@example.com",
      privilege_level: "member",
    });
    await approveClaim(baseUrl, "self", "self@example.com");
    const token = await loginToken(baseUrl, "self@example.com");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const attempt = () =>
      fetch(`${baseUrl}/auth/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({ new_email: "renamed@example.com", current_password: "wrong-pass" }),
      });
    for (let i = 0; i < 10; i += 1) {
      expect((await attempt()).status).toBe(401);
    }
    expect((await attempt()).status).toBe(429);
  });

  it("lists papers relevant to the member principal", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "res", {
      name: "Researcher",
      email: "res@example.com",
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
    await approveClaim(baseUrl, "res", "res@example.com");
    const token = await loginToken(baseUrl, "res@example.com");

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
      email: "someone@example.com",
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
      email: "target@example.com",
      privilege_level: "member",
    });
    const governed: Array<Record<string, unknown>> = [
      { privilege_level: "admin" },
      { status: "inactive" },
      { email: "moved@example.com" },
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
    const token = await adminToken(baseUrl, "boss", "boss@example.com");
    seedMember(baseUrl, "grantee", {
      name: "Grantee",
      email: "grantee@example.com",
      privilege_level: "member",
    });
    const res = await fetch(`${baseUrl}/lab/members/grantee`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Grantee",
        email: "grantee@example.com",
        privilege_level: "core_member",
        status: "active",
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "grantee",
      privilege_level: "core_member",
    });
  });

  it("denies the service principal on settings, sensitive-info, and registration decisions", async () => {
    const { baseUrl } = await startService();
    const approveId = await pendingClaim(baseUrl, "ap", "ap@example.com");
    const rejectId = await pendingClaim(baseUrl, "rj", "rj@example.com");

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
    const token = await adminToken(baseUrl, "boss", "boss@example.com");
    const adminHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const approveId = await pendingClaim(baseUrl, "ap", "ap@example.com");
    const rejectId = await pendingClaim(baseUrl, "rj", "rj@example.com");

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
    const token = await adminToken(baseUrl, "boss", "boss@example.com");
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
});
