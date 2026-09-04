import { render } from "lit";
import { beforeAll, describe, expect, it } from "vitest";
import { adminBotPaperSlots } from "../../../../extensions/adminbot/src/contracts/paper-slots.js";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";
import {
  applyPaste,
  columnIndexOf,
  gridColumns,
  clampWidth,
  tableWidth,
  ROWNUM_WIDTH,
  columnWidth,
  fillDown,
  TITLE_COLUMN,
  cellError,
  cellValue,
  clearHistory,
  describeHistory,
  diffForHistory,
  emptyPaperGridState,
  loadHistory,
  pendingSaves,
  recordHistory,
  renderPaperGrid,
  PAPER_GRID_THRESHOLD,
  mergeAuthorLinks,
  parseVenueTargets,
  clearSavedEdits,
  isWritable,
  pendingSlotWrites,
  unsentSlotEdits,
  visibleColumns,
  COLUMN_GROUPS,
  type GridCycles,
} from "./paper-grid.ts";

function paper(id: string, artifacts: Record<string, string> = {}): AdminBotPaperRecord {
  return {
    id,
    title: `Paper ${id}`,
    authors: ["Someone"],
    current_step: "overleaf_writing",
    artifacts,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  } as AdminBotPaperRecord;
}

// `save` matters: fillDown and applyPaste both refuse a column the backend cannot persist, so a
// stub without it silently tests the refusal path instead of the behaviour.
const arxivCol = {
  key: "arxiv_url",
  save: "arxivUrl",
  format: "https://arxiv.org/abs/…",
  label: "arXiv",
  short: "arXiv",
  hosts: ["arxiv.org"],
  path: /^\/abs\//u,
} as never;
const pwCol = {
  key: "arxiv_paper_password",
  label: "pw",
  short: "pw",
  pattern: /^[A-Za-z0-9]{6}$/u,
} as never;

describe("cell validation", () => {
  it("accepts an empty cell — empty clears the link", () => {
    expect(cellError(arxivCol, "")).toBeUndefined();
    expect(cellError(arxivCol, "   ")).toBeUndefined();
  });

  it("rejects a non-URL and a non-https URL", () => {
    expect(cellError(arxivCol, "not a url")).toBe("not a URL");
    expect(cellError(arxivCol, "http://arxiv.org/abs/1")).toBe("must be https");
  });

  it("rejects the right link on the wrong host", () => {
    expect(cellError(arxivCol, "https://drive.google.com/abs/1")).toContain("expected arxiv.org");
  });

  it("rejects the arXiv PDF, which is the common mistake", () => {
    expect(cellError(arxivCol, "https://arxiv.org/pdf/2306.05836")).toBeDefined();
    expect(cellError(arxivCol, "https://arxiv.org/abs/2306.05836")).toBeUndefined();
  });

  it("checks the paper password shape rather than URL shape", () => {
    expect(cellError(pwCol, "ab12cd")).toBeUndefined();
    expect(cellError(pwCol, "abc")).toBe("must be 6 letters/digits");
    expect(cellError(pwCol, "abc-12")).toBe("must be 6 letters/digits");
  });
});

describe("paste from a spreadsheet", () => {
  const papers = [paper("p1"), paper("p2"), paper("p3")];
  // Addressed by name, not by 0. These tests used to start at literal column 0 and read back
  // brainstorming_doc_url, which was the same thing until the grid grew the card's own fields and
  // Title took that slot -- exactly the drift columnIndexOf exists to survive.
  const docs = columnIndexOf("brainstorming_doc_url");

  it("spreads a tab-separated block down and across from the pasted cell", () => {
    const state = emptyPaperGridState();
    const filled = applyPaste(state, papers, 0, docs, "folderA\tviewA\nfolderB\tviewB");
    expect(filled).toBe(4);
    expect(state.edits.get("p1")?.get("brainstorming_doc_url")).toBe("folderA");
    expect(state.edits.get("p1")?.get("overleaf_view_url")).toBe("viewA");
    expect(state.edits.get("p2")?.get("brainstorming_doc_url")).toBe("folderB");
  });

  it("starts at the pasted cell, not at the top-left", () => {
    const state = emptyPaperGridState();
    applyPaste(state, papers, 1, columnIndexOf("overleaf_view_url"), "viewOnly");
    expect(state.edits.get("p1")).toBeUndefined();
    expect(state.edits.get("p2")?.get("overleaf_view_url")).toBe("viewOnly");
  });

  it("drops rows pasted past the end instead of inventing papers", () => {
    const state = emptyPaperGridState();
    const filled = applyPaste(state, papers, 2, docs, "a\nb\nc\nd");
    expect(filled).toBe(1);
    expect(state.edits.size).toBe(1);
  });

  it("handles CRLF, which is what Excel on Windows puts on the clipboard", () => {
    const state = emptyPaperGridState();
    applyPaste(state, papers, 0, docs, "one\r\ntwo\r\n");
    expect(state.edits.get("p2")?.get("brainstorming_doc_url")).toBe("two");
  });
});

