/* @vitest-environment jsdom */
// My Desk: what lands in each queue, and what does not.
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { LogisticsRequest, MemberProfileOverviewRow } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import {
  overleafReadingQueue,
  recLetterQueue,
  renderProfessorView,
  thinTimelines,
  type ProfessorViewProps,
} from "./professor.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function request(fields: Partial<LogisticsRequest> & { id: string }): LogisticsRequest {
  return {
    kind: "recommendation_letters",
    member_id: "mei",
    member_name: "Mei Chen",
    status: "submitted",
    submitted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...fields,
  } as LogisticsRequest;
}

function paper(fields: Partial<AdminBotPaperRecord> & { id: string }): AdminBotPaperRecord {
  return {
    title: `Paper ${fields.id}`,
    authors: ["Mei Chen"],
    current_step: "overleaf_writing",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...fields,
  } as AdminBotPaperRecord;
}

function profile(fields: Partial<MemberProfileOverviewRow> & { id: string }) {
  return {
    name: `Member ${fields.id}`,
    privilege_level: "member",
    missing_fields: [],
    filled_field_count: 12,
    self_filled_field_count: 12,
    projects: { total: 0, self_updated: 0 },
    timeline: { availability: 0, time_off: 0, milestones: 0, trips: 0, total: 5 },
    ...fields,
  } as MemberProfileOverviewRow;
}

function draw(overrides: Partial<ProfessorViewProps> = {}) {
  const opened: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderProfessorView({
      requests: [],
      requestsLoading: false,
      papers: [],
      profiles: [],
      adoption: null,
      pendingProposals: 0,
      onOpen: (tab) => opened.push(tab),
      ...overrides,
    }),
    container,
  );
  return { container, opened };
}

describe("recLetterQueue", () => {
  it("keeps what is still waiting on the lab, soonest first", () => {
    const queue = recLetterQueue([
      request({ id: "late", deadline_at: "2026-06-01T00:00:00Z" }),
      request({ id: "soon", deadline_at: "2026-02-01T00:00:00Z" }),
      // Nobody is waiting on these any more.
      request({ id: "done", status: "completed", deadline_at: "2026-01-01T00:00:00Z" }),
      request({ id: "gone", status: "withdrawn", deadline_at: "2026-01-02T00:00:00Z" }),
      // A different kind of request entirely.
      request({ id: "sig", kind: "document_signature" }),
    ]);
    expect(queue.map((entry) => entry.id)).toEqual(["soon", "late"]);
  });

  it("puts a request with no deadline last rather than first", () => {
    const queue = recLetterQueue([
      request({ id: "undated" }),
      request({ id: "dated", deadline_at: "2026-02-01T00:00:00Z" }),
    ]);
    expect(queue.map((entry) => entry.id)).toEqual(["dated", "undated"]);
  });
});

describe("overleafReadingQueue", () => {
  it("takes drafts that are readable and not yet submitted", () => {
    const queue = overleafReadingQueue([
      paper({ id: "ready", artifacts: { overleaf_edit_url: "https://overleaf.com/project/1" } }),
      // No link: nothing to read.
      paper({ id: "nolink" }),
      // Past submission: reading it now is a different, slower kind of useful.
      paper({
        id: "submitted",
        current_step: "arxiv_polish",
        artifacts: { overleaf_edit_url: "https://overleaf.com/project/2" },
      }),
    ]);
    expect(queue.map((entry) => entry.paper.id)).toEqual(["ready"]);
  });

  it("falls back to the read-only link, and sorts by deadline", () => {
    const queue = overleafReadingQueue([
      paper({
        id: "later",
        deadline: "2026-09-01",
        artifacts: { overleaf_view_url: "https://overleaf.com/read/a" },
      }),
      paper({
        id: "sooner",
        deadline: "2026-03-01",
        artifacts: { overleaf_edit_url: "https://overleaf.com/project/b" },
      }),
    ]);
    expect(queue.map((entry) => entry.paper.id)).toEqual(["sooner", "later"]);
    expect(queue[1]?.url).toBe("https://overleaf.com/read/a");
  });
});

