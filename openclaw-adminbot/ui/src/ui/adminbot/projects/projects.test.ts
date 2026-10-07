import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import {
  openLanes,
  projectPath,
  projectRouteFromPath,
  venuePosition,
  type ProjectSummary,
} from "./model.ts";
import { renderProjectsNav, type ProjectsNavState } from "./nav.ts";

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    paper_id: "p1",
    title: "Synthetic Paper",
    current_step: "overleaf_writing",
    venue_targets: [],
    provided_count: 0,
    required_count: 20,
    lanes: {
      core: { open: 2, ready: 1 },
      venue: { open: 1, ready: 0 },
      archive: { open: 0, ready: 0 },
      talk: { open: 0, ready: 0 },
      social: { open: 0, ready: 0 },
    },
    todos: [],
    ...overrides,
  };
}

describe("project routes", () => {
  it("reads the card list, a project, and a project's lane tab from the path", () => {
    expect(projectRouteFromPath("/my-work")).toEqual({ paperId: null, tab: "project" });
    expect(projectRouteFromPath("/my-work/p%201")).toEqual({ paperId: "p 1", tab: "project" });
    expect(projectRouteFromPath("/my-work/p1/writing")).toEqual({ paperId: "p1", tab: "writing" });
    // An unknown lane still lands on the paper.
    expect(projectRouteFromPath("/my-work/p1/nonsense")).toEqual({ paperId: "p1", tab: "project" });
    expect(projectRouteFromPath("/ui/my-work/p1/social", "/ui")).toEqual({
      paperId: "p1",
      tab: "social",
    });
  });

  it("writes the same paths back", () => {
    expect(projectPath(null)).toBe("/my-work");
    expect(projectPath("p 1")).toBe("/my-work/p%201");
    expect(projectPath("p1", "venue", "/ui")).toBe("/ui/my-work/p1/venue");
  });
});

describe("project summaries", () => {
  it("names where the paper is aimed, most specific first", () => {
    expect(venuePosition(summary())).toBe("No venue picked yet");
    expect(venuePosition(summary({ venue: "EMNLP" }))).toBe("Aiming at EMNLP");
    expect(
      venuePosition(
        summary({
          venue_targets: [
            { venue_id: "iclr", label: "ICLR 2027", confidence: 99 },
            { venue_id: "neurips", label: "NeurIPS", confidence: 30 },
          ],
        }),
      ),
    ).toBe("99% ICLR 2027 · 30% NeurIPS");
    expect(venuePosition(summary({ venue_decision: "accept", venue: "ICLR" }))).toBe(
      "Accepted at ICLR",
    );
  });

  it("puts a dot only on lanes with open work", () => {
    expect(openLanes(summary()).map((entry) => entry.lane.branch)).toEqual(["core", "venue"]);
  });
});

describe("sidebar project list", () => {
  const container = document.createElement("div");
  afterEach(() => {
    render("", container);
    localStorage.clear();
  });

  function state(overrides: Partial<ProjectsNavState> = {}): ProjectsNavState {
    return {
      tab: "dashboard",
      basePath: "",
      memberId: "viewer",
      settings: { navCollapsed: false },
      myProjects: [summary(), summary({ paper_id: "p2", title: "Second", alias: "second" })],
      myProjectsChoosing: false,
      ...overrides,
    } as unknown as ProjectsNavState;
  }

  it("lists each project with a legend on every dot, and a ring where nothing can start yet", () => {
    render(renderProjectsNav(state()), container);
    const row = container.querySelector('[data-testid="projects-nav-p1"]');
    expect(row?.textContent).toContain("Synthetic Paper");
    const dots = [...(row?.querySelectorAll(".lane-dot") ?? [])];
    expect(dots.map((dot) => dot.getAttribute("data-legend"))).toEqual([
      "Writing: the draft, Overleaf, review fixes, a clean PDF. 2 open, 1 can be done now.",
      "Venue: the submission and the venue's decision. 1 open, waiting on earlier steps.",
    ]);
    expect(dots[1]?.classList.contains("lane-dot--waiting")).toBe(true);
    // The alias is the short name where there is one.
    expect(container.querySelector('[data-testid="projects-nav-p2"]')?.textContent).toContain(
      "second",
    );
  });

  it("hides an unticked paper from the list", () => {
    const choosing = state({ myProjectsChoosing: true });
    render(renderProjectsNav(choosing), container);
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    boxes[0]?.dispatchEvent(new Event("change"));
    render(renderProjectsNav(state()), container);
    expect(container.querySelector('[data-testid="projects-nav-p1"]')).toBeNull();
    expect(container.querySelector('[data-testid="projects-nav-p2"]')).not.toBeNull();
  });
});
