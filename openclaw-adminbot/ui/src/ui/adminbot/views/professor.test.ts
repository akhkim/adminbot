/* @vitest-environment jsdom */
// My Desk: what lands in each queue, and what does not.
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EscalatedNudgeRow,
  LogisticsRequest,
  MemberProfileOverviewRow,
} from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import {
  incompleteProfiles,
  overleafReadingQueue,
  recLetterQueue,
  renderProfessorView,
  thinTimelines,
  unattendedProjects,
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
      escalated: [],
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

describe("the adoption columns", () => {
  const bare = { availability: 0, time_off: 0, milestones: 0, trips: 0, total: 0 };

  it("leaves alumni out of every column: nobody is reminding someone who has left", () => {
    const gone = profile({
      id: "gone",
      status: "alumni",
      missing_fields: ["office"],
      timeline: bare,
      projects: { total: 2, self_updated: 0 },
    });
    const here = profile({
      id: "here",
      status: "active",
      missing_fields: ["office"],
      timeline: bare,
      projects: { total: 2, self_updated: 0 },
    });
    expect(incompleteProfiles([gone, here]).map((row) => row.id)).toEqual(["here"]);
    expect(thinTimelines([gone, here]).map((row) => row.id)).toEqual(["here"]);
    expect(unattendedProjects([gone, here]).map((row) => row.id)).toEqual(["here"]);
  });

  it("orders each column by how far behind the member is", () => {
    expect(
      incompleteProfiles([
        profile({ id: "one", missing_fields: ["office"] }),
        profile({ id: "three", missing_fields: ["office", "phone", "advisor"] }),
      ]).map((row) => row.id),
    ).toEqual(["three", "one"]);
    expect(
      unattendedProjects([
        // Every paper carries an update of their own, so they are not behind on anything.
        profile({ id: "current", projects: { total: 3, self_updated: 3 } }),
        // No papers at all is not a thing to be reminded about.
        profile({ id: "none", projects: { total: 0, self_updated: 0 } }),
        profile({ id: "one", projects: { total: 2, self_updated: 1 } }),
        profile({ id: "two", projects: { total: 2, self_updated: 0 } }),
      ]).map((row) => row.id),
    ).toEqual(["two", "one"]);
  });
});

describe("renderProfessorView", () => {
  it("shows every queue with its count, and no approval section", () => {
    const { container } = draw();
    for (const id of ["letters", "drafts", "adoption"]) {
      expect(container.querySelector(`[data-testid="professor-${id}"]`), id).not.toBeNull();
    }
    // Approvals live on Pending Actions, which the sidebar reaches directly.
    expect(container.querySelector('[data-testid="professor-approvals"]')).toBeNull();
  });

  it("carries no subtitle under any section heading", () => {
    const { container } = draw();
    expect(container.querySelector(".professor .card-sub")).toBeNull();
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

  it("counts people rather than rows: one member short on two counts is one reminder", () => {
    const { container } = draw({
      profiles: [
        profile({
          id: "both",
          missing_fields: ["office"],
          timeline: { availability: 0, time_off: 0, milestones: 0, trips: 0, total: 0 },
        }),
        profile({ id: "fine" }),
      ],
    });
    const section = container.querySelector('[data-testid="professor-adoption"]');
    expect(section?.querySelector(".professor__count")?.textContent?.trim()).toBe("1");
    expect(section?.querySelector('[data-testid="professor-adoption-profile"]')).not.toBeNull();
    expect(section?.querySelector('[data-testid="professor-adoption-timeline"]')).not.toBeNull();
    expect(section?.querySelector('[data-testid="professor-adoption-papers"]')).not.toBeNull();
  });

  it("sinks a column with nobody in it below the ones with somebody in them", () => {
    const { container } = draw({
      profiles: [profile({ id: "papers", projects: { total: 2, self_updated: 0 } })],
    });
    const order = [...container.querySelectorAll('[data-testid^="professor-adoption-"]')].map(
      (node) => node.getAttribute("data-testid"),
    );
    expect(order[0]).toBe("professor-adoption-papers");
  });

  it("sinks a settled section below one that still has work in it", () => {
    const { container } = draw({ profiles: [profile({ id: "a", missing_fields: ["office"] })] });
    const order = [...container.querySelectorAll(".professor__section")].map((node) =>
      node.getAttribute("data-testid"),
    );
    expect(order).toEqual([
      "professor-adoption",
      "professor-escalated",
      "professor-letters",
      "professor-drafts",
    ]);
  });

  // The queue the escalation pass was always computing. It leads the page when it has anybody in
  // it: everything else here is work she can schedule, and this is the part where the lab has
  // already stopped chasing and is waiting on her.
  describe("escalated nudges", () => {
    const row = (overrides: Partial<EscalatedNudgeRow> = {}): EscalatedNudgeRow => ({
      memberId: "mei",
      name: "Mei Chen",
      escalatedAt: "2026-08-20T09:00:00.000Z",
      items: [
        {
          id: "n1",
          title: "Submission ID missing",
          body: "Still missing.",
          createdAt: "2026-08-14T09:00:00.000Z",
        },
      ],
      ...overrides,
    });

    it("names the person, what is outstanding, and when it was raised", () => {
      const { container } = draw({ escalated: [row()] });
      const section = container.querySelector('[data-testid="professor-escalated"]');
      expect(section).not.toBeNull();
      expect(section?.textContent).toContain("Mei Chen");
      expect(section?.textContent).toContain("Submission ID missing");
      expect(section?.textContent).toContain("2026-08-20");
    });

    it("counts a member's items instead of listing them all", () => {
      const { container } = draw({
        escalated: [
          row({
            items: [
              { id: "n1", title: "First", body: "", createdAt: "2026-08-14T09:00:00.000Z" },
              { id: "n2", title: "Second", body: "", createdAt: "2026-08-15T09:00:00.000Z" },
            ],
          }),
        ],
      });
      const section = container.querySelector('[data-testid="professor-escalated"]');
      expect(section?.textContent).toContain("2 things outstanding");
    });

    it("leads the page when somebody is waiting on her", () => {
      const { container } = draw({ escalated: [row()] });
      const order = [...container.querySelectorAll(".professor__section")].map((node) =>
        node.getAttribute("data-testid"),
      );
      expect(order[0]).toBe("professor-escalated");
    });

    it("sinks below real work, and says so plainly, when nobody is waiting", () => {
      const { container } = draw({
        escalated: [],
        profiles: [profile({ id: "a", missing_fields: ["office"] })],
      });
      const section = container.querySelector('[data-testid="professor-escalated"]');
      expect(section?.textContent).toContain("Nobody has ignored a nudge long enough");
      const order = [...container.querySelectorAll(".professor__section")].map((node) =>
        node.getAttribute("data-testid"),
      );
      // Below the adoption columns, which do have somebody in them.
      expect(order[0]).toBe("professor-adoption");
      expect(order.indexOf("professor-escalated")).toBeGreaterThan(0);
    });

    it("sends her where she can write to them", () => {
      const { container, opened } = draw({ escalated: [row()] });
      container
        .querySelector<HTMLButtonElement>('[data-testid="professor-open-escalated"]')
        ?.click();
      expect(opened).toEqual(["adminbotAnnouncements"]);
    });
  });

  it("holds a still-loading queue in place rather than sinking it as settled", () => {
    const { container } = draw({
      requestsLoading: true,
      profiles: [profile({ id: "a", missing_fields: ["office"] })],
    });
    const order = [...container.querySelectorAll(".professor__section")].map((node) =>
      node.getAttribute("data-testid"),
    );
    expect(order[0]).toBe("professor-letters");
  });
});
