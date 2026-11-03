// /lab/members/requests -- a non-admin proposing somebody for the roster, and the PI deciding.
// What matters here is the gate: a request never reaches the roster on its own, only the PI can
// turn one into a member, and approving it is the same save an admin's own Add member makes.
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService, parseMemberApproverIds } from "./server.js";

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

async function startService(options: { memberApproverIds?: string[]; piApproverIds?: string[] } = {}) {
  const calendarShares: string[] = [];
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async (email: string) => {
      calendarShares.push(email);
    },
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
    // Pinned to none unless a test names some, so a developer's own environment cannot open the gate.
    memberApproverIds: options.memberApproverIds ?? [],
    piApproverIds: options.piApproverIds ?? [],
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
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock, calendarShares };
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function seedMember(
  mock: ReturnType<typeof createAdminBotMockService>,
  input: AdminBotLabMemberInput,
): void {
  const result = mock.service.upsertLabMember(withCompleteProfile(input));
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

const roster = (mock: ReturnType<typeof createAdminBotMockService>) =>
  (
    mock.service as never as { store: { listLabMembers: () => AdminBotLabMember[] } }
  ).store.listLabMembers();

type RequestView = {
  id: string;
  status: string;
  requested_by: string;
  requested_by_name?: string;
  access_level?: string;
  member_id?: string;
  decision_note?: string;
  profile: Record<string, string>;
  updated_at: string;
  meetings?: string[];
};

async function lab(options: { memberApproverIds?: string[]; piApproverIds?: string[] } = {}) {
  const { baseUrl, mock, calendarShares } = await startService(options);
  seedMember(mock, {
    id: "admin",
    name: "Admin",
    email: "admin@cs.toronto.edu",
    privilege_level: "admin",
  });
  seedMember(mock, {
    id: "andy",
    name: "Andy",
    email: "andy@cs.toronto.edu",
    privilege_level: "admin",
  });
  seedMember(mock, {
    id: "pat",
    name: "Pat",
    email: "pat@cs.toronto.edu",
    privilege_level: "member",
  });
  seedMember(mock, {
    id: "sam",
    name: "Sam",
    email: "sam@cs.toronto.edu",
    privilege_level: "external_collaborator",
  });
  seedMember(mock, {
    id: "zhijing",
    name: "Zhijing",
    email: "zhijing@cs.toronto.edu",
    privilege_level: "admin",
  });
  const settings = mock.service.updateSettings({ head_professor_member_id: "zhijing" });
  if (!settings.ok) {
    throw new Error(settings.error.message);
  }
  const admin = await memberToken(mock, baseUrl, "admin", "admin@cs.toronto.edu");
  const andy = await memberToken(mock, baseUrl, "andy", "andy@cs.toronto.edu");
  const pi = await memberToken(mock, baseUrl, "zhijing", "zhijing@cs.toronto.edu");
  const pat = await memberToken(mock, baseUrl, "pat", "pat@cs.toronto.edu");
  const sam = await memberToken(mock, baseUrl, "sam", "sam@cs.toronto.edu");
  const call = (token: string, path: string, method = "GET", body?: unknown) =>
    fetch(`${baseUrl}/lab/members/requests${path}`, {
      method,
      headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = async (token: string, query = "") =>
    ((await (await call(token, query)).json()) as { requests: RequestView[] }).requests;
  return { baseUrl, mock, admin, andy, pi, pat, sam, call, list, calendarShares };
}

/** One pending sign-up (a roster row claimed by its owner), and a way to decide it. */
async function pendingSignUp(baseUrl: string, mock: ReturnType<typeof createAdminBotMockService>) {
  seedMember(mock, { id: "kim", name: "Kim", email: "kim@cs.toronto.edu" });
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      member_id: "kim",
      email: "kim@cs.toronto.edu",
      password: "correcthorse",
    }),
  });
  const queue = async (token: string) =>
    (await (
      await fetch(`${baseUrl}/auth/registrations?status=pending`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { registrations: Array<{ id: string; member_id?: string }>; can_decide: boolean };
  const decide = async (token: string, decision: "approve" | "reject") => {
    const registration = (await queue(SERVICE_TOKEN)).registrations.find(
      (entry) => entry.member_id === "kim",
    );
    return fetch(`${baseUrl}/auth/registrations/${registration?.id}/${decision}`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
      body: "{}",
    });
  };
  return { queue, decide };
}

const ADA = {
  name: "Ada Lovelace",
  email: "ada@example.org",
  calendar_email: "ada@gmail.com",
  member_type: "full",
  affiliation: "Analytical Engines",
  note: "Started with us this week.",
};

describe("member requests", () => {
  it("lets an admin correct a pending request without onboarding, and approval uses the correction", async () => {
    const { mock, admin, pi, pat, sam, call, list, calendarShares } = await lab();
    const { request } = (await (
      await call(pat, "", "POST", {
        ...ADA,
        member_type: "full, coauthor-major",
        meetings: ["theme-demo"],
      })
    ).json()) as { request: RequestView };
    const body = {
      ...ADA,
      member_type: "coauthor-major",
      expected_updated_at: request.updated_at,
      privilege_level: "admin",
    };
    expect((await call(pat, `/${request.id}/edit`, "POST", body)).status).toBe(403);
    expect((await call(sam, `/${request.id}/edit`, "POST", body)).status).toBe(403);
    calendarShares.length = 0;
    const saved = await call(admin, `/${request.id}/edit`, "POST", body);
    expect(saved.status).toBe(200);
    const edited = ((await saved.json()) as { request: RequestView }).request;
    expect(edited).toMatchObject({
      status: "pending",
      requested_by: "pat",
      profile: { member_type: "coauthor-major" },
      meetings: ["theme-demo"],
    });
    expect(edited.profile).not.toHaveProperty("privilege_level");
    expect(edited.updated_at).not.toBe(request.updated_at);
    expect(roster(mock).some((member) => member.email === ADA.email)).toBe(false);
    expect(calendarShares).toEqual([]);
    expect((await call(admin, `/${request.id}/edit`, "POST", body)).status).toBe(409);
    expect((await list(admin))[0]?.profile.member_type).toBe("coauthor-major");
    expect(
      (
        await call(pi, `/${request.id}/approve`, "POST", {
          expected_updated_at: request.updated_at,
        })
      ).status,
    ).toBe(409);
    expect((await call(pi, `/${request.id}/approve`, "POST", {})).status).toBe(200);
    expect(roster(mock).find((member) => member.email === ADA.email)?.member_type).toBe(
      "coauthor-major",
    );
    expect(
      (
        await call(admin, `/${request.id}/edit`, "POST", {
          ...body,
          expected_updated_at: edited.updated_at,
        })
      ).status,
    ).toBe(409);
  });

  it("refuses invalid or duplicate edits and preserves the original request", async () => {
    const { admin, pat, call, list } = await lab();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    expect(
      (
        await call(admin, `/${request.id}/edit`, "POST", {
          ...ADA,
          email: "bad",
          expected_updated_at: request.updated_at,
        })
      ).status,
    ).toBe(400);
    await call(pat, "", "POST", { name: "Other", email: "other@example.org" });
    expect(
      (
        await call(admin, `/${request.id}/edit`, "POST", {
          ...ADA,
          email: "other@example.org",
          expected_updated_at: request.updated_at,
        })
      ).status,
    ).toBe(409);
    expect((await list(admin)).find((row) => row.id === request.id)?.profile).toMatchObject({
      email: ADA.email,
      member_type: "full",
    });
  });

  it("holds a non-admin's request out of the roster until the PI approves it", async () => {
    const { mock, admin, pi, pat, call, list } = await lab();
    const submitted = await call(pat, "", "POST", ADA);
    expect(submitted.status).toBe(201);
    const { request } = (await submitted.json()) as { request: RequestView };
    expect(request).toMatchObject({ status: "pending", requested_by: "pat" });
    expect(roster(mock).some((m) => m.email === "ada@example.org")).toBe(false);

    const queue = await list(admin, "?status=pending");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: request.id,
      requested_by_name: "Pat",
      access_level: "member",
    });

    const approved = await call(pi, `/${request.id}/approve`, "POST", {});
    expect(approved.status).toBe(200);
    const result = (await approved.json()) as {
      request: RequestView;
      member: { id: string; privilege_level: string };
    };
    expect(result.request).toMatchObject({ status: "approved", member_id: result.member.id });
    const created = roster(mock).find((member) => member.email === "ada@example.org");
    // Member Type set the access level, exactly as it does on the admin's own Add member form.
    expect(created).toMatchObject({
      id: result.member.id,
      name: "Ada Lovelace",
      member_type: "full",
      privilege_level: "member",
      affiliation: "Analytical Engines",
    });
    expect(result.member.id).toMatch(/^mem_/u);

    // A second press on the same card must not create Ada twice.
    const again = await call(pi, `/${request.id}/approve`, "POST", {});
    expect(again.status).toBe(409);
    expect(roster(mock).filter((m) => m.email === "ada@example.org")).toHaveLength(1);
  });

  // Approving a request used to create the record and stop: the enrollment Add member runs --
  // calendar, Monday meeting, rooms -- was skipped because the save was not flagged as new.
  it("enrolls the approved member exactly as Add member does", async () => {
    const { pi, pat, call, calendarShares } = await lab();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    calendarShares.length = 0;
    const approved = (await (await call(pi, `/${request.id}/approve`, "POST", {})).json()) as {
      member: {
        member_type_change?: { steps: Array<{ step: string; status: string }> };
      };
    };
    const steps = approved.member.member_type_change?.steps ?? [];
    expect(steps.find((step) => step.step === "lab_calendar")?.status).toBe("done");
    expect(calendarShares).toEqual(["ada@gmail.com"]);
  });

  it("lets anyone signed in propose, and shows each requester only their own", async () => {
    const { pat, sam, call, list } = await lab();
    expect((await call(sam, "", "POST", ADA)).status).toBe(201);
    expect(
      (await call(pat, "", "POST", { name: "Grace", email: "grace@example.org" })).status,
    ).toBe(201);
    expect((await list(sam)).map((r) => r.profile.email)).toEqual(["ada@example.org"]);
    expect((await list(pat)).map((r) => r.profile.email)).toEqual(["grace@example.org"]);
  });

  it("only lets the PI decide -- not an admin, and not an admin viewing as the PI", async () => {
    const { baseUrl, mock, admin, pi, pat, sam, call, list } = await lab();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    expect((await call(pat, `/${request.id}/approve`, "POST", {})).status).toBe(403);
    expect((await call(sam, `/${request.id}/reject`, "POST", {})).status).toBe(403);
    expect((await call(admin, `/${request.id}/approve`, "POST", {})).status).toBe(403);
    expect((await call(admin, `/${request.id}/reject`, "POST", {})).status).toBe(403);
    const viewing = await fetch(`${baseUrl}/auth/impersonate`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${admin}` }),
      body: JSON.stringify({ member_id: "zhijing" }),
    });
    const asPi = ((await viewing.json()) as { session_token: string }).session_token;
    expect((await call(asPi, `/${request.id}/approve`, "POST", {})).status).toBe(403);
    expect(roster(mock).some((member) => member.email === ADA.email)).toBe(false);

    // Admins still see the queue, told the decision is not theirs; the PI is offered it.
    expect((await list(admin))[0]).toMatchObject({ status: "pending", can_decide: false });
    expect((await list(pi))[0]).toMatchObject({ status: "pending", can_decide: true });
    expect((await call(pi, `/${request.id}/approve`, "POST", {})).status).toBe(200);
  });

  it("leaves account sign-ups to the PI as well", async () => {
    const { baseUrl, mock, admin, pi } = await lab();
    seedMember(mock, { id: "kim", name: "Kim", email: "kim@cs.toronto.edu" });
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        member_id: "kim",
        email: "kim@cs.toronto.edu",
        password: "correcthorse",
      }),
    });
    const queue = async (token: string) =>
      (await (
        await fetch(`${baseUrl}/auth/registrations?status=pending`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json()) as { registrations: Array<{ id: string }>; can_decide: boolean };
    const seenByAdmin = await queue(admin);
    expect(seenByAdmin.can_decide).toBe(false);
    const [registration] = seenByAdmin.registrations;
    const decide = (token: string, decision: string) =>
      fetch(`${baseUrl}/auth/registrations/${registration?.id}/${decision}`, {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
        body: "{}",
      });
    expect((await decide(admin, "approve")).status).toBe(403);
    expect((await decide(admin, "reject")).status).toBe(403);
    expect((await decide(SERVICE_TOKEN, "approve")).status).toBe(403);
    const seenByPi = await queue(pi);
    expect(seenByPi.can_decide).toBe(true);
    expect(seenByPi.registrations[0]?.id).toBe(registration?.id);
    expect((await decide(pi, "approve")).status).toBe(200);
  });

  it("lets nobody decide while no PI is named, until an admin names one", async () => {
    const { baseUrl, mock, admin, pi, pat, call, list } = await lab();
    expect(mock.service.updateSettings({ head_professor_member_id: "" }).ok).toBe(true);
    expect(mock.service.headProfessorMemberId()).toBeUndefined();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    // An unset setting is not "anybody may": the queue waits rather than opening to every admin.
    expect((await list(admin))[0]).toMatchObject({ can_decide: false });
    expect((await call(admin, `/${request.id}/approve`, "POST", {})).status).toBe(403);
    expect((await call(pi, `/${request.id}/approve`, "POST", {})).status).toBe(403);
    const named = await fetch(`${baseUrl}/settings`, {
      method: "PUT",
      headers: jsonHeaders({ Authorization: `Bearer ${admin}` }),
      body: JSON.stringify({ head_professor_member_id: "zhijing" }),
    });
    expect(named.status).toBe(200);
    expect((await call(pi, `/${request.id}/approve`, "POST", {})).status).toBe(200);
  });

  it("does not let an admin make themselves the PI", async () => {
    const { baseUrl, mock, admin, pi } = await lab();
    const put = (token: string, head: string) =>
      fetch(`${baseUrl}/settings`, {
        method: "PUT",
        headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
        body: JSON.stringify({ head_professor_member_id: head }),
      });
    expect((await put(admin, "admin")).status).toBe(403);
    expect((await put(admin, "")).status).toBe(403);
    // Viewing as the PI is still an admin's hands on the keyboard.
    const viewing = await fetch(`${baseUrl}/auth/impersonate`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${admin}` }),
      body: JSON.stringify({ member_id: "zhijing" }),
    });
    const asPi = ((await viewing.json()) as { session_token: string }).session_token;
    expect((await put(asPi, "admin")).status).toBe(403);
    // Re-sending the PI unchanged is what the Settings form does on every save.
    expect((await put(admin, "zhijing")).status).toBe(200);
    expect(mock.service.headProfessorMemberId()).toBe("zhijing");
    expect((await put(pi, "admin")).status).toBe(200);
    expect(mock.service.headProfessorMemberId()).toBe("admin");
  });

  // The PI approvers the host names share her paper review, on the same terms as the member
  // approvers: an admin, in their own session. The list is the host's; /settings only reports it.
  it("lets a host-named PI approver approve publication, and keeps the list off /settings", async () => {
    const { baseUrl, admin, andy, pat } = await lab({ piApproverIds: ["andy", "pat"] });
    const send = (token: string, method: string, route: string, body?: unknown) =>
      fetch(`${baseUrl}${route}`, {
        method,
        headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const paper = await send(admin, "PUT", "/papers/p1", {
      title: "Causal abstraction",
      authors: ["Pat"],
      current_step: "overleaf_writing",
      first_author_member_id: "pat",
      venue: "ICLR 2027",
      deadline: "2099-01-01",
    });
    expect(paper.status).toBe(200);
    const approve = (token: string) =>
      send(token, "PUT", "/papers/p1/slots/pi_approval", { done: true });
    expect((await approve(admin)).status).toBe(403);
    // Named, but a member rather than an admin: naming grants nothing on its own.
    expect((await approve(pat)).status).toBe(403);
    const viewing = await send(admin, "POST", "/auth/impersonate", { member_id: "andy" });
    const asAndy = ((await viewing.json()) as { session_token: string }).session_token;
    expect((await approve(asAndy)).status).toBe(403);
    expect((await approve(andy)).status).toBe(200);
    // Nor is viewing as the PI her yes: that is still the admin at the keyboard.
    const viewingPi = await send(admin, "POST", "/auth/impersonate", { member_id: "zhijing" });
    const asPi = ((await viewingPi.json()) as { session_token: string }).session_token;
    expect((await approve(asPi)).status).toBe(403);

    const approvers = async () =>
      ((await (await send(admin, "GET", "/settings")).json()) as {
        pi_approver_member_ids?: string[];
      }).pi_approver_member_ids;
    expect(await approvers()).toEqual(["andy", "pat"]);
    await send(admin, "PUT", "/settings", { pi_approver_member_ids: ["admin"] });
    expect(await approvers()).toEqual(["andy", "pat"]);
  });

  it("refuses the service principal and anonymous callers", async () => {
    const { baseUrl, call } = await lab();
    expect((await call(SERVICE_TOKEN, "", "POST", ADA)).status).toBe(403);
    const anonymous = await fetch(`${baseUrl}/lab/members/requests`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(ADA),
    });
    expect(anonymous.status).toBe(401);
  });

  it("drops governance fields a request tries to carry", async () => {
    const { mock, pi, pat, call } = await lab();
    const { request } = (await (
      await call(pat, "", "POST", { ...ADA, member_type: "", privilege_level: "admin" })
    ).json()) as { request: RequestView };
    expect(request.profile).not.toHaveProperty("privilege_level");
    const approved = (await (await call(pi, `/${request.id}/approve`, "POST", {})).json()) as {
      member: { id: string };
    };
    expect(roster(mock).find((m) => m.id === approved.member.id)).toMatchObject({
      privilege_level: "external_collaborator",
    });
  });

  it("returns a rejection and its reason to the requester", async () => {
    const { mock, pi, pat, call, list } = await lab();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    const rejected = await call(pi, `/${request.id}/reject`, "POST", {
      note: "Already added under her other address.",
    });
    expect(rejected.status).toBe(200);
    expect(await list(pat)).toEqual([
      expect.objectContaining({
        status: "rejected",
        decision_note: "Already added under her other address.",
      }),
    ]);
    expect(roster(mock).some((m) => m.email === "ada@example.org")).toBe(false);
  });

  it("refuses somebody already on the roster or already waiting", async () => {
    const { pat, sam, call } = await lab();
    expect(
      (await call(pat, "", "POST", { name: "Sam again", email: "SAM@cs.toronto.edu" })).status,
    ).toBe(409);
    expect((await call(pat, "", "POST", ADA)).status).toBe(201);
    expect((await call(sam, "", "POST", ADA)).status).toBe(409);
  });

  it("requires a name and a usable email", async () => {
    const { pat, call } = await lab();
    expect((await call(pat, "", "POST", { email: "x@example.org" })).status).toBe(400);
    expect((await call(pat, "", "POST", { name: "X", email: "not-an-email" })).status).toBe(400);
  });

  it("lets the requester withdraw a pending request, and nobody else", async () => {
    const { pat, sam, call, list } = await lab();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    expect((await call(sam, `/${request.id}`, "DELETE")).status).toBe(403);
    expect((await call(pat, `/${request.id}`, "DELETE")).status).toBe(200);
    expect(await list(pat)).toEqual([]);
  });
});