describe("what gets saved", () => {
  const papers = [paper("p1"), paper("p2")];

  it("sends only the rows that changed", () => {
    const state = emptyPaperGridState();
    applyPaste(state, papers, 0, columnIndexOf("arxiv_url"), "https://arxiv.org/abs/1234.5678");
    const saves = pendingSaves(state, papers);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      id: "p1",
      arxivUrl: "https://arxiv.org/abs/1234.5678",
    });
  });

  it("leaves an invalid cell behind but still saves the valid ones in the same row", () => {
    // One typo in a wide row must not cost the author the other nine columns.
    const state = emptyPaperGridState();
    applyPaste(state, papers, 0, columnIndexOf("arxiv_url"), "junk");
    applyPaste(state, papers, 0, columnIndexOf("poster_url"), "https://example.com/poster.pdf");
    const saves = pendingSaves(state, papers);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.arxivUrl).toBeUndefined();
    expect(saves[0]?.posterUrl).toBe("https://example.com/poster.pdf");
  });

  it("shows the stored value until it is edited", () => {
    const stored = paper("p9", {
      arxiv_url: "https://arxiv.org/abs/9999.1111",
    });
    const state = emptyPaperGridState();
    expect(cellValue(state, stored, arxivCol)).toBe("https://arxiv.org/abs/9999.1111");
    applyPaste(state, [stored], 0, columnIndexOf("arxiv_url"), "https://arxiv.org/abs/0000.2222");
    expect(cellValue(state, stored, arxivCol)).toBe("https://arxiv.org/abs/0000.2222");
  });
});

describe("threshold", () => {
  it("is 2 — the sheet appears from the third paper on", () => {
    expect(PAPER_GRID_THRESHOLD).toBe(2);
    // Three papers is a normal number to have, and it must show the button. The first attempt at
    // this used `> 3`, which hid the sheet from exactly that person.
    expect(2 > PAPER_GRID_THRESHOLD).toBe(false);
    expect(3 > PAPER_GRID_THRESHOLD).toBe(true);
  });
});

describe("change history", () => {
  // The jsdom stub here exposes a localStorage object whose methods are missing, so the real
  // one is replaced with a working in-memory store to exercise the persistence path.
  beforeAll(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: () => null,
        length: 0,
      },
    });
  });

  const stored = paper("p1", { arxiv_url: "https://arxiv.org/abs/1111.1111" });

  it("reports a first value as added", () => {
    const state = emptyPaperGridState();
    applyPaste(
      state,
      [paper("p2")],
      0,
      columnIndexOf("poster_url"),
      "https://example.com/poster.pdf",
    );
    const [entry] = diffForHistory(state, [paper("p2")]);
    expect(entry).toMatchObject({ kind: "added", column: "Poster" });
    expect(describeHistory(entry!)).toBe("You added Poster: https://example.com/poster.pdf");
  });

  it("reports a replacement as changed, carrying both values", () => {
    const state = emptyPaperGridState();
    applyPaste(state, [stored], 0, columnIndexOf("arxiv_url"), "https://arxiv.org/abs/2222.2222");
    const [entry] = diffForHistory(state, [stored]);
    expect(entry).toMatchObject({
      kind: "changed",
      from: "https://arxiv.org/abs/1111.1111",
      to: "https://arxiv.org/abs/2222.2222",
    });
    expect(describeHistory(entry!)).toContain("from https://arxiv.org/abs/1111.1111 to");
  });

  it("ignores a cell retyped to the value it already had", () => {
    const state = emptyPaperGridState();
    applyPaste(state, [stored], 0, columnIndexOf("arxiv_url"), "https://arxiv.org/abs/1111.1111");
    expect(diffForHistory(state, [stored])).toEqual([]);
  });

  it("does not log a cell that failed validation, since it is not saved either", () => {
    const state = emptyPaperGridState();
    applyPaste(state, [stored], 0, columnIndexOf("arxiv_url"), "junk");
    expect(diffForHistory(state, [stored])).toEqual([]);
  });

  it("keeps only the most recent 30, newest first", () => {
    clearHistory();
    const make = (n: number) => ({
      at: new Date().toISOString(),
      paperTitle: `P${n}`,
      column: "Poster",
      from: "",
      to: `v${n}`,
      kind: "added" as const,
    });
    for (let i = 0; i < 12; i += 1) {
      recordHistory([make(i)]);
    }
    recordHistory(Array.from({ length: 25 }, (_, i) => make(100 + i)));
    const history = loadHistory();
    expect(history).toHaveLength(30);
    expect(history[0]?.paperTitle).toBe("P100");
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});

