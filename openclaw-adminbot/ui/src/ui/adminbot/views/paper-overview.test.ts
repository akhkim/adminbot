// Active Papers: what a person's row says, how papers fold into people, and what the filters
// group the lab's papers into.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PaperSlotOverviewRow } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import {
  EMPTY_PAPER_OVERVIEW_FILTER,
  filterPaperRows,
  paperOverviewRows,
  paperOverviewSummary,
  paperPersonRows,
  paperProgress,
  paperVenueOptions,
  renderPaperOverviewTable,
  type PaperOverviewFilter,
} from "./paper-overview.ts";

function paper(fields: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p-1",
    title: "Meta agents for reliable science",
    authors: ["Mira Member"],
    current_step: "overleaf_writing",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...fields,
  } as AdminBotPaperRecord;
}

function slots(fields: Partial<PaperSlotOverviewRow> = {}): PaperSlotOverviewRow {
  return {
    paper_id: "p-1",
    title: "Meta agents for reliable science",
    current_step: "overleaf_writing",
    provided_count: 3,
    required_count: 3,
    dormant: false,
    closed: false,
    missing_slots: [],
    escalating: false,
    ...fields,
  };
}

function build(params: {
  papers: AdminBotPaperRecord[];
  slots?: PaperSlotOverviewRow[];
  blockers?: Record<string, number>;
}) {
  return paperOverviewRows({
    papers: params.papers,
    slots: params.slots ?? [],
    blockerCounts: new Map(Object.entries(params.blockers ?? {})),
    stepLabel: (step) => step,
    stepCount: 8,
  });
}

function draw(options: { rows: ReturnType<typeof build>; filter?: Partial<PaperOverviewFilter> }) {
  const filters: PaperOverviewFilter[] = [];
  const opened: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderPaperOverviewTable({
      rows: options.rows,
      filter: { ...EMPTY_PAPER_OVERVIEW_FILTER, ...options.filter },
      onFilterChange: (next) => filters.push(next),
      onOpenPaper: (id) => opened.push(id),
      stages: [{ value: "overleaf_writing", label: "Overleaf writing" }],
    }),
    container,
  );
  return { container, filters, opened };
}

const tableRows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>(".paper-overview__row"),
];

describe("paperOverviewRows", () => {
  it("counts a paper as outstanding when evidence, a blocker or an escalation is open", () => {
    const [missing, blocked, escalating, clear] = build({
      papers: [
        paper({ id: "missing" }),
        paper({ id: "blocked" }),
        paper({ id: "escalating" }),
        paper({ id: "clear" }),
      ],
      slots: [
        slots({
          paper_id: "missing",
          provided_count: 1,
          missing_slots: ["camera_ready"],
        }),
        slots({ paper_id: "blocked" }),
        slots({ paper_id: "escalating", escalating: true }),
        slots({ paper_id: "clear" }),
      ],
      blockers: { blocked: 2 },
    });
    expect(missing?.needsAttention).toBe(true);
    expect(blocked?.needsAttention).toBe(true);
    expect(escalating?.needsAttention).toBe(true);
    expect(clear?.needsAttention).toBe(false);
  });

  it("asks nothing of a dormant paper, whatever it is missing", () => {
    // Otherwise the sweep is permanently non-empty, and so permanently ignorable.
    const [row] = build({
      papers: [paper({ dormant_override: true })],
      slots: [slots({ provided_count: 0, missing_slots: ["camera_ready"] })],
      blockers: { "p-1": 1 },
    });
    expect(row?.dormant).toBe(true);
    expect(row?.needsAttention).toBe(false);
  });

  it("prefers the venue a paper landed in over the one it was aimed at", () => {
    const [row] = build({
      papers: [paper({ venue: "EMNLP 2026", accepted_venue: "ACL 2026" })],
    });
    expect(row?.venue).toBe("ACL 2026");
  });
});

