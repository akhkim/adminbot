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

/** Where a page starts and how long it is. */
export type AdminListPageRequest = { limit: number; offset: number };

/**
 * A page of an already-ordered list.
 *
 * `total` is the size of the whole filtered list, not of the page, so a heading can say "12 open"
 * while drawing 20 rows of a longer list. `next_cursor` is absent on the last page; it is an
 * opaque string to the client, an offset here, which is what lets the same cursor serve any sort
 * order the list offers.
 */
export type AdminListPage<T> = { rows: T[]; total: number; next_cursor?: string };

export function pageOf<T>(ordered: readonly T[], page: AdminListPageRequest): AdminListPage<T> {
  const end = page.offset + page.limit;
  return {
    rows: ordered.slice(page.offset, end),
    total: ordered.length,
    ...(end < ordered.length ? { next_cursor: String(end) } : {}),
  };
}

/**
 * `?limit=` and `?cursor=` read off a query string.
 *
 * Absent means the first page of the default size. A limit past the ceiling, a non-numeric limit
 * or a cursor that is not an offset is "invalid" -- the same 400 the Meetings page answers -- so a
 * typo never turns into a silently different page.
 */
export function readAdminListPage(params: URLSearchParams): AdminListPageRequest | "invalid" {
  const rawLimit = params.get("limit");
  const rawCursor = params.get("cursor");
  if (rawLimit !== null && !/^[1-9]\d{0,3}$/u.test(rawLimit)) {
    return "invalid";
  }
  if (rawCursor !== null && !/^\d{1,9}$/u.test(rawCursor)) {
    return "invalid";
  }
  const limit = rawLimit === null ? ADMIN_LIST_PAGE_SIZE : Number(rawLimit);
  if (limit > ADMIN_LIST_PAGE_MAX) {
    return "invalid";
  }
  return { limit, offset: rawCursor === null ? 0 : Number(rawCursor) };
}
