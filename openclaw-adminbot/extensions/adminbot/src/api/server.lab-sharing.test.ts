import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "lab-sharing-service-token";
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
  const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN, allowedOrigins: ["http://127.0.0.1:5197"] });
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

const draft = {
  description: "Review synthetic agent traces",
  tags: ["QA"],
  members_needed: 2,
  hours_per_week: 3,
  timeline: "September",
};
describe("Lab Sharing routes", () => {
  it("persists a request, scopes writes, and closes it without contacting anybody", async () => {
    const { mock, baseUrl } = await startLab();
    const member = await memberSession(mock, baseUrl, "member");
    const admin = await memberSession(mock, baseUrl, "admin");
    const url = `${baseUrl}/lab-sharing`;
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status,
    ).toBe(403);
    const save = (headers: Record<string, string>, body: unknown, paper = "paper-1") =>
      fetch(`${url}/requests/${paper}`, { method: "PUT", headers, body: JSON.stringify(body) });
    const first = await save(member, { ...draft, owner_id: "admin", status: "closed" });
    expect(first.status).toBe(200);
    const payload = await first.json();
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests[0]).toMatchObject({ owner_id: "member", status: "open", tags: ["qa"] });
    expect(payload.requests[0]).not.toHaveProperty("authors");
    expect((await save(member, draft)).status).toBe(200);
    expect(mock.store.listHelpRequests()).toHaveLength(1);
    mock.service.upsertPaper({
      id: "other",
      title: "Other project",
      authors: ["Unrelated Author"],
      current_step: "brainstorming",
    });
    expect((await save(member, draft, "other")).status).toBe(403);
    expect((await save(admin, draft, "other")).status).toBe(200);
    const visible = await (await fetch(url, { headers: member })).json();
    expect(
      visible.requests.find((row: { paper_id: string }) => row.paper_id === "other"),
    ).toMatchObject({ can_manage: false });
    expect(
      (await fetch(`${url}/requests/other/close`, { method: "POST", headers: admin })).status,
    ).toBe(200);
    const closed = await (await fetch(url, { headers: member })).json();
    expect(closed.requests.some((row: { paper_id: string }) => row.paper_id === "other")).toBe(
      false,
    );

    expect(
      (await fetch(`${url}/requests/other/close`, { method: "POST", headers: member })).status,
    ).toBe(403);
    expect((await save(member, { ...draft, members_needed: 0 })).status).toBe(400);
    expect((await save(member, { ...draft, tags: [23] })).status).toBe(400);
    expect((await save(member, { ...draft, description: " " })).status).toBe(400);
    expect((await save(member, draft, "missing")).status).toBe(404);
    expect(
      (await fetch(`${url}/requests/paper-1/close`, { method: "POST", headers: member })).status,
    ).toBe(200);
    expect(mock.store.listHelpRequests().find((row) => row.paper_id === "paper-1")?.status).toBe(
      "closed",
    );
    const audit = mock.store.listAuditEvents();
    expect(audit.some((row) => row.type === "lab_help.saved" && row.actor === "member")).toBe(true);
  });
  it("authenticates offers, bounds input, protects private responses and allows own withdrawal", async () => {
    const { mock, baseUrl } = await startLab();
    const member = await memberSession(mock, baseUrl, "member");
    const admin = await memberSession(mock, baseUrl, "admin");
    mock.service.upsertPaper({
      id: "offers",
      title: "Synthetic recruitment",
      authors: ["Ada Admin"],
      current_step: "brainstorming",
    });
    mock.service.labSharing().save("admin", "offers", draft);
    const root = `${baseUrl}/lab-sharing`;
    const url = `${root}/requests/offers/interest`;
    const put = (headers: Record<string, string>, body: unknown) =>
      fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
    expect((await put({}, { hours_per_week: 2 })).status).toBe(401);
    expect(
      (await put({ Authorization: `Bearer ${SERVICE_TOKEN}` }, { hours_per_week: 2 })).status,
    ).toBe(403);
    expect((await put(admin, { hours_per_week: 2 })).status).toBe(403);
    expect((await put(member, { hours_per_week: 0 })).status).toBe(400);
    expect((await put(member, { hours_per_week: 2, note: "x".repeat(5000) })).status).toBe(413);
    expect((await fetch(url, { method: "PUT", headers: member, body: "{" })).status).toBe(400);
    const saved = await put(member, {
      hours_per_week: 2,
      note: "Private synthetic offer",
      member_id: "admin",
      status: "withdrawn",
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).interests[0]).toMatchObject({
      member_id: "member",
      status: "active",
    });
    const managed = await (await fetch(root, { headers: admin })).json();
    expect(managed.interests[0].note).toBe("Private synthetic offer");
    expect(
      (
        await fetch(`${url}/withdraw`, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ member_id: "member" }),
        })
      ).status,
    ).toBe(404);
    expect(mock.store.listHelpInterests()[0].status).toBe("active");
    mock.service.labSharing().save("admin", "offers", {}, true);
    expect((await put(member, { hours_per_week: 3 })).status).toBe(409);
    expect((await fetch(`${url}/withdraw`, { method: "POST", headers: member })).status).toBe(200);
    expect(mock.store.listHelpInterests()).toHaveLength(1);
    expect(mock.store.listHelpInterests()[0].status).toBe("withdrawn");
    expect((await (await fetch(root, { headers: admin })).json()).interests).toEqual([]);
    const audit = mock.store
      .listAuditEvents()
      .filter((event) => event.type.startsWith("lab_interest."));
    expect(audit.map((event) => event.type)).toEqual(
      expect.arrayContaining(["lab_interest.saved", "lab_interest.withdrawn"]),
    );
    expect(audit.every((event) => event.actor === "member")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("Private synthetic offer");
  });
  it("serves a narrow member search only to authenticated members", async () => {
    const { mock, baseUrl } = await startLab();
    const member = await memberSession(mock, baseUrl, "member");
    const admin = await memberSession(mock, baseUrl, "admin");
    const url = `${baseUrl}/lab-sharing/members`;
    expect((await fetch(`${url}?q=mina`)).status).toBe(401);
    expect(
      (await fetch(`${url}?q=mina`, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } }))
        .status,
    ).toBe(403);
    for (const headers of [member, admin]) {
      const response = await fetch(`${url}?q=%20MINA%20`, { headers });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.members).toHaveLength(1);
      expect(Object.keys(data.members[0]).sort()).toEqual([
        "id",
        "matched_fields",
        "name",
        "projects",
        "research_branch",
        "research_topics",
      ]);
      expect(JSON.stringify(data)).not.toContain("member@lab.test");
      expect(data.members[0].matched_fields).toContain("name");
    }
    expect((await (await fetch(url, { headers: member })).json()).members).toEqual([]);
    expect((await fetch(`${url}?q=${"x".repeat(101)}`, { headers: member })).status).toBe(400);
    expect((await (await fetch(`${url}?q=reliable`, { headers: member })).json()).members).toEqual(
      [],
    );
    mock.service.labSharing().save("member", "paper-1", draft);
    const open = await (await fetch(`${url}?q=reliable`, { headers: member })).json();
    expect(open.members[0].projects).toEqual([
      { id: "paper-1", title: "Reliable Research Agents" },
    ]);
    mock.service.labSharing().save("member", "paper-1", {}, true);
    expect((await (await fetch(`${url}?q=reliable`, { headers: member })).json()).members).toEqual(
      [],
    );
    expect((await fetch(url, { method: "POST", headers: member })).status).toBe(404);
  });
});

