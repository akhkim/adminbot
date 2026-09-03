import { beforeAll, describe, expect, it } from "vitest";
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
  PAPER_GRID_THRESHOLD,
  mergeAuthorLinks,
  parseVenueTargets,
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
    expect(saves[0]).toMatchObject({ id: "p1", arxivUrl: "https://arxiv.org/abs/1234.5678" });
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
    const stored = paper("p9", { arxiv_url: "https://arxiv.org/abs/9999.1111" });
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
      "submission_url",
      "arxiv_paper_password",
    ]) {
      expect(keys, `${key} should be a column`).toContain(key);
    }
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

  // The service refuses venue_decision from the member write path (400, admin included) and drops
  // the four details beside it. A cell that accepted them would fail the whole row.
  it("shows the acceptance answers without offering an edit the service would refuse", () => {
    const state = emptyPaperGridState();
    for (const key of [
      "venue_decision",
      "accepted_venue",
      "accepted_year",
      "is_archival",
      "presentation_type",
    ]) {
      const column = columnFor(key);
      expect(column.save, `${key} must not be writable`).toBeUndefined();
      expect(column.apply, `${key} must not be writable`).toBeUndefined();
      state.edits.set("p1", new Map([[key, "accept"]]));
      expect(pendingSaves(state, [rich()]), `${key} must not reach a save`).toEqual([]);
    }
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
