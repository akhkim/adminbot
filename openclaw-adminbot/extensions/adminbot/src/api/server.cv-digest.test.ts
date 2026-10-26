import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotCvEntry, AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import type { AdminBotCvScanDeps } from "../cv-scan.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

const running: ReturnType<typeof createAdminBotMockService>[] = [];

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

async function startService(options: Parameters<typeof createAdminBotMockService>[0] = {}) {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath: path.join(
      os.tmpdir(),
      `adminbot-cv-digest-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    ),
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
  running.push(mock);
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" };
}

// A scan that always "reads" one entry off whatever CV it is pointed at, so the route can be
// exercised without a network fetch, a python interpreter, or a running model.
function stubScanDeps(entries: AdminBotCvEntry[]): AdminBotCvScanDeps {
  return {
    fetchPdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    extractText: async () => ({ ok: true, text: entries.map((entry) => entry.title).join("\n") }),
    extractEntries: async () => entries,
    now: () => new Date("2026-08-20T09:00:00.000Z"),
  };
}

const MEMBER: AdminBotLabMemberInput = {
  id: "m-jane",
  name: "Jane Doe",
  privilege_level: "member",
  cv_url: "https://example.com/jane.pdf",
};

const RECENT_POSITION: AdminBotCvEntry = {
  kind: "position",
  title: "Research Scientist",
  organization: "NVIDIA",
  start: "2026-07",
  start_iso: "2026-07",
};

// Seeded through the service rather than over HTTP: creating a roster member needs a real admin
// *member* session, which this suite has no reason to stand up just to give the scan something
// with a cv_url to read.
function seedMember(
  mock: ReturnType<typeof createAdminBotMockService>,
  member: AdminBotLabMemberInput = MEMBER,
) {
  const result = mock.service.upsertLabMember(withCompleteProfile(member));
  expect(result.ok).toBe(true);
}

describe("POST /cv/publish-digest", () => {
  it("refuses an unauthenticated caller", async () => {
    const { baseUrl } = await startService();
    const response = await fetch(`${baseUrl}/cv/publish-digest`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  // The document id is deploy config, so a service without one has no job at all rather than a
  // button that fails inside the gog CLI.
  it("answers 503 naming the variable when no document is configured", async () => {
    const { baseUrl } = await startService({ cvScanDeps: stubScanDeps([RECENT_POSITION]) });
    const response = await fetch(`${baseUrl}/cv/publish-digest`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("ADMINBOT_CV_DIGEST_DOC_ID");
  });

  it("scans, publishes the rendered document, and reports what it wrote", async () => {
    const publish = vi.fn(async () => {});
    const { baseUrl, mock } = await startService({
      cvScanDeps: stubScanDeps([RECENT_POSITION]),
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish },
    });
    seedMember(mock);

    const response = await fetch(`${baseUrl}/cv/publish-digest`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      document_url: string;
      day_count: number;
      change_count: number;
    };
    expect(body.document_url).toBe("https://docs.example/doc");
    expect(body.change_count).toBe(1);
    expect(body.day_count).toBe(1);

    expect(publish).toHaveBeenCalledTimes(1);
    const markdown = publish.mock.calls[0]?.[0] as unknown as string;
    expect(markdown).toContain("# CV Updates");
    expect(markdown).toContain("Jane Doe");
    expect(markdown).toContain("NVIDIA");
  });

  // The whole reason the document renders from the ledger rather than from the scan: a scan
  // consumes its own diff, so the second run finds nothing and a scan-shaped document would go
  // blank. The published body must still carry the change the first run recorded.
  it("keeps publishing earlier changes when a later scan finds nothing new", async () => {
    const publish = vi.fn(async () => {});
    const { baseUrl, mock } = await startService({
      cvScanDeps: stubScanDeps([RECENT_POSITION]),
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish },
    });
    seedMember(mock);

    await fetch(`${baseUrl}/cv/publish-digest`, { method: "POST", headers: headers() });
    const second = await fetch(`${baseUrl}/cv/publish-digest`, {
      method: "POST",
      headers: headers(),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { change_count: number };
    expect(body.change_count).toBe(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0] as unknown as string).toContain("NVIDIA");
  });

  it("reports a failed write as a 500 and does not claim the document changed", async () => {
    const publish = vi.fn(async () => {
      throw new Error("gog exited with code 1");
    });
    const { baseUrl, mock } = await startService({
      cvScanDeps: stubScanDeps([RECENT_POSITION]),
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish },
    });
    seedMember(mock);

    const response = await fetch(`${baseUrl}/cv/publish-digest`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("gog exited with code 1");

    const audit = await fetch(`${baseUrl}/audit`, { headers: headers() });
    const events = (await audit.json()) as { events: Array<{ type: string }> };
    expect(events.events.some((event) => event.type === "cv.digest_failed")).toBe(true);
    expect(events.events.some((event) => event.type === "cv.digest_published")).toBe(false);
  });

  it("records who published, and what, on the audit ledger", async () => {
    const { baseUrl, mock } = await startService({
      cvScanDeps: stubScanDeps([RECENT_POSITION]),
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish: async () => {} },
    });
    seedMember(mock);
    await fetch(`${baseUrl}/cv/publish-digest`, { method: "POST", headers: headers() });

    const audit = await fetch(`${baseUrl}/audit`, { headers: headers() });
    const events = (await audit.json()) as {
      events: Array<{ type: string; actor?: string; details?: Record<string, unknown> }>;
    };
    const published = events.events.find((event) => event.type === "cv.digest_published");
    expect(published).toBeDefined();
    expect(published?.details?.document_url).toBe("https://docs.example/doc");
    expect(published?.details?.change_count).toBe(1);
  });
});

describe("daily CV sweep", () => {
  it("scans once a day and refreshes the doc only when something new appeared", async () => {
    const publish = vi.fn(async () => {});
    const extractEntries = vi.fn(async () => [RECENT_POSITION]);
    const { mock } = await startService({
      cvScanDeps: { ...stubScanDeps([RECENT_POSITION]), extractEntries },
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish },
    });
    seedMember(mock);

    const day1 = new Date("2026-08-20T09:00:00.000Z");
    expect(await mock.runCvSweep(day1)).toEqual({
      status: "done",
      changed_members: 1,
      published: true,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toContain("NVIDIA");

    // An hour later the sweep is not due, so nothing is fetched at all.
    expect(await mock.runCvSweep(new Date("2026-08-20T10:00:00.000Z"))).toEqual({
      status: "skipped",
      reason: "not_due",
    });

    // A day later the CV is unchanged: the hash match skips the model and the doc is left alone.
    expect(await mock.runCvSweep(new Date("2026-08-21T09:00:00.000Z"))).toEqual({
      status: "done",
      changed_members: 0,
      published: false,
    });
    expect(extractEntries).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("puts this year's invited talks on the doc and retries a write that failed", async () => {
    const invited: AdminBotCvEntry = {
      kind: "talk",
      title: "Probing refusals",
      organization: "Stanford NLP Seminar",
      start: "2026",
      invited: true,
    };
    const publish = vi
      .fn<(markdown: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("gog keyring locked"))
      .mockResolvedValue(undefined);
    const { baseUrl, mock } = await startService({
      cvScanDeps: stubScanDeps([invited]),
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish },
    });
    seedMember(mock);

    // Day one: the write fails, so nothing counts as published.
    expect(await mock.runCvSweep(new Date("2026-08-20T09:00:00.000Z"))).toMatchObject({
      published: false,
    });
    // Day two: the CV is unchanged and the ledger did not grow, but the doc never went out, so
    // it is written now.
    expect(await mock.runCvSweep(new Date("2026-08-21T09:00:00.000Z"))).toEqual({
      status: "done",
      changed_members: 0,
      published: true,
    });
    expect(publish.mock.calls[1]?.[0]).toContain("- #1 **Jane Doe** — 1 talk (1 invited)");
    // Day three: same content as what went out, so it is left alone.
    expect(await mock.runCvSweep(new Date("2026-08-22T09:00:00.000Z"))).toMatchObject({
      published: false,
    });
    expect(publish).toHaveBeenCalledTimes(2);

    const response = await fetch(`${baseUrl}/cv/talk-leaderboard?year=2026`, {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      year: 2026,
      rows: [
        { rank: 1, member_id: "m-jane", member_name: "Jane Doe", invited: 1, orals: 0, total: 1 },
      ],
      unscanned: [],
      sweep: {
        state: "idle",
        last_completed_at: "2026-08-22T09:00:00.000Z",
        last_failed_at: null,
        next_due_at: "2026-08-23T09:00:00.000Z",
      },
    });
    const bad = await fetch(`${baseUrl}/cv/talk-leaderboard?year=26x`, { headers: headers() });
    expect(bad.status).toBe(400);
  });

  it("shows a sweep in progress on the leaderboard, and goes back to idle when it ends", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = stubScanDeps([RECENT_POSITION]);
    const { baseUrl, mock } = await startService({
      cvScanDeps: {
        ...deps,
        extractEntries: async (text) => {
          await gate;
          return deps.extractEntries(text);
        },
      },
    });
    seedMember(mock);
    const sweep = mock.runCvSweep(new Date("2026-08-20T09:00:00.000Z"));
    const during = await fetch(`${baseUrl}/cv/talk-leaderboard?year=2026`, { headers: headers() });
    expect(((await during.json()) as { sweep: unknown }).sweep).toMatchObject({
      state: "reading",
      done: 0,
      total: 1,
      eta_seconds: null,
    });
    release();
    await sweep;
    const after = await fetch(`${baseUrl}/cv/talk-leaderboard?year=2026`, { headers: headers() });
    expect(((await after.json()) as { sweep: unknown }).sweep).toMatchObject({
      state: "idle",
      last_completed_at: "2026-08-20T09:00:00.000Z",
    });
  });

  it("records the scan without a doc when no digest document is configured", async () => {
    const { mock } = await startService({ cvScanDeps: stubScanDeps([RECENT_POSITION]) });
    seedMember(mock);
    expect(await mock.runCvSweep(new Date("2026-08-20T09:00:00.000Z"))).toEqual({
      status: "done",
      changed_members: 1,
      published: false,
    });
    expect(mock.store.listCvChangesSince("1970-01-01T00:00:00.000Z")).toHaveLength(1);
  });

  it("counts each member's outcome and failure reason on the audit log, without names", async () => {
    const { baseUrl, mock } = await startService({
      cvScanDeps: {
        ...stubScanDeps([RECENT_POSITION]),
        fetchPdf: async (url: string) => {
          if (url.includes("private")) {
            throw new Error("cv fetch failed: 403");
          }
          return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        },
      },
    });
    seedMember(mock);
    seedMember(mock, {
      ...MEMBER,
      id: "m-sam",
      name: "Sam Roe",
      cv_url: "https://example.com/private.pdf",
    });
    await mock.runCvSweep(new Date("2026-08-20T09:00:00.000Z"));

    const audit = await fetch(`${baseUrl}/audit`, { headers: headers() });
    const events = (await audit.json()) as {
      events: Array<{ type: string; details?: Record<string, unknown> }>;
    };
    const completed = events.events.find((event) => event.type === "cv.sweep_completed");
    expect(completed?.details).toMatchObject({
      statuses: { first_scan: 1, failed: 1 },
      failures: { "cv fetch failed: 403": 1 },
    });
    expect(JSON.stringify(completed?.details)).not.toContain("Sam");
  });

  it("records a sweep that crashed and tries again at the next check", async () => {
    const { baseUrl, mock } = await startService({ cvScanDeps: stubScanDeps([RECENT_POSITION]) });
    seedMember(mock);
    const recordChanges = vi.spyOn(mock.store, "recordCvChanges").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    expect(await mock.runCvSweep(new Date("2026-08-20T09:00:00.000Z"))).toEqual({
      status: "failed",
      reason: "database is locked",
    });
    const audit = await fetch(`${baseUrl}/audit`, { headers: headers() });
    const events = (await audit.json()) as {
      events: Array<{ type: string; details?: Record<string, unknown> }>;
    };
    expect(events.events.find((event) => event.type === "cv.sweep_failed")?.details).toEqual({
      reason: "database is locked",
    });

    // A failure is not the day's sweep: an hour later it runs again instead of waiting a day.
    expect(await mock.runCvSweep(new Date("2026-08-20T10:00:00.000Z"))).toMatchObject({
      status: "done",
    });
    expect(recordChanges).toHaveBeenCalledTimes(2);
  });

  it("does nothing when CV scanning is not configured", async () => {
    const { mock } = await startService();
    expect(await mock.runCvSweep()).toEqual({ status: "skipped", reason: "not_configured" });
  });
});

describe("GET /cv/talk-leaderboard", () => {
  // The leaderboard page is open to the whole lab, as the list in the meeting doc was, so a plain
  // member's session has to be enough -- and a visitor's absence of one has to not be.
  it("answers a signed-in member who is not an admin, and refuses a visitor", async () => {
    const { baseUrl, mock } = await startService({
      calendarInviteRunner: async () => {},
      accountApprovedEmailRunner: async () => {},
    });
    seedMember(mock, { ...MEMBER, email: "jane@example.test" });
    const email = "jane@example.test";
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: MEMBER.id, email, password: "correcthorse" }),
    });
    const pending = (await (
      await fetch(`${baseUrl}/auth/registrations?status=pending`, { headers: headers() })
    ).json()) as { registrations: Array<{ id: string; member_id?: string }> };
    const registration = pending.registrations.find((entry) => entry.member_id === MEMBER.id);
    expect(registration).toBeDefined();
    await mock.auth.approveRegistration(registration?.id ?? "", "seed-admin");
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correcthorse" }),
    });
    const token = ((await login.json()) as { session_token: string }).session_token;

    const member = await fetch(`${baseUrl}/cv/talk-leaderboard?year=2026`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({ year: 2026, rows: [], unscanned: ["Jane Doe"] });

    const visitor = await fetch(`${baseUrl}/cv/talk-leaderboard`);
    expect(visitor.status).toBe(401);
  });
});