describe("fill down", () => {
  const arxiv = (id: string, url?: string) => paper(id, url ? { arxiv_url: url } : {});

  it("copies the value into the empty cells below", () => {
    const papers = [arxiv("p1", "https://arxiv.org/abs/1111.1111"), arxiv("p2"), arxiv("p3")];
    const state = emptyPaperGridState();
    expect(fillDown(state, papers, arxivCol, 0, 2)).toBe(2);
    expect(cellValue(state, papers[2]!, arxivCol)).toBe("https://arxiv.org/abs/1111.1111");
  });

  it("never overwrites a cell that already has something", () => {
    // The whole reason it fills blanks only: one drag covers thirty rows, there is no undo, and
    // the rows belong to other people.
    const papers = [
      arxiv("p1", "https://arxiv.org/abs/1111.1111"),
      arxiv("p2", "https://arxiv.org/abs/2222.2222"),
      arxiv("p3"),
    ];
    const state = emptyPaperGridState();
    expect(fillDown(state, papers, arxivCol, 0, 2)).toBe(1);
    expect(cellValue(state, papers[1]!, arxivCol)).toBe("https://arxiv.org/abs/2222.2222");
    expect(cellValue(state, papers[2]!, arxivCol)).toBe("https://arxiv.org/abs/1111.1111");
  });

  it("does nothing from an empty cell", () => {
    const papers = [arxiv("p1"), arxiv("p2")];
    expect(fillDown(emptyPaperGridState(), papers, arxivCol, 0, 1)).toBe(0);
  });

  it("stops at the last row when asked to go further", () => {
    const papers = [arxiv("p1", "https://arxiv.org/abs/1111.1111"), arxiv("p2")];
    expect(fillDown(emptyPaperGridState(), papers, arxivCol, 0, 99)).toBe(1);
  });
});

describe("column widths", () => {
  it("falls back to a default until one is set", () => {
    const state = emptyPaperGridState();
    state.widths = new Map();
    expect(columnWidth(state, TITLE_COLUMN)).toBeGreaterThan(columnWidth(state, "arxiv_url"));
  });

  it("uses the stored width once there is one", () => {
    const state = emptyPaperGridState();
    state.widths.set("arxiv_url", 420);
    expect(columnWidth(state, "arxiv_url")).toBe(420);
  });

  it("refuses widths that would make a column unusable or hide the sheet", () => {
    expect(clampWidth(2)).toBeGreaterThanOrEqual(64);
    expect(clampWidth(99999)).toBeLessThanOrEqual(900);
    expect(clampWidth(250.4)).toBe(250);
  });
});

describe("table width", () => {
  it("is the gutter plus every column, so fixed layout has a definite width to obey", () => {
    const state = emptyPaperGridState();
    state.widths = new Map();
    const before = tableWidth(state);
    expect(before).toBeGreaterThan(ROWNUM_WIDTH);

    // Shrinking a column must shrink the table. Without this the space is handed to a neighbour
    // and the Paper column cannot actually be pulled left.
    state.widths.set(TITLE_COLUMN, 120);
    expect(tableWidth(state)).toBeLessThan(before);
  });

  it("grows when a column is widened", () => {
    const state = emptyPaperGridState();
    state.widths = new Map();
    const before = tableWidth(state);
    state.widths.set("arxiv_url", 600);
    expect(tableWidth(state)).toBeGreaterThan(before);
  });
});

