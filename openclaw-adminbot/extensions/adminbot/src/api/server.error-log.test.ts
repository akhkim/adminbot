import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-error-log-service-token";
const OPS = { Authorization: `Bearer ${SERVICE_TOKEN}` };

type Mock = ReturnType<typeof createAdminBotMockService>;

const running: Mock[] = [];

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

async function startService(): Promise<{ baseUrl: string; mock: Mock }> {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
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

async function memberSession(baseUrl: string, mock: Mock, id: string): Promise<string> {
  const email = `${id}@cs.toronto.edu`;
  const seeded = mock.service.upsertLabMember(
    withCompleteProfile({
      id,
      name: id[0]!.toUpperCase() + id.slice(1),
      email,
      privilege_level: "member",
    } as AdminBotLabMemberInput),
  );
  if (!seeded.ok) {
    throw new Error(seeded.error.message);
  }
  const claim = await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ member_id: id, email, password: "correcthorse" }),
  });
  expect(claim.status).toBe(200);
  const pending = (await (
    await fetch(`${baseUrl}/auth/registrations?status=pending`, { headers: OPS })
  ).json()) as { registrations: Array<{ id: string; member_id?: string }> };
  const registration = pending.registrations.find((entry) => entry.member_id === id);
  if (!registration) {
    throw new Error("missing claim registration");
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
  expect(login.status).toBe(200);
  return ((await login.json()) as { session_token: string }).session_token;
}

function report(baseUrl: string, token: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/ui/errors`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

type Groups = {
  groups: Array<{
    id: string;
    kind: string;
    message: string;
    count: number;
    member_ids: string[];
    members: Array<{ id: string; name: string }>;
    api_method?: string;
    api_path?: string;
    api_status?: number;
    page?: string;
    resolved_at?: string;
  }>;
};

async function listGroups(baseUrl: string, query = ""): Promise<Groups> {
  const response = await fetch(`${baseUrl}/ops/errors${query}`, { headers: OPS });
  expect(response.status).toBe(200);
  return (await response.json()) as Groups;
}

const crash = {
  kind: "error",
  name: "TypeError",
  message: "x is undefined",
  stack: "TypeError: x is undefined\n    at render (https://lab.example/assets/app.js:1:2)",
  page: "/papers?draft=secret-title",
  user_agent: "TestBrowser/1.0",
};

describe("the error log routes", () => {
  it("turns away a report from nobody, and one from the service token", async () => {
    const { baseUrl } = await startService();
    expect((await report(baseUrl, undefined, crash)).status).toBe(401);
    expect((await report(baseUrl, SERVICE_TOKEN, crash)).status).toBe(401);
    expect((await listGroups(baseUrl)).groups).toEqual([]);
  });

  it("files a member's report under the session's member, not the body's", async () => {
    const { baseUrl, mock } = await startService();
    const ada = await memberSession(baseUrl, mock, "ada");
    const grace = await memberSession(baseUrl, mock, "grace");

    const first = await report(baseUrl, ada, { ...crash, member_id: "mallory" });
    expect(first.status).toBe(200);
    const filed = (await first.json()) as Record<string, unknown>;
    expect(Object.keys(filed).toSorted()).toEqual(["count", "id", "recorded"]);
    expect((await report(baseUrl, ada, crash)).status).toBe(200);
    expect((await report(baseUrl, grace, crash)).status).toBe(200);

    const { groups } = await listGroups(baseUrl);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "error",
      message: "x is undefined",
      count: 3,
      member_ids: ["ada", "grace"],
      members: [
        { id: "ada", name: "Ada" },
        { id: "grace", name: "Grace" },
      ],
      page: "/papers",
    });
    expect(JSON.stringify(groups)).not.toContain("secret-title");
  });

  it("rejects a report with no message or an unknown kind", async () => {
    const { baseUrl, mock } = await startService();
    const ada = await memberSession(baseUrl, mock, "ada");
    expect((await report(baseUrl, ada, { kind: "error" })).status).toBe(400);
    expect((await report(baseUrl, ada, { kind: "server", message: "forged" })).status).toBe(400);
    expect((await listGroups(baseUrl)).groups).toEqual([]);
  });

  it("keeps the list and the resolve button from ordinary members", async () => {
    const { baseUrl, mock } = await startService();
    const ada = await memberSession(baseUrl, mock, "ada");
    const filed = (await (await report(baseUrl, ada, crash)).json()) as { id: string };
    const asMember = { Authorization: `Bearer ${ada}` };

    expect((await fetch(`${baseUrl}/ops/errors`, { headers: asMember })).status).toBe(403);
    expect((await fetch(`${baseUrl}/ops/errors`)).status).toBe(401);
    const resolve = await fetch(`${baseUrl}/ops/errors/${filed.id}/resolve`, {
      method: "POST",
      headers: asMember,
    });
    expect(resolve.status).toBe(403);
    expect((await listGroups(baseUrl)).groups).toHaveLength(1);
  });

  it("lets an operator resolve a group, which reopens if it happens again", async () => {
    const { baseUrl, mock } = await startService();
    const ada = await memberSession(baseUrl, mock, "ada");
    const filed = (await (await report(baseUrl, ada, crash)).json()) as { id: string };

    const resolved = await fetch(`${baseUrl}/ops/errors/${filed.id}/resolve`, {
      method: "POST",
      headers: OPS,
    });
    expect(resolved.status).toBe(200);
    expect((await listGroups(baseUrl)).groups).toEqual([]);
    expect((await listGroups(baseUrl, "?resolved=1")).groups[0]?.resolved_at).toBeTruthy();
    const missing = await fetch(`${baseUrl}/ops/errors/err_nope/resolve`, {
      method: "POST",
      headers: OPS,
    });
    expect(missing.status).toBe(404);

    await report(baseUrl, ada, crash);
    const [reopened] = (await listGroups(baseUrl)).groups;
    expect(reopened).toMatchObject({ count: 2 });
    expect(reopened?.resolved_at).toBeUndefined();
  });

  it("records a route handler that throws, with its route and the member it failed for", async () => {
    const { baseUrl, mock } = await startService();
    const ada = await memberSession(baseUrl, mock, "ada");
    // A body that is not JSON makes the handler's own read throw: the plainest real 500 there is.
    const broken = await fetch(`${baseUrl}/ui/tab-visits?secret=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ada}` },
      body: "{not json",
    });
    expect(broken.status).toBe(500);

    const { groups } = await listGroups(baseUrl);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "server",
      api_method: "POST",
      api_path: "/ui/tab-visits",
      api_status: 500,
      member_ids: ["ada"],
      count: 1,
    });
  });
});
