import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotVenuePaper } from "../contracts/actions.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-venue-"));
  dirs.push(dir);
  return new AdminBotSqliteStore(path.join(dir, "adminbot.sqlite"));
}

function paper(id: string, venue = "ICLR 2026 Poster"): AdminBotVenuePaper {
  return {
    venue_id: "ICLR.cc/2026/Conference",
    paper_id: id,
    title: `Paper ${id}`,
    abstract: "",
    keywords: [],
    venue,
    forum_url: `https://openreview.net/forum?id=${id}`,
    vector: [1, 0],
  };
}

describe("venue paper reads", () => {
  // A large venue is ~70MB of JSON, and both the search and the category list read all of it.
  // Parsing that per request blocked every other user for the better part of a second.
  it("parses a venue once and serves repeat reads from memory", () => {
    const store = openStore();
    store.replaceVenueIndex("ICLR.cc/2026/Conference", [paper("a"), paper("b")], "t1", "m");

    const first = store.listVenuePapers("ICLR.cc/2026/Conference");
    expect(first.map((row) => row.paper_id).toSorted()).toEqual(["a", "b"]);
    expect(store.listVenuePapers("ICLR.cc/2026/Conference")).toBe(first);
  });

  it("drops the cached venue when it is re-indexed", () => {
    const store = openStore();
    store.replaceVenueIndex("ICLR.cc/2026/Conference", [paper("a")], "t1", "m");
    const before = store.listVenuePapers("ICLR.cc/2026/Conference");

    store.replaceVenueIndex("ICLR.cc/2026/Conference", [paper("c")], "t2", "m");

    const after = store.listVenuePapers("ICLR.cc/2026/Conference");
    expect(after).not.toBe(before);
    expect(after.map((row) => row.paper_id)).toEqual(["c"]);
  });

  it("keeps the old cache when a re-index fails", () => {
    const store = openStore();
    store.replaceVenueIndex("ICLR.cc/2026/Conference", [paper("a")], "t1", "m");
    const before = store.listVenuePapers("ICLR.cc/2026/Conference");

    // A duplicate paper id violates the primary key mid-insert and rolls the rebuild back.
    expect(() =>
      store.replaceVenueIndex("ICLR.cc/2026/Conference", [paper("x"), paper("x")], "t2", "m"),
    ).toThrow();

    expect(store.listVenuePapers("ICLR.cc/2026/Conference").map((row) => row.paper_id)).toEqual(
      before.map((row) => row.paper_id),
    );
  });
});