// ADMINBOT_MEMBER_APPROVER_IDS: the host names admins who decide new members alongside the PI.
describe("named member approvers", () => {
  it("lets a named admin approve and reject member requests, and no other admin", async () => {
    const { mock, admin, andy, pat, call, list } = await lab({ memberApproverIds: ["andy"] });
    const first = ((await (await call(pat, "", "POST", ADA)).json()) as { request: RequestView })
      .request;
    expect((await list(andy))[0]).toMatchObject({ status: "pending", can_decide: true });
    expect((await list(admin))[0]).toMatchObject({ status: "pending", can_decide: false });
    expect((await call(admin, `/${first.id}/approve`, "POST", {})).status).toBe(403);
    expect((await call(andy, `/${first.id}/approve`, "POST", {})).status).toBe(200);
    expect(roster(mock).some((member) => member.email === ADA.email)).toBe(true);

    const second = (
      (await (
        await call(pat, "", "POST", { ...ADA, name: "Grace Hopper", email: "grace@example.org" })
      ).json()) as { request: RequestView }
    ).request;
    expect((await call(admin, `/${second.id}/reject`, "POST", {})).status).toBe(403);
    expect((await call(andy, `/${second.id}/reject`, "POST", {})).status).toBe(200);
    expect(roster(mock).some((member) => member.email === "grace@example.org")).toBe(false);
  });

  it("lets a named admin approve and reject sign-ups", async () => {
    const approving = await lab({ memberApproverIds: ["andy"] });
    const signUp = await pendingSignUp(approving.baseUrl, approving.mock);
    expect((await signUp.queue(approving.andy)).can_decide).toBe(true);
    expect((await signUp.queue(approving.admin)).can_decide).toBe(false);
    expect((await signUp.decide(approving.admin, "approve")).status).toBe(403);
    expect((await signUp.decide(approving.andy, "approve")).status).toBe(200);

    const rejecting = await lab({ memberApproverIds: ["andy"] });
    const second = await pendingSignUp(rejecting.baseUrl, rejecting.mock);
    expect((await second.decide(rejecting.admin, "reject")).status).toBe(403);
    expect((await second.decide(rejecting.andy, "reject")).status).toBe(200);
  });

  // The list delegates an admin decision; it does not turn a member or collaborator into an admin.
  it("ignores a named member or collaborator who is not an admin", async () => {
    const { pat, sam, call, list } = await lab({ memberApproverIds: ["pat", "sam"] });
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    expect((await list(pat))[0]).toMatchObject({ can_decide: false });
    expect((await call(pat, `/${request.id}/approve`, "POST", {})).status).toBe(403);
    expect((await call(sam, `/${request.id}/reject`, "POST", {})).status).toBe(403);
  });

  it("refuses a named approver's view-as session, and the service token", async () => {
    const { baseUrl, mock, andy, pat, call } = await lab({ memberApproverIds: ["andy", "pat"] });
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    const viewing = await fetch(`${baseUrl}/auth/impersonate`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${andy}` }),
      body: JSON.stringify({ member_id: "admin" }),
    });
    const asAdmin = ((await viewing.json()) as { session_token: string }).session_token;
    expect((await call(asAdmin, `/${request.id}/approve`, "POST", {})).status).toBe(403);
    const signUp = await pendingSignUp(baseUrl, mock);
    expect((await signUp.decide(SERVICE_TOKEN, "approve")).status).toBe(403);
  });

  // Deciding new members is all the list grants: naming the PI stays the PI's alone.
  it("does not let a named approver change who the PI is", async () => {
    const { baseUrl, mock, andy } = await lab({ memberApproverIds: ["andy"] });
    const moved = await fetch(`${baseUrl}/settings`, {
      method: "PUT",
      headers: jsonHeaders({ Authorization: `Bearer ${andy}` }),
      body: JSON.stringify({ head_professor_member_id: "andy" }),
    });
    expect(moved.status).toBe(403);
    expect(mock.service.headProfessorMemberId()).toBe("zhijing");
  });

  it("decides nothing when no approver is named", async () => {
    const { andy, pat, call } = await lab();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    expect((await call(andy, `/${request.id}/approve`, "POST", {})).status).toBe(403);
  });

  it("reads the host list comma- or space-separated, without blanks or repeats", () => {
    expect(parseMemberApproverIds(" andrew-kim, ada  grace,,andrew-kim ")).toEqual([
      "andrew-kim",
      "ada",
      "grace",
    ]);
    expect(parseMemberApproverIds(undefined)).toEqual([]);
    expect(parseMemberApproverIds("  ")).toEqual([]);
  });
});
