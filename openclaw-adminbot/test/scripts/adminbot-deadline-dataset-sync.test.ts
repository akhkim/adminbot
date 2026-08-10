import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEADLINE_VENUES as pluginVenues } from "../../extensions/adminbot/src/workflows/deadlines/generated/dataset.js";
import { DEADLINE_VENUES as controlUiVenues } from "../../ui/src/ui/adminbot/data/deadlines.js";

// venues.json is the source of truth; both TS modules are generated from it by
// scripts/adminbot-deadline-collect.py. They drifted once already — the plugin dataset sat at 78
// venues while the collector's own output had 106 — and nothing failed, because no test compared
// them. Regenerate with `python3 scripts/adminbot-deadline-collect.py` rather than hand-editing.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const venuesDoc = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "extensions", "adminbot", "content", "deadlines", "venues.json"),
    "utf8",
  ),
) as { count: number; items: Array<Record<string, string>> };

describe("AdminBot deadline dataset generation", () => {
  it("keeps venues.json self-consistent", () => {
    expect(venuesDoc.items).not.toHaveLength(0);
    expect(venuesDoc.count).toBe(venuesDoc.items.length);
  });

  it("keeps both generated datasets in step with venues.json", () => {
    expect(pluginVenues.map((venue) => venue.id)).toEqual(venuesDoc.items.map((item) => item.id));
    expect(controlUiVenues.map((venue) => venue.id)).toEqual(
      venuesDoc.items.map((item) => item.id),
    );
  });

  it("carries every field the Control UI renders", () => {
    for (const [index, venue] of controlUiVenues.entries()) {
      const source = venuesDoc.items[index]!;
      expect(venue.name).toBe(source.name);
      expect(venue.deadline_aoe).toBe(source.deadline_aoe);
      expect(venue.venue_group).toBe(source.venue_group);
    }
  });

  it("uses sortable AoE timestamps and keeps the list ordered by deadline", () => {
    const deadlines = venuesDoc.items.map((item) => item.deadline_aoe!);
    for (const deadline of deadlines) {
      expect(deadline).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    }
    // The reminder cadence walks this list in order, so ordering is behavior, not cosmetics.
    expect(deadlines).toEqual([...deadlines].sort());
  });

  it("gives every venue a unique id", () => {
    const ids = venuesDoc.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
