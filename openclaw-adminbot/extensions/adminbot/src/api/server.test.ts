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

  it("approving a registration submits the DCS form with the member's split name and email", async () => {
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
    expect(submitted).toEqual([
      { firstName: "Dcs", lastName: "Person", email: "dcs-person@cs.toronto.edu" },
    ]);
  });

  it("a failing DCS form submission does not block approval or expose an error to the caller", async () => {
    const { baseUrl } = await startService({
      dcsFormRunner: async () => {
        throw new Error("form layout changed");
      },
    });
    seedMember(baseUrl, "df", { name: "DF", email: "df@cs.toronto.edu" });
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "df",
        email: "df@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    const registration = (await listPending(baseUrl)).find((entry) => entry.member_id === "df");
    expect(approveRegistration(baseUrl, registration!.id)).toEqual({
      status: "approved",
      member_id: "df",
    });
    expect(await loginToken(baseUrl, "df@cs.toronto.edu")).toBeTruthy();
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

  it("serves the member map to a privileged principal and refuses anonymous callers", async () => {
    const { baseUrl } = await startService();
    await seedMember(baseUrl, "ada", {
      name: "Ada",
      privilege_level: "member",
      location: "Toronto",
    });

    const anonymous = await fetch(`${baseUrl}/member-map`);
    expect(anonymous.status).toBe(401);

    const response = await fetch(`${baseUrl}/member-map`, { headers: serviceHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      places: Array<{ label: string; members: Array<{ name: string; source: string }> }>;
    };
    expect(body.places[0]?.label).toBe("Toronto");
    expect(body.places[0]?.members[0]).toMatchObject({ name: "Ada", source: "roster" });
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
    expect(body).toEqual({ idsResolved: 1, timezonesChecked: 1, timezonesUpdated: 1 });

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

  it("reports members with incomplete mandatory profile fields to any caller", async () => {
    const { baseUrl } = await startService();
    seedMember(baseUrl, "blank", { name: "Blank" });
    const res = await fetch(`${baseUrl}/members/mandatory-fields-incomplete`, {
      headers: serviceHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ id: string; missing_fields: string[] }> };
    expect(body.members.map((member) => member.id)).toEqual(["blank"]);
    expect(body.members[0]?.missing_fields).toContain("role");
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
