// The cron entry point: find the standing meeting, reconcile it, file proposals, remove nobody.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotCalendarEvent } from "../workflows/calendar/events.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const SERIES = "1qrj9v886kpnj58fdviqugk4g6";

const running: Array<{
  mock: ReturnType<typeof createAdminBotMockService>;
  cleanupPaths: string[];
}> = [];

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
  reader: (params: { calendarId?: string }) => Promise<AdminBotCalendarEvent[]>,
): Promise<string> {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-invite-membership-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
    calendarEventsReader: reader,
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
  running.push({ mock, cleanupPaths: [sensitiveInfoPath] });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  for (const row of [
    { id: "full", privilege_level: "member", status: "active", email: "full@cs.toronto.edu" },
    { id: "trial", privilege_level: "trial", status: "active", email: "trial@cs.toronto.edu" },
    {
      id: "major",
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_major",
      status: "active",
      email: "major@other.test",
    },
  ]) {
    const created = mock.service.upsertLabMember({ name: `Name ${row.id}`, ...row } as never);
    if (!created.ok) {
      throw new Error(created.error.message);
    }
  }
  return baseUrl;
}

const post = async (baseUrl: string, body: Record<string, unknown> = {}) =>
  await fetch(`${baseUrl}/meetings/invite-membership/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const occurrence = (attendees: string[]): AdminBotCalendarEvent => ({
  // A recurring meeting comes back as dated occurrences, which is what the route has to match.
  id: `${SERIES}_20260824T133000Z`,
  summary: "Jinesis group meeting",
  start: "2026-08-24T13:30:00Z",
  attendees,
});

describe("POST /meetings/invite-membership/run", () => {
  it("matches the series through a dated occurrence and proposes the removals", async () => {
    const baseUrl = await startService(async () => [
      occurrence(["full@cs.toronto.edu", "trial@cs.toronto.edu", "major@other.test"]),
    ]);

    const response = await post(baseUrl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      remove: Array<{ member_id: string }>;
      keep: string[];
      proposal_id?: string;
    };

    // The trial member goes; the major coauthor keeps their seat at the group meeting.
    expect(body.remove.map((entry) => entry.member_id)).toEqual(["trial"]);
    expect(body.keep.toSorted()).toEqual(["full@cs.toronto.edu", "major@other.test"]);
    expect(body.proposal_id).toBeTruthy();
  });

  it("drops the major coauthor when the surface is the lab calendar", async () => {
    const baseUrl = await startService(async () => [
      occurrence(["full@cs.toronto.edu", "major@other.test"]),
    ]);
    const response = await post(baseUrl, { surface: "lab_calendar" });
    const body = (await response.json()) as { remove: Array<{ member_id: string }> };
    expect(body.remove.map((entry) => entry.member_id)).toEqual(["major"]);
  });

  it("reports a calendar it cannot read rather than planning an empty invite", async () => {
    const baseUrl = await startService(async () => {
      throw new Error("gog: token expired");
    });
    const response = await post(baseUrl);
    // The whole plan is computed from this read; a failure must never become "no attendees".
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).toContain("token expired");
  });

  it("404s when the configured event is not on the calendar", async () => {
    const baseUrl = await startService(async () => [
      { id: "someone-elses-event", summary: "Other", start: "2026-08-24T13:30:00Z" },
    ]);
    const response = await post(baseUrl);
    expect(response.status).toBe(404);
  });

  it("refuses an event with no attendees", async () => {
    const baseUrl = await startService(async () => [occurrence([])]);
    const response = await post(baseUrl);
    expect(response.status).toBe(422);
  });

  it("needs a privileged principal", async () => {
    const baseUrl = await startService(async () => [occurrence(["full@cs.toronto.edu"])]);
    const response = await fetch(`${baseUrl}/meetings/invite-membership/run`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});
