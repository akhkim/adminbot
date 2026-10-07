import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

let cached: { file: string; version: string; items: readonly unknown[] } | undefined;

/**
 * Checked on each request: collection must not require rebuilding or restarting the service.
 *
 * Only a stat is paid per call. The parse and validation re-run when the file's inode, size or
 * nanosecond mtime moves -- an atomic rename-replace always changes the inode -- and an invalid file
 * is never cached, so it keeps throwing until it is fixed.
 */
export function readDeadlineDataset(
  file = process.env.ADMINBOT_DEADLINE_DATASET_PATH ??
    resolve("extensions/adminbot/content/deadlines/deadlines.json"),
): readonly unknown[] {
  const stat = statSync(file, { bigint: true });
  const version = `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  if (cached?.file === file && cached.version === version) {
    return cached.items;
  }
  const items = parseDeadlineDataset(readFileSync(file, "utf8"));
  cached = { file, version, items };
  return items;
}

function parseDeadlineDataset(text: string): readonly unknown[] {
  const document = JSON.parse(text) as { items?: unknown[] };
  if (!Array.isArray(document.items) || !document.items.length) {
    throw new Error("Deadline dataset is empty or invalid");
  }
  const ids = new Set<string>();
  for (const item of document.items) {
    if (!item || typeof item !== "object") {
      throw new Error("Invalid deadline record");
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !row.id.trim() ||
      ids.has(row.id) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      typeof row.deadline_aoe !== "string" ||
      (!(row.deadline_aoe === "" && row.venue_type === "workshop") &&
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(row.deadline_aoe))
    ) {
      throw new Error("Invalid or duplicate deadline record");
    }
    if (row.deadline_aoe === "") {
      ids.add(row.id);
      continue;
    }
    const instant = new Date(row.deadline_aoe.replace(" ", "T") + "Z");
    if (
      !Number.isFinite(instant.getTime()) ||
      instant.toISOString().slice(0, 19).replace("T", " ") !== row.deadline_aoe
    ) {
      throw new Error("Invalid deadline date");
    }
    ids.add(row.id);
  }
  return document.items;
}