it("gates director status and supports publish/read/clear with bounded JSON", async () => {
  const { mock, baseUrl } = await startLab();
  const admin = await memberSession(mock, baseUrl, "admin");
  const member = await memberSession(mock, baseUrl, "member");
  const url = `${baseUrl}/lab-sharing/status`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status).toBe(
    403,
  );
  const body = JSON.stringify({
    availability: "busy",
    message: "Synthetic review",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    updated_by: "spoof",
  });
  expect((await fetch(url, { method: "PUT", headers: member, body })).status).toBe(403);
  expect((await fetch(url, { method: "PUT", headers: admin, body: "{" })).status).toBe(400);
  expect((await fetch(url, { method: "PUT", headers: admin, body: "x".repeat(4097) })).status).toBe(
    413,
  );
  expect((await fetch(url, { method: "PUT", headers: admin, body })).status).toBe(200);
  expect(await (await fetch(url, { headers: member })).json()).toMatchObject({
    status: { message: "Synthetic review", updated_by: "admin" },
    can_manage: false,
  });
  expect((await fetch(`${url}/clear`, { method: "POST", headers: member })).status).toBe(403);
  expect((await fetch(`${url}/clear`, { method: "POST", headers: admin })).status).toBe(200);
  expect(await (await fetch(url, { headers: member })).json()).toMatchObject({ status: null });
});

