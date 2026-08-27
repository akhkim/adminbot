/* @vitest-environment jsdom */
// Hiding a paper is a view preference, and the tests are mostly about what it must *not* do:
// touch the paper, leak between members, or drop rows without saying so.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearHiddenPapers,
  partitionHiddenPapers,
  readHiddenPapers,
  toggleHiddenPaper,
  writeHiddenPapers,
} from "./hidden-papers.ts";

afterEach(() => {
  localStorage.clear();
});

describe("hidden papers", () => {
  it("remembers what one member hid", () => {
    toggleHiddenPaper("ada", "paper-1");
    expect([...readHiddenPapers("ada")]).toEqual(["paper-1"]);
  });

  it("toggles back off", () => {
    toggleHiddenPaper("ada", "paper-1");
    toggleHiddenPaper("ada", "paper-1");
    expect(readHiddenPapers("ada").size).toBe(0);
  });

  it("keeps one member's list out of another's", () => {
    // Two people share a lab laptop often enough that this is the ordinary case, not the edge one.
    toggleHiddenPaper("ada", "paper-1");
    expect(readHiddenPapers("grace").size).toBe(0);
    toggleHiddenPaper("grace", "paper-2");
    expect([...readHiddenPapers("ada")]).toEqual(["paper-1"]);
  });

  it("clears the key rather than storing an empty list", () => {
    writeHiddenPapers("ada", new Set(["paper-1"]));
    writeHiddenPapers("ada", new Set());
    const leftover = Object.keys(localStorage).filter((key) => key.includes("hidden-papers"));
    expect(leftover).toEqual([]);
  });

  it("brings everything back at once", () => {
    toggleHiddenPaper("ada", "paper-1");
    toggleHiddenPaper("ada", "paper-2");
    clearHiddenPapers("ada");
    expect(readHiddenPapers("ada").size).toBe(0);
  });

  it("returns both halves so the page can say how many it is holding back", () => {
    const papers = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const split = partitionHiddenPapers(papers, new Set(["b"]));
    expect(split.visible.map((paper) => paper.id)).toEqual(["a", "c"]);
    expect(split.hidden.map((paper) => paper.id)).toEqual(["b"]);
  });

  it("renders unfiltered when storage is unreadable rather than failing", () => {
    // Private windows and blocked site data throw on access. A preference that cannot be read is
    // not a reason to show somebody an empty page.
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(readHiddenPapers("ada").size).toBe(0);
    } finally {
      Storage.prototype.getItem = getItem;
    }
  });

  it("survives a corrupted value", () => {
    localStorage.setItem("adminbot:my-work:hidden-papers:v1:ada", "{not json");
    expect(readHiddenPapers("ada").size).toBe(0);
  });
});
