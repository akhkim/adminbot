// The read each AdminBot page is certain to make when it opens, by tab.
//
// loading/page-data-prefetch.ts starts these on the way to a page -- a sidebar link pointed at, or
// a tab just chosen -- so the page's own loader joins a request already in flight instead of
// starting one after its code has arrived. Only a page's single obvious first read is listed, and
// only where that read is light for the service: the audit log, OpenReview, the venue pickers and
// the Slack channel list are left to the page itself (and refused by isPrefetchableReadPath).
import {
  isPrefetchableReadPath,
  registerPageDataPrefetch,
} from "../../loading/page-data-prefetch.ts";
import { loadSettings } from "../../storage.ts";
import {
  hasAuthedRead,
  loadStoredMemberSession,
  prefetchAuthedRead,
  resolveAdminBotBaseUrl,
} from "./session.ts";

type PageRead = {
  tab: string;
  path: () => string;
  /**
   * `visit`: the page asks again every time it opens, so every approach is worth a head start.
   * `session`: the page keeps what it loaded for the whole session, so only the first approach is.
   */
  asks: "visit" | "session";
};

export const ADMINBOT_PAGE_READS: readonly PageRead[] = [
  { tab: "adminbotLabProjects", path: () => "/lab/projects", asks: "visit" },
  {
    tab: "adminbotTalkLeaderboard",
    path: () => `/cv/talk-leaderboard?year=${new Date().getFullYear()}`,
    asks: "visit",
  },
  { tab: "adminbotErrorLog", path: () => "/ops/errors", asks: "visit" },
  {
    tab: "adminbotRegistrations",
    path: () => "/auth/registrations?status=pending",
    asks: "session",
  },
  { tab: "adminbotBadges", path: () => "/badges", asks: "session" },
  { tab: "adminbotMeetings", path: () => "/meetings/series", asks: "session" },
];

function warmPageRead(read: PageRead): void {
  const token = loadStoredMemberSession()?.sessionToken;
  if (!token) {
    return;
  }
  const path = read.path();
  if (!isPrefetchableReadPath(path)) {
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(loadSettings());
  // Already read in this session by a page that keeps its data: nothing is waiting for an answer.
  if (read.asks === "session" && hasAuthedRead(baseUrl, path, token)) {
    return;
  }
  prefetchAuthedRead(baseUrl, path, token);
}

let registered = false;

/** Registers every page read above. Called once when the app starts. */
export function registerAdminBotPageReads(): void {
  if (registered) {
    return;
  }
  registered = true;
  for (const read of ADMINBOT_PAGE_READS) {
    registerPageDataPrefetch([read.tab], () => warmPageRead(read));
  }
}

export function resetAdminBotPageReadsForTest(): void {
  registered = false;
}
