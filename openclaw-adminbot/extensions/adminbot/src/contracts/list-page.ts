// One page of an admin list, shared by the service and the Control UI.
//
// The lab's rule for long lists is "only recent matters": a screen opens on one short page and
// older rows arrive on demand. One constant so the Requests queue, the Lab Overview and whatever
// pages next agree on what "a page" is, and the service's ceiling is the same number the UI
// knows it may ask for.

/** What a page is when the caller does not say. */
export const ADMIN_LIST_PAGE_SIZE = 20;

/**
 * The most rows any one response carries.
 *
 * A ceiling rather than a suggestion: a caller that asks for more is refused rather than quietly
 * trimmed, so nobody reads a short page as the whole list. Internal callers that truly need every
 * row walk the cursor.
 */
export const ADMIN_LIST_PAGE_MAX = 50;

/**
 * Where a page starts and how long it is. `after` is the id of the last row the previous page
 * ended on, when its cursor named one (see pageOf).
 */
export type AdminListPageRequest = { limit: number; offset: number; after?: string };

/**
 * A page of an already-ordered list.
 *
 * `total` is the size of the whole filtered list, not of the page, so a heading can say "12 open"
 * while drawing 20 rows of a longer list. `next_cursor` is absent on the last page; it is an
 * opaque string to the client.
 *
 * The cursor is an offset, optionally anchored on the last row served ("20~logreq_7") when the
 * caller passes `idOf`. Offsets alone skip a row whenever one already shown leaves the list before
 * the next page is asked for -- an admin settling a request on page 1 of the open queue, then
 * pressing Load more. The anchor says where page 1 really ended, so the next page resumes after
 * it; it never resumes later than the offset would, so whatever else moved costs at most a row
 * served twice, which the client drops by id (load-more.ts `appendPage`).
 *
 * Why not a keyset cursor, as Meetings has: Meetings has one order, on (started_at, id), which
 * never change. These lists offer several orders over derived and mutable keys -- open-first
 * grouping, status rank, deadline, a locale name compare, profile progress that moves as members
 * fill in the very fields the page chases -- so a keyset cursor would have to carry the whole sort
 * tuple and still miss rows whose key changed. Both lists are sorted in memory, so there is no
 * query cost to save either.
 */
export type AdminListPage<T> = { rows: T[]; total: number; next_cursor?: string };

export function pageOf<T>(
  ordered: readonly T[],
  page: AdminListPageRequest,
  idOf?: (row: T) => string,
): AdminListPage<T> {
  const anchor =
    page.after !== undefined && idOf ? ordered.findIndex((row) => idOf(row) === page.after) : -1;
  const start = anchor < 0 ? page.offset : Math.min(anchor + 1, page.offset);
  const end = start + page.limit;
  const rows = ordered.slice(start, end);
  const last = rows.at(-1);
  return {
    rows,
    total: ordered.length,
    ...(end < ordered.length
      ? { next_cursor: idOf && last !== undefined ? `${end}~${idOf(last)}` : String(end) }
      : {}),
  };
}

/**
 * `?limit=` and `?cursor=` read off a query string.
 *
 * Absent means the first page of the default size. A limit past the ceiling, a non-numeric limit
 * or a cursor that is not an offset (with an optional `~id` anchor) is "invalid" -- the same 400
 * the Meetings page answers -- so a typo never turns into a silently different page.
 */
export function readAdminListPage(params: URLSearchParams): AdminListPageRequest | "invalid" {
  const rawLimit = params.get("limit");
  const rawCursor = params.get("cursor");
  if (rawLimit !== null && !/^[1-9]\d{0,3}$/u.test(rawLimit)) {
    return "invalid";
  }
  const cursor = rawCursor === null ? null : /^(\d{1,9})(?:~(.{1,200}))?$/su.exec(rawCursor);
  if (rawCursor !== null && !cursor) {
    return "invalid";
  }
  const limit = rawLimit === null ? ADMIN_LIST_PAGE_SIZE : Number(rawLimit);
  if (limit > ADMIN_LIST_PAGE_MAX) {
    return "invalid";
  }
  return {
    limit,
    offset: cursor ? Number(cursor[1]) : 0,
    ...(cursor?.[2] !== undefined ? { after: cursor[2] } : {}),
  };
}
