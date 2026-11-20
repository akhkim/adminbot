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
import { defaultMailingListRange } from "../controllers/mailing-list.ts";
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
  // The first, unfiltered page, exactly as loadAdminBotMemberList builds its path.
  { tab: "adminbotMembers", path: () => "/lab/members/roster?limit=50&offset=0", asks: "visit" },
  // Requests to add somebody: drawn above the roster, read alongside it by loadAdminBotMemberRequests.
  { tab: "adminbotMembers", path: () => "/lab/members/requests", asks: "visit" },
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
  // My Desk: the desk read and its two queues, asked together by loadAdminBotProfileOverview.
  { tab: "adminbotProfessor", path: () => "/members/profile-overview?view=desk", asks: "visit" },
  { tab: "adminbotProfessor", path: () => "/nudges/escalated", asks: "visit" },
  { tab: "adminbotProfessor", path: () => "/papers/pi-review", asks: "visit" },
  // The default window, as app.ts starts adminBotTabUsageDays; read once per session.
  { tab: "adminbotTabUsage", path: () => "/ui/tab-visits?days=30", asks: "session" },
  // Served from the service's kept sheet view (api/sheet-page-reads.ts), so a head start costs
  // no extra Google read.
  { tab: "adminbotOnboarding", path: () => "/membership/sheet", asks: "session" },
  // The retired ARR path lands on Lab Members with a client-side filter, so a cold load there makes
  // the Members page's two reads (the filter is not in the query).
  {
    tab: "adminbotArrReviewers",
    path: () => "/lab/members/roster?limit=50&offset=0",
    asks: "visit",
  },
  { tab: "adminbotArrReviewers", path: () => "/lab/members/requests", asks: "visit" },
  // The whole paper list, read by loadAdminBotOverSession for every lab-scope page once per
  // session. ETagged, and otherwise sent only after /lab/members/self has come back.
  { tab: "adminbotPapers", path: () => "/papers", asks: "session" },
  { tab: "adminbotAnnouncements", path: () => "/papers", asks: "session" },
  { tab: "adminbotGrantReport", path: () => "/papers", asks: "session" },
  { tab: "adminbotCalendar", path: () => "/papers", asks: "session" },
  { tab: "adminbotProfessor", path: () => "/papers", asks: "session" },
  { tab: "adminbotMembers", path: () => "/papers", asks: "session" },
  { tab: "adminbotArrReviewers", path: () => "/papers", asks: "session" },
  { tab: "myWork", path: () => "/papers", asks: "session" },
  // Papers: the slot overview (app-render) and the three admin queues (admin-queues.ts QUEUE_PATHS),
  // each read once per session and computed in memory by the service.
  { tab: "adminbotPapers", path: () => "/papers/slot-overview", asks: "session" },
  {
    tab: "adminbotPapers",
    path: () => "/proposals/pending?view=summary&limit=25",
    asks: "session",
  },
  { tab: "adminbotPapers", path: () => "/papers/nudges?limit=25", asks: "session" },
  { tab: "adminbotPapers", path: () => "/papers/conference-rosters", asks: "session" },
  // Calendar: the drift flags beside the month. The month itself goes through the Google calendar
  // CLI on every read, so it is left to the page.
  { tab: "adminbotCalendar", path: () => "/lab/location-drifts", asks: "session" },
  // Lab Overview: the unfiltered first page (the default filter adds no parameters).
  { tab: "adminbotProfileOverview", path: () => "/members/profile-overview", asks: "session" },
  // Badges: the pending nomination queue, read once beside /badges.
  { tab: "adminbotBadges", path: () => "/badges/nominations?status=pending", asks: "session" },
  // Workshop nudges: the venue picker's options. The stored pass is a POST and is not prefetched.
  { tab: "adminbotWorkshopNudges", path: () => "/workshop-nudges/conferences", asks: "session" },
  // Opportunities: the element reads the board every time it is connected.
  { tab: "adminbotOpportunities", path: () => "/opportunities", asks: "visit" },
  // Mailing list: year to date with no venue, as app.ts starts the range, and the outreach drafts
  // for no venue. Both read once per session from the local store.
  {
    tab: "adminbotMailingList",
    path: () => `/papers/mailing-list?${new URLSearchParams(defaultMailingListRange()).toString()}`,
    asks: "session",
  },
  { tab: "adminbotMailingList", path: () => "/papers/outreach", asks: "session" },
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
  // One warmer per tab, starting all of that tab's reads: the prefetch registry keeps a single
  // warmer per tab, so registering each read on its own kept only the last one listed.
  const byTab = new Map<string, PageRead[]>();
  for (const read of ADMINBOT_PAGE_READS) {
    byTab.set(read.tab, [...(byTab.get(read.tab) ?? []), read]);
  }
  for (const [tab, reads] of byTab) {
    registerPageDataPrefetch([tab], () => {
      for (const read of reads) {
        warmPageRead(read);
      }
    });
  }
}

export function resetAdminBotPageReadsForTest(): void {
  registered = false;
}
