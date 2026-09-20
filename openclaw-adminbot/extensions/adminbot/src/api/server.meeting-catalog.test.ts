// The meeting catalog over real HTTP: who may read the list, and who may rebuild it.
//
// The gate is the point. Every other calendar route is admin-only because it reaches Google, and
// this pair deliberately splits that in two -- the *read* is served from the stored catalog and is
// open to any signed-in member, because the Profile page's meeting picker is a member's page, and
// only the refresh needs the calendar and the privilege that comes with it.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const PASSWORD = "correcthorse";
const SERIES = "f4d1qkcntmet3g8033kbugn40q";

// What a real read returns, calendar id and all: two occurrences of one weekly theme meeting, one
// project meeting, and an ordinary event that is neither.
const CALENDAR = "lab@example.com";
const EVENTS = [
  {
    id: `${SERIES}_20260923T130000Z`,
    summary: "Theme: Causal Inference",
    start: "2026-09-23T13:00:00Z",
    calendar_id: CALENDAR,
  },
  {
    id: `${SERIES}_20260930T130000Z`,
    summary: "Theme: Causal Inference",
    start: "2026-09-30T13:00:00Z",
    calendar_id: CALENDAR,
  },
  {
    id: "proj-law",
    summary: "Proj: Law to Benchmark",
    start: "2026-09-25T15:00:00Z",
    calendar_id: CALENDAR,
  },
  { id: "lunch", summary: "Lab lunch", start: "2026-09-24T12:00:00Z", calendar_id: CALENDAR },
];

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

type Lab = { baseUrl: string; tokens: Record<string, string> };

async function startLab(options: { calendarFails?: boolean } = {}): Promise<Lab> {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-meeting-catalog-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
    calendarEventsReader: async () => {
      if (options.calendarFails) {
        throw new Error("gog is not authenticated");
      }
      return EVENTS;
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  running.push({ mock, cleanup: sensitiveInfoPath });

  const tokens: Record<string, string> = {};
  for (const [id, privilege] of [
    ["ada", "member"],
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

const asMember = (lab: Lab, id: string) => ({
  Authorization: `Bearer ${lab.tokens[id]}`,
});

const refresh = (lab: Lab, id: string) =>
  fetch(`${lab.baseUrl}/meetings/catalog/run`, {
    method: "POST",
    headers: asMember(lab, id),
  });

const read = async (lab: Lab, id: string) => {
  const res = await fetch(`${lab.baseUrl}/meetings/catalog`, {
    headers: asMember(lab, id),
  });
  return {
    status: res.status,
    body: (await res.json()) as { meetings?: unknown[] },
  };
};

describe("POST /meetings/catalog/run", () => {
  it("refuses a plain member", async () => {
    const lab = await startLab();
    expect((await refresh(lab, "ada")).status).toBe(403);
  });

  it("builds one entry per meeting from the calendar, dropping everything else", async () => {
    const lab = await startLab();
    const res = await refresh(lab, "zhijing");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meetings: Array<{ topic: string; event_id: string }>;
    };
    expect(body.meetings.map((entry) => entry.topic)).toEqual([
      "Causal Inference",
      "Law to Benchmark",
    ]);
    // The recurring Wednesday collapses onto its series, which is what an invite has to name.
    expect(body.meetings[0]?.event_id).toBe(SERIES);
  });

  it("answers 502 when the calendar cannot be read, rather than reporting an empty lab", async () => {
    // The whole reason the service refuses an empty read: a broken `gog` and a lab that cancelled
    // every meeting look identical from here, and only one of them should empty the picker.
    const lab = await startLab({ calendarFails: true });
    const res = await refresh(lab, "zhijing");
    expect(res.status).toBe(502);
    expect((await read(lab, "zhijing")).body.meetings).toEqual([]);
  });
});

describe("GET /meetings/catalog", () => {
  it("serves the list to a plain member, by name and never by event id", async () => {
    const lab = await startLab();
    await refresh(lab, "zhijing");
    const { status, body } = await read(lab, "ada");
    expect(status).toBe(200);
    expect(body.meetings).toEqual([
      {
        topic: "Causal Inference",
        summary: "Theme: Causal Inference",
        family: "theme",
        starts_at: "2026-09-23T13:00:00Z",
      },
      {
        topic: "Law to Benchmark",
        summary: "Proj: Law to Benchmark",
        family: "project",
        starts_at: "2026-09-25T15:00:00Z",
      },
    ]);
  });

  it("refuses an anonymous caller", async () => {
    const lab = await startLab();
    const res = await fetch(`${lab.baseUrl}/meetings/catalog`);
    expect(res.status).toBe(401);
  });
});
