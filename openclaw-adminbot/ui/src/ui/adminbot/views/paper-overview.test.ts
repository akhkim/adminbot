// Active Papers: what a row says, and what the filters group the lab's papers into.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PaperSlotOverviewRow } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import {
  EMPTY_PAPER_OVERVIEW_FILTER,
  filterPaperRows,
  paperOverviewRows,
  paperOverviewSummary,
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
        slots({ paper_id: "missing", provided_count: 1, missing_slots: ["camera_ready"] }),
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

describe("filterPaperRows", () => {
  const rows = build({
    papers: [
      paper({ id: "needs", title: "Needs work", venue: "ACL 2026" }),
      paper({ id: "fine", title: "All fine", venue: "EMNLP 2026", current_step: "submission" }),
      paper({ id: "old", title: "Shelved", dormant_override: true }),
    ],
    slots: [
      slots({ paper_id: "needs", provided_count: 0, missing_slots: ["camera_ready"] }),
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

describe("renderPaperOverviewTable", () => {
  it("puts the lab on one scannable line per paper", () => {
    const { container } = draw({
      rows: build({
        papers: [paper({ timeline: { progress_percent: 40, items: [] } as never })],
        slots: [slots({ provided_count: 1, missing_slots: ["camera_ready", "slides"] })],
      }),
      filter: { state: "all" },
    });
    expect(
      [...container.querySelectorAll(".profile-overview__head")].map((h) => h.textContent?.trim()),
    ).toEqual(["Paper", "Progress", "Stage", "Evidence", "Venue", "Outstanding"]);
    expect(container.querySelector(".profile-overview__percent")?.textContent).toBe("40%");
    expect(container.textContent).toContain("1/3");
    expect(container.textContent).toContain("camera ready");
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

  it("opens the paper from its title", () => {
    const { container, opened } = draw({
      rows: build({ papers: [paper()] }),
      filter: { state: "all" },
    });
    tableRows(container)[0]?.querySelector<HTMLButtonElement>("button")?.click();
    expect(opened).toEqual(["p-1"]);
  });

  it("calls out a paper nobody can plan around", () => {
    const { container } = draw({ rows: build({ papers: [paper()] }), filter: { state: "all" } });
    expect(container.textContent).toContain("no venue");
  });
});
