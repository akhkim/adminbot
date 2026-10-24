#!/usr/bin/env -S node --import tsx
/**
 * One pass over the meeting artifact drop folder.
 *
 * The half of the meetings pipeline that a person still touches. The recording notice arrives by
 * itself (the hourly email pass files it), but the transcript, the participant CSV and the
 * recording itself have to be fetched from Zoom's web UI by hand -- there is no API on this
 * account -- so a host drops them in a Drive folder and this pass picks them up: matches each file
 * to a meeting, folds it into the record, summarizes the transcript on the local model, and
 * forgets the transcript.
 *
 * A gallery-view recording is sampled for attendance: one frame every thirty minutes, each read by
 * the local vision model on its own GPU for the names on the participant tiles. The video and its
 * frames live in this pass's scratch directory and are deleted with it.
 *
 * Everything that decides anything lives in `extensions/adminbot/src/workflows/meetings/`, under
 * test. This file is the I/O: Drive through `gog`, frames through `ffmpeg`, the database through
 * the plugin's own service, and a JSON summary on stdout so a failed pass shows red in the Cron
 * tab with a reason.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  artifactKind,
  createAdminBotSqliteService,
  DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
  formatOffset,
  matchArtifactToMeeting,
  parseFfmpegDuration,
  participantsUpdate,
  readGalleryFrame,
  snapshotOffsets,
  snapshotUpdate,
  summarizeMeeting,
  transcriptUpdate,
  type AdminBotMeetingRecord,
  type GalleryFrameReading,
} from "../extensions/adminbot/api.js";
import { resolveGogExecutable } from "../extensions/adminbot/src/connectors/gog.js";
import { adminbotServiceDatabasePath } from "./adminbot-service-database.js";
import { isMainModule } from "./lib/is-main-module.mjs";

const execFileAsync = promisify(execFile);
const GOG_TIMEOUT_MS = 120_000;
// An hour of 1080p gallery view is several hundred megabytes; the transcript timeout would kill
// the download of every real recording.
const VIDEO_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const FFMPEG_TIMEOUT_MS = 120_000;

export type ArtifactPassSummary = {
  found: number;
  attached: number;
  summarized: number;
  /** Gallery recordings whose frames were read and folded into attendance. */
  snapshotted: number;
  unmatched: string[];
  /** Gallery recordings left for a later pass because no vision model is configured yet. */
  deferred: string[];
  errors: string[];
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set — the meeting artifact pass has nothing to read`);
  }
  return value;
}

type VisionConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  intervalSeconds: number;
  ffmpeg: string;
};

/**
 * The vision model's settings, or undefined when the gallery path is not switched on.
 *
 * Off unless the base URL is set, so a deployment that has not stood up the vision server keeps
 * filing transcripts and CSVs exactly as before, and its gallery recordings wait in the folder
 * (reported as deferred) instead of failing every hour.
 */
function visionConfig(): VisionConfig | undefined {
  const baseUrl = process.env.ADMINBOT_MEETING_VISION_BASE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }
  const minutes = Number(process.env.ADMINBOT_MEETING_SNAPSHOT_MINUTES?.trim() || "");
  const apiKey =
    process.env.ADMINBOT_MEETING_VISION_API_KEY?.trim() || process.env.VLLM_API_KEY?.trim();
  return {
    baseUrl,
    model: requireEnv("ADMINBOT_MEETING_VISION_MODEL"),
    ...(apiKey ? { apiKey } : {}),
    intervalSeconds:
      Number.isFinite(minutes) && minutes > 0
        ? Math.round(minutes * 60)
        : DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
    ffmpeg: process.env.ADMINBOT_FFMPEG_BIN?.trim() || "ffmpeg",
  };
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

async function downloadFile(
  fileId: string,
  directory: string,
  account: string,
  timeout = GOG_TIMEOUT_MS,
): Promise<string> {
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
    { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, env: process.env },
  );
  const created = fs.readdirSync(directory).find((name) => !before.has(name));
  if (!created) {
    throw new Error(`Drive file ${fileId} downloaded without a discoverable output path`);
  }
  return path.join(directory, created);
}

/**
 * The recording's length in seconds, read from ffmpeg's own banner.
 *
 * `ffmpeg -i` with no output exits non-zero by design and prints the container's Duration line on
 * stderr, which spares deploying ffprobe alongside it. The record's notice duration is the
 * fallback: it is the same recording, measured by Zoom.
 */
async function probeDurationSeconds(
  ffmpeg: string,
  videoPath: string,
): Promise<number | undefined> {
  let stderr = "";
  try {
    ({ stderr } = await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-i", videoPath], {
      encoding: "utf8",
      timeout: FFMPEG_TIMEOUT_MS,
    }));
  } catch (error) {
    const failed = error as { code?: unknown; stderr?: unknown };
    if (failed.code === "ENOENT") {
      throw new Error(`ffmpeg is not installed at ${ffmpeg}; set ADMINBOT_FFMPEG_BIN`);
    }
    stderr = typeof failed.stderr === "string" ? failed.stderr : "";
  }
  return parseFfmpegDuration(stderr);
}

/**
 * One JPEG frame at an offset.
 *
 * `-ss` before `-i` seeks by keyframe, which is what keeps a frame at 1:30:00 from decoding an
 * hour and a half of video first. Width is capped at 1920: a 1440p gallery spends tokens on pixels
 * the name labels do not need.
 */
async function extractFrame(
  ffmpeg: string,
  videoPath: string,
  offsetSeconds: number,
  framePath: string,
): Promise<Buffer> {
  await execFileAsync(
    ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(offsetSeconds),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(1920,iw)':-2",
      "-q:v",
      "2",
      "-y",
      framePath,
    ],
    { encoding: "utf8", timeout: FFMPEG_TIMEOUT_MS },
  );
  const jpeg = fs.existsSync(framePath) ? fs.readFileSync(framePath) : Buffer.alloc(0);
  if (jpeg.length === 0) {
    throw new Error(`no frame decoded at ${formatOffset(offsetSeconds)}`);
  }
  return jpeg;
}

/**
 * Sample a gallery recording and fold the names into the meeting's attendance.
 *
 * Every frame is read before anything is written, so a model that fails halfway files nothing and
 * the next pass retries the whole recording, rather than half a meeting's attendance being stored
 * as if it were all of it. Returns how many attendance lines the frames produced.
 */
async function attachGallerySnapshots(
  service: ReturnType<typeof createAdminBotSqliteService>["service"],
  meeting: AdminBotMeetingRecord,
  videoPath: string,
  roster: Parameters<typeof snapshotUpdate>[2],
  vision: VisionConfig,
  scratch: string,
): Promise<number> {
  const duration =
    (await probeDurationSeconds(vision.ffmpeg, videoPath)) ?? meeting.duration_seconds;
  const offsets = snapshotOffsets(duration ?? 0, vision.intervalSeconds);
  if (offsets.length === 0) {
    throw new Error("recording length is unknown or zero; no frame to sample");
  }
  const readings: Array<{ offsetSeconds: number; reading: GalleryFrameReading }> = [];
  for (const offsetSeconds of offsets) {
    const framePath = path.join(scratch, `frame-${offsetSeconds}.jpg`);
    try {
      const jpeg = await extractFrame(vision.ffmpeg, videoPath, offsetSeconds, framePath);
      const reading = await readGalleryFrame(
        { jpeg, offsetSeconds },
        {
          fetchImpl: globalThis.fetch,
          baseUrl: vision.baseUrl,
          model: vision.model,
          ...(vision.apiKey ? { apiKey: vision.apiKey } : {}),
        },
      );
      readings.push({ offsetSeconds, reading });
    } finally {
      fs.rmSync(framePath, { force: true });
    }
  }
  const update = snapshotUpdate(meeting, readings, roster, vision.model, new Date().toISOString());
  const filed = service.upsertMeeting(update);
  if (!filed.ok) {
    throw new Error(filed.error.message);
  }
  return update.attendees?.length ?? 0;
}

export async function runMeetingArtifactPass(): Promise<ArtifactPassSummary> {
  const account = requireEnv("ADMINBOT_BOT_EMAIL");
  const folderId = requireEnv("ADMINBOT_MEETING_DROP_FOLDER_ID");
  const vision = visionConfig();
  const databasePath = adminbotServiceDatabasePath();
  const summary: ArtifactPassSummary = {
    found: 0,
    attached: 0,
    summarized: 0,
    snapshotted: 0,
    unmatched: [],
    deferred: [],
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
  // Transcripts, recordings and frames are written here and deleted in the finally below. A tmpdir
  // per pass rather than a fixed path so a crashed run leaves one identifiable directory instead of
  // a growing pile.
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
      if (kind === "gallery_video" && !vision) {
        summary.deferred.push(file.name);
        continue;
      }
      summary.found += 1;
      let localPath: string | undefined;
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
        if (kind === "gallery_video" && vision) {
          localPath = await downloadFile(file.id, scratch, account, VIDEO_DOWNLOAD_TIMEOUT_MS);
          await attachGallerySnapshots(service, meeting, localPath, roster, vision, scratch);
          summary.snapshotted += 1;
          summary.attached += 1;
          record(file, meeting.id, "attached");
          continue;
        }
        localPath = await downloadFile(file.id, scratch, account);
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
      } finally {
        // A recording is hundreds of megabytes; one pass can meet several, and the scratch
        // directory is only removed at the end.
        if (localPath) {
          fs.rmSync(localPath, { force: true });
        }
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
