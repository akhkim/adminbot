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
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
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
    const seeded = mock.service.upsertLabMember(
      withCompleteProfile({
        id,
        name: id,
        email: `${id}@cs.toronto.edu`,
        privilege_level: privilege,
      }),
    );
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

describe("GET /meetings paging", () => {
  // Before the default, a request without `limit` was the whole history -- 25 MB at 200 meetings
  // of 1,000 attendees. Now it is the first page the tab paints, whoever asks.
  it("answers a request without a limit with the newest ten and a cursor", async () => {
    const lab = await startLab();
    fileMeetings(lab, 12, 5);
    const response = await fetch(`${lab.baseUrl}/meetings`, { headers: as(lab, "zhijing") });
    const page = (await response.json()) as {
      meetings: Array<{ id: string }>;
      next_cursor?: { started_at: string; id: string };
    };
    expect(page.meetings.map((meeting) => meeting.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `zoom-${11 - index}`),
    );
    expect(page.next_cursor?.id).toBe("zoom-2");
    const query = new URLSearchParams({
      before_started_at: page.next_cursor?.started_at ?? "",
      before_id: page.next_cursor?.id ?? "",
    });
    const rest = await fetch(`${lab.baseUrl}/meetings?${query}`, { headers: as(lab, "ada") });
    const second = (await rest.json()) as {
      meetings: Array<{ id: string }>;
      next_cursor?: unknown;
    };
    expect(second.meetings.map((meeting) => meeting.id)).toEqual(["zoom-1", "zoom-0"]);
    expect(second.next_cursor).toBeUndefined();
  });

  it("refuses a page larger than fifty", async () => {
    const lab = await startLab();
    const response = await fetch(`${lab.baseUrl}/meetings?limit=51`, {
      headers: as(lab, "zhijing"),
    });
    expect(response.status).toBe(400);
  });

  // Measured with this fixture, admin / member: 5,104 / 6,104 bytes at both 10 x 200 and
  // 10 x 1,000 -- a row's size no longer depends on how many people attended. (A member's row is
  // the larger one: it carries their own attendance line, which their closed card renders.)
  it("keeps the first page of ten small at any roster size", async () => {
    for (const size of [200, 1000]) {
      const lab = await startLab();
      fileMeetings(lab, 10, size);
      const admin = await bytes(lab, "/meetings", "zhijing");
      const member = await bytes(lab, "/meetings", "ada");
      expect(admin).toBeLessThan(8_000);
      expect(member).toBeLessThan(8_000);
    }
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

describe("meeting series", () => {
  function file(lab: Lab, id: string, topic: string, startedAt: string, minutes = 60) {
    const saved = lab.mock.service.upsertMeeting({
      id,
      topic,
      started_at: startedAt,
      duration_minutes: minutes,
      recording: { share_url: `https://us02web.zoom.us/rec/share/${id}` },
      attendees: roster(3),
      source: "zoom_email",
    });
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
  }

  async function seed(): Promise<Lab> {
    const lab = await startLab();
    file(lab, "weekly-1", "Weekly Lab Meeting", "2026-09-07T14:00:00.000Z");
    file(lab, "reading-1", "Reading Group", "2026-09-10T15:00:00.000Z");
    // The same series as filed by a different host: case and spacing differ, the meeting does not.
    file(lab, "weekly-2", "weekly  lab meeting ", "2026-09-14T14:00:00.000Z");
    file(lab, "weekly-3", "Weekly Lab Meeting", "2026-09-21T14:00:00.000Z");
    // Under the default ten-minute floor: hidden from the list, so it must not be counted either.
    file(lab, "reading-check", "Reading Group", "2026-09-22T15:00:00.000Z", 2);
    return lab;
  }

  it("indexes one row per recurring meeting, newest series first, for members too", async () => {
    const lab = await seed();
    expect((await fetch(`${lab.baseUrl}/meetings/series`)).status).toBe(401);
    for (const viewer of ["ada", "zhijing"]) {
      const response = await fetch(`${lab.baseUrl}/meetings/series`, { headers: as(lab, viewer) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        series: [
          {
            key: "weekly lab meeting",
            topic: "Weekly Lab Meeting",
            count: 3,
            latest_started_at: "2026-09-21T14:00:00.000Z",
          },
          {
            key: "reading group",
            topic: "Reading Group",
            count: 1,
            latest_started_at: "2026-09-10T15:00:00.000Z",
          },
        ],
      });
    }
  });

  it("pages one series' recordings, newest first, with the viewer's own redaction", async () => {
    const lab = await seed();
    const series = encodeURIComponent("weekly lab meeting");
    const first = await fetch(`${lab.baseUrl}/meetings?series=${series}&limit=2`, {
      headers: as(lab, "ada"),
    });
    const page = (await first.json()) as {
      meetings: { id: string; attendees?: { member_id?: string }[] }[];
      next_cursor?: { started_at: string; id: string };
    };
    expect(page.meetings.map((meeting) => meeting.id)).toEqual(["weekly-3", "weekly-2"]);
    // A member's row carries their own line and nobody else's.
    expect(page.meetings[0]?.attendees?.map((line) => line.member_id)).toEqual(["ada"]);
    const cursor = page.next_cursor;
    expect(cursor?.id).toBe("weekly-2");
    const rest = await fetch(
      `${lab.baseUrl}/meetings?series=${series}&limit=2&before_started_at=${encodeURIComponent(
        cursor?.started_at ?? "",
      )}&before_id=${cursor?.id}`,
      { headers: as(lab, "zhijing") },
    );
    const tail = (await rest.json()) as {
      meetings: { id: string; attendees?: unknown; attendee_count?: number }[];
      next_cursor?: unknown;
    };
    expect(tail.meetings.map((meeting) => meeting.id)).toEqual(["weekly-1"]);
    expect(tail.next_cursor).toBeUndefined();
    // An admin's list row is a headcount; the roster stays on GET /meetings/:id.
    expect(tail.meetings[0]?.attendees).toBeUndefined();
    expect(tail.meetings[0]?.attendee_count).toBe(3);
  });

  it("refuses an empty or oversized series key", async () => {
    const lab = await seed();
    for (const series of ["", "%20%20", "x".repeat(301)]) {
      const response = await fetch(`${lab.baseUrl}/meetings?series=${series}`, {
        headers: as(lab, "ada"),
      });
      expect(response.status).toBe(400);
    }
  });

  it("revalidates the index until a meeting is filed", async () => {
    const lab = await seed();
    const first = await fetch(`${lab.baseUrl}/meetings/series`, { headers: as(lab, "ada") });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const same = await fetch(`${lab.baseUrl}/meetings/series`, {
      headers: { ...as(lab, "ada"), "If-None-Match": etag ?? "" },
    });
    expect(same.status).toBe(304);
    file(lab, "journal-1", "Journal Club", "2026-10-01T16:00:00.000Z");
    const changed = await fetch(`${lab.baseUrl}/meetings/series`, {
      headers: { ...as(lab, "ada"), "If-None-Match": etag ?? "" },
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { series: { key: string }[] }).series[0]?.key).toBe(
      "journal club",
    );
  });
});
