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
});
