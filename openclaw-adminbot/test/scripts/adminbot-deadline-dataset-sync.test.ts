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
      expect(venue.group_label).toBe(source.group_label);
    }
  });

  it("carries the three independent venue classifications", () => {
    const entryTypes = new Set([
      "main_conference",
      "demo_track",
      "workshop",
      "arr_direct_submission",
      "arr_commitment",
      "rebuttal",
      "other",
    ]);
    for (const venue of controlUiVenues) {
      expect(entryTypes).toContain(venue.entry_type);
      expect(["archival", "non_archival", "unknown"]).toContain(venue.archival_status);
      expect(["primary", "secondary", "standard"]).toContain(venue.venue_priority);
    }
  });

  it("uses sortable AoE timestamps and keeps the list ordered by deadline", () => {
    const deadlines = venuesDoc.items.map((item) => item.deadline_aoe!);
    for (const deadline of deadlines) {
      expect(deadline).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    }
    // The reminder cadence walks this list in order, so ordering is behavior, not cosmetics.
    expect(deadlines).toEqual(deadlines.toSorted());
  });

  // Kept only for older non-display consumers. New surfaces use archival_status so false never
  // turns an unknown venue into a claim that it is non-archival.
  it("keeps the legacy archival boolean aligned with the tri-state classification", () => {
    for (const venue of controlUiVenues) {
      expect(typeof venue.archival).toBe("boolean");
      expect(venue.archival).toBe(venue.archival_status === "archival");
    }
    expect(controlUiVenues.some((venue) => venue.archival)).toBe(true);
  });

  it("only calls a venue archival when its family and track say so", () => {
    const ARR = ["ACL", "EMNLP", "NAACL", "EACL"];
    const ML = ["NeurIPS", "ICML", "ICLR", "COLM", "CLeaR"];
    for (const venue of controlUiVenues.filter((candidate) => candidate.archival)) {
      expect([...ARR, ...ML]).toContain(venue.venue_family);
      expect(["main", "demo"]).toContain(venue.track);
    }
    // Workshop status is not inferred from its entry type.
    for (const venue of controlUiVenues.filter((candidate) => candidate.track === "workshop")) {
      expect(venue.archival).toBe(false);
      expect(venue.archival_status).toBe("unknown");
      expect(venue.venue_priority).toBe("standard");
    }
  });

  it("tags each ARR-family entry with the route it opens", () => {
    const routed = controlUiVenues.filter((venue) => venue.submission_type);
    expect(routed.length).toBeGreaterThan(0);
    for (const venue of routed) {
      expect(["direct", "commitment"]).toContain(venue.submission_type);
    }
  });

  // Sub-deadlines are separate rows sharing a venue_group, which is what lets the board group them
  // under one conference and count down to each. A row whose stage is unclassified still renders,
  // but it sorts last and shows its raw label, so drift here is worth catching.
  it("classifies each row's sub-deadline stage", () => {
    const stages = new Set([
      "abstract",
      "direct_submission",
      "full_paper",
      "demo",
      "commitment",
      "rebuttal",
      "notification",
      "camera_ready",
      "",
    ]);
    for (const venue of controlUiVenues) {
      expect(stages).toContain(venue.milestone ?? "");
    }
    expect(controlUiVenues.some((venue) => venue.milestone)).toBe(true);
  });

  it("keeps a venue's sub-deadlines together under one group", () => {
    const iclr = controlUiVenues.filter((venue) => venue.venue_group === "ICLR 2027");
    // The full-paper date used to live inside the display name, where nothing could count down
    // to it. It is its own row now.
    expect(iclr.map((venue) => venue.milestone).toSorted()).toEqual(["abstract", "full_paper"]);
    expect(new Set(iclr.map((venue) => venue.deadline_aoe)).size).toBe(2);
  });

  it("gives every venue a unique id", () => {
    const ids = venuesDoc.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
