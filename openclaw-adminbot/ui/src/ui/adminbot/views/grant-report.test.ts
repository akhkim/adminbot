/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { SAFETY_AREA_IDS } from "../grant-report/areas.ts";
import {
  allTrackRecordsMarkdown,
  areaCounts,
  areaMapMarkdown,
  fullReportMarkdown,
  papersForArea,
  papersForSection,
  pipelinePapers,
  unmappedPapers,
} from "../grant-report/linkage.ts";
import { GRANT_PAPERS } from "../grant-report/papers.ts";
import {
  classifyRecord,
  inferPlacement,
  needsReview,
  resolvePapers,
  titleKey,
} from "../grant-report/resolve.ts";
import { GRANT_SECTIONS, GRANT_SECTION_BY_ID } from "../grant-report/sections.ts";
import { renderGrantReport } from "./grant-report.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function record(partial: Partial<AdminBotPaperRecord> & { title: string }): AdminBotPaperRecord {
  return {
    id: partial.id ?? partial.title,
    title: partial.title,
    authors: partial.authors ?? [],
    current_step: partial.current_step ?? ("idea" as AdminBotPaperRecord["current_step"]),
    ...partial,
  } as AdminBotPaperRecord;
}

async function renderView(papers: readonly AdminBotPaperRecord[] = []): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderGrantReport({ papers }), container);
  await (
    container.querySelector("adminbot-grant-report-view") as { updateComplete?: Promise<unknown> }
  )?.updateComplete;
  return container;
}

const SNAPSHOT = resolvePapers([]);

