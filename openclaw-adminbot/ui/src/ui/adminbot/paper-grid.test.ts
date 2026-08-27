import { beforeAll, describe, expect, it } from "vitest";
import {
  applyPaste,
  columnIndexOf,
  clampWidth,
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
} from "./paper-grid.ts";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";

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
  label: "arXiv",
  short: "arXiv",
  hosts: ["arxiv.org"],
  path: /^\/abs\//u,
} as never;
const pwCol = { key: "arxiv_paper_password", label: "pw", short: "pw", pattern: /^[A-Za-z0-9]{6}$/u } as never;

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

  it("spreads a tab-separated block down and across from the pasted cell", () => {
    const state = emptyPaperGridState();
    const filled = applyPaste(state, papers, 0, 0, "folderA\tviewA\nfolderB\tviewB");
    expect(filled).toBe(4);
    expect(state.edits.get("p1")?.get("brainstorming_doc_url")).toBe("folderA");
    expect(state.edits.get("p1")?.get("overleaf_view_url")).toBe("viewA");
    expect(state.edits.get("p2")?.get("brainstorming_doc_url")).toBe("folderB");
  });

  it("starts at the pasted cell, not at the top-left", () => {
    const state = emptyPaperGridState();
    applyPaste(state, papers, 1, 1, "viewOnly");
    expect(state.edits.get("p1")).toBeUndefined();
    expect(state.edits.get("p2")?.get("overleaf_view_url")).toBe("viewOnly");
  });

  it("drops rows pasted past the end instead of inventing papers", () => {
    const state = emptyPaperGridState();
    const filled = applyPaste(state, papers, 2, 0, "a\nb\nc\nd");
    expect(filled).toBe(1);
    expect(state.edits.size).toBe(1);
  });

  it("handles CRLF, which is what Excel on Windows puts on the clipboard", () => {
    const state = emptyPaperGridState();
    applyPaste(state, papers, 0, 0, "one\r\ntwo\r\n");
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
    applyPaste(state, [paper("p2")], 0, columnIndexOf("poster_url"), "https://example.com/poster.pdf");
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
  const arxiv = (id: string, url?: string) =>
    paper(id, url ? { arxiv_url: url } : {});

  it("copies the value into the empty cells below", () => {
    const papers = [
      arxiv("p1", "https://arxiv.org/abs/1111.1111"),
      arxiv("p2"),
      arxiv("p3"),
    ];
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