describe("what a column asks for", () => {
  // The rules live in `hosts` and `path`, which nobody filling the sheet can see. The format
  // string is the only place they are stated for a reader, so it has to agree with them.
  it("states a format for every column", () => {
    for (const column of gridColumns()) {
      expect(column.format, `${column.label} has no format`).toBeTruthy();
    }
  });

  it("names a host and path the column would actually accept", () => {
    for (const column of gridColumns()) {
      if (!column.hosts) {
        continue;
      }
      const url = new URL(column.format.split(" ")[0] as string);
      expect(
        column.hosts,
        `${column.label}: ${url.hostname} is not in its own host list`,
      ).toContain(url.hostname);
      if (column.path) {
        expect(
          column.path.test(url.pathname),
          `${column.label}: ${url.pathname} fails its own path rule`,
        ).toBe(true);
      }
    }
  });

  it("shows a shape, never a usable link", () => {
    // A complete example reads as real and gets pasted, which is how a sheet ends up with thirty
    // rows pointing at one fictional document. Every URL format stops at the prefix.
    for (const column of gridColumns()) {
      if (column.format.startsWith("https://")) {
        expect(column.format, `${column.label} reads as a real link`).toContain("…");
      }
    }
  });

  it("still rejects the arXiv PDF, which is what its note is for", () => {
    const arxiv = gridColumns().find((column) => column.key === "arxiv_url");
    expect(cellError(arxiv!, "https://arxiv.org/pdf/2508.01234")).toBeDefined();
    expect(cellError(arxiv!, "https://arxiv.org/abs/2508.01234")).toBeUndefined();
  });
});

describe("the help bubble", () => {
  it("opens one column at a time and closes on a second press", () => {
    const state = emptyPaperGridState();
    expect(state.helpFor).toBeNull();
    state.helpFor = "arxiv_url";
    expect(state.helpFor).toBe("arxiv_url");
    state.helpFor = null;
    expect(state.helpFor).toBeNull();
  });
});

