import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEADLINE_VENUES as pluginVenues } from "../../extensions/adminbot/src/workflows/deadlines/generated/dataset.js";
import {
  DEADLINE_VENUES as controlUiVenues,
  type DeadlineVenue,
} from "../../ui/src/ui/adminbot/data/deadlines.js";

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
) as { history_version: number; count: number; items: DeadlineVenue[] };

describe("AdminBot deadline dataset generation", () => {
  it("keeps venues.json self-consistent", () => {
    expect(venuesDoc.history_version).toBe(1);
    expect(venuesDoc.items).not.toHaveLength(0);
    expect(venuesDoc.count).toBe(venuesDoc.items.length);
  });

  it("preserves the NLP4PI workshop introduced by the original deadline PR", () => {
    const nlp4pi = venuesDoc.items.find((item) => item.id === "emnlp2026_ws_nlp4pi");
    expect(nlp4pi).toMatchObject({
      deadline_aoe: "2026-08-03 23:59:59",
      notification_aoe: "2026-08-15 23:59:59",
      submission_type: "commitment",
      venue_group: "EMNLP 2026 Workshops",
      openreview_url: "https://openreview.net/group?id=EMNLP/2026/Workshop/NLP4PI_ARR_Commitment",
    });
    expect(nlp4pi?.cfp_url).toMatch(/^https?:\/\//u);
  });

  it("keeps one current projection with dated history and explicit venue aliases", () => {
    const expired = venuesDoc.items.filter(
      (item) => Date.parse(item.deadline_aoe!.replace(" ", "T") + "-12:00") < Date.now(),
    );
    expect(expired.length).toBeGreaterThan(0);
    for (const item of venuesDoc.items) {
      expect(item.deadline_id).toBe(item.id);
      expect(item.venue_id).toBeTruthy();
      expect(item.venue_aliases).toContain(item.deadline_id);
      expect(item.venue_aliases).toContain(item.venue_id);
      expect(item.revisions.length).toBeGreaterThan(0);
      expect(item.revisions.at(-1)?.deadline_aoe).toBe(item.deadline_aoe);
      expect(typeof item.stale).toBe("boolean");
    }
  });

  it("retains a real changed deadline without treating source-link updates as revisions", () => {
    const revised = venuesDoc.items.filter((item) => item.revisions.length > 1);
    expect(revised).toHaveLength(1);
    expect(revised[0]).toMatchObject({
      id: "emnlp2026_ws_MINT_ARR_Commitment",
      deadline_aoe: "2026-08-31 23:59:00",
    });
    expect(revised[0]?.revisions.map((revision) => revision.deadline_aoe)).toEqual([
      "2026-08-24 23:59:00",
      "2026-08-31 23:59:00",
    ]);
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
      expect(["archival", "non_archival", "mixed", "unknown"]).toContain(venue.archival_status);
      expect(["primary", "secondary", "standard"]).toContain(venue.venue_priority);
    }
  });

  it("supplies unambiguous labels for workshop groups", () => {
    const labels = new Set(
      controlUiVenues
        .filter((venue) => venue.entry_type === "workshop")
        .map((venue) => venue.venue_group),
    );
    expect(labels).toContain("EMNLP 2026 Workshops");
    expect(labels).toContain("NeurIPS 2026 Workshops");
    expect(labels).not.toContain("EMNLP 2026");
    expect(labels).not.toContain("NeurIPS 2026");
  });

  it("stores workshop title, OpenReview, and provenance links separately", () => {
    const workshops = controlUiVenues.filter((venue) => venue.entry_type === "workshop");
    expect(workshops.length).toBeGreaterThan(0);
    for (const workshop of workshops) {
      expect(workshop.cfp_url || workshop.homepage_url).toMatch(/^https?:\/\//u);
      expect(workshop.openreview_url).toMatch(/^https:\/\/openreview\.net\/group\?id=/u);
      expect(workshop.source_url).toBe(workshop.openreview_url);
      expect(workshop.source_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/u);
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
  // turns an unresolved venue into a claim that it is non-archival.
  it("keeps the legacy archival boolean aligned with the explicit classification", () => {
    for (const venue of controlUiVenues) {
      expect(typeof venue.archival).toBe("boolean");
      expect(venue.archival).toBe(venue.archival_status === "archival");
    }
    expect(controlUiVenues.some((venue) => venue.archival)).toBe(true);
  });

  it("keeps conference policy separate from source-established workshop policy", () => {
    const ARR = ["ACL", "EMNLP", "NAACL", "EACL", "AACL"];
    const ML = ["NeurIPS", "ICML", "ICLR", "COLM", "CLeaR"];
    for (const venue of controlUiVenues.filter(
      (candidate) => candidate.archival && candidate.track !== "workshop",
    )) {
      expect([...ARR, ...ML]).toContain(venue.venue_family);
      expect(["main", "demo"]).toContain(venue.track);
    }
    const workshops = controlUiVenues.filter((candidate) => candidate.track === "workshop");
    for (const venue of workshops) {
      expect(["archival", "non_archival", "mixed", "unknown"]).toContain(venue.archival_status);
      expect(venue.venue_priority).toBe("standard");
    }
    expect(workshops.some((venue) => venue.archival_status === "mixed")).toBe(true);
    expect(workshops.some((venue) => venue.archival_status === "unknown")).toBe(false);
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
