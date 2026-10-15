// The one control a paged admin list adds: Meeting Recordings' "Show N more" button.
//
// Pages are cut on the service, so the button asks for the next one rather than revealing rows the
// tab already holds. It names how many the next page will bring, not how many are left in all --
// "Show 20 more" is a promise the click keeps; "Show 980 more" is not.
import { html, nothing } from "lit";
import { ADMIN_LIST_PAGE_SIZE } from "../../../../extensions/adminbot/logistics-api.js";
import { t } from "../../i18n/index.ts";

/**
 * Where a paged list stands: what the service said the whole filtered list holds, where the next
 * page starts, and the query the loaded pages answered -- the next page must ask the same question,
 * or its offset counts into a different list.
 */
export type PagedListState = {
  total: number;
  nextCursor: string | null;
  loadingMore: boolean;
  query: string;
};

export const EMPTY_PAGED_LIST: PagedListState = {
  total: 0,
  nextCursor: null,
  loadingMore: false,
  query: "",
};

// Which read of each list is the current one. A fresh page 1 (a new search, sort or filter) makes
// every read still in flight stale, so a slow answer to an old question cannot land on top of the
// new one -- or be appended to it as if it were its next page.
const versions = new WeakMap<object, Map<string, number>>();

export function nextListVersion(host: object, list: string): number {
  const held = versions.get(host) ?? new Map<string, number>();
  versions.set(host, held);
  const version = (held.get(list) ?? 0) + 1;
  held.set(list, version);
  return version;
}

export function isCurrentListVersion(host: object, list: string, version: number): boolean {
  return (versions.get(host)?.get(list) ?? 0) === version;
}

export function currentListVersion(host: object, list: string): number {
  return versions.get(host)?.get(list) ?? 0;
}

/** Appends a page, dropping any row already held: an offset shifts when a row changes filter. */
export function appendPage<T extends { id: string }>(held: readonly T[], page: readonly T[]): T[] {
  const ids = new Set(held.map((row) => row.id));
  return [...held, ...page.filter((row) => !ids.has(row.id))];
}

export type LoadMoreProps = {
  /** Rows the service still holds past the ones loaded. Zero, or no cursor, hides the button. */
  remaining: number;
  loading: boolean;
  onLoadMore: () => void;
};

/** What a paged list's state says is left, for a list that may have grown or shrunk in place. */
export function remainingRows(total: number, loaded: number, nextCursor: string | null): number {
  return nextCursor ? Math.max(total - loaded, 1) : 0;
}

export function renderLoadMore(props: LoadMoreProps | null | undefined, testId: string) {
  if (!props || props.remaining <= 0) {
    return nothing;
  }
  return html`
    <button
      class="btn meetings__more"
      type="button"
      data-testid=${testId}
      ?disabled=${props.loading}
      aria-busy=${props.loading ? "true" : "false"}
      @click=${props.onLoadMore}
    >
      ${props.loading
        ? t("common.loading")
        : t("professor.showMore", {
            count: String(Math.min(ADMIN_LIST_PAGE_SIZE, props.remaining)),
          })}
    </button>
  `;
}
