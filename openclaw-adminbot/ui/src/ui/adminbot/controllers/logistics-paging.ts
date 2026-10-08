// When the Requests list and My Desk's letters are read, and with what question.
//
// The service pages the list, so the question has to travel with the read: an admin's queue asks
// for its filter and sort, a member's own list asks for nothing and gets the most recent first.
// Cut out of app-render (which is at its file-size ratchet) and kept apart from logistics.ts,
// which owns the writes.
import {
  ADMIN_LIST_PAGE_MAX,
  logisticsQueueParams,
} from "../../../../../extensions/adminbot/logistics-api.js";
import { isLogisticsTab } from "../../navigation.ts";
import type { Tab } from "../../navigation.ts";
import { fetchLogisticsRequests, type LogisticsRequest } from "../api/logistics.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import { logisticsQueueQueryFor, type LogisticsQueueOptions } from "../data/logistics-queue.ts";
import type { LogisticsMode } from "../views/logistics.ts";
import { loadAdminBotLogisticsRequests, type AdminBotLogisticsHost } from "./logistics.ts";

export type LogisticsReadHost = AdminBotLogisticsHost & {
  tab: Tab;
  adminBotLogisticsMode: LogisticsMode;
  adminBotLogisticsQueueOptions: LogisticsQueueOptions;
  adminBotLogisticsShowSettled: boolean;
  adminBotLogisticsRequestsLoadedAt: number | null;
};

/** The question the list on screen asks: the queue's controls for an admin, the default otherwise. */
export function logisticsListQuery(host: LogisticsReadHost, isAdmin: boolean): URLSearchParams {
  return isAdmin
    ? logisticsQueueParams(
        logisticsQueueQueryFor(
          host.adminBotLogisticsQueueOptions,
          host.adminBotLogisticsShowSettled,
        ),
      )
    : new URLSearchParams();
}

/**
 * The render pass's read effects for both lists.
 *
 * The list is read when a Requests tab is opened in view mode -- including on a reload that lands
 * straight on it, which the mode-change handler alone would miss. `requests.length` is not the
 * sentinel: a lab with no requests would re-ask on every render. My Desk reads its own letters
 * rather than borrowing the queue's first page, whose counts would stop at twenty.
 */
export function readAdminBotLogisticsLists(
  host: LogisticsReadHost,
  params: { isAdmin: boolean; hasMemberSession: boolean },
  requestHostUpdate: (() => void) | undefined,
): void {
  if (!params.hasMemberSession) {
    return;
  }
  if (
    isLogisticsTab(host.tab) &&
    host.adminBotLogisticsMode === "view" &&
    !host.adminBotLogisticsRequestsLoading &&
    !host.adminBotLogisticsRequestsError &&
    host.adminBotLogisticsRequestsLoadedAt === null
  ) {
    host.adminBotLogisticsRequestsLoadedAt = Date.now();
    void loadAdminBotLogisticsRequests(host, logisticsListQuery(host, params.isAdmin)).finally(() =>
      requestHostUpdate?.(),
    );
  }
  if (
    host.tab === "adminbotProfessor" &&
    !host.adminBotDeskLetters.loading &&
    host.adminBotDeskLetters.loadedAt === null
  ) {
    void loadAdminBotDeskLetters(host).finally(() => requestHostUpdate?.());
  }
}

// Long enough that typing a name is one read rather than one per letter; short enough that the
// list has answered by the time the hands come off the keyboard.
const SEARCH_SETTLE_MS = 300;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Asks for page 1 again after the queue's controls change.
 *
 * A search waits for the typing to settle; a sort, filter or the finished-requests toggle asks at
 * once. Either way the read goes through the same sentinel the tab-open effect watches.
 */
export function rereadLogisticsQueue(
  host: LogisticsReadHost,
  requestHostUpdate: (() => void) | undefined,
  options: { debounce: boolean },
): void {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  const reread = () => {
    searchTimer = null;
    host.adminBotLogisticsRequestsLoadedAt = null;
    requestHostUpdate?.();
  };
  if (options.debounce) {
    searchTimer = setTimeout(reread, SEARCH_SETTLE_MS);
  } else {
    reread();
  }
}

// Fifty a page and at most twenty pages: a thousand open letters is past any lab this serves, and
// the cap keeps a service that kept handing back a cursor from holding the desk in a loop.
const DESK_LETTER_PAGES = 20;

/**
 * Every open recommendation-letter request, soonest deadline first, for My Desk.
 *
 * The desk does need all of them -- it counts them by how close each deadline is -- so it pages to
 * the end rather than taking the first twenty. Open letters only, which is a short list even in a
 * lab whose request history is long.
 */
export async function loadAdminBotDeskLetters(host: AdminBotLogisticsHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const token = stored.sessionToken;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  host.adminBotDeskLetters = { ...host.adminBotDeskLetters, loading: true, loadedAt: Date.now() };
  const letters: LogisticsRequest[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < DESK_LETTER_PAGES; page += 1) {
      const params = new URLSearchParams({
        status: "open",
        kind: "recommendation_letters",
        sort: "deadline",
        dir: "asc",
        limit: String(ADMIN_LIST_PAGE_MAX),
      });
      if (cursor) {
        params.set("cursor", cursor);
      }
      const result = await fetchLogisticsRequests(token, baseUrl, params);
      if (loadStoredMemberSession()?.sessionToken !== token || !result.ok) {
        break;
      }
      letters.push(...result.value.requests);
      cursor = result.value.nextCursor;
      if (!cursor) {
        break;
      }
    }
  } finally {
    if (loadStoredMemberSession()?.sessionToken === token) {
      host.adminBotDeskLetters = { ...host.adminBotDeskLetters, requests: letters, loading: false };
    }
  }
}
