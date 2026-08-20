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

  // The archival split is the board's organising idea, and it is stamped by the collector rather
  // than re-derived per surface (see is_archival in scripts/adminbot_deadlines.py). A generator
  // that stopped emitting the field would leave every venue reading as non-archival, which is
  // silent: the board would still render, just with an empty archival column.
  it("stamps the archival classification onto every venue", () => {
    for (const venue of controlUiVenues) {
      expect(typeof venue.archival).toBe("boolean");
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
    // Workshops are never archival, whichever family they belong to.
    for (const venue of controlUiVenues.filter((candidate) => candidate.track === "workshop")) {
      expect(venue.archival).toBe(false);
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
