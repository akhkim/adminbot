import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { toggleHiddenPaper } from "../hidden-papers.ts";
import {
  openLanes,
  ownPapers,
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

  it("keeps the paper disclosure open across list updates", () => {
    const host = state();
    render(renderProjectsNav(host), container);
    const disclosure = container.querySelector("details")!;
    expect(disclosure.open).toBe(false);
    container.querySelector("summary")!.click();
    expect(disclosure.open).toBe(true);
    host.myProjects = [...(host.myProjects ?? [])];
    render(renderProjectsNav(host), container);
    expect(container.querySelector("details")).toBe(disclosure);
    expect(disclosure.open).toBe(true);
  });

  it("leaves out a paper hidden on My Work, and has no hiding control of its own", () => {
    toggleHiddenPaper("viewer", "p1");
    render(renderProjectsNav(state()), container);
    expect(container.querySelector('[data-testid="projects-nav-p1"]')).toBeNull();
    expect(container.querySelector('[data-testid="projects-nav-p2"]')).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain("Choose papers");
  });

  it("sorts by start date, acceptance, then displayed name", () => {
    const projects = [
      summary({ paper_id: "undated", title: "Undated" }),
      summary({
        paper_id: "accepted",
        title: "Accepted",
        started_on: "2026-10-01",
        venue_decision: "accept",
      }),
      summary({ paper_id: "zebra", title: "Zebra", started_on: "2026-10-01" }),
      summary({
        paper_id: "newest",
        title: "Newest",
        started_on: "2026-10-02",
        venue_decision: "accept",
      }),
      summary({
        paper_id: "alias",
        title: "Last title",
        alias: "alpha",
        started_on: "2026-10-01",
      }),
      summary({ paper_id: "older", title: "Older", started_on: "2026-09-30" }),
    ];
    const originalOrder = projects.map((p) => p.paper_id);
    render(renderProjectsNav(state({ myProjects: projects })), container);
    const labels = container.querySelectorAll(".projects-nav__name");
    expect([...labels].map((el) => el.textContent?.trim())).toEqual([
      "Newest",
      "alpha",
      "Zebra",
      "Accepted",
      "Older",
      "Undated",
    ]);
    expect(projects.map((p) => p.paper_id)).toEqual(originalOrder);
  });
});
describe("ownPapers — whose paper is it", () => {
  function stateWith(authors: string[], memberName: string) {
    return {
      memberId: "me",
      adminBotData: {
        members: [{ id: "me", name: memberName, privilege_level: "member", access: [] }],
        papers: [
          {
            id: "p1",
            title: "Preserving Historical Truth",
            authors,
            current_step: "arxiv_polish",
            submitted_by_member_id: "someone-else",
          },
        ],
      },
    } as never;
  }

  it("finds a paper where the author list marks equal contribution", () => {
    // Regression: a co-first author could not see their own paper, because the venue's asterisk
    // made the name compare unequal to the roster's.
    const papers = ownPapers(stateWith(["Francesco Ortu*", "Joeun Yook*"], "Joeun Yook"));
    expect(papers.map((p) => p.title)).toEqual(["Preserving Historical Truth"]);
  });

  it("finds a paper listing the name with an accent the roster omits", () => {
    expect(ownPapers(stateWith(["Bernhard Schölkopf"], "Bernhard Scholkopf"))).toHaveLength(1);
  });

  it("does not claim somebody else's paper", () => {
    expect(ownPapers(stateWith(["Andrew Yook", "Jane Doe"], "Joeun Yook"))).toHaveLength(0);
  });

  // The point of the recorded links: a paper one coauthor files shows up for all of them, whatever
  // the paper happens to call them.
  it("shows a coauthor a paper somebody else filed, by recorded link rather than by spelling", () => {
    const state = {
      memberId: "andrew-kim",
      adminBotData: {
        members: [{ id: "andrew-kim", name: "Andrew Kim", privilege_level: "member", access: [] }],
        papers: [
          {
            id: "adminbot",
            title: "AdminBot",
            // The printed list spells him a way the roster does not, and he did not file it.
            authors: ["Joeun Yook*", "A. K. Kim", "Zhijing Jin"],
            author_links: [
              { name: "Joeun Yook*", member_id: "joeun-yook" },
              { name: "A. K. Kim", member_id: "andrew-kim" },
              { name: "Zhijing Jin", member_id: "zhijing-jin" },
            ],
            current_step: "brainstorming_docs",
            submitted_by_member_id: "joeun-yook",
          },
        ],
      },
    } as never;
    expect(ownPapers(state).map((paper) => paper.title)).toEqual(["AdminBot"]);
  });

  it("does not show a paper to an external coauthor's address", () => {
    const state = {
      memberId: "bs@tue.mpg.de",
      adminBotData: {
        members: [{ id: "bs@tue.mpg.de", name: "Bernhard", privilege_level: "member", access: [] }],
        papers: [
          {
            id: "adminbot",
            title: "AdminBot",
            authors: ["Joeun Yook", "Bernhard Schölkopf"],
            // An external is an email on the paper, never a member id, so nothing keys off them.
            author_links: [
              { name: "Joeun Yook", member_id: "joeun-yook" },
              { name: "Bernhard Schölkopf", email: "bs@tue.mpg.de" },
            ],
            current_step: "brainstorming_docs",
            submitted_by_member_id: "joeun-yook",
          },
        ],
      },
    } as never;
    expect(ownPapers(state)).toHaveLength(0);
  });
});
