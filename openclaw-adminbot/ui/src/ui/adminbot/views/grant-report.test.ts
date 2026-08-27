/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
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
import { GRANT_SECTIONS, GRANT_SECTION_BY_ID } from "../grant-report/sections.ts";
import { renderGrantReport } from "./grant-report.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

async function renderView(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderGrantReport(), container);
  await (
    container.querySelector("adminbot-grant-report-view") as {
      updateComplete?: Promise<unknown>;
    }
  )?.updateComplete;
  return container;
}

describe("grant report data", () => {
  it("gives every paper a unique id", () => {
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
      expect(papersForSection(section.id).length, section.id).toBeGreaterThan(0);
    }
  });
});

describe("linkage", () => {
  it("rolls a child section's papers up into its parent", () => {
    const child = papersForSection("p1.1.1.A");
    const parent = papersForSection("p1.1.1");
    expect(child.length).toBeGreaterThan(0);
    for (const paper of child) {
      expect(parent.map((p) => p.id)).toContain(paper.id);
    }
  });

  it("counts a paper in each area it belongs to", () => {
    const multi = GRANT_PAPERS.find((paper) => paper.areas.length > 1);
    expect(multi).toBeDefined();
    for (const area of multi!.areas) {
      expect(papersForArea(area).map((p) => p.id)).toContain(multi!.id);
    }
  });

  it("keeps published prior work out of the pipeline count", () => {
    expect(pipelinePapers().every((paper) => !paper.published)).toBe(true);
    expect(pipelinePapers().length).toBeLessThan(GRANT_PAPERS.length);
  });

  it("reports unmapped papers rather than hiding them", () => {
    const unmapped = unmappedPapers();
    expect(unmapped.length).toBeGreaterThan(0);
    expect(unmapped.every((paper) => paper.sections.length === 0)).toBe(true);
  });

  it("orders area counts largest first", () => {
    const counts = areaCounts().map((row) => row.count);
    expect(counts.toSorted((a, b) => b - a)).toEqual(counts);
  });
});

describe("markdown export", () => {
  it("emits one table row per paper", () => {
    const lines = areaMapMarkdown().split("\n");
    // Two header lines, then one row per paper.
    expect(lines.length).toBe(GRANT_PAPERS.length + 2);
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
    const markdown = fullReportMarkdown();
    expect(markdown).toContain("Jinesis Contact/Paper list with Zhijing");
    expect(markdown).toContain("Task 1 — Papers mapped to the six areas");
    expect(markdown).toContain("Task 2 — Track record by proposal section");
  });
});

describe("renderGrantReport", () => {
  it("opens on the area map with all six areas", async () => {
    const container = await renderView();
    const areas = container.querySelectorAll(".gr-area");
    expect(areas.length).toBe(SAFETY_AREA_IDS.length);
    expect(container.textContent).toContain("make it want the right thing");
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

  it("shows the coverage panel with the unclaimed papers", async () => {
    const container = await renderView();
    const view = container.querySelector("adminbot-grant-report-view") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    (container.querySelectorAll(".gr-panel-tab")[2] as HTMLButtonElement).click();
    await view.updateComplete;
    expect(container.textContent).toContain("Lab output the technical agenda does not claim");
    expect(container.querySelectorAll(".gr-stat").length).toBe(4);
  });
});
