#!/usr/bin/env -S node --import tsx
/**
 * One pass over the meeting artifact drop folder.
 *
 * The half of the meetings pipeline that a person still touches. The recording notice arrives by
 * itself (the hourly email pass files it), but the transcript and the participant CSV have to be
 * fetched from Zoom's web UI by hand -- there is no API on this account -- so a host drops both in
 * a Drive folder and this pass picks them up: matches each file to a meeting, folds it into the
 * record, summarizes the transcript on the local model, and forgets the transcript.
 *
 * Everything that decides anything lives in `extensions/adminbot/src/workflows/meetings/`, under
 * test. This file is the I/O: Drive through `gog`, the database through the plugin's own service,
 * and a JSON summary on stdout so a failed pass shows red in the Cron tab with a reason.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  artifactKind,
  createAdminBotSqliteService,
  matchArtifactToMeeting,
  participantsUpdate,
  summarizeMeeting,
  transcriptUpdate,
  type AdminBotMeetingRecord,
} from "../extensions/adminbot/api.js";
import { resolveGogExecutable } from "../extensions/adminbot/src/connectors/gog.js";
import { isMainModule } from "./lib/is-main-module.mjs";

const execFileAsync = promisify(execFile);
const GOG_TIMEOUT_MS = 120_000;

export type ArtifactPassSummary = {
  found: number;
  attached: number;
  summarized: number;
  unmatched: string[];
  errors: string[];
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set — the meeting artifact pass has nothing to read`);
  }
  return value;
}

type DriveFile = { id: string; name: string };

/**
 * The drop folder's contents.
 *
 * `--results-only` because the envelope varies between gog releases and the file list does not;
 * the shape is then narrowed by hand rather than trusted, since this is external input.
 */
async function listDropFolder(folderId: string, account: string): Promise<DriveFile[]> {
  const { stdout } = await execFileAsync(
    resolveGogExecutable(),
    [
      "drive",
      "ls",
      "--parent",
      folderId,
      "--max",
      "100",
      "--account",
      account,
      "--json",
      "--results-only",
      "--no-input",
    ],
    { encoding: "utf8", timeout: GOG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: process.env },
  );
  const parsed = JSON.parse(stdout || "[]") as unknown;
  const rows = Array.isArray(parsed) ? parsed : ((parsed as { files?: unknown[] }).files ?? []);
  return rows.flatMap((row) => {
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : "";
    return id && name ? [{ id, name }] : [];
  });
}

async function downloadFile(fileId: string, directory: string, account: string): Promise<string> {
  const before = new Set(fs.readdirSync(directory));
  await execFileAsync(
    resolveGogExecutable(),
    [
      "drive",
      "download",
      fileId,
      "--out",
      directory,
      "--overwrite",
      "--account",
      account,
      "--json",
      "--results-only",
      "--no-input",
    ],
    { encoding: "utf8", timeout: GOG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: process.env },
  );
  const created = fs.readdirSync(directory).find((name) => !before.has(name));
  if (!created) {
    throw new Error(`Drive file ${fileId} downloaded without a discoverable output path`);
  }
  return path.join(directory, created);
}