describe("grant report data", () => {
  it("gives every snapshot paper a unique id", () => {
    const ids = GRANT_PAPERS.map((paper) => paper.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only assigns areas the taxonomy defines", () => {
    for (const paper of GRANT_PAPERS) {
      for (const area of paper.areas) {
        expect(SAFETY_AREA_IDS).toContain(area);
      }
    }
  });

  // The two data files are edited independently, and a section renamed on one side would otherwise
  // silently drop its papers from the report rather than failing.
  it("only assigns sections the proposal tree defines", () => {
    for (const paper of GRANT_PAPERS) {
      for (const section of paper.sections) {
        expect(GRANT_SECTION_BY_ID[section], `${paper.id} -> ${section}`).toBeDefined();
      }
    }
  });

  it("points every child section at a parent that exists", () => {
    for (const section of GRANT_SECTIONS) {
      if (section.parent) {
        expect(GRANT_SECTION_BY_ID[section.parent], section.id).toBeDefined();
      }
    }
  });

  it("gives every section a track record with at least two bullets", () => {
    for (const section of GRANT_SECTIONS) {
      expect(section.trackRecord.lede.length, section.id).toBeGreaterThan(0);
      expect(section.trackRecord.bullets.length, section.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("leaves no leaf section of the technical agenda without papers", () => {
    for (const section of GRANT_SECTIONS.filter((s) => s.depth > 2)) {
      expect(papersForSection(SNAPSHOT, section.id).length, section.id).toBeGreaterThan(0);
    }
  });
});

describe("resolvePapers", () => {
  it("falls back to the whole snapshot when the store is empty", () => {
    expect(resolvePapers([]).length).toBe(GRANT_PAPERS.length);
    expect(resolvePapers([]).every((paper) => paper.fromSnapshot)).toBe(true);
  });

  // The point of the whole change: a paper added to the store shows up without anyone editing code.
  it("includes a paper the store has that the snapshot does not", () => {
    const resolved = resolvePapers([record({ title: "A Brand New Interpretability Paper" })]);
    const added = resolved.find((paper) => paper.title === "A Brand New Interpretability Paper");
    expect(added).toBeDefined();
    expect(added!.fromSnapshot).toBe(false);
  });

  it("does not list a paper twice when the store and the snapshot both have it", () => {
    const title = GRANT_PAPERS.find((paper) => !paper.published)!.title;
    const resolved = resolvePapers([record({ title })]);
    const matches = resolved.filter((paper) => titleKey(paper.title) === titleKey(title));
    expect(matches.length).toBe(1);
    expect(matches[0].fromSnapshot).toBe(false);
  });

  it("matches a store title to the snapshot through case and punctuation", () => {
    const curated = GRANT_PAPERS.find((paper) => paper.areas.length > 0 && !paper.published)!;
    const noisy = `${curated.title.toUpperCase()}!!`;
    const classified = classifyRecord(record({ title: noisy }));
    expect(classified.origin).toBe("curated");
    expect(classified.areas).toEqual(curated.areas);
  });

  it("keeps published prior work even when the store never carries it", () => {
    const resolved = resolvePapers([record({ title: "Something Else Entirely" })]);
    const published = resolved.filter((paper) => paper.published);
    expect(published.length).toBe(GRANT_PAPERS.filter((paper) => paper.published).length);
  });

  it("prefers the store's venue and authors over the sheet's note", () => {
    const curated = GRANT_PAPERS.find((paper) => !paper.published)!;
    const classified = classifyRecord(
      record({ title: curated.title, venue: "ICLR 2027", authors: ["Ada", "Grace"] }),
    );
    expect(classified.venue).toBe("ICLR 2027");
    expect(classified.authors).toBe("Ada, Grace");
  });
});

describe("inferPlacement", () => {
  it("guesses interpretability from the title", () => {
    const guess = inferPlacement("Sparse Autoencoder Probes for Refusal Circuits", "NeurIPS");
    expect(guess.areas).toContain("whiteBox");
    expect(guess.sections).toContain("p1.1.5");
  });

  it("guesses adversarial defense from the title", () => {
    const guess = inferPlacement("Tamper-Resistant Unlearning for Open-Weight Models", "");
    expect(guess.sections).toContain("p1.1.3");
  });

  it("returns nothing for a title it does not recognise", () => {
    const guess = inferPlacement("A Study of Widget Assembly Throughput", "");
    expect(guess.areas).toEqual([]);
    expect(guess.sections).toEqual([]);
  });

  it("marks an unrecognised store paper unclassified rather than dropping it", () => {
    const classified = classifyRecord(record({ title: "A Study of Widget Assembly Throughput" }));
    expect(classified.origin).toBe("unclassified");
    const resolved = resolvePapers([record({ title: "A Study of Widget Assembly Throughput" })]);
    expect(resolved.some((paper) => paper.origin === "unclassified")).toBe(true);
  });

  it("marks a rule-matched store paper inferred, never curated", () => {
    const classified = classifyRecord(record({ title: "Probing Latent Deception Circuits" }));
    expect(classified.origin).toBe("inferred");
    expect(needsReview([classified]).length).toBe(1);
  });
});

describe("linkage", () => {
  it("rolls a child section's papers up into its parent", () => {
    const child = papersForSection(SNAPSHOT, "p1.1.1.A");
    const parent = papersForSection(SNAPSHOT, "p1.1.1");
    expect(child.length).toBeGreaterThan(0);
    for (const paper of child) {
      expect(parent.map((p) => p.id)).toContain(paper.id);
    }
  });

  it("counts a paper in each area it belongs to", () => {
    const multi = SNAPSHOT.find((paper) => paper.areas.length > 1);
    expect(multi).toBeDefined();
    for (const area of multi!.areas) {
      expect(papersForArea(SNAPSHOT, area).map((p) => p.id)).toContain(multi!.id);
    }
  });

  it("keeps published prior work out of the pipeline count", () => {
    expect(pipelinePapers(SNAPSHOT).every((paper) => !paper.published)).toBe(true);
    expect(pipelinePapers(SNAPSHOT).length).toBeLessThan(SNAPSHOT.length);
  });

  it("reports unmapped papers rather than hiding them", () => {
    const unmapped = unmappedPapers(SNAPSHOT);
    expect(unmapped.length).toBeGreaterThan(0);
    expect(unmapped.every((paper) => paper.sections.length === 0)).toBe(true);
  });

  it("orders area counts largest first", () => {
    const counts = areaCounts(SNAPSHOT).map((row) => row.count);
    expect(counts.toSorted((a, b) => b - a)).toEqual(counts);
  });
});

describe("markdown export", () => {
  it("emits one table row per paper", () => {
    const lines = areaMapMarkdown(SNAPSHOT).split("\n");
    // Two header lines, then one row per paper.
    expect(lines.length).toBe(SNAPSHOT.length + 2);
  });

  // An unconfirmed guess must never reach a funding document looking like a considered judgment.
  it("flags an inferred placement in the exported table", () => {
    const resolved = resolvePapers([record({ title: "Probing Latent Deception Circuits" })]);
    const markdown = areaMapMarkdown(resolved);
    expect(markdown).toContain("Probing Latent Deception Circuits _(inferred — confirm)_");
    expect(fullReportMarkdown(resolved)).toContain("placements are inferred and unconfirmed");
  });

  it("says so plainly when every placement is curated", () => {
    expect(fullReportMarkdown(SNAPSHOT)).toContain("All placements are curated.");
  });

  it("emits a track record block for every section", () => {
    const markdown = allTrackRecordsMarkdown();
    for (const section of GRANT_SECTIONS) {
      expect(markdown).toContain(`${section.number}: ${section.title}`);
    }
    expect(markdown.match(/\*\*Track record\*\*/gu)?.length).toBe(GRANT_SECTIONS.length);
  });

  it("renders a bullet's links inline, in the proposal's format", () => {
    const markdown = allTrackRecordsMarkdown();
    expect(markdown).toContain("[arXiv:2605.23055](https://arxiv.org/abs/2605.23055)");
    expect(markdown).toContain("  - **");
  });

  it("carries provenance into the full report", () => {
    const markdown = fullReportMarkdown(SNAPSHOT);
    expect(markdown).toContain("Jinesis Contact/Paper list with Zhijing");
    expect(markdown).toContain("Task 1 — Papers mapped to the six areas");
    expect(markdown).toContain("Task 2 — Track record by proposal section");
  });
});

describe("renderGrantReport", () => {
  it("opens on the area map with all six areas", async () => {
    const container = await renderView();
    expect(container.querySelectorAll(".gr-area").length).toBe(SAFETY_AREA_IDS.length);
    expect(container.textContent).toContain("make it want the right thing");
  });

  it("renders a paper the store just added", async () => {
    const container = await renderView([record({ title: "A Brand New Interpretability Paper" })]);
    expect(container.textContent).toContain("A Brand New Interpretability Paper");
  });

  it("warns when placements are unconfirmed, and stays quiet when they are not", async () => {
    const clean = await renderView();
    expect(clean.querySelector(".gr-banner")).toBeNull();

    document.body.innerHTML = "";
    const dirty = await renderView([record({ title: "Probing Latent Deception Circuits" })]);
    expect(dirty.querySelector(".gr-banner")).not.toBeNull();
    expect(dirty.textContent).toContain("inferred — confirm");
  });

  it("filters the paper list to one area when that area is clicked", async () => {
    const container = await renderView();
    const view = container.querySelector("adminbot-grant-report-view") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    const before = container.querySelectorAll(".gr-paper").length;
    (container.querySelectorAll(".gr-area")[0] as HTMLButtonElement).click();
    await view.updateComplete;
    const after = container.querySelectorAll(".gr-paper").length;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  it("shows the track record panel with the proposal's sections", async () => {
    const container = await renderView();
    const view = container.querySelector("adminbot-grant-report-view") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    (container.querySelectorAll(".gr-panel-tab")[1] as HTMLButtonElement).click();
    await view.updateComplete;
    expect(container.querySelectorAll(".gr-section").length).toBe(GRANT_SECTIONS.length);

    (container.querySelector(".gr-section-head") as HTMLButtonElement).click();
    await view.updateComplete;
    expect(container.querySelector(".gr-tr")).not.toBeNull();
    expect(container.textContent).toContain("Track record");
  });

  it("lists the papers awaiting confirmation on the coverage panel", async () => {
    const container = await renderView([record({ title: "Probing Latent Deception Circuits" })]);
    const view = container.querySelector("adminbot-grant-report-view") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    (container.querySelectorAll(".gr-panel-tab")[2] as HTMLButtonElement).click();
    await view.updateComplete;
    expect(container.textContent).toContain("Awaiting confirmation");
    expect(container.textContent).toContain("Lab output the technical agenda does not claim");
    expect(container.querySelectorAll(".gr-stat").length).toBe(4);
  });
});