describe("paperProgress", () => {
  const of = (
    slotFields: Partial<PaperSlotOverviewRow>,
    decision?: "pending" | "accept" | "reject",
    complete = false,
  ) => paperProgress({ slots: slots(slotFields), decision, complete });

  it("counts filed artifacts and an acceptance toward the same total", () => {
    // Five required slots plus the venue decision is six units. Three filed and no acceptance is
    // 3/6; three filed with an acceptance is 4/6.
    expect(of({ provided_count: 3, required_count: 5 }).percent).toBe(50);
    expect(of({ provided_count: 3, required_count: 5 }, "accept").percent).toBe(67);
  });

  it("gives a rejection no credit, because the paper has to go back out", () => {
    const rejected = of({ provided_count: 3, required_count: 5 }, "reject");
    expect(rejected.percent).toBe(50);
    expect(rejected.waitingOn).toBe("resubmission");
  });

  it("cannot reach 100 on evidence alone, and does on a closed cycle", () => {
    // Every artifact in but no verdict is 5/6 -- the one thing left is not the authors' to do.
    expect(of({ provided_count: 5, required_count: 5 }).percent).toBe(83);
    expect(of({ provided_count: 5, required_count: 5 }, "accept").percent).toBe(100);
    expect(of({ provided_count: 2, required_count: 5 }, undefined, true).percent).toBe(100);
  });

  it("reports nothing rather than zero for a paper the service has not counted", () => {
    expect(paperProgress({ slots: undefined, decision: "pending", complete: false }).percent).toBe(
      null,
    );
    expect(of({ required_count: 0, provided_count: 0 }).percent).toBe(null);
  });

  it("names who the remainder is waiting on, which the number cannot", () => {
    // Actionable slots outstanding is the authors' problem...
    expect(of({ missing_slots: ["camera_ready"], provided_count: 1 }).waitingOn).toBe("evidence");
    // ...and nothing actionable with no verdict is the venue's.
    expect(of({ missing_slots: [], provided_count: 3 }).waitingOn).toBe("decision");
    expect(of({ missing_slots: [], provided_count: 3 }, "accept").waitingOn).toBe("nothing");
  });
});

describe("filterPaperRows", () => {
  const rows = build({
    papers: [
      paper({ id: "needs", title: "Needs work", venue: "ACL 2026" }),
      paper({
        id: "fine",
        title: "All fine",
        venue: "EMNLP 2026",
        current_step: "submission",
      }),
      paper({ id: "old", title: "Shelved", dormant_override: true }),
    ],
    slots: [
      slots({
        paper_id: "needs",
        provided_count: 0,
        missing_slots: ["camera_ready"],
      }),
      slots({ paper_id: "fine" }),
      slots({ paper_id: "old" }),
    ],
  });

  const titles = (filter: Partial<PaperOverviewFilter>) =>
    filterPaperRows(rows, { ...EMPTY_PAPER_OVERVIEW_FILTER, ...filter }).map(
      (row) => row.paper.title,
    );

  it("groups by what is outstanding rather than listing everything", () => {
    expect(titles({ state: "attention" })).toEqual(["Needs work"]);
    expect(titles({ state: "in_flight" })).toEqual(["Needs work", "All fine"]);
    expect(titles({ state: "dormant" })).toEqual(["Shelved"]);
    expect(titles({ state: "all" })).toHaveLength(3);
  });

  it("narrows by stage and by venue", () => {
    expect(titles({ state: "all", stage: "submission" })).toEqual(["All fine"]);
    expect(titles({ state: "all", venue: "ACL 2026" })).toEqual(["Needs work"]);
  });

  it("searches title, author and venue together", () => {
    expect(titles({ state: "all", search: "shelved" })).toEqual(["Shelved"]);
    expect(titles({ state: "all", search: "mira" })).toHaveLength(3);
    expect(titles({ state: "all", search: "emnlp" })).toEqual(["All fine"]);
  });

  it("offers only the venues papers actually name", () => {
    expect(paperVenueOptions(rows)).toEqual(["ACL 2026", "EMNLP 2026"]);
  });

  it("counts the roll-up over every paper, not over what the filter left", () => {
    expect(paperOverviewSummary(rows)).toEqual({
      papers: 3,
      attention: 1,
      inFlight: 2,
      dormant: 1,
      withoutVenue: 1,
    });
  });
});

