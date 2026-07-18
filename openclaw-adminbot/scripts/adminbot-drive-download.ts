import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACCOUNT = "jinesis.adminbot@gmail.com";

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
  const gog =
    process.env.GOG_BIN ??
    (fs.existsSync("/home/akhkim/.local/bin/gog") ? "/home/akhkim/.local/bin/gog" : "gog");
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
        ACCOUNT,
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
