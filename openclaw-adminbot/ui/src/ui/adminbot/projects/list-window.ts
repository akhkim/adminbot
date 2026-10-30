// One search box and one "show more" for every drawing of the viewer's papers -- cards, sheet and
// flat view alike -- so a member with five papers and one with fifteen hundred meet the same page.
//
// Drawing every paper at once is what froze the page for a large list: fifteen hundred sheet rows
// are tens of thousands of inputs, and the flat view is worse. The rows arrive already sorted with
// what needs the reader first, so the first window is the part worth drawing; the rest is a search
// or a press away. Only what is drawn is windowed -- counts, saves and sheet imports still see every
// paper, so nothing is lost or matched against a partial list.
import { html, nothing } from "lit";

/** Rows drawn before "Show more". Large enough that most members never see the button. */
export const LIST_WINDOW = 50;
/** Below this many papers a search box is clutter: the whole list fits on a screen or two. */
export const LIST_SEARCH_FROM = 10;

let query = "";
let limit = LIST_WINDOW;

// A paper record carries `id`, a project summary `paper_id`; either is searchable.
type Searchable = { id?: string; paper_id?: string; title: string; alias?: string; venue?: string };

/** Whether a paper matches the search: title, short name, venue or id, ignoring case. */
export function matchesListQuery(paper: Searchable, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return [paper.title, paper.alias, paper.venue, paper.id ?? paper.paper_id].some((value) =>
    (value ?? "").toLocaleLowerCase().includes(needle),
  );
}

/** The papers to draw, and how many matched before the window cut them. */
export function windowList<T extends Searchable>(papers: T[]): { shown: T[]; matched: number } {
  const matched = papers.filter((paper) => matchesListQuery(paper, query));
  return { shown: matched.slice(0, limit), matched: matched.length };
}

/**
 * Two lists drawn one after the other under one window -- the active cards, then the papers that
 * are not active -- so "Show more" means the same thing on the cards as in the sheet.
 */
export function windowLists<A extends Searchable, B extends Searchable>(
  first: A[],
  second: B[],
): { first: A[]; second: B[]; shown: number; matched: number } {
  const a = first.filter((paper) => matchesListQuery(paper, query));
  const b = second.filter((paper) => matchesListQuery(paper, query));
  const shownA = a.slice(0, limit);
  const shownB = b.slice(0, Math.max(0, limit - shownA.length));
  return {
    first: shownA,
    second: shownB,
    shown: shownA.length + shownB.length,
    matched: a.length + b.length,
  };
}

/** The search box, or nothing for a short list (but kept while a search is active). */
export function renderListSearch(total: number, rerender: () => void) {
  if (total <= LIST_SEARCH_FROM && !query) {
    return nothing;
  }
  return html`<label class="projects__search">
    <span class="sr-only">Search your papers</span>
    <input
      type="search"
      data-testid="my-work-search"
      placeholder=${`Search ${total.toLocaleString()} papers`}
      title="Matches title, short name, venue or id"
      .value=${query}
      @input=${(event: Event) => {
        query = (event.target as HTMLInputElement).value;
        limit = LIST_WINDOW;
        rerender();
      }}
    />
  </label>`;
}

/** "Show 50 more", or a line saying the search matched nothing. Nothing when all are drawn. */
export function renderListMore(shown: number, matched: number, rerender: () => void) {
  if (matched === 0 && query) {
    return html`<p class="projects__empty" data-testid="my-work-no-match">
      No papers match "${query}".
    </p>`;
  }
  if (shown >= matched) {
    return nothing;
  }
  const next = Math.min(LIST_WINDOW, matched - shown);
  return html`<p class="projects__more">
    <span>Showing ${shown} of ${matched}</span>
    <button
      type="button"
      class="btn btn--sm"
      data-testid="my-work-show-more"
      @click=${() => {
        limit += LIST_WINDOW;
        rerender();
      }}
    >
      Show ${next} more
    </button>
  </p>`;
}

/** Forgets the search and the window, before a different member uses this browser. */
export function resetListWindow(): void {
  query = "";
  limit = LIST_WINDOW;
}
