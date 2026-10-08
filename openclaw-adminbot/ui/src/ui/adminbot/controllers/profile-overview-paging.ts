// When the Lab Overview and My Desk read the roster, and with what question.
//
// The service pages and filters the roster, so the question travels with the read: the Lab
// Overview asks for its filter, My Desk for its adoption columns' heads (`view=desk`). Cut out of
// app-render (which is at its file-size ratchet) and kept apart from profile-overview.ts, which
// owns the reads and writes themselves.
import { profileOverviewFilterParams } from "../../../../../extensions/adminbot/src/workflows/members/profile-overview-filter.js";
import type { Tab } from "../../navigation.ts";
import type { ProfileOverviewFilter } from "../views/profile-overview.ts";
import {
  loadAdminBotProfileOverview,
  type AdminBotProfileOverviewHost,
} from "./profile-overview.ts";

export type ProfileOverviewReadHost = AdminBotProfileOverviewHost & {
  tab: Tab;
  adminBotProfileOverviewFilter: ProfileOverviewFilter;
};

/** Which read the tab on screen needs, if it reads the roster at all. */
function wantedView(tab: Tab): "list" | "desk" | null {
  return tab === "adminbotProfessor" ? "desk" : tab === "adminbotProfileOverview" ? "list" : null;
}

/** The question the tab on screen asks. */
export function profileOverviewQuery(host: ProfileOverviewReadHost): URLSearchParams {
  return wantedView(host.tab) === "desk"
    ? new URLSearchParams({ view: "desk" })
    : profileOverviewFilterParams(host.adminBotProfileOverviewFilter);
}

/**
 * The render pass's read effect for both tabs.
 *
 * Same "never asked" sentinel as before: the roster is read when either tab is opened, and re-read
 * after a reminder run or a filter change clears the stamp. Opening the other tab asks again,
 * because the rows held answer the first tab's question, not its.
 */
export function readAdminBotProfileOverview(
  host: ProfileOverviewReadHost,
  hasMemberSession: boolean,
  requestHostUpdate: (() => void) | undefined,
): void {
  const view = wantedView(host.tab);
  if (
    view &&
    hasMemberSession &&
    !host.adminBotProfileOverviewLoading &&
    !host.adminBotProfileOverviewError &&
    (host.adminBotProfileOverviewLoadedAt === null ||
      host.adminBotProfileOverviewPage.view !== view)
  ) {
    host.adminBotProfileOverviewLoadedAt = Date.now();
    void loadAdminBotProfileOverview(host, profileOverviewQuery(host)).finally(() =>
      requestHostUpdate?.(),
    );
  }
}

// The same settle time the Requests queue's search uses: one read per name typed, not per letter.
const SEARCH_SETTLE_MS = 300;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Asks for page 1 again after the filter changes: at once for a select or a checkbox, once the
 * typing settles for the search box.
 */
export function rereadProfileOverview(
  host: ProfileOverviewReadHost,
  requestHostUpdate: (() => void) | undefined,
  options: { debounce: boolean },
): void {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  const reread = () => {
    searchTimer = null;
    host.adminBotProfileOverviewLoadedAt = null;
    requestHostUpdate?.();
  };
  if (options.debounce) {
    searchTimer = setTimeout(reread, SEARCH_SETTLE_MS);
  } else {
    reread();
  }
}
