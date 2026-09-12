import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Read on each request: collection must not require rebuilding or restarting the service. */
export function readDeadlineDataset(
  file = process.env.ADMINBOT_DEADLINE_DATASET_PATH ??
    resolve("extensions/adminbot/content/deadlines/venues.json"),
): readonly unknown[] {
  const document = JSON.parse(readFileSync(file, "utf8")) as { items?: unknown[] };
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
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(row.deadline_aoe)
    ) {
      throw new Error("Invalid or duplicate deadline record");
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
