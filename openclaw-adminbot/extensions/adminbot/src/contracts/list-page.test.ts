import { describe, expect, it } from "vitest";
import {
  ADMIN_LIST_PAGE_MAX,
  ADMIN_LIST_PAGE_SIZE,
  pageOf,
  readAdminListPage,
} from "./list-page.js";

const read = (query: string) => readAdminListPage(new URLSearchParams(query));

describe("admin list pages", () => {
  it("defaults to the first page of the shared size", () => {
    expect(read("")).toEqual({ limit: ADMIN_LIST_PAGE_SIZE, offset: 0 });
    expect(ADMIN_LIST_PAGE_SIZE).toBe(20);
  });

  it("refuses a limit past the ceiling rather than trimming it", () => {
    expect(read(`limit=${ADMIN_LIST_PAGE_MAX}`)).toEqual({ limit: 50, offset: 0 });
    expect(read(`limit=${ADMIN_LIST_PAGE_MAX + 1}`)).toBe("invalid");
    expect(read("limit=100000")).toBe("invalid");
  });

  it("refuses a limit or cursor that is not a plain number", () => {
    for (const query of ["limit=0", "limit=-1", "limit=1.5", "limit=", "cursor=x", "cursor=-2"]) {
      expect(read(query)).toBe("invalid");
    }
    expect(read("cursor=40&limit=20")).toEqual({ limit: 20, offset: 40 });
  });

  it("cuts a page and names the next one until the list runs out", () => {
    const rows = Array.from({ length: 45 }, (_, index) => index);
    const first = pageOf(rows, { limit: 20, offset: 0 });
    expect(first).toEqual({ rows: rows.slice(0, 20), total: 45, next_cursor: "20" });
    const last = pageOf(rows, { limit: 20, offset: 40 });
    expect(last).toEqual({ rows: [40, 41, 42, 43, 44], total: 45 });
    expect(pageOf(rows, { limit: 20, offset: 99 })).toEqual({ rows: [], total: 45 });
  });

  describe("a cursor anchored on the last row shown", () => {
    const idOf = (row: string) => row;
    const ids = (page: { rows: string[] }) => page.rows;

    it("names the last row it served, and reads it back", () => {
      const first = pageOf(["a", "b", "c"], { limit: 2, offset: 0 }, idOf);
      expect(first).toEqual({ rows: ["a", "b"], total: 3, next_cursor: "2~b" });
      expect(read("cursor=2~b&limit=2")).toEqual({ limit: 2, offset: 2, after: "b" });
      // An id may carry anything; only the offset in front has a shape.
      expect(read(`cursor=${encodeURIComponent("2~logreq_7~x")}`)).toMatchObject({
        offset: 2,
        after: "logreq_7~x",
      });
      for (const query of ["cursor=x~b", "cursor=~b", "cursor=2~"]) {
        expect(read(query)).toBe("invalid");
      }
    });

    it("does not skip a row when one already shown leaves the list", () => {
      // Page 1 showed a and b; then a was settled and dropped out of the open queue.
      const page = { limit: 2, offset: 2, after: "b" };
      expect(ids(pageOf(["b", "c", "d", "e"], page, idOf))).toEqual(["c", "d"]);
    });

    it("never starts later than the offset would", () => {
      // A row arrived above: b is served again, which a client appending by id drops, not skipped.
      const page = { limit: 2, offset: 2, after: "b" };
      expect(ids(pageOf(["x", "a", "b", "c", "d"], page, idOf))).toEqual(["b", "c"]);
      // The anchor moved down the list: start where the offset says, as before.
      expect(ids(pageOf(["a", "c", "d", "e", "b"], page, idOf))).toEqual(["d", "e"]);
      // The anchor is gone: the offset is all there is to go on.
      expect(ids(pageOf(["a", "c", "d"], page, idOf))).toEqual(["d"]);
    });

    it("keeps reading a plain offset cursor", () => {
      expect(ids(pageOf(["a", "b", "c", "d"], { limit: 2, offset: 2 }, idOf))).toEqual(["c", "d"]);
    });
  });
});