it("gates member guidebook questions and validates bounded input", async () => {
  const { mock, baseUrl } = await startLab();
  const url = `${baseUrl}/lab-sharing/ask`;
  expect((await fetch(url, { method: "POST" })).status).toBe(401);
  expect(
    (await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } }))
      .status,
  ).toBe(403);
  const headers = await memberSession(mock, baseUrl, "member");
  expect(
    (await fetch(url, { method: "POST", headers, body: JSON.stringify({ question: " " }) })).status,
  ).toBe(400);
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ question: "x".repeat(1001) }),
      })
    ).status,
  ).toBe(400);
  expect((await fetch(url, { method: "POST", headers, body: "{" })).status).toBe(400);
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ question: "x".repeat(5000) }),
      })
    ).status,
  ).toBe(413);
});

it("creates deduplicated approval-bound invitations without disclosing contacts", async () => {
  const { mock, baseUrl } = await startLab();
  const headers = await memberSession(mock, baseUrl, "member");
  const adminHeaders = await memberSession(mock, baseUrl, "admin");
  mock.service.labSharing().save("member", "paper-1", draft, false);
  const url = `${baseUrl}/lab-sharing/invites`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status).toBe(
    403,
  );
  mock.service.upsertLabMember({
    id: "observer",
    name: "Observer",
    email: "observer@lab.test",
    privilege_level: "member",
  });
  expect(
    mock.service.labSharingInvites().request("observer", {
      paper_id: "paper-1",
      recipient_id: "admin",
      kind: "collaboration",
      note: "Unauthorized",
    }),
  ).toMatchObject({ ok: false, status: 403 });
  const input = {
    paper_id: "paper-1",
    recipient_id: "admin",
    kind: "collaboration",
    note: "Review synthetic traces",
    actor_id: "spoofed",
    to: "outsider@invalid.test",
  };
  const send = (body: unknown) =>
    fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const first = await (await send(input)).json();
  expect(first.status).toBe("pending");
  expect(await (await send(input)).json()).toEqual(first);
  const stored = mock.store.listProposalsByType("email.send").find((row) => row.id === first.id)!;
  expect(stored.proposed_payload).toMatchObject({
    to: "admin@lab.test",
    reply_to: "member@lab.test",
  });
  expect(stored.target).toMatchObject({ actor_id: "member" });
  expect(stored.approvals).toEqual([]);
  expect(await mock.service.execute(stored.id, { dry_run: true })).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(
    mock.service.approve(stored.id, { payload_hash: "wrong", approver_role: "admin" }),
  ).toMatchObject({ ok: false, status: 409 });
  const own = await (await fetch(url, { headers })).json();
  expect(own.invites).toHaveLength(1);
  expect(JSON.stringify(own)).not.toContain("@lab.test");
  expect((await (await fetch(url, { headers: adminHeaders })).json()).invites).toEqual([]);
  expect((await send({ ...input, paper_id: "missing" })).status).toBe(403);
  expect((await send({ ...input, recipient_id: "member" })).status).toBe(400);
  expect((await send({ ...input, kind: "call", start: "bad", end: "bad" })).status).toBe(400);
  const call = await (
    await send({
      ...input,
      kind: "call",
      start: "2099-01-01T10:00:00Z",
      end: "2099-01-01T11:00:00Z",
    })
  ).json();
  expect(call.status).toBe("pending");
  expect(
    mock.store.listProposalsByType("calendar.send_invite").find((row) => row.id === call.id)
      ?.proposed_payload,
  ).toMatchObject({ attendees: ["member@lab.test", "admin@lab.test"], timezone: "UTC" });
  mock.service.labSharing().save("member", "paper-1", {}, true);
  expect((await send(input)).status).toBe(409);
});