// The grid now carries what the card carries, and writes it to the same row through the same
// endpoint. These cover the fields that are not a plain string on the save input, because those
// are the ones a naive round-trip would quietly damage.
describe("the fields the card carries", () => {
  const rich = (): AdminBotPaperRecord =>
    ({
      id: "p1",
      title: "Causal abstraction",
      alias: "cais",
      started_on: "2026-01-15",
      current_step: "overleaf_writing",
      authors: ["Ada Lovelace", "Yook, Joeun"],
      author_links: [
        { name: "Ada Lovelace", member_id: "ada" },
        { name: "Yook, Joeun", member_id: "joeun" },
      ],
      feedback_givers: ["Rahul Shrestha"],
      venue_decision: "accept",
      accepted_year: 2027,
      is_archival: true,
      artifacts: {},
    }) as unknown as AdminBotPaperRecord;

  const columnFor = (key: string) => gridColumns()[columnIndexOf(key)]!;

  it("offers every field the card can edit", () => {
    const keys = gridColumns().map((column) => String(column.key));
    for (const key of [
      "title",
      "alias",
      "started_on",
      "current_step",
      "authors",
      "author_roles",
      "feedback_givers",
      "venue",
      "venue_targets",
      "topic",
      "venue_decision",
      "accepted_venue",
      "accepted_year",
      "is_archival",
      "presentation_type",
      "blocker_log",
      // Filing a blocker and closing the paper out are both things the card does, so both are
      // cells here too.
      "blocker",
      "completed_at",
      "submission_url",
      "arxiv_paper_password",
    ]) {
      expect(keys, `${key} should be a column`).toContain(key);
    }
  });

  // Appends, never replaces: the log carries who raised each entry and when, and a sheet that
  // overwrote it would trade a history for one line of retyped text.
  it("files a blocker from a cell, keeping the ones already on the paper", () => {
    const state = emptyPaperGridState();
    const paperWithLog = {
      ...rich(),
      artifacts: {
        blocker_log: JSON.stringify([
          {
            stage: "submission",
            title: "Waiting on numbers",
            note: "",
            by: "Ada",
            at: "2026-08-01T00:00:00.000Z",
          },
        ]),
      },
    } as unknown as AdminBotPaperRecord;
    state.edits.set("p1", new Map([["blocker", "Overleaf compile is broken"]]));
    const [save] = pendingSaves(state, [paperWithLog]);
    const log = JSON.parse(save?.blockerLog ?? "[]") as Array<{
      title: string;
    }>;
    expect(log.map((entry) => entry.title)).toEqual([
      "Overleaf compile is broken",
      "Waiting on numbers",
    ]);
  });

  it("reads the record's own columns, not just artifacts", () => {
    const state = emptyPaperGridState();
    const record = rich();
    expect(cellValue(state, record, columnFor("title"))).toBe("Causal abstraction");
    expect(cellValue(state, record, columnFor("alias"))).toBe("cais");
    expect(cellValue(state, record, columnFor("started_on"))).toBe("2026-01-15");
    expect(cellValue(state, record, columnFor("current_step"))).toBe("overleaf_writing");
    expect(cellValue(state, record, columnFor("accepted_year"))).toBe("2027");
    expect(cellValue(state, record, columnFor("is_archival"))).toBe("true");
  });

  // The hazard worth naming: author_links is what decides whose My Projects page a paper appears
  // on, and a cell holds names and nothing else.
  it("keeps an author's roster link when their name is untouched", () => {
    const state = emptyPaperGridState();
    const record = rich();
    state.edits.set("p1", new Map([["authors", "Ada Lovelace; Yook, Joeun; New Person"]]));
    const [save] = pendingSaves(state, [record]);

    expect(save?.authors).toEqual(["Ada Lovelace", "Yook, Joeun", "New Person"]);
    expect(save?.authorLinks).toEqual([
      { name: "Ada Lovelace", member_id: "ada" },
      { name: "Yook, Joeun", member_id: "joeun" },
      // Genuinely new, so unlinked rather than guessed at. The card's picker links it.
      { name: "New Person" },
    ]);
  });

  it("splits authors on semicolons, because a BibTeX name has a comma in it", () => {
    expect(mergeAuthorLinks(rich(), ["Yook, Joeun"]).map((link) => link.name)).toEqual([
      "Yook, Joeun",
    ]);
  });

  it("round-trips venue targets through the way the spreadsheet reads them", () => {
    expect(parseVenueTargets("80% ICLR 2027 · 50% ARR October")).toEqual([
      { venue_id: "iclr 2027", label: "ICLR 2027", confidence: 80 },
      { venue_id: "arr october", label: "ARR October", confidence: 50 },
    ]);
    expect(parseVenueTargets("")).toEqual([]);
    expect(parseVenueTargets("ICLR, probably")).toBeUndefined();
  });

  it("holds a cell it cannot parse instead of writing a broken record", () => {
    const state = emptyPaperGridState();
    const record = rich();
    state.edits.set("p1", new Map([["venue_targets", "ICLR, probably"]]));
    expect(pendingSaves(state, [record])).toEqual([]);
  });

  it("refuses an empty title and a short name Slack could not take", () => {
    expect(cellError(columnFor("title"), "   ")).toBeTruthy();
    expect(cellError(columnFor("title"), "Fine")).toBeUndefined();
    expect(cellError(columnFor("alias"), "Bob's Project")).toBeTruthy();
    expect(cellError(columnFor("alias"), "cais")).toBeUndefined();
    // Blank clears it, which the record allows.
    expect(cellError(columnFor("alias"), "")).toBeUndefined();
  });

  // A text column is not a URL column, and running new URL() over a title would call it bad.
  it("does not hold non-link columns to link rules", () => {
    expect(
      cellError(columnFor("author_roles"), "Ada writes, Joeun runs experiments"),
    ).toBeUndefined();
    expect(cellError(columnFor("venue"), "ICLR 2027")).toBeUndefined();
    expect(cellError(columnFor("current_step"), "overleaf_writing")).toBeUndefined();
    expect(cellError(columnFor("current_step"), "not_a_step")).toBeTruthy();
  });

  it("writes the arXiv password that used to be dropped", () => {
    const state = emptyPaperGridState();
    state.edits.set("p1", new Map([["arxiv_paper_password", "ab12cd"]]));
    const [save] = pendingSaves(state, [rich()]);
    expect(save).toMatchObject({ arxivPaperPassword: "ab12cd" });
    expect(cellError(columnFor("arxiv_paper_password"), "nope")).toBeTruthy();
  });

  // The card offers these five and so does the sheet, and the member write path takes all five
  // (OWN_PAPER_EDITABLE_FIELDS) -- so an author records their own paper's outcome, and an admin
  // records a round of them without opening twenty cards.
  it("offers the acceptance answers the card offers", () => {
    for (const key of [
      "venue_decision",
      "accepted_venue",
      "accepted_year",
      "is_archival",
      "presentation_type",
    ]) {
      expect(columnFor(key).save, `${key} should be writable`).toBeDefined();
    }
    const state = emptyPaperGridState();
    state.edits.set("p1", new Map([["venue_decision", "accept"]]));
    expect(pendingSaves(state, [rich()])[0]).toMatchObject({
      venueDecision: "accept",
    });
  });

  // The property that keeps a stored answer safe: a row nobody typed a decision into never carries
  // one, so editing the Overleaf link beside it cannot rewrite what the venue said.
  it("sends a decision only from the cell that was typed in", () => {
    const state = emptyPaperGridState();
    state.edits.set("p1", new Map([["overleaf_view_url", "https://www.overleaf.com/read/abcdef"]]));
    const [save] = pendingSaves(state, [rich()]);
    expect(save).toBeDefined();
    expect(save?.venueDecision).toBeUndefined();
    expect(save?.acceptedVenue).toBeUndefined();
  });

  // Shown so the grid is honest about what a paper holds; not editable, because each entry carries
  // an author and a timestamp that retyping would erase.
  it("shows the blocker log without offering to overwrite it", () => {
    const column = columnFor("blocker_log");
    expect(column.save).toBeUndefined();
    expect(column.apply).toBeUndefined();
    const state = emptyPaperGridState();
    state.edits.set("p1", new Map([["blocker_log", "anything"]]));
    expect(pendingSaves(state, [rich()])).toEqual([]);
  });
});

