// The one place the Control UI says "somebody opened this tab".
//
// Hung off the tab switch itself rather than off each view, for the reason every other choke point
// in this app exists: a per-view call is a call somebody forgets to add, and a usage log with three
// missing tabs is worse than none -- it reads as three tabs nobody wanted.
//
// What it deliberately does not do is wait, retry, or report. Navigation happens whether or not the
// log is written; see recordTabVisit in auth/session.ts.
import type { Tab } from "../../navigation.ts";
import type { UiSettings } from "../../storage.ts";
import {
  loadStoredMemberSession,
  recordTabVisit,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";

export type AdminBotTabVisitHost = {
  settings: UiSettings;
  /**
   * The tab the last visit was recorded for.
   *
   * On the host rather than in this module so two hosts in one page (tests, an embedded shell)
   * cannot swallow each other's first visit. Not reactive state: nothing renders it, and a render
   * per navigation for a counter nobody sees is a render for nothing.
   */
  adminBotLastVisitTab?: Tab;
};

/**
 * Record that this tab is now open, unless it already was.
 *
 * The guard is what makes this callable from anywhere: the landing tab is recorded on first paint
 * and the router re-asserts the same tab on a hash change, on a "view as" switch and on the
 * head-professor landing, and none of those is a second visit.
 *
 * A visitor with no member session is skipped entirely. Their browsing is real, but it is not the
 * lab's data and there is nobody to attribute it to -- the service would refuse the row anyway.
 */
export function recordAdminBotTabVisit(host: AdminBotTabVisitHost, tab: Tab): void {
  if (host.adminBotLastVisitTab === tab) {
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  host.adminBotLastVisitTab = tab;
  void recordTabVisit(stored.sessionToken, resolveAdminBotBaseUrl(host.settings), tab);
}