it("gates discovery and rejects malformed pagination without exposing private offers", async () => {
  const { mock, baseUrl } = await startLab();
  const url = `${baseUrl}/lab-sharing/discover`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status).toBe(
    403,
  );
  const headers = await memberSession(mock, baseUrl, "member");
  mock.service.labSharing().save("member", "paper-1", draft);
  const response = await fetch(`${url}?limit=1`, { headers });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.requests).toHaveLength(1);
  expect(body.next_cursor).toBeNull();
  expect(body.interests).toBeUndefined();
  for (const query of ["limit=51", "cursor=bad", "cursor=a&cursor=b"]) {
    expect((await fetch(`${url}?${query}`, { headers })).status).toBe(400);
  }
  mock.service.labSharing().save("member", "paper-1", {}, true);
  expect((await (await fetch(url, { headers })).json()).requests).toEqual([]);
});

it("scopes direct project lookup and hides closed requests from non-managers", async () => {
  const { mock, baseUrl } = await startLab();
  const headers = await memberSession(mock, baseUrl, "member");
  const admin = await memberSession(mock, baseUrl, "admin");
  mock.service.upsertPaper({
    id: "admin-project",
    title: "Admin project",
    authors: ["Ada Admin"],
    first_author_member_id: "admin",
    current_step: "brainstorming",
  });
  mock.service.labSharing().save("admin", "admin-project", draft);
  const url = `${baseUrl}/lab-sharing/projects/admin-project`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status).toBe(
    403,
  );
  expect((await fetch(url, { headers })).status).toBe(200);
  expect((await fetch(`${baseUrl}/lab-sharing/projects/missing`, { headers })).status).toBe(404);
  mock.service.labSharing().save("admin", "admin-project", {}, true);
  expect((await fetch(url, { headers: admin })).status).toBe(200);
  expect((await fetch(url, { headers })).status).toBe(404);
  expect((await fetch(`${baseUrl}/lab-sharing/projects/%ZZ`, { headers })).status).toBe(400);
});

it("preserves management flags across discovery pages and rejects changed cursor filters", async () => {
  const { mock, baseUrl } = await startLab();
  const headers = await memberSession(mock, baseUrl, "member");
  mock.service.labSharing().save("member", "paper-1", draft);
  mock.service.upsertPaper({
    id: "admin-page",
    title: "AAA",
    authors: ["Ada Admin"],
    first_author_member_id: "admin",
    current_step: "brainstorming",
  });
  mock.service.labSharing().save("admin", "admin-page", draft);
  const url = `${baseUrl}/lab-sharing/discover?limit=1`;
  const first = await (await fetch(url, { headers })).json();
  expect(first.requests).toHaveLength(1);
  expect(first.requests[0].paper_id).toBe("admin-page");
  expect(first.requests[0].can_manage).toBe(false);
  expect(typeof first.next_cursor).toBe("string");
  const continuation = `${url}&cursor=${encodeURIComponent(first.next_cursor)}`;
  const second = await (await fetch(continuation, { headers })).json();
  expect(second.requests[0].paper_id).toBe("paper-1");
  expect(second.requests[0].can_manage).toBe(true);
  expect(second.next_cursor).toBeNull();
  expect((await fetch(`${continuation}&sort=hours`, { headers })).status).toBe(400);
});

