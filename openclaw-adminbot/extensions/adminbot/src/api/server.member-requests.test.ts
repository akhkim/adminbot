// /lab/members/requests -- a non-admin proposing somebody for the roster, and an admin deciding.
// What matters here is the gate: a request never reaches the roster on its own, only an admin can
// turn one into a member, and approving it is the same save an admin's own Add member makes.
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
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

async function startService() {
  const calendarShares: string[] = [];
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async (email: string) => {
      calendarShares.push(email);
    },
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

async function lab() {
  const { baseUrl, mock, calendarShares } = await startService();
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
    id: "sam",
    name: "Sam",
    email: "sam@cs.toronto.edu",
    privilege_level: "external_collaborator",
  });
  const admin = await memberToken(mock, baseUrl, "admin", "admin@cs.toronto.edu");
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
  return { baseUrl, mock, admin, pat, sam, call, list, calendarShares };
}

const ADA = {
  name: "Ada Lovelace",
  email: "ada@example.org",
  member_type: "full",
  affiliation: "Analytical Engines",
  note: "Started with us this week.",
};

describe("member requests", () => {
  it("lets an admin correct a pending request without onboarding, and approval uses the correction", async () => {
    const { mock, admin, pat, sam, call, list, calendarShares } = await lab();
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
        await call(admin, `/${request.id}/approve`, "POST", {
          expected_updated_at: request.updated_at,
        })
      ).status,
    ).toBe(409);
    expect((await call(admin, `/${request.id}/approve`, "POST", {})).status).toBe(200);
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

  it("holds a non-admin's request out of the roster until an admin approves it", async () => {
    const { mock, admin, pat, call, list } = await lab();
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

    const approved = await call(admin, `/${request.id}/approve`, "POST", {});
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
    const again = await call(admin, `/${request.id}/approve`, "POST", {});
    expect(again.status).toBe(409);
    expect(roster(mock).filter((m) => m.email === "ada@example.org")).toHaveLength(1);
  });

  // Approving a request used to create the record and stop: the enrollment Add member runs --
  // calendar, Monday meeting, rooms -- was skipped because the save was not flagged as new.
  it("enrolls the approved member exactly as Add member does", async () => {
    const { admin, pat, call, calendarShares } = await lab();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    calendarShares.length = 0;
    const approved = (await (await call(admin, `/${request.id}/approve`, "POST", {})).json()) as {
      member: {
        member_type_change?: { steps: Array<{ step: string; status: string }> };
      };
    };
    const steps = approved.member.member_type_change?.steps ?? [];
    expect(steps.find((step) => step.step === "lab_calendar")?.status).toBe("done");
    expect(calendarShares).toEqual(["ada@example.org"]);
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

  it("only lets an admin decide", async () => {
    const { pat, sam, call } = await lab();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    expect((await call(pat, `/${request.id}/approve`, "POST", {})).status).toBe(403);
    expect((await call(sam, `/${request.id}/reject`, "POST", {})).status).toBe(403);
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
    const { mock, admin, pat, call } = await lab();
    const { request } = (await (
      await call(pat, "", "POST", { ...ADA, member_type: "", privilege_level: "admin" })
    ).json()) as { request: RequestView };
    expect(request.profile).not.toHaveProperty("privilege_level");
    const approved = (await (await call(admin, `/${request.id}/approve`, "POST", {})).json()) as {
      member: { id: string };
    };
    expect(roster(mock).find((m) => m.id === approved.member.id)).toMatchObject({
      privilege_level: "external_collaborator",
    });
  });

  it("returns a rejection and its reason to the requester", async () => {
    const { mock, admin, pat, call, list } = await lab();
    const { request } = (await (await call(pat, "", "POST", ADA)).json()) as {
      request: RequestView;
    };
    const rejected = await call(admin, `/${request.id}/reject`, "POST", {
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