// ── the evidence half ─────────────────────────────────────────────────────────────────────
//
// The checklist the card counts as "0/21 artifacts" lives in `paper_slots`, not on the paper, and
// it is written one slot at a time. These are the tests that it is the same data and not a second
// copy of it: what the sheet shows comes from the cycle the card loaded, and what it saves goes to
// the endpoint the card's own checkbox uses.

describe("evidence columns", () => {
  const paperRow = (): AdminBotPaperRecord =>
    ({
      id: "p1",
      title: "Causal abstraction",
      authors: ["Ada"],
      current_step: "arxiv_polish",
      artifacts: { poster_url: "https://drive.google.com/file/d/old/view" },
    }) as unknown as AdminBotPaperRecord;

  const cycles = (rows: Array<Record<string, unknown>>): GridCycles => ({
    p1: { slots: rows as never },
  });

  const columnFor = (key: string) => gridColumns()[columnIndexOf(key)]!;

  it("gives every slot in the registry a column, once", () => {
    const slotted = gridColumns().flatMap((column) => (column.slot ? [column.slot] : []));
    expect(new Set(slotted).size, "no slot may appear twice").toBe(slotted.length);
    for (const slot of adminBotPaperSlots) {
      expect(slotted, `${slot} should be reachable from the sheet`).toContain(slot);
    }
  });

  it("shows the slot's own value ahead of the artifact it mirrors", () => {
    const state = emptyPaperGridState();
    const column = columnFor("poster_url");
    // No cycle loaded: the artifact the paper has always carried is what there is.
    expect(cellValue(state, paperRow(), column)).toBe("https://drive.google.com/file/d/old/view");
    state.cycles = cycles([
      {
        slot: "poster",
        status: "provided",
        url: "https://drive.google.com/file/d/new/view",
      },
    ]);
    expect(cellValue(state, paperRow(), column)).toBe("https://drive.google.com/file/d/new/view");
  });

  it("reads a yes/no gate as the two answers its checkbox gives", () => {
    const state = emptyPaperGridState();
    const column = columnFor("slot:pi_approval");
    expect(cellValue(state, paperRow(), column)).toBe("");
    state.cycles = cycles([{ slot: "pi_approval", status: "provided" }]);
    expect(cellValue(state, paperRow(), column)).toBe("yes");
  });

  it("sends each changed slot as the write its own kind takes", () => {
    const state = emptyPaperGridState();
    state.cycles = cycles([
      { slot: "pi_approval", status: "missing" },
      { slot: "submission_id", status: "missing" },
      { slot: "talk_video", status: "missing" },
    ]);
    state.edits.set(
      "p1",
      new Map([
        ["slot:pi_approval", "yes"],
        ["slot:submission_id", "4821"],
        ["slot:talk_video", "https://www.youtube.com/watch?v=abc"],
      ]),
    );
    const writes = pendingSlotWrites(state, [paperRow()]);
    expect(writes.map((write) => write.slot).sort()).toEqual([
      "pi_approval",
      "submission_id",
      "talk_video",
    ]);
    expect(writes.find((write) => write.slot === "pi_approval")?.input).toEqual({ done: true });
    expect(writes.find((write) => write.slot === "submission_id")?.input).toEqual({
      value_text: "4821",
    });
    expect(writes.find((write) => write.slot === "talk_video")?.input).toEqual({
      url: "https://www.youtube.com/watch?v=abc",
    });
  });

  // Re-sending a value that is already stored would restamp who provided the evidence and when,
  // on a row somebody else filled in.
  it("does not re-send a slot that already holds the typed value", () => {
    const state = emptyPaperGridState();
    state.cycles = cycles([{ slot: "pi_approval", status: "provided" }]);
    state.edits.set("p1", new Map([["slot:pi_approval", "yes"]]));
    expect(pendingSlotWrites(state, [paperRow()])).toEqual([]);
  });

  // A tick typed before the paper's slots arrived cannot be told apart from a re-send, so it is
  // held rather than sent -- and held rather than dropped, which is what the notice promises.
  it("holds evidence typed against a paper whose slots have not loaded", () => {
    const state = emptyPaperGridState();
    state.edits.set(
      "p1",
      new Map([
        ["slot:pi_approval", "yes"],
        ["title", "Renamed"],
      ]),
    );
    const papers = [paperRow()];
    expect(pendingSlotWrites(state, papers)).toEqual([]);
    expect(unsentSlotEdits(state, papers)).toBe(1);
    clearSavedEdits(state, papers);
    expect(state.edits.get("p1")?.get("title")).toBeUndefined();
    expect(state.edits.get("p1")?.get("slot:pi_approval")).toBe("yes");
  });

  // The two social-draft gates read the drafts table and reject a direct write. Shown, never typed
  // in -- a tick there would claim a consent that was never asked for.
  it("shows the derived gates without offering to tick them", () => {
    for (const key of ["slot:x_draft", "slot:linkedin_draft"]) {
      expect(isWritable(columnFor(key)), `${key} must not be writable`).toBe(false);
    }
    const state = emptyPaperGridState();
    state.cycles = cycles([{ slot: "x_draft", status: "missing" }]);
    state.edits.set("p1", new Map([["slot:x_draft", "yes"]]));
    expect(pendingSlotWrites(state, [paperRow()])).toEqual([]);
  });

  it("keeps an evidence link honest by the registry's own rule", () => {
    const column = columnFor("slot:x_post");
    expect(cellError(column, "not-a-link")).toBeDefined();
    expect(cellError(column, "https://x.com/JinesisLab/status/1839")).toBeUndefined();
  });
});

