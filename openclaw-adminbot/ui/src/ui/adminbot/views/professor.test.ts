/* @vitest-environment jsdom */
// My Desk: what lands in each queue, and what does not.
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EscalatedNudgeRow,
  LogisticsRequest,
  MemberProfileOverviewRow,
  PiReviewRow,
} from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import {
  incompleteProfiles,
  overleafReadingQueue,
  recLetterDeadlineQueue,
  recLetterGroups,
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

function piReviewRow(fields: Partial<PiReviewRow> = {}): PiReviewRow {
  return {
    paperId: "p1",
    title: "Causal Garden Planning",
    authors: ["Ada Lovelace"],
    packageComplete: true,
    ...fields,
  };
}

function escalatedRow(fields: Partial<EscalatedNudgeRow> = {}): EscalatedNudgeRow {
  return {
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
    ...fields,
  };
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
  const toggled: string[] = [];
  const draft: string[] = [];
  const expiry: string[] = [];
  const availability: string[] = [];
  const published: Array<{ message: string; availability: string; expiresOn: string } | null> = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderProfessorView({
      requests: [],
      requestsLoading: false,
      papers: [],
      profiles: [],
      escalated: [],
      piReview: [],
      onOpen: (tab) => opened.push(tab),
      expanded: new Set<string>(),
      onToggleExpand: (id) => toggled.push(id),
      broadcast: null,
      onBroadcastDraftChange: (value) => draft.push(value),
      onBroadcastExpiryChange: (value) => expiry.push(value),
      onBroadcastAvailabilityChange: (value) => availability.push(value),
      onBroadcastPublish: (value) => published.push(value),
      ...overrides,
    }),
    container,
  );
  return { container, opened, toggled, draft, expiry, availability, published };
}

/**
 * The queue sections, in render order.
 *
 * Excludes the broadcast composer: it is not a queue and sits above the settled-sinks-to-the-bottom
 * sort on purpose, so counting it here would make every ordering assertion about the wrong thing.
 */