describe("thinTimelines", () => {
  it("lists the emptiest first, and leaves a planned term alone", () => {
    const thin = thinTimelines([
      profile({ id: "full" }),
      profile({
        id: "empty",
        timeline: { availability: 0, time_off: 0, milestones: 0, trips: 0, total: 0 },
      }),
      profile({
        id: "some",
        timeline: { availability: 1, time_off: 0, milestones: 0, trips: 0, total: 1 },
      }),
    ]);
    expect(thin.map((row) => row.id)).toEqual(["empty", "some"]);
  });
});

describe("renderProfessorView", () => {
  it("shows all five queues with their counts", () => {
    const { container } = draw();
    for (const id of ["letters", "drafts", "adoption", "timelines", "approvals"]) {
      expect(container.querySelector(`[data-testid="professor-${id}"]`), id).not.toBeNull();
    }
  });

  it("goes quiet at zero, and loud when something is waiting", () => {
    const empty = draw().container.querySelector<HTMLElement>(
      '[data-testid="professor-letters"] .professor__count',
    );
    expect(empty?.dataset.empty).toBe("true");

    const busy = draw({
      requests: [request({ id: "a", deadline_at: "2026-02-01T00:00:00Z" })],
    }).container.querySelector<HTMLElement>('[data-testid="professor-letters"] .professor__count');
    expect(busy?.dataset.empty).toBe("false");
    expect(busy?.textContent?.trim()).toBe("1");
  });

  it("links each queue at the page that does the work", () => {
    // It aggregates and links; it does not re-implement. Every section has a way through.
    const { container, opened } = draw();
    for (const [id, tab] of [
      ["letters", "adminbotRecLetters"],
      ["drafts", "adminbotPapers"],
      ["adoption", "adminbotProfileOverview"],
      ["timelines", "adminbotTimeAvailability"],
      ["approvals", "adminbot"],
    ] as const) {
      container.querySelector<HTMLButtonElement>(`[data-testid="professor-open-${id}"]`)?.click();
      expect(opened).toContain(tab);
    }
  });

  it("opens a draft in a new tab rather than navigating away from the desk", () => {
    const { container } = draw({
      papers: [
        paper({ id: "a", artifacts: { overleaf_edit_url: "https://overleaf.com/project/1" } }),
      ],
    });
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="professor-drafts"] a');
    expect(link?.href).toBe("https://overleaf.com/project/1");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noreferrer");
  });

  it("caps a long queue and says how much it is not showing", () => {
    const { container } = draw({
      requests: Array.from({ length: 8 }, (_, index) =>
        request({ id: `r${index}`, deadline_at: `2026-0${(index % 9) + 1}-01T00:00:00Z` }),
      ),
    });
    const items = container.querySelectorAll('[data-testid="professor-letters"] li');
    expect(items).toHaveLength(6);
    expect(items[5]?.textContent).toContain("3 more");
  });

  it("says it is still reading rather than claiming an empty queue", () => {
    // An empty letter queue and an unloaded one look identical, and only one of them is good news.
    const { container } = draw({ requestsLoading: true });
    expect(container.querySelector('[data-testid="professor-letters"]')?.textContent).toContain(
      "Reading",
    );
  });

  it("counts the people who have never signed in as the adoption number to chase", () => {
    const { container } = draw({
      adoption: { members: 20, profile_rate: 0.4, project_rate: 0.25, signed_in_ever: 12 },
    });
    const section = container.querySelector('[data-testid="professor-adoption"]');
    expect(section?.querySelector(".professor__count")?.textContent?.trim()).toBe("8");
    expect(section?.textContent).toContain("40%");
    expect(section?.textContent).toContain("12/20");
  });
});
