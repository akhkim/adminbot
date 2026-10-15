/**
 * One page of a list route: `?limit=` and `?offset=` in, `total` and `next_offset` out.
 *
 * Every list a page draws used to arrive whole, so a queue a thousand rows deep cost the same to
 * open as one with three. Each route now names how many rows its view shows before anyone asks for
 * more (`defaultLimit`) and a ceiling no caller can raise (`maxLimit`), so nobody -- the console,
 * the gateway tool, a script -- is sent the entire queue in one response. `total` keeps a badge or
 * a "N waiting" count honest while only a page is loaded.
 *
 * A malformed or out-of-range value is clamped rather than refused: older consoles sent
 * `?limit=50` to routes that ignored it, and a list that answers with a sensible page is the
 * friendlier failure than a 400 on a page that used to load.
 */
export type PageQuery = { limit: number; offset: number };

export type Page<T> = { items: T[]; total: number; next_offset?: number };

export function readPageQuery(
  url: URL,
  bounds: { defaultLimit: number; maxLimit: number },
): PageQuery {
  const limit = wholeNumber(url.searchParams.get("limit"));
  const offset = wholeNumber(url.searchParams.get("offset"));
  return {
    limit: Math.min(bounds.maxLimit, limit && limit > 0 ? limit : bounds.defaultLimit),
    offset: offset ?? 0,
  };
}

/** Slices an already-ordered list. `next_offset` is present only while rows remain. */
export function pageOf<T>(items: readonly T[], query: PageQuery): Page<T> {
  return pageFrom(items.slice(query.offset, query.offset + query.limit), items.length, query);
}

/** Wraps a page the store already cut, given the size of the whole list. */
export function pageFrom<T>(items: T[], total: number, query: PageQuery): Page<T> {
  const end = query.offset + items.length;
  return { items, total, ...(end < total ? { next_offset: end } : {}) };
}

function wholeNumber(text: string | null): number | undefined {
  return text !== null && /^\d{1,9}$/u.test(text) ? Number(text) : undefined;
}