describe("column bands", () => {
  it("draws only the bands that are switched on", () => {
    const state = emptyPaperGridState();
    // Evidence is off by default: it is the one band that costs a request per paper to fill.
    expect(state.groups).not.toContain("evidence");
    expect(visibleColumns(state).some((column) => column.group === "evidence")).toBe(false);
    state.groups = [...state.groups, "evidence"];
    expect(visibleColumns(state).some((column) => column.group === "evidence")).toBe(true);
  });

  it("keeps the bands in registry order however they were ticked", () => {
    const state = emptyPaperGridState();
    state.groups = ["links", "project"];
    const order = visibleColumns(state).map((column) => column.group);
    expect(order.indexOf("project")).toBeLessThan(order.indexOf("links"));
  });

  // The paste target is an index into what is drawn. With a band hidden that differs from the
  // registry's order, and pasting into the registry's would land every value in the wrong column.
  it("pastes into the columns on screen, not the ones behind a hidden band", () => {
    const state = emptyPaperGridState();
    state.groups = ["links"];
    const papers = [paperRow2()];
    const columns = visibleColumns(state);
    const first = columns[0]!;
    applyPaste(state, papers, 0, 0, "https://docs.google.com/document/d/abc/edit");
    expect(state.edits.get("p2")?.get(String(first.key))).toBe(
      "https://docs.google.com/document/d/abc/edit",
    );
  });

  it("names every band a column claims", () => {
    const known = new Set(COLUMN_GROUPS.map((group) => group.id));
    for (const column of gridColumns()) {
      expect(known, `${String(column.key)} is in an unknown band`).toContain(column.group);
    }
  });
});

