import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The Google account Drive is read as. Names a real mailbox, so it is deployment configuration. */
function account(): string {
  const value = process.env.ADMINBOT_BOT_EMAIL?.trim();
  if (!value) {
    throw new Error("ADMINBOT_BOT_EMAIL is not set — Drive downloads have no account to read as");
  }
  return value;
}

export function driveFileIds(text: string): string[] {
  const ids: string[] = [];
  const patterns = [
    /https?:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/giu,
    /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)/giu,
    /https?:\/\/drive\.google\.com\/open\?[^ \n]*\bid=([A-Za-z0-9_-]+)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) ids.push(match[1]);
    }
  }
  return [...new Set(ids)];
}

export async function downloadLinkedDriveFiles(text: string, directory: string): Promise<string[]> {
  // The service's systemd unit runs with a minimal PATH that misses the per-user install dir, so
  // fall back to it under $HOME before giving up on a bare lookup.
  const userGog = path.join(os.homedir(), ".local", "bin", "gog");
  const gog = process.env.GOG_BIN ?? (fs.existsSync(userGog) ? userGog : "gog");
  const files: string[] = [];
  for (const fileId of driveFileIds(text)) {
    const before = new Set(fs.readdirSync(directory));
    const result = await execFileAsync(
      gog,
      [
        "drive",
        "download",
        fileId,
        "--out",
        directory,
        "--overwrite",
        "--account",
        account(),
        "--json",
        "--results-only",
        "--no-input",
      ],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      },
    );
    const created = fs
      .readdirSync(directory)
      .filter((name) => !before.has(name))
      .map((name) => path.join(directory, name));
    if (created.length) {
      files.push(...created);
      continue;
    }
    const output = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
    const reported = String(output.path ?? output.file ?? output.output ?? "");
    if (reported && fs.existsSync(reported)) {
      files.push(reported);
      continue;
    }
    throw new Error(`Drive file ${fileId} downloaded without a discoverable output path`);
  }
  return files;
}
