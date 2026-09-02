import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";
import {
  cancelWorkshopNudgeRun,
  readWorkshopNudgeRun,
  startWorkshopNudgeRun,
  WORKSHOP_RUN_STALLED_MESSAGE,
  workshopRunIsAbandoned,
} from "./server.workshop-nudges.js";

const SERVICE_TOKEN = "test-service-token";
const running: Array<{
  mock: ReturnType<typeof createAdminBotMockService>;
  sensitiveInfoPath: string;
}> = [];

afterEach(async () => {
  while (running.length) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    await rm(entry.sensitiveInfoPath, { force: true });
  }
});

async function startService(executed: AdminBotStoredProposal[] = []) {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-workshop-nudges-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    // Stands in for the model: the first collected workshop takes every seeded paper, which is
    // all these tests need -- what is under test is the HTTP gate and the recompute, not matching.
    workshopMatcher: vi.fn(async ({ papers, workshops }) =>
      papers.map((paper) => ({
        workshop_id: (workshops[0] as { workshop_id: string }).workshop_id,
        paper_id: paper.paper_id,
        relevance: 0.9,
        reason: "The call covers this paper's topic.",
      })),
    ),
    workshopNudgeNow: () => new Date("2026-08-25T00:00:00Z"),
    executor: {
      execute: async (proposal) => {
        executed.push(proposal);
        return { handled: proposal.type === "member_nudge.send" };
      },
    },
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
  running.push({ mock, sensitiveInfoPath });
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

async function adminHeaders(baseUrl: string, mock: ReturnType<typeof createAdminBotMockService>) {
  seedMember(mock, {
    id: "admin-1",
    name: "Ada Admin",
    email: "ada@cs.toronto.edu",
    privilege_level: "admin",
  });
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      member_id: "admin-1",
      email: "ada@cs.toronto.edu",
      password: "correcthorse",
    }),
  });
  const pending = (
    (await (
      await fetch(`${baseUrl}/auth/registrations?status=pending`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
      })
    ).json()) as { registrations: Array<{ id: string; member_id?: string }> }
  ).registrations.find((entry) => entry.member_id === "admin-1");
  if (!pending) {
    throw new Error("missing pending admin claim");
  }
  const approved = mock.auth.approveRegistration(pending.id, "test-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ada@cs.toronto.edu", password: "correcthorse" }),
  });
  const token = ((await login.json()) as { session_token: string }).session_token;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function seedMember(
  mock: ReturnType<typeof createAdminBotMockService>,
  member: Parameters<typeof mock.service.upsertLabMember>[0],
) {
  // On the nudge list unless the case overrides it: these fixtures exist to receive nudges.
  const result = mock.service.upsertLabMember({ receives_nudges: true, ...member });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

function seedPaper(
  mock: ReturnType<typeof createAdminBotMockService>,
  title = "Meta agents for reliable science",
) {
  const result = mock.service.upsertPaper({
    id: "paper-1",
    title,
    authors: ["Mira Member"],
    author_links: [{ name: "Mira Member", member_id: "member-1" }],
    current_step: "submission",
    notes: "Year: 2025\nTopic: meta agents, evaluation, reliable science",
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

/**
 * Start a pass and wait for the stored answer.
 *
 * Two steps now, because the match no longer happens inside the request that asks for it: a pass
 * is thousands of model calls, so Refresh starts it and the preview reads whatever the last pass
 * left behind. The tests use a stub matcher, so the wait is short -- but it is a real wait, and
 * polling here is what the page does too.
 */
async function runAndRead(baseUrl: string, headers: Record<string, string>) {
  const started = await fetch(`${baseUrl}/workshop-nudges/refresh`, {
    method: "POST",
    headers,
    body: "{}",
  });
  if (started.status !== 202) {
    return started;
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const read = await fetch(`${baseUrl}/workshop-nudges/preview`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const body = (await read.clone().json()) as { status?: string };
    if (body.status === "ready" || body.status === "failed") {
      return read;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the pass never finished");
}

describe("workshop nudge HTTP flow", () => {
  it("previews current native papers and exact messages for an administrator", async () => {
    const { baseUrl, mock } = await startService();
    const headers = await adminHeaders(baseUrl, mock);
    seedMember(mock, {
      id: "member-1",
      name: "Mira Member",
      email: "mira@cs.toronto.edu",
      slack_user_id: "U-MIRA",
      privilege_level: "member",
      status: "active",
    });
    seedPaper(mock);

    const response = await runAndRead(baseUrl, headers);
    expect(response.status).toBe(200);
    // The payload is what the last pass produced, wrapped in the run that produced it.
    const run = (await response.json()) as {
      status: string;
      preview: {
        paper_count: number;
        recipients: Array<{
          recipient_member_id: string;
          delivery_ready: boolean;
          draft: { text: string } | null;
        }>;
        coverage: { members_without_usable_papers: Array<{ member_id: string }> };
      };
    };
    expect(run.status).toBe("ready");
    const body = run.preview;
    expect(body.paper_count).toBe(1);
    expect(body.recipients).toEqual([
      expect.objectContaining({
        recipient_member_id: "member-1",
        delivery_ready: true,
        draft: expect.objectContaining({ text: expect.stringContaining("Meta agents") }),
      }),
    ]);
    expect(body.coverage.members_without_usable_papers).toContainEqual({
      member_id: "admin-1",
      name: "Ada Admin",
    });
  });

  // Send delivers the pass the administrator was looking at, not a fresh one. Recomputing here ran
  // the whole cross-product inside the Send request -- a Cloudflare 524 at a hundred seconds -- and
  // could put out a draft nobody had read, since the matcher is a language model and its output is
  // not deterministic.
  it("sends the reviewed draft, not a recomputed one, as one member_nudge.send", async () => {
    const executed: AdminBotStoredProposal[] = [];
    const { baseUrl, mock } = await startService(executed);
    const headers = await adminHeaders(baseUrl, mock);
    seedMember(mock, {
      id: "member-1",
      name: "Mira Member",
      email: "mira@cs.toronto.edu",
      slack_user_id: "U-MIRA",
      privilege_level: "member",
      status: "active",
    });
    seedPaper(mock, "Old meta agents title");
    const preview = await runAndRead(baseUrl, headers);
    expect(JSON.stringify(await preview.json())).toContain("Old meta agents title");

    // A paper added after the pass. It must not appear in what goes out: the administrator approved
    // the earlier answer, and this one has never been on screen.
    seedPaper(mock, "Current meta agents title");
    const response = await fetch(`${baseUrl}/workshop-nudges/send`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        recipient_member_ids: ["member-1"],
        message: "browser-controlled text must be ignored",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      created: [{ member_id: "member-1", status: "executed" }],
      skipped: [],
    });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.type).toBe("member_nudge.send");
    expect(executed[0]?.proposed_payload).toMatchObject({
      target: "U-MIRA",
      message: expect.stringContaining("Old meta agents title"),
    });
    expect(JSON.stringify(executed[0]?.proposed_payload)).not.toContain(
      "Current meta agents title",
    );
    // Still true, and still the point of the route taking only a recipient list: the browser cannot
    // choose the text.
    expect(JSON.stringify(executed[0]?.proposed_payload)).not.toContain("browser-controlled");
  });

  // Refused rather than quietly starting a pass. One is tens of minutes; an administrator pressing
  // Nudge is not waiting for it, and starting one silently is what produced the timeout.
  it("refuses to send when no pass has produced recommendations yet", async () => {
    const executed: AdminBotStoredProposal[] = [];
    const { baseUrl, mock } = await startService(executed);
    const headers = await adminHeaders(baseUrl, mock);
    seedMember(mock, {
      id: "member-1",
      name: "Mira Member",
      email: "mira@cs.toronto.edu",
      slack_user_id: "U-MIRA",
      privilege_level: "member",
      status: "active",
    });
    seedPaper(mock, "Never matched");

    const response = await fetch(`${baseUrl}/workshop-nudges/send`, {
      method: "POST",
      headers,
      body: JSON.stringify({ recipient_member_ids: ["member-1"] }),
    });
    expect(response.status).not.toBe(200);
    expect(JSON.stringify(await response.json())).toContain("run a match first");
    expect(executed).toHaveLength(0);
  });

  it("reports a missing Slack identity and refuses both routes to the service principal", async () => {
    const { baseUrl, mock } = await startService();
    const headers = await adminHeaders(baseUrl, mock);
    seedMember(mock, {
      id: "member-1",
      name: "Mira Member",
      email: "mira@cs.toronto.edu",
      privilege_level: "member",
      status: "active",
    });
    seedPaper(mock);
    const preview = await runAndRead(baseUrl, headers);
    expect(await preview.json()).toMatchObject({
      status: "ready",
      preview: {
        recipients: [
          {
            recipient_member_id: "member-1",
            delivery_ready: false,
            delivery_blocked_reason: "No Slack identity is linked.",
          },
        ],
      },
    });

    // Reading, starting a pass and sending are all lab-internal: a service token is insufficient
    // for every one of them.
    for (const pathname of ["preview", "refresh", "send", "cancel"]) {
      const response = await fetch(`${baseUrl}/workshop-nudges/${pathname}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SERVICE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recipient_member_ids: ["member-1"] }),
      });
      expect(response.status).toBe(403);
    }
  });
});

// The pass is an un-awaited task inside the service, so a row saying `running` is only evidence
// that one started. The tab that reported 1671 of 2540 model calls for days was reading a run
// whose process had been gone since the count stopped moving, and "one pass at a time" then
// refused every attempt to start a new one -- in the dead run's name.
describe("a pass that stopped moving", () => {
  const stale = (progressAt?: string) => ({
    status: "running" as const,
    started_at: "2026-08-30T00:00:00.000Z",
    ...(progressAt ? { progress_at: progressAt } : {}),
  });
  const now = new Date("2026-08-30T02:00:00.000Z");

  it("is abandoned once it has gone quiet for long enough", () => {
    expect(workshopRunIsAbandoned(stale("2026-08-30T01:59:00.000Z"), now)).toBe(false);
    expect(workshopRunIsAbandoned(stale("2026-08-30T01:00:00.000Z"), now)).toBe(true);
  });

  it("falls back to the start time for a run written before the clock existed", () => {
    expect(workshopRunIsAbandoned(stale(), now)).toBe(true);
  });

  it("leaves a finished pass alone", () => {
    expect(
      workshopRunIsAbandoned({ ...stale(), status: "ready" as unknown as "running" }, now),
    ).toBe(false);
  });
});

/**
 * Noticing a stalled pass on the cheap route, not only on the expensive one.
 *
 * `workshopRunIsAbandoned` was only ever consulted by `startWorkshopNudgeRun`, which is what a
 * press of Find recommendations calls. But the tab does not press anything: it polls the read
 * route every few seconds, and that route handed back `status: "running"` verbatim. So an
 * administrator watching "1671 of 2540 model calls done" was watching a number that no code path
 * they were exercising could ever change. Staleness is a fact about the row; the reader is
 * entitled to act on it.
 */
describe("reading a pass that stopped moving", () => {
  const wedged = (id: string) => ({
    id,
    status: "running" as const,
    started_at: new Date().toISOString(),
    calls_done: 1671,
    calls_total: 2540,
  });

  it("closes out a stalled run instead of reporting it as running forever", async () => {
    const { mock } = await startService();
    mock.service.saveWorkshopMatchRun(wedged("wsm_stalled"));

    const view = readWorkshopNudgeRun(mock.service, new Date(Date.now() + 61 * 60 * 1000));
    expect(view.status).toBe("failed");
    expect(view.error).toBe(WORKSHOP_RUN_STALLED_MESSAGE);
    // The counts stay put: they are the only record of how far it got, and resetting them to zero
    // would leave nobody able to say what happened.
    expect(view.calls_done).toBe(1671);
    expect(view.calls_total).toBe(2540);
    // And the closing is persisted, so the next poll does not have to rediscover it.
    expect(mock.service.latestWorkshopMatchRun()?.status).toBe("failed");
  });

  it("leaves a pass that is still moving alone", async () => {
    const { mock } = await startService();
    mock.service.saveWorkshopMatchRun(wedged("wsm_live"));
    expect(readWorkshopNudgeRun(mock.service, new Date()).status).toBe("running");
  });

  it("lets an administrator stop a pass without waiting out the stall window", async () => {
    const { mock } = await startService();
    mock.service.saveWorkshopMatchRun(wedged("wsm_wedged"));

    const view = cancelWorkshopNudgeRun({ service: mock.service, actor: "admin-1" });
    expect(view.status).toBe("failed");
    expect(view.error).toContain("stopped by admin-1");
    expect(view.error).toContain("1671 of 2540");
  });

  it("starts a fresh pass over a wedged one when the administrator forces it", async () => {
    const { mock } = await startService();
    const now = new Date();
    mock.service.saveWorkshopMatchRun(wedged("wsm_wedged"));

    // Without `force` the guard hands back the wedged run: it has not gone quiet long enough yet,
    // which is the right default for a pass nobody is watching and the wrong one for an
    // administrator who has been staring at a still count.
    const refused = startWorkshopNudgeRun({ service: mock.service, match: async () => [], now });
    expect(refused.calls_done).toBe(1671);
    expect(mock.service.latestWorkshopMatchRun()?.id).toBe("wsm_wedged");

    const forced = startWorkshopNudgeRun({
      service: mock.service,
      match: async () => [],
      now,
      force: true,
    });
    expect(forced.calls_done).toBe(0);
    expect(mock.service.latestWorkshopMatchRun()?.id).not.toBe("wsm_wedged");
  });
});