describe("paperPersonRows", () => {
  it("puts a co-authored paper on every author, because it is outstanding to each of them", () => {
    const people = paperPersonRows(
      build({ papers: [paper({ authors: ["Mira Member", "Ravi Reviewer"] })] }),
    );
    expect(people.map((person) => person.name)).toEqual(["Mira Member", "Ravi Reviewer"]);
    expect(people.every((person) => person.papers.length === 1)).toBe(true);
  });

  it("folds a linked author and a name-spelled one into a single person", () => {
    // The same student, linked on one paper and typed by hand on the other.
    const people = paperPersonRows(
      build({
        papers: [
          paper({
            id: "linked",
            authors: ["Mira Member"],
            author_links: [{ name: "Mira Member", member_id: "m-1" }],
          }),
          paper({ id: "typed", authors: ["Mira Member"] }),
        ],
      }),
    );
    expect(people).toHaveLength(1);
    expect(people[0]?.memberId).toBe("m-1");
    expect(people[0]?.papers.map((row) => row.paper.id)).toEqual(["linked", "typed"]);
  });

  it("keeps two members who share a name apart, rather than guessing", () => {
    const people = paperPersonRows(
      build({
        papers: [
          paper({
            id: "one",
            authors: ["Sam Student"],
            author_links: [{ name: "Sam Student", member_id: "m-1" }],
          }),
          paper({
            id: "two",
            authors: ["Sam Student"],
            author_links: [{ name: "Sam Student", member_id: "m-2" }],
          }),
        ],
      }),
    );
    expect(people).toHaveLength(2);
  });

  it("counts what a person is carrying, and averages progress over their papers", () => {
    const [person] = paperPersonRows(
      build({
        papers: [
          paper({ id: "a", title: "A", authors: ["Mira Member"] }),
          paper({ id: "b", title: "B", authors: ["Mira Member"] }),
        ],
        slots: [
          slots({
            paper_id: "a",
            provided_count: 1,
            required_count: 5,
            missing_slots: ["slides"],
          }),
          slots({ paper_id: "b", provided_count: 5, required_count: 5 }),
        ],
        blockers: { a: 2 },
      }),
    );
    // 1/6 and 5/6 of the units, so 17% and 83%.
    expect(person?.percent).toBe(50);
    expect(person?.provided).toBe(6);
    expect(person?.required).toBe(10);
    expect(person?.attention).toBe(1);
    expect(person?.openBlockers).toBe(2);
    expect(person?.missing).toEqual(["slides"]);
  });

  it("lists the person holding the most up first, and their outstanding paper first", () => {
    const people = paperPersonRows(
      build({
        papers: [
          paper({ id: "clear", title: "Clear", authors: ["Ada Quiet"] }),
          paper({ id: "late", title: "Late", authors: ["Bo Busy"] }),
          paper({ id: "fine", title: "Fine", authors: ["Bo Busy"] }),
        ],
        slots: [
          slots({ paper_id: "clear" }),
          slots({
            paper_id: "late",
            provided_count: 0,
            missing_slots: ["camera_ready"],
          }),
          slots({ paper_id: "fine" }),
        ],
      }),
    );
    expect(people.map((person) => person.name)).toEqual(["Bo Busy", "Ada Quiet"]);
    expect(people[0]?.papers.map((row) => row.paper.title)).toEqual(["Late", "Fine"]);
  });

  it("keeps a paper naming nobody, in a bucket that sorts last", () => {
    const people = paperPersonRows(
      build({
        papers: [
          paper({ id: "orphan", authors: [] }),
          paper({ id: "owned", authors: ["Mira Member"] }),
        ],
      }),
    );
    expect(people.map((person) => person.name)).toEqual(["Mira Member", ""]);
    expect(people[1]?.papers.map((row) => row.paper.id)).toEqual(["orphan"]);
  });
});

describe("renderPaperOverviewTable", () => {
  it("puts the lab on one scannable line per person, with their papers inside it", () => {
    const { container } = draw({
      rows: build({
        papers: [paper({ timeline: { current_step_index: 2, items: [] } as never })],
        slots: [
          slots({
            provided_count: 1,
            missing_slots: ["camera_ready", "slides"],
          }),
        ],
      }),
      filter: { state: "all" },
    });
    // Stage and Progress were the same fact twice: both were derived from `current_step` and
    // nothing else, so one of them had to go.
    expect(
      [...container.querySelectorAll(".profile-overview__head")].map((h) => h.textContent?.trim()),
    ).toEqual(["Person", "Progress", "Evidence", "Papers", "Outstanding"]);
    expect(container.querySelector(".paper-overview__person")?.textContent).toContain(
      "Mira Member",
    );
    // Progress is measured from what the paper filed; Stage says where it is, in words.
    expect(container.querySelector(".profile-overview__percent")?.textContent?.trim()).toBe("25%");
    expect(container.querySelector(".paper-overview__stage")?.textContent).toContain("step 3 of 8");
    expect(container.textContent).toContain("1/3");
    expect(container.textContent).toContain("camera ready");
  });

  it("says a finished paper is finished, which a step percentage never could", () => {
    // The service's own progress_percent tops out at 88% on the last step: it is the position of
    // `current_step` in a fixed plan, so nothing a paper actually does can carry it to the end.
    const { container } = draw({
      rows: build({
        papers: [paper({ reminder: { status: "complete" } })],
        slots: [slots()],
      }),
      filter: { state: "all" },
    });
    expect(container.querySelector(".profile-overview__percent")?.textContent?.trim()).toBe("100%");
    expect(container.querySelector(".paper-overview__stage")?.textContent).toContain("Complete");
    expect(container.querySelector(".profile-overview__bar.is-complete")).not.toBeNull();
  });

  it("reads the step from the paper, not from a percentage that is the same for every paper on it", () => {
    const [early, late] = build({
      papers: [
        paper({
          id: "early",
          timeline: { current_step_index: 1, items: [] } as never,
        }),
        paper({
          id: "late",
          timeline: { current_step_index: 6, items: [] } as never,
        }),
      ],
      slots: [slots({ paper_id: "early" }), slots({ paper_id: "late" })],
    });
    expect(early?.stepIndex).toBe(1);
    expect(late?.stepIndex).toBe(6);
    expect(early?.stepCount).toBe(8);
  });

  it("lets the roll-up figure be the filter, so a count is read and acted on once", () => {
    const { container, filters } = draw({
      rows: build({ papers: [paper()], slots: [slots({ provided_count: 0 })] }),
      filter: { state: "all" },
    });
    container
      .querySelector<HTMLButtonElement>('[data-testid="paper-overview-figure-attention"]')
      ?.click();
    expect(filters).toEqual([{ ...EMPTY_PAPER_OVERVIEW_FILTER, state: "attention" }]);
  });

  it("says a filter matched nothing rather than that the lab has no papers", () => {
    const { container } = draw({
      rows: build({ papers: [paper()], slots: [slots()] }),
      filter: { state: "attention" },
    });
    expect(container.textContent).toContain("No papers match these filters");

    const empty = draw({ rows: [], filter: { state: "all" } });
    expect(empty.container.textContent).toContain("No papers are registered yet");
  });

  it("opens the paper's own card from its title", () => {
    const { container, opened } = draw({
      rows: build({ papers: [paper()] }),
      filter: { state: "all" },
    });
    // By testid, not by position: the person's name is a button too now (it folds their papers
    // away), so "the first button in the row" is no longer the paper title.
    container.querySelector<HTMLButtonElement>('[data-testid="paper-overview-open-p-1"]')?.click();
    expect(opened).toEqual(["p-1"]);
  });

  it("says who the remainder is waiting on next to the bar", () => {
    const { container } = draw({
      rows: build({
        papers: [paper({ venue_decision: "reject" })],
        slots: [slots({ provided_count: 2 })],
      }),
      filter: { state: "all" },
    });
    expect(container.querySelector('[data-waiting="resubmission"]')?.textContent).toContain(
      "needs re-aiming",
    );
  });

  it("calls out a paper nobody can plan around", () => {
    const { container } = draw({
      rows: build({ papers: [paper()] }),
      filter: { state: "all" },
    });
    expect(container.textContent).toContain("no venue");
  });
});