it("separates managed requests from discovery while retaining private offers", async () => {
  const { mock, baseUrl } = await startLab();
  const headers = await memberSession(mock, baseUrl, "member");
  mock.service.labSharing().save("member", "paper-1", draft);
  mock.service.upsertPaper({
    id: "other",
    title: "Other",
    authors: ["Ada Admin"],
    first_author_member_id: "admin",
    current_step: "brainstorming",
  });
  mock.service.labSharing().save("admin", "other", draft);
  mock.service
    .labSharing()
    .interest("member", "other", { hours_per_week: 2, note: "My private offer" });
  const url = `${baseUrl}/lab-sharing/mine`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } })).status).toBe(
    403,
  );
  const result = await (await fetch(url, { headers })).json();
  expect(result.requests.map((row: { paper_id: string }) => row.paper_id)).toEqual(["paper-1"]);
  expect(result.interests[0].note).toBe("My private offer");
  expect(result.projects.map((row: { id: string }) => row.id)).toEqual(["paper-1"]);
  mock.service.labSharing().save("member", "paper-1", {}, true);
  const closed = await (await fetch(url, { headers })).json();
  expect(closed.requests[0].status).toBe("closed");
});

it("supports compact mutation responses without changing legacy responses", async () => {
  const { mock, baseUrl } = await startLab();
  const headers = await memberSession(mock, baseUrl, "member");
  const url = `${baseUrl}/lab-sharing/requests/paper-1`;
  const compact = await fetch(url, {
    method: "PUT",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(draft),
  });
  expect(await compact.json()).toEqual({ saved: true });
  expect(mock.store.getHelpRequest("paper-1")?.description).toBe(draft.description);
  const close = await fetch(`${url}/close`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: "{}",
  });
  expect(await close.json()).toEqual({ saved: true });
  const legacy = await fetch(url, { method: "PUT", headers, body: JSON.stringify(draft) });
  expect((await legacy.json()).requests).toHaveLength(1);
});

it("allows compact-response preference in an allowed-origin preflight",async()=>{
 const {baseUrl}=await startLab();
 const response=await fetch(`${baseUrl}/lab-sharing/requests/paper-1`,{method:"OPTIONS",headers:{Origin:"http://127.0.0.1:5197","Access-Control-Request-Method":"PUT","Access-Control-Request-Headers":"authorization,content-type,prefer"}});
 expect(response.headers.get("access-control-allow-headers")).toContain("Prefer");
});

  // The broadcast archive, end to end: admin publishes, every member reads back the history.
  it("keeps a broadcast archive that members can read and only admins can add to", async () => {
    const { mock, baseUrl } = await startLab();
    const member = await memberSession(mock, baseUrl, "member");
    const admin = await memberSession(mock, baseUrl, "admin");
    const url = `${baseUrl}/lab-sharing/status`;
    const publish = (headers: Record<string, string>, message: string) =>
      fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          availability: "away",
          message,
          expires_at: "2099-01-01T00:00:00Z",
        }),
      });

    // Publishing is admin-only; reading is not, because a broadcast is addressed to everybody.
    expect((await publish(member, "Members cannot broadcast")).status).toBe(403);
    expect((await publish(admin, "First broadcast")).status).toBe(200);
    expect((await publish(admin, "Second broadcast")).status).toBe(200);

    const seen = await fetch(url, { headers: member });
    expect(seen.status).toBe(200);
    const payload = (await seen.json()) as {
      status: { message: string } | null;
      history: Array<{ message: string; id?: string }>;
      can_manage: boolean;
    };
    expect(payload.status?.message).toBe("Second broadcast");
    // The first one survives the second, which the single-row table it replaced could not do.
    expect(payload.history.map((row) => row.message)).toEqual([
      "Second broadcast",
      "First broadcast",
    ]);
    expect(payload.can_manage).toBe(false);

    // Clearing takes the current one down without emptying the record of it.
    expect(
      (await fetch(`${url}/clear`, { method: "POST", headers: admin })).status,
    ).toBe(200);
    const after = (await (await fetch(url, { headers: admin })).json()) as {
      status: unknown;
      history: unknown[];
    };
    expect(after.status).toBeNull();
    expect(after.history).toHaveLength(2);
  });
