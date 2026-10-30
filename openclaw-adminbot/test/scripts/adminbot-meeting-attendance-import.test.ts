import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminBotSqliteService } from "../../extensions/adminbot/src/persistence/sqlite.js";
import { main } from "../../scripts/adminbot-meeting-attendance-import.js";

const dirs: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const HEADER =
  "﻿Topic,Type,ID,Host name,Host email,Start time,End time,Participants,Duration (minutes)," +
  "Total participant minutes,Department,Group,Source,Unique viewers,Max concurrent views," +
  "Creation time,Personal Meeting ID,Name (original name),Email,Join time,Leave time," +
  "Duration (minutes),Guest,Recording disclaimer response,In waiting room";

function row(start: string, minutes: number, name: string) {
  return `Weekly Lab Meeting,Meeting,812 3456 7890,Host,host@example.edu,"${start}","${start}",3,${minutes},90,,Group,Zoom,-,-,"10/06/2025 01:16:21 AM",,"${name}",,"${start}","${start}",${minutes},Yes,OK,No`;
}

// Two real meetings (three people each) and a one-person opening of the room.
const EXPORT = [
  HEADER,
  ...["Ada Lovelace", "Alan T", "Grace Hopper"].map((name) =>
    row("08/24/2026 09:25:32 AM", 104, name),
  ),
  ...["Ada Lovelace", "Alan T", "Grace Hopper"].map((name) =>
    row("09/21/2026 08:59:07 AM", 107, name),
  ),
  row("09/21/2026 08:30:00 AM", 1, "Ada Lovelace"),
  "",
].join("\n");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-attendance-import-"));
  dirs.push(dir);
  const databasePath = path.join(dir, "adminbot.sqlite");
  const csv = path.join(dir, "meetinglistdetails_2026_08_01_2026_09_30.csv");
  fs.writeFileSync(csv, EXPORT);
  const db = createAdminBotSqliteService({ databasePath });
  for (const [id, name] of [
    ["m-ada", "Ada Lovelace"],
    ["m-alan", "Alan Turing"],
    ["m-grace", "Grace Hopper"],
  ]) {
    const created = db.service.upsertLabMember({ id, name, email: `${id}@example.edu` });
    expect(created.ok).toBe(true);
  }
  // What a recording notice whose date line did not parse leaves: filed when the mail arrived.
  const notice = db.service.upsertMeeting({
    id: "zoom-notice",
    topic: "Weekly Lab Meeting",
    started_at: "2026-09-21T17:21:00.000Z",
    duration_seconds: 6412,
    recording: { share_url: "https://zoom.example/rec/share/notice" },
    source: "zoom_email",
  });
  expect(notice.ok).toBe(true);
  db.close();
  return { dir, databasePath, csv };
}

function meetings(databasePath: string) {
  const db = createAdminBotSqliteService({ databasePath });
  try {
    const listed = db.service.listMeetings({ includeShort: true });
    return listed.ok ? listed.payload.meetings : [];
  } finally {
    db.close();
  }
}

describe("adminbot-meeting-attendance-import", () => {
  it("writes nothing on a dry run", () => {
    const { databasePath, csv } = setup();
    expect(main([csv, "--database", databasePath, "--min-participants", "2"])).toBe(0);
    expect(meetings(databasePath).map((m) => [m.id, m.attendees?.length ?? 0])).toEqual([
      ["zoom-notice", 0],
    ]);
  });

  it("files the qualifying meetings, onto the notice's record where there is one", () => {
    const { dir, databasePath, csv } = setup();
    const aliases = path.join(dir, "aliases.json");
    fs.writeFileSync(aliases, JSON.stringify({ "Alan T": "m-alan" }));
    const args = [csv, "--database", databasePath, "--min-participants", "2", "--aliases", aliases];
    expect(main([...args, "--apply"])).toBe(0);

    const byId = new Map(meetings(databasePath).map((m) => [m.id, m]));
    expect([...byId.keys()].toSorted()).toEqual(["zoom-81234567890-2026-08-24", "zoom-notice"]);
    // The notice's record keeps its link and gains the report's start time and roster.
    const notice = byId.get("zoom-notice")!;
    expect(notice.recording.share_url).toBe("https://zoom.example/rec/share/notice");
    expect(notice.started_at).toBe("2026-09-21T12:59:07.000Z");
    expect(notice.source).toBe("zoom_email");
    expect(notice.attendees?.map((a) => a.member_id).toSorted()).toEqual([
      "m-ada",
      "m-alan",
      "m-grace",
    ]);
    // The unrecorded meeting is filed from the report alone.
    const unrecorded = byId.get("zoom-81234567890-2026-08-24")!;
    expect(unrecorded.source).toBe("participant_report");
    expect(unrecorded.recording).toEqual({});
    expect(unrecorded.duration_minutes).toBe(104);
    expect(unrecorded.attendees?.every((a) => a.source === "participant_report")).toBe(true);

    // Running it again changes nothing.
    expect(main([...args, "--apply"])).toBe(0);
    const again = meetings(databasePath);
    expect(again).toHaveLength(2);
    expect(again.map((m) => m.attendees?.length)).toEqual([3, 3]);
  });

  it("stops before writing when an alias names no member", () => {
    const { dir, databasePath, csv } = setup();
    const aliases = path.join(dir, "aliases.json");
    fs.writeFileSync(aliases, JSON.stringify({ "Alan T": "m-nobody" }));
    expect(() =>
      main([
        csv,
        "--database",
        databasePath,
        "--min-participants",
        "2",
        "--aliases",
        aliases,
        "--apply",
      ]),
    ).toThrow(/m-nobody/u);
    expect(meetings(databasePath)).toHaveLength(1);
  });
});
