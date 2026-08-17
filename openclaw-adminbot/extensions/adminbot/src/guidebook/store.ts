/**
 * On-disk home for the guidebook index.
 *
 * The index holds verbatim guidebook text, so it is written with the same care as
 * a credential file: owner-only mode, outside the repo, and never logged. It lives
 * beside the other AdminBot local state rather than in the workspace, so a
 * `git archive` deploy cannot pick it up.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GuidebookIndex } from "./types.js";

const OWNER_ONLY = 0o600;

export function resolveGuidebookIndexPath(override?: string): string {
  const configured = override?.trim() || process.env.ADMINBOT_GUIDEBOOK_INDEX?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".openclaw", "adminbot-guidebook", "index.json");
}

export async function readGuidebookIndex(indexPath: string): Promise<GuidebookIndex | null> {
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as GuidebookIndex;
  if (parsed?.version !== 1 || !Array.isArray(parsed.chunks)) {
    throw new Error(`guidebook index at ${indexPath} is not a version 1 index`);
  }
  return parsed;
}

export async function writeGuidebookIndex(indexPath: string, index: GuidebookIndex): Promise<void> {
  await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  await writeFile(indexPath, `${JSON.stringify(index)}\n`, { encoding: "utf8", mode: OWNER_ONLY });
  // writeFile only applies mode when it creates the file; an existing index keeps
  // whatever mode it had, so set it explicitly every time.
  await chmod(indexPath, OWNER_ONLY);
}
