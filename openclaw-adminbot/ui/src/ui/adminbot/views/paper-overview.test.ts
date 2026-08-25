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
        papers: [paper({ timeline: { current_step_index: 2, items: [] } as never })],
        slots: [slots({ provided_count: 1, missing_slots: ["camera_ready", "slides"] })],
      }),
      filter: { state: "all" },
    });
    // Stage and Progress were the same fact twice: both were derived from `current_step` and
    // nothing else, so one of them had to go.
    expect(
      [...container.querySelectorAll(".profile-overview__head")].map((h) => h.textContent?.trim()),
    ).toEqual(["Paper", "Progress", "Stage", "Evidence", "Venue", "Outstanding"]);
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
    expect(container.querySelector(".paper-overview__stage")?.textContent).toContain("done");
    expect(container.querySelector(".profile-overview__bar.is-complete")).not.toBeNull();
  });

  it("reads the step from the paper, not from a percentage that is the same for every paper on it", () => {
    const [early, late] = build({
      papers: [
        paper({ id: "early", timeline: { current_step_index: 1, items: [] } as never }),
        paper({ id: "late", timeline: { current_step_index: 6, items: [] } as never }),
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
    tableRows(container)[0]?.querySelector<HTMLButtonElement>("button")?.click();
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
    const { container } = draw({ rows: build({ papers: [paper()] }), filter: { state: "all" } });
    expect(container.textContent).toContain("no venue");
  });
});