function queueOrder(container: HTMLElement): Array<string | null> {
  return [...container.querySelectorAll(".professor__section")]
    .map((node) => node.getAttribute("data-testid"))
    .filter((id) => id !== "professor-broadcast");
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

describe("recLetterDeadlineQueue", () => {
  // Fixed, because "overdue" is a claim about a moment and a test that reads the clock makes it
  // one about the day it happens to run on.
  const now = new Date("2026-02-01T12:00:00Z");

  it("places each request against today without reordering the queue", () => {
    const queue = recLetterDeadlineQueue(
      [
        request({ id: "later", deadline_at: "2026-06-01T00:00:00Z" }),
        request({ id: "undated" }),
        request({ id: "late", deadline_at: "2026-01-20T00:00:00Z" }),
        request({ id: "soon", deadline_at: "2026-02-05T00:00:00Z" }),
        request({ id: "month", deadline_at: "2026-02-20T00:00:00Z" }),
      ],
      now,
    );
    expect(queue.map((entry) => entry.request.id)).toEqual([
      "late",
      "soon",
      "month",
      "later",
      "undated",
    ]);
    expect(queue.map((entry) => entry.bucket)).toEqual([
      "overdue",
      "week",
      "month",
      "later",
      "undated",
    ]);
  });

  it("counts the days out, and back for one already past", () => {
    const queue = recLetterDeadlineQueue(
      [
        request({ id: "past", deadline_at: "2026-01-30T12:00:00Z" }),
        request({ id: "future", deadline_at: "2026-02-04T12:00:00Z" }),
        request({ id: "undated" }),
      ],
      now,
    );
    expect(queue.map((entry) => entry.daysAway)).toEqual([-2, 3, undefined]);
  });

  it("files an unparseable deadline as undated rather than at the top of the overdue list", () => {
    const queue = recLetterDeadlineQueue([request({ id: "typo", deadline_at: "soon" })], now);
    expect(queue[0]?.bucket).toBe("undated");
    expect(queue[0]?.daysAway).toBeUndefined();
  });

  it("caps the rows across the whole queue but still counts each bucket in full", () => {
    const queue = recLetterDeadlineQueue(
      [
        request({ id: "late", deadline_at: "2026-01-20T00:00:00Z" }),
        ...Array.from({ length: 6 }, (_, index) =>
          request({ id: `m${index}`, deadline_at: `2026-02-2${index}T00:00:00Z` }),
        ),
      ],
      now,
    );
    const groups = recLetterGroups(queue, 3);
    expect(groups.map((group) => [group.bucket, group.total, group.rows.length])).toEqual([
      ["overdue", 1, 1],
      ["month", 6, 2],
    ]);
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

  // The spelling 22 of the lab's 24 alumni actually carry: the roster was imported from a
  // spreadsheet that records leaving in `member_type`, and those rows have no `status` at all.
  // Testing `status` alone let every one of them back into the reminder list -- and because their
  // records are the emptiest, they sorted to the top of it.
  it("leaves out alumni the roster spells in member_type, with no status", () => {
    const gone = profile({
      id: "gone",
      member_type: "alumni",
      missing_fields: ["office", "phone"],
      timeline: bare,
      projects: { total: 2, self_updated: 0 },
    });
    // A combination type, which is how the sheet records somebody who left a full member.
    const alsoGone = profile({
      id: "also-gone",
      member_type: "full, alumni",
      missing_fields: ["office", "phone", "advisor"],
      timeline: bare,
      projects: { total: 3, self_updated: 0 },
    });
    const here = profile({
      id: "here",
      member_type: "full",
      status: "active",
      missing_fields: ["office"],
      timeline: bare,
      projects: { total: 2, self_updated: 0 },
    });
    expect(incompleteProfiles([gone, alsoGone, here]).map((row) => row.id)).toEqual(["here"]);
    expect(thinTimelines([gone, alsoGone, here]).map((row) => row.id)).toEqual(["here"]);
    expect(unattendedProjects([gone, alsoGone, here]).map((row) => row.id)).toEqual(["here"]);
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

  // One line per queue saying what it is for. Three of these sections are a list of papers with
  // her name against them, and the titles alone did not say which question each was asking --
  // approve the finished thing, read the unfinished thing, or go and ask somebody for something.
  it("says what each paper queue is for, in words that tell them apart", () => {
    const { container } = draw();
    const blurb = (id: string) =>
      container.querySelector(`[data-testid="professor-${id}"] .professor__blurb`)?.textContent ??
      "";
    // Blocked on her: nothing moves until she acts.
    expect(blurb("pi-review")).toContain("Nothing is posted until you say yes");
    // Not blocked on her: reading, while reading can still change something.
    expect(blurb("drafts")).toContain("Nobody is blocked on you here");
    // Not a paper queue at all: information nobody sent, and she is the one left to ask.
    expect(blurb("escalated")).toContain("a message from you is what is left");
  });

  it("titles the two paper queues by the job, not by where the file lives", () => {
    const { container } = draw();
    const title = (id: string) =>
      container.querySelector(`[data-testid="professor-${id}"] .card-title`)?.textContent ?? "";
    expect(title("pi-review")).toBe("Approve before it goes public");
    expect(title("drafts")).toBe("Read and comment while they are still writing");
    expect(title("escalated")).toBe("Missing information — needs a word from you");
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
        paper({
          id: "a",
          title: "Draft A",
          artifacts: { overleaf_edit_url: "https://overleaf.com/project/1" },
        }),
      ],
    });
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="professor-drafts"] a');
    expect(link?.href).toBe("https://overleaf.com/project/1");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noreferrer");
    // The whole row is the link, not a title with a line of facts sitting outside it.
    expect(link?.textContent).toContain("Draft A");
    expect(link?.textContent).toContain("Mei Chen");
  });

  it("keeps the PDF on an approval row reachable beside the row rather than inside it", () => {
    const { container } = draw({
      piReview: [piReviewRow({ drivePdfUrl: "https://drive.google.com/file/d/1" })],
    });
    const row = container.querySelector('[data-testid="professor-pi-review"] .professor__row');
    // A link inside a button is reachable by neither, so it sits outside it.
    expect(row?.querySelector("a")).toBeNull();
    const pdf = container.querySelector<HTMLAnchorElement>(
      '[data-testid="professor-pi-review"] .professor__row-aside',
    );
    expect(pdf?.href).toBe("https://drive.google.com/file/d/1");
  });

  it("caps a long queue and offers the rest as a control rather than as a count", () => {
    const letters = Array.from({ length: 8 }, (_, index) =>
      request({ id: `r${index}`, deadline_at: `2026-0${(index % 9) + 1}-01T00:00:00Z` }),
    );
    const { container, toggled } = draw({ requests: letters });
    expect(container.querySelectorAll('[data-testid="professor-letters"] li')).toHaveLength(5);

    const more = container.querySelector<HTMLButtonElement>(
      '[data-testid="professor-more-letters"]',
    );
    expect(more?.textContent).toContain("Show 3 more");
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    expect(more?.getAttribute("aria-controls")).toBe("professor-list-letters");
    more?.click();
    expect(toggled).toEqual(["letters"]);

    // The whole queue once it is open, and the switch now offers the way back.
    const open = draw({ requests: letters, expanded: new Set(["letters"]) }).container;
    expect(open.querySelectorAll('[data-testid="professor-letters"] li')).toHaveLength(8);
    const fewer = open.querySelector('[data-testid="professor-more-letters"]');
    expect(fewer?.textContent).toContain("Show fewer");
    expect(fewer?.getAttribute("aria-expanded")).toBe("true");
  });

  it("says how many of how many when an opened list is still holding rows back", () => {
    // Opening a list asks for the rest of it, not for all of a queue this long -- so it stops, and
    // it says that it stopped rather than looking like the whole of a 25-letter term.
    const { container } = draw({
      requests: Array.from({ length: 25 }, (_, index) =>
        request({ id: `r${index}`, deadline_at: "2026-03-01T00:00:00Z" }),
      ),
      expanded: new Set(["letters"]),
    });
    expect(container.querySelectorAll('[data-testid="professor-letters"] li')).toHaveLength(20);
    expect(container.querySelector(".professor__more-note")?.textContent).toContain(
      "Showing 20 of 25",
    );
    // The section's own count is still the real one.
    expect(
      container
        .querySelector('[data-testid="professor-letters"] .professor__count')
        ?.textContent?.trim(),
    ).toBe("25");
  });

  it("opens each list on its own, so the adoption columns do not move together", () => {
    const behind = Array.from({ length: 7 }, (_, index) =>
      profile({
        id: `p${index}`,
        missing_fields: ["orcid"],
        timeline: { availability: 0, time_off: 0, milestones: 0, trips: 0, total: 0 },
      }),
    );
    const { container } = draw({ profiles: behind, expanded: new Set(["adoption-profile"]) });
    expect(
      container.querySelectorAll('[data-testid="professor-adoption-profile"] li'),
    ).toHaveLength(7);
    expect(
      container.querySelectorAll('[data-testid="professor-adoption-timeline"] li'),
    ).toHaveLength(5);
  });

  it("makes every row a way through to the page that does the work", () => {
    // The point of the change: the rows were the only thing worth looking at and the only thing you
    // could not press.
    const { container, opened } = draw({
      requests: [request({ id: "a", deadline_at: "2026-02-01T00:00:00Z" })],
      escalated: [escalatedRow()],
      piReview: [piReviewRow()],
      profiles: [profile({ id: "p", missing_fields: ["orcid"] })],
    });
    for (const [id, tab] of [
      ["letters", "adminbotRecLetters"],
      ["escalated", "adminbotAnnouncements"],
      ["pi-review", "adminbotPapers"],
      ["adoption-profile", "adminbotProfileOverview"],
    ] as const) {
      const row = container.querySelector<HTMLButtonElement>(
        `#professor-list-${id} .professor__row`,
      );
      row?.click();
      expect(opened, id).toContain(tab);
    }
  });

  it("says what pressing a row does, for a reader who cannot see the chevron", () => {
    const { container } = draw({
      requests: [request({ id: "a", deadline_at: "2026-02-01T00:00:00Z" })],
    });
    const row = container.querySelector('[data-testid="professor-letters"] .professor__row');
    expect(row?.querySelector(".sr-only")?.textContent).toContain("Open the request queue");
  });

  it("groups the letter queue into deadline windows and says how far off each one is", () => {
    // Deadlines relative to the clock the page is actually read on, so the buckets are the ones a
    // reader would compute themselves.
    const days = (count: number) =>
      new Date(Date.now() + count * 24 * 60 * 60 * 1000).toISOString();
    const { container } = draw({
      requests: [
        request({ id: "late", member_name: "Late Ling", deadline_at: days(-3) }),
        request({ id: "soon", member_name: "Soon Sun", deadline_at: days(2) }),
        request({ id: "undated", member_name: "Undated Uma" }),
      ],
    });
    const section = container.querySelector('[data-testid="professor-letters"]');
    expect(
      section?.querySelector('[data-testid="professor-letters-overdue"]')?.textContent,
    ).toContain("Late Ling");
    expect(section?.querySelector('[data-testid="professor-letters-week"]')?.textContent).toContain(
      "Soon Sun",
    );
    expect(
      section?.querySelector('[data-testid="professor-letters-undated"]')?.textContent,
    ).toContain("no deadline given");
    // A window nobody is in is not drawn: "Later this term 0" is furniture.
    expect(section?.querySelector('[data-testid="professor-letters-later"]')).toBeNull();
    expect(
      section?.querySelector('[data-testid="professor-letters-overdue"] .professor__when')
        ?.textContent,
    ).toContain("3 day(s) ago");
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
    const order = queueOrder(container);
    expect(order).toEqual([
      "professor-adoption",
      // The settled ones keep their relative order below it, the PI gate among them.
      "professor-pi-review",
      "professor-letters",
      "professor-drafts",
      // Pinned last, below even the settled ones. See the escalated-nudges block.
      "professor-escalated",
    ]);
  });

  // The queue the escalation pass was always computing. It sits at the bottom of the page, and
  // stays there whether or not anybody is in it: everything above is a queue she works through on
  // her own, and this one is the lab asking her to go and chase a person -- the slowest and least
  // frequent thing here, and not something that should land between two reading lists on the
  // weeks it happens to be busy.
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

    it("sits at the bottom even when somebody is waiting on her", () => {
      const { container } = draw({ escalated: [row()] });
      const order = queueOrder(container);
      expect(order.at(-1)).toBe("professor-escalated");
      // And it is genuinely last, not merely below the one section that has work in it: a pinned
      // section outranks the settled sort rather than joining it.
      expect(order).toHaveLength(5);
    });

    it("stays at the bottom, and says so plainly, when nobody is waiting", () => {
      const { container } = draw({
        escalated: [],
        profiles: [profile({ id: "a", missing_fields: ["office"] })],
      });
      const section = container.querySelector('[data-testid="professor-escalated"]');
      expect(section?.textContent).toContain("Nobody has ignored a nudge long enough");
      const order = queueOrder(container);
      // Below the adoption columns, which do have somebody in them.
      expect(order[0]).toBe("professor-adoption");
      expect(order.at(-1)).toBe("professor-escalated");
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
    expect(queueOrder(container)[0]).toBe("professor-letters");
  });
});

// The box she types the lab's broadcast into. Lives here rather than on Lab Sharing because it is
// the one thing on this page that is hers to author.
describe("the broadcast box", () => {
  const live = {
    id: "bcast_1",
    availability: "away" as const,
    message: "Sep 11-17: Zürich.",
    updated_at: "2026-09-10T18:00:00.000Z",
    expires_at: "2026-09-26T03:59:59.000Z",
    updated_by: "zhijing",
  };

  it("always leads the page, even with queues waiting", () => {
    const { container } = draw({
      escalated: [
        {
          member_id: "m1",
          name: "Waiting Member",
          items: [{ kind: "profile", title: "Fill in your profile" }],
          escalatedAt: "2026-09-01T00:00:00Z",
        } as unknown as EscalatedNudgeRow,
      ],
    });
    const first = container.querySelector(".professor__section");
    expect(first?.getAttribute("data-testid")).toBe("professor-broadcast");
  });

  it("starts holding whatever is live, so an edit is a correction not a retype", () => {
    const { container } = draw({ broadcast: live });
    const box = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="professor-broadcast-text"]',
    );
    expect(box?.value).toBe("Sep 11-17: Zürich.");
    expect(
      container.querySelector('[data-testid="professor-broadcast-until"]')?.textContent,
    ).toContain("2026-09-26");
  });

  it("posts what is typed, with the chosen end date", () => {
    const { container, published } = draw({
      broadcastDraft: "Back in Toronto Thursday.",
      broadcastExpiry: "2026-09-30",
      broadcastAvailability: "busy",
    });
    container.querySelector<HTMLButtonElement>('[data-testid="professor-broadcast-post"]')?.click();
    expect(published).toEqual([
      { message: "Back in Toronto Thursday.", availability: "busy", expiresOn: "2026-09-30" },
    ]);
  });

  it("reports every keystroke so the draft survives a re-render", () => {
    const { container, draft } = draw({});
    const box = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="professor-broadcast-text"]',
    )!;
    box.value = "Travelling next week";
    box.dispatchEvent(new Event("input"));
    expect(draft).toEqual(["Travelling next week"]);
  });

  // An empty box is a real state -- it is what taking a broadcast down leaves behind -- so it must
  // not silently refill itself from the one just cleared.
  it("keeps an emptied box empty rather than refilling it from the live broadcast", () => {
    const { container } = draw({ broadcast: live, broadcastDraft: "" });
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="professor-broadcast-text"]')
        ?.value,
    ).toBe("");
  });

  it("will not post an empty or unchanged broadcast", () => {
    const empty = draw({ broadcastDraft: "   " });
    expect(
      empty.container.querySelector<HTMLButtonElement>('[data-testid="professor-broadcast-post"]')
        ?.disabled,
    ).toBe(true);

    // Same text and same end date as what is already up: nothing to say.
    const unchanged = draw({ broadcast: live, broadcastExpiry: live.expires_at.slice(0, 10) });
    expect(
      unchanged.container.querySelector<HTMLButtonElement>(
        '[data-testid="professor-broadcast-post"]',
      )?.disabled,
    ).toBe(true);
  });

  it("offers a take-down only when something is live, and sends null for it", () => {
    expect(
      draw({}).container.querySelector('[data-testid="professor-broadcast-clear"]'),
    ).toBeNull();

    const { container, published } = draw({ broadcast: live });
    container
      .querySelector<HTMLButtonElement>('[data-testid="professor-broadcast-clear"]')
      ?.click();
    expect(published).toEqual([null]);
  });

  it("locks the controls and shows the reason while a post is in flight or has failed", () => {
    const busy = draw({ broadcastDraft: "x", broadcastBusy: true });
    expect(
      busy.container.querySelector<HTMLTextAreaElement>('[data-testid="professor-broadcast-text"]')
        ?.disabled,
    ).toBe(true);

    const failed = draw({
      broadcastNotice: { kind: "error", text: "Could not post that broadcast." },
    });
    const notice = failed.container.querySelector('[data-testid="professor-broadcast-notice"]');
    expect(notice?.textContent).toContain("Could not post");
    expect(notice?.getAttribute("role")).toBe("alert");
  });

  it("says plainly when nothing is being broadcast", () => {
    const { container } = draw({});
    expect(container.querySelector('[data-testid="professor-broadcast"]')?.textContent).toContain(
      "Nothing being broadcast",
    );
  });
});

