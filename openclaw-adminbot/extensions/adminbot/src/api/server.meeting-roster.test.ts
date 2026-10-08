// GET /meetings and GET /meetings/:id over real HTTP: what the list carries, and the roster read.
//
// A sibling of server.test.ts rather than more of it. The list is read on every visit to the
// Meetings tab and the roster only when an admin opens a meeting's attendance, so the list's size
// at a large lab is asserted here alongside who may read the roster.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotMeetingAttendee } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const PASSWORD = "correcthorse";

const running: { mock: ReturnType<typeof createAdminBotMockService>; cleanup: string }[] = [];

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
  mock: ReturnType<typeof createAdminBotMockService>;
  tokens: Record<string, string>;
};

async function startLab(): Promise<Lab> {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-meeting-roster-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsRosterRecorder: async () => ({
      username: "stub@cs.toronto.edu",
      password: "stub",
      candidates: ["stub@cs.toronto.edu"],
    }),
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
      body: JSON.stringify({ member_id: id, email: `${id}@cs.toronto.edu`, password: PASSWORD }),
    });
    const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const { registrations } = (await pending.json()) as {
      registrations: { id: string; member_id?: string }[];
    };
    const claim = registrations.find((entry) => entry.member_id === id);
    if (!claim) {
      throw new Error(`no pending claim for ${id}`);
    }
    const approved = await mock.auth.approveRegistration(claim.id, "test-admin");
    if (!approved.ok) {
      throw new Error(approved.error.message);
    }
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${id}@cs.toronto.edu`, password: PASSWORD }),
    });
    tokens[id] = ((await login.json()) as { session_token: string }).session_token;
  }
  return { baseUrl, mock, tokens };
}

function as(lab: Lab, memberId: string) {
  return { Authorization: `Bearer ${lab.tokens[memberId]}` };
}

/** A Zoom participant report's worth of lines: what an import of a large meeting stores. */
function roster(size: number): AdminBotMeetingAttendee[] {
  const lines: AdminBotMeetingAttendee[] = [
    { member_id: "ada", display_name: "ada", source: "participant_report", present: true },
  ];
  for (let index = 1; index < size; index++) {
    lines.push({
      member_id: `member-${String(index).padStart(4, "0")}`,
      display_name: `Researcher Number ${index}`,
      email: `researcher.${index}@cs.toronto.edu`,
      joined_at: "2026-08-12T14:02:11.000Z",
      minutes: 40 + (index % 20),
      source: "participant_report",
      present: index % 7 !== 0,
    });
  }
  return lines;
}

function fileMeetings(lab: Lab, count: number, size: number) {
  for (let index = 0; index < count; index++) {
    const day = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString();
    const saved = lab.mock.service.upsertMeeting({
      id: `zoom-${index}`,
      topic: `Weekly Lab Meeting ${index}`,
      started_at: day,
      duration_minutes: 60,
      recording: {
        share_url: `https://us02web.zoom.us/rec/share/tok-${index}`,
        passcode: "k7$Rm2pQ",
      },
      summary: {
        overview: "The lab reviewed submissions and planned the next reading group.",
        decisions: ["Move the reading group to Thursdays"],
        action_items: [{ text: "Circulate the draft", owner_name: "ada" }],
        generated_at: day,
        model: "local",
      },
      attendees: roster(size),
      source: "zoom_email",
    });
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
  }
}

async function bytes(lab: Lab, url: string, memberId: string): Promise<number> {
  const response = await fetch(`${lab.baseUrl}${url}`, { headers: as(lab, memberId) });
  expect(response.status).toBe(200);
  return Buffer.byteLength(await response.text());
}

describe("GET /meetings at a large lab", () => {
  // Measured with this fixture: the admin list was 1,269,284 bytes at 50 x 200 before the roster
  // moved to its own read, and 25,584 after.
  it("sends an admin a headcount per meeting instead of the roster", async () => {
    const lab = await startLab();
    fileMeetings(lab, 50, 200);
    expect(await bytes(lab, "/meetings?limit=50", "zhijing")).toBeLessThan(40_000);
    const response = await fetch(`${lab.baseUrl}/meetings?limit=50`, {
      headers: as(lab, "zhijing"),
    });
    const { meetings } = (await response.json()) as {
      meetings: Array<{ attendees?: unknown[]; attendee_count?: number }>;
    };
    expect(meetings).toHaveLength(50);
    expect(meetings.every((meeting) => meeting.attendees === undefined)).toBe(true);
    // 200 lines, every seventh (index 7, 14, ... 196) absent: 28 of them.
    expect(meetings[0]?.attendee_count).toBe(172);
  });
});

describe("GET /meetings/:id", () => {
  it("gives an admin the roster, in the list's attendance-line shape", async () => {
    const lab = await startLab();
    fileMeetings(lab, 2, 200);
    const response = await fetch(`${lab.baseUrl}/meetings/zoom-1`, { headers: as(lab, "zhijing") });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeTruthy();
    const meeting = (await response.json()) as {
      id: string;
      attendees: Array<Record<string, unknown>>;
      attendee_count?: number;
    };
    expect(meeting.id).toBe("zoom-1");
    expect(meeting.attendees).toHaveLength(200);
    expect(meeting.attendee_count).toBeUndefined();
    // The Zoom address and join time stay on the server, as they do for the list.
    expect(meeting.attendees.some((line) => "email" in line || "joined_at" in line)).toBe(false);

    const again = await fetch(`${lab.baseUrl}/meetings/zoom-1`, {
      headers: { ...as(lab, "zhijing"), "If-None-Match": response.headers.get("etag") ?? "" },
    });
    expect(again.status).toBe(304);
  });

  // The same redaction as the list: a member who asks for one meeting by id gets their own line
  // and a headcount, never the names of everyone else who was there.
  it("gives a member their own line and a headcount, not the roster", async () => {
    const lab = await startLab();
    fileMeetings(lab, 1, 50);
    const response = await fetch(`${lab.baseUrl}/meetings/zoom-0`, { headers: as(lab, "ada") });
    expect(response.status).toBe(200);
    const meeting = (await response.json()) as {
      attendees: Array<{ member_id?: string }>;
      attendee_count: number;
    };
    expect(meeting.attendees.map((line) => line.member_id)).toEqual(["ada"]);
    expect(meeting.attendee_count).toBe(43);
  });

  it("refuses an anonymous read and 404s what the list would not show", async () => {
    const lab = await startLab();
    fileMeetings(lab, 1, 3);
    lab.mock.service.upsertMeeting({
      id: "room-check",
      topic: "Room check",
      started_at: "2026-02-01T10:00:00.000Z",
      duration_minutes: 1,
      recording: {},
      attendees: roster(3),
      source: "manual",
    });
    expect((await fetch(`${lab.baseUrl}/meetings/zoom-0`)).status).toBe(401);
    for (const id of ["nope", "room-check"]) {
      const response = await fetch(`${lab.baseUrl}/meetings/${id}`, {
        headers: as(lab, "zhijing"),
      });
      expect(response.status).toBe(404);
    }
  });

  it("leaves /meetings/attendance-nudges to its own route", async () => {
    const lab = await startLab();
    const member = await fetch(`${lab.baseUrl}/meetings/attendance-nudges`, {
      headers: as(lab, "ada"),
    });
    expect(member.status).toBe(403);
    const admin = await fetch(`${lab.baseUrl}/meetings/attendance-nudges`, {
      headers: as(lab, "zhijing"),
    });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toHaveProperty("absent");
  });
});