export async function runMeetingArtifactPass(): Promise<ArtifactPassSummary> {
  const account = requireEnv("ADMINBOT_BOT_EMAIL");
  const folderId = requireEnv("ADMINBOT_MEETING_DROP_FOLDER_ID");
  const databasePath =
    process.env.ADMINBOT_DB_PATH ??
    path.join(os.homedir(), ".openclaw", "state", "adminbot.sqlite");
  const summary: ArtifactPassSummary = {
    found: 0,
    attached: 0,
    summarized: 0,
    unmatched: [],
    errors: [],
  };
  const { service, store, close } = createAdminBotSqliteService({ databasePath });
  // The Drive file id is the deduplication key. Unmatched and empty files remain retryable.
  const record = (
    file: DriveFile,
    meetingId: string | undefined,
    status: "attached" | "unmatched" | "empty",
  ) =>
    store.recordMeetingArtifact({
      file_id: file.id,
      file_name: file.name,
      meeting_id: meetingId,
      status,
      processed_at: new Date().toISOString(),
    });
  // Transcripts are written here and deleted in the finally below. A tmpdir per pass rather than a
  // fixed path so a crashed run leaves one identifiable directory instead of a growing pile.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-meeting-"));
  try {
    const files = await listDropFolder(folderId, account);
    const members = service.listLabMembers();
    const roster = members.ok ? members.payload.members : [];
    for (const file of files) {
      const kind = artifactKind(file.name);
      if (!kind || store.hasAttachedMeetingArtifact(file.id)) {
        continue;
      }
      summary.found += 1;
      try {
        // includeShort: a transcript for a nine-minute meeting still has to reach its record, and
        // the duration that would hide it is often the very thing this file is about to supply.
        const meetings = service.listMeetings({ includeShort: true });
        const meeting = meetings.ok
          ? matchArtifactToMeeting(file.name, meetings.payload.meetings)
          : undefined;
        if (!meeting) {
          summary.unmatched.push(file.name);
          record(file, undefined, "unmatched");
          continue;
        }
        const localPath = await downloadFile(file.id, scratch, account);
        const contents = fs.readFileSync(localPath, "utf8");
        if (kind === "participants") {
          const update = participantsUpdate(meeting, contents, roster);
          if (!update) {
            summary.unmatched.push(`${file.name} (no participant rows)`);
            record(file, meeting.id, "empty");
            continue;
          }
          const result = service.upsertMeeting(update);
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          summary.attached += 1;
          record(file, meeting.id, "attached");
          continue;
        }
        summary.summarized += (await attachTranscript(
          service,
          meeting,
          contents,
          roster,
          file.name,
        ))
          ? 1
          : 0;
        summary.attached += 1;
        record(file, meeting.id, "attached");
      } catch (error) {
        summary.errors.push(
          `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    // The transcript exists on disk for the length of one summarization and no longer. This is the
    // same promise the record shape makes, and it has to hold on the failure path too.
    fs.rmSync(scratch, { recursive: true, force: true });
    close();
  }
  return summary;
}

/**
 * Fold a transcript into a meeting and summarize it.
 *
 * The record is written before the summary is attempted, so a model that is down costs the lab the
 * summary and not the transcript metadata. Returns whether a summary was produced.
 */
async function attachTranscript(
  service: ReturnType<typeof createAdminBotSqliteService>["service"],
  meeting: AdminBotMeetingRecord,
  vttSource: string,
  roster: Parameters<typeof transcriptUpdate>[2],
  fileName: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { update, transcriptText } = transcriptUpdate(meeting, vttSource, roster, now);
  const filed = service.upsertMeeting(update);
  if (!filed.ok) {
    throw new Error(filed.error.message);
  }
  if (!transcriptText.trim()) {
    return false;
  }
  const summary = await summarizeMeeting(
    {
      topic: meeting.topic,
      startedAt: meeting.started_at,
      transcriptText,
      members: roster,
    },
    {
      fetchImpl: globalThis.fetch,
      ...(process.env.ADMINBOT_LOCAL_BASE_URL
        ? { baseUrl: process.env.ADMINBOT_LOCAL_BASE_URL }
        : {}),
      ...(process.env.ADMINBOT_LOCAL_MODEL ? { model: process.env.ADMINBOT_LOCAL_MODEL } : {}),
      ...(process.env.VLLM_API_KEY ? { apiKey: process.env.VLLM_API_KEY } : {}),
    },
  );
  const stored = service.upsertMeeting({ ...update, summary });
  if (!stored.ok) {
    throw new Error(`${fileName}: ${stored.error.message}`);
  }
  return true;
}

if (isMainModule(import.meta.url)) {
  void runMeetingArtifactPass()
    .then((summary) => {
      console.log(JSON.stringify(summary));
      if (summary.errors.length > 0) {
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    });
}