// The gate PaperFlow calls GT. Nothing asked her about it until now: the nudge sweep computed the
// item and the send path refused to message the head professor, so a prepared paper reached the
// gate with nobody told.
describe("the papers waiting on her yes", () => {
  const row = (fields: Partial<PiReviewRow> = {}): PiReviewRow => ({
    paperId: "p1",
    title: "Causal Garden Planning",
    authors: ["Ada Lovelace"],
    waitingSince: "2026-09-10T09:00:00.000Z",
    drivePdfUrl: "https://drive.google.com/file/d/1PdF9x",
    packageComplete: true,
    ...fields,
  });

  it("names the paper, its authors and the PDF she would be approving", () => {
    const { container } = draw({ piReview: [row()] });
    const section = container.querySelector('[data-testid="professor-pi-review"]');

    expect(section?.querySelector(".professor__count")?.textContent?.trim()).toBe("1");
    expect(section?.textContent).toContain("Causal Garden Planning");
    expect(section?.textContent).toContain("Ada Lovelace");
    expect(section?.querySelector("a")?.getAttribute("href")).toBe(
      "https://drive.google.com/file/d/1PdF9x",
    );
    expect(section?.textContent).toContain("2026-09-10");
  });

  it("says when the package is not finished, without holding the decision up for it", () => {
    const { container } = draw({ piReview: [row({ packageComplete: false })] });
    const section = container.querySelector('[data-testid="professor-pi-review"]');

    expect(section?.textContent).toContain("paper password still missing");
    // Still listed: the missing password is the authors' errand, not a reason to stall her yes.
    expect(section?.textContent).toContain("Causal Garden Planning");
  });

  it("leads the page when something is waiting on her", () => {
    const { container } = draw({ piReview: [row()] });
    expect(queueOrder(container)[0]).toBe("professor-pi-review");
  });

  it("says so plainly when nothing is", () => {
    const { container } = draw({ piReview: [] });
    expect(container.querySelector('[data-testid="professor-pi-review"]')?.textContent).toContain(
      "No paper is waiting on your approval.",
    );
  });
});