describe("folding a person's papers away", () => {
  // Somebody with eleven papers pushes everyone below them off the screen. An administrator
  // scanning for who is stuck needs to put that stack away without losing the row that says how
  // the person is doing.
  const two = () =>
    build({
      papers: [paper(), paper({ id: "p-2", title: "Second paper" })],
    });

  it("asks the page to fold, keyed by person", () => {
    const { container, filters } = draw({ rows: two(), filter: { state: "all" } });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid^="paper-overview-person-toggle-"]',
    );
    expect(toggle).not.toBeNull();
    toggle?.click();
    expect(filters.at(-1)?.collapsed).toHaveLength(1);
  });

  it("hides the titles but keeps the person's row", () => {
    const { container, filters } = draw({ rows: two(), filter: { state: "all" } });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid^="paper-overview-person-toggle-"]',
    );
    toggle?.click();
    const collapsed = filters.at(-1)?.collapsed ?? [];

    const folded = draw({ rows: two(), filter: { state: "all", collapsed } });
    expect(folded.container.textContent).not.toContain("Second paper");
    // The measures an administrator is actually scanning stay put.
    expect(
      folded.container.querySelector('[data-testid="adminbot-paper-overview"]'),
    ).not.toBeNull();
    expect(tableRows(folded.container)).toHaveLength(1);
  });

  it("offers its own way back from the folded cell", () => {
    const { container, filters } = draw({ rows: two(), filter: { state: "all" } });
    container
      .querySelector<HTMLButtonElement>('[data-testid^="paper-overview-person-toggle-"]')
      ?.click();
    const collapsed = filters.at(-1)?.collapsed ?? [];

    const folded = draw({ rows: two(), filter: { state: "all", collapsed } });
    const back = folded.container.querySelector<HTMLButtonElement>(
      '[data-testid^="paper-overview-person-folded-"]',
    );
    // The row is wide; reaching back for the name means crossing the table.
    expect(back).not.toBeNull();
    back?.click();
    expect(folded.filters.at(-1)?.collapsed).toEqual([]);
  });

  it("says how many it is holding back", () => {
    const { container, filters } = draw({ rows: two(), filter: { state: "all" } });
    container
      .querySelector<HTMLButtonElement>('[data-testid^="paper-overview-person-toggle-"]')
      ?.click();
    const collapsed = filters.at(-1)?.collapsed ?? [];
    const folded = draw({ rows: two(), filter: { state: "all", collapsed } });
    expect(
      folded.container.querySelector('[data-testid^="paper-overview-person-folded-"]')?.textContent,
    ).toContain("2");
  });

  it("leaves everyone else expanded", () => {
    const { container } = draw({ rows: two(), filter: { state: "all", collapsed: ["nobody"] } });
    expect(container.textContent).toContain("Second paper");
  });
});