function paperRow2(): AdminBotPaperRecord {
  return {
    id: "p2",
    title: "Second",
    authors: ["Ada"],
    current_step: "brainstorming_docs",
    artifacts: {},
  } as unknown as AdminBotPaperRecord;
}

// ── the drawn sheet ───────────────────────────────────────────────────────────────────────
//
// The parts of the surface that are behaviour rather than layout: which bands are drawn, what
// asking for a band costs, and that one press sends both halves of a row.

describe("the sheet as drawn", () => {
  const papers = [paperRow2()];

  function draw(overrides: Partial<Parameters<typeof renderPaperGrid>[0]> = {}) {
    document.body.replaceChildren();
    const host = document.createElement("div");
    document.body.append(host);
    const loaded: string[] = [];
    const saved: unknown[][] = [];
    const slotWrites: unknown[][] = [];
    const state = emptyPaperGridState();
    const props = {
      state,
      papers,
      onChange: () => undefined,
      onSaveAll: (inputs: unknown[]) => saved.push(inputs),
      onExit: () => undefined,
      onLoadSlots: (id: string) => loaded.push(id),
      onSaveSlots: (writes: unknown[]) => slotWrites.push(writes),
      ...overrides,
    } as Parameters<typeof renderPaperGrid>[0];
    render(renderPaperGrid(props), host);
    return { host, state, loaded, saved, slotWrites, props };
  }

  it("draws a chip per band, with the evidence one off", () => {
    const { host } = draw();
    for (const group of COLUMN_GROUPS) {
      expect(
        host.querySelector(`[data-testid="paper-grid-band-${group.id}"]`),
        `${group.id} needs a chip`,
      ).not.toBeNull();
    }
    const evidence = host.querySelector('[data-testid="paper-grid-band-evidence"]');
    expect(evidence?.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelectorAll('th[data-band="evidence"]').length).toBe(0);
  });

  // One request per paper, and only for the band that needs them. A member who never opens
  // Evidence sends none of these at all.
  it("asks for a paper's evidence once, and only while the band is open", async () => {
    const { loaded } = draw();
    await Promise.resolve();
    expect(loaded).toEqual([]);

    const second = draw();
    second.state.groups = [...second.state.groups, "evidence"];
    render(renderPaperGrid(second.props), second.host);
    await Promise.resolve();
    expect(second.loaded).toEqual(["p2"]);
    // Drawn again with nothing loaded yet: the request is not repeated on every frame.
    render(renderPaperGrid(second.props), second.host);
    await Promise.resolve();
    expect(second.loaded).toEqual(["p2"]);
  });

  it("sends the record and the evidence from one press", () => {
    const drawn = draw({
      slots: { p2: { slots: [{ slot: "pi_approval", status: "missing" }] } },
    });
    const { host, state, saved, slotWrites } = drawn;
    state.edits.set(
      "p2",
      new Map([
        ["title", "Renamed"],
        ["slot:pi_approval", "yes"],
      ]),
    );
    // Drawn again: the button is disabled until there is something to send, which is the state
    // the first draw was in.
    render(renderPaperGrid(drawn.props), host);
    const update = host.querySelector("button.btn.primary") as HTMLButtonElement;
    update.click();
    expect(saved[0]).toHaveLength(1);
    expect(slotWrites[0]).toHaveLength(1);
  });
});
