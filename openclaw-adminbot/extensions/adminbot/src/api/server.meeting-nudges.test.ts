// The attendance-nudge and notification routes over real HTTP: who the wire lets in.
//
// A sibling of server.test.ts rather than more of it -- that file is already the longest test in
// the extension. These four routes split cleanly in two: the nudge pair is governance (it names
// people and sends Slack DMs), and the notification pair is strictly own-scope, so what is worth
// asserting here is the gate rather than the payload, which the service tests already cover.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const PASSWORD = "correcthorse";

const running: {
  mock: ReturnType<typeof createAdminBotMockService>;
  cleanup: string;
}[] = [];

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
    await rm(entry.cleanup, { force: true });
  }
});

type Lab = {
  baseUrl: string;
  /** Session tokens, by member id. */
  tokens: Record<string, string>;
};

async function startLab(): Promise<Lab> {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-meeting-nudge-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  running.push({ mock, cleanup: sensitiveInfoPath });

  const tokens: Record<string, string> = {};
  for (const [id, privilege] of [
    ["ada", "member"],
    ["grace", "member"],
    ["zhijing", "admin"],
  ] as const) {
    const seeded = mock.service.upsertLabMember({
      id,
      name: id,
      email: `${id}@cs.toronto.edu`,
      privilege_level: privilege,
    });
    if (!seeded.ok) {
      throw new Error(seeded.error.message);
    }
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member_id: id,
        email: `${id}@cs.toronto.edu`,
        password: PASSWORD,
      }),
    });
    const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const registrations = (
      (await pending.json()) as {
        registrations: { id: string; member_id?: string }[];
      }
    ).registrations;
    const claim = registrations.find((entry) => entry.member_id === id);
    if (!claim) {
      throw new Error(`no pending claim for ${id}`);
    }
    const approved = mock.auth.approveRegistration(claim.id, "test-admin");
    if (!approved.ok) {
      throw new Error(approved.error.message);
    }
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `${id}@cs.toronto.edu`,
        password: PASSWORD,
      }),
    });
    tokens[id] = ((await login.json()) as { session_token: string }).session_token;
  }
  return { baseUrl, tokens };
}

function asMember(lab: Lab, memberId: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${lab.tokens[memberId]}`, ...extra };
}

describe("GET/POST /meetings/attendance-nudges", () => {
  it("refuses a plain member on both verbs", async () => {
    const lab = await startLab();
    const preview = await fetch(`${lab.baseUrl}/meetings/attendance-nudges`, {
      headers: asMember(lab, "ada"),
    });
    expect(preview.status).toBe(403);
    const send = await fetch(`${lab.baseUrl}/meetings/attendance-nudges`, {
      method: "POST",
      headers: asMember(lab, "ada"),
    });
    expect(send.status).toBe(403);
  });

  it("previews for an admin, with the calendar unresolved on a box with no gog", async () => {
    const lab = await startLab();
    const res = await fetch(`${lab.baseUrl}/meetings/attendance-nudges`, {
      headers: asMember(lab, "zhijing"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      streak: number;
      absent: unknown[];
      invite_resolved: boolean;
    };
    expect(body.streak).toBe(2);
    // No meetings have been filed, so nobody can have missed two -- and a calendar read that
    // cannot happen narrows the audience rather than failing the route.
    expect(body.absent).toEqual([]);
    expect(body.invite_resolved).toBe(false);
  });

  it("does not answer other verbs", async () => {
    const lab = await startLab();
    const res = await fetch(`${lab.baseUrl}/meetings/attendance-nudges`, {
      method: "DELETE",
      headers: asMember(lab, "zhijing"),
    });
    expect(res.status).toBe(405);
  });
});

describe("/notifications", () => {
  it("is the caller's own, with no way to name somebody else", async () => {
    const lab = await startLab();
    const res = await fetch(`${lab.baseUrl}/notifications?member_id=grace`, {
      headers: asMember(lab, "ada"),
    });
    expect(res.status).toBe(200);
    // The member id comes from the session, so the query parameter is simply ignored.
    expect((await res.json()) as { notifications: unknown[] }).toEqual({ notifications: [] });
  });

  it("refuses the shared service principal, which is nobody in particular", async () => {
    const lab = await startLab();
    const res = await fetch(`${lab.baseUrl}/notifications`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("takes a read with no ids as 'all of mine'", async () => {
    const lab = await startLab();
    const res = await fetch(`${lab.baseUrl}/notifications/read`, {
      method: "POST",
      headers: asMember(lab, "ada", { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { read: number }).toEqual({ read: 0 });
  });
});
