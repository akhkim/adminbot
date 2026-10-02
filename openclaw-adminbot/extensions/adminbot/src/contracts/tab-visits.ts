/**
 * Which parts of the Control UI people actually open.
 *
 * The lab has counts of what members *produce* -- filled fields, timeline entries, papers carrying
 * their own update -- and none of what they *look at*. Those answer different questions. A tab
 * nobody opens is not the same as a tab nobody needed: it may be unreachable, misnamed, or three
 * clicks from where the work starts, and none of that shows up in a completeness percentage. This
 * log is the missing half, and it is the half an HCI write-up is about.
 *
 * Append-only, for the reason the login log gives: a "last opened" field on a tab would be
 * destroyed by the next visit, and every question worth asking here -- how often, by how many, in
 * what order -- is a question about a distribution, not about a latest value.
 */

/**
 * One tab opening.
 *
 * `member_id` is who was at the keyboard, which on a "view as" session is the admin and never the
 * member being viewed. That follows `principalActor`'s split, and here it is not a nicety: an
 * admin's tour of somebody's account would otherwise land in that member's row and read, later, as
 * the member using a tab they never opened. `impersonated` marks those rows so an analysis can drop
 * them, rather than the log dropping them silently and leaving a gap nobody can see.
 *
 * `tab` is the Control UI's own tab id (`navigation.ts`), stored as the string the UI sent. The
 * service does not check it against a list: the list lives in the UI, a build can add to it, and a
 * visit to a tab this build has never heard of is data, not an error. Readers group by the raw id.
 */
export type AdminBotTabVisit = {
  id: string;
  member_id: string;
  tab: string;
  /** ISO-8601. When the tab was opened. */
  at: string;
  impersonated?: boolean;
};

/**
 * One tab's share of a period.
 *
 * `visits` counts openings and `members` counts distinct people, because they answer different
 * questions and their ratio is the interesting one: 200 visits from 2 members is a tab that two
 * people live in, 200 from 40 is a tab the lab passes through.
 */
export type AdminBotTabVisitRate = {
  tab: string;
  visits: number;
  /** Distinct members who opened it. */
  members: number;
  /** Openings per day across the window, so windows of different lengths compare. */
  visits_per_day: number;
  /**
   * How long the tab stayed open, in seconds, over the visits we can time.
   *
   * Derived from the gap to that member's next visit rather than stored: a dwell column would need
   * the browser to report a departure, which a closed laptop never does. The median is reported
   * next to the total because a handful of tabs left open over lunch otherwise reads as engagement.
   */
  dwell_seconds_median: number;
  dwell_seconds_total: number;
  /** Visits that could be timed. Lower than `visits`, and by how much is worth knowing. */
  dwell_samples: number;
  first_at: string;
  last_at: string;
};

/**
 * The whole window, tabs busiest first.
 *
 * `impersonated_visits` is reported rather than filtered so the number is visible: a report that
 * quietly excluded them would be the more honest-looking of two wrong answers.
 */
export type AdminBotTabVisitReport = {
  /** ISO-8601 bounds of the window actually counted. */
  from: string;
  to: string;
  days: number;
  visits: number;
  /** Distinct members across every tab, which is not the sum of the per-tab counts. */
  members: number;
  impersonated_visits: number;
  tabs: AdminBotTabVisitRate[];
};

/**
 * The gap after which a visit is treated as the end of a sitting rather than as dwell.
 *
 * Somebody who opens Deadlines, leaves for the afternoon and comes back to Papers did not spend
 * four hours reading Deadlines. Thirty minutes is the usual analytics cut and the exact value
 * matters less than that there is one and it is stated: without it a single overnight gap
 * outweighs every real reading session in the mean.
 */
export const ADMINBOT_TAB_DWELL_CAP_SECONDS = 30 * 60;

/** Longest tab id stored. Long enough for every real one; short enough not to be a payload. */
export const ADMINBOT_TAB_ID_MAX_LENGTH = 64;

/**
 * Tab visits grouped into one report.
 *
 * Exported as a function over plain rows rather than a method on the store so both stores share it
 * and a test can hand it a fixture: the arithmetic is the part worth pinning down, and it should
 * not need a database to assert.
 *
 * Rows may arrive in any order. Dwell is computed per member over that member's own sequence, so
 * two people reading at once never borrow each other's gaps.
 */
export function summarizeTabVisits(
  visits: readonly AdminBotTabVisit[],
  window: { from: string; to: string; days: number },
): AdminBotTabVisitReport {
  const byTab = new Map<
    string,
    { visits: number; members: Set<string>; dwell: number[]; first: string; last: string }
  >();
  const byMember = new Map<string, AdminBotTabVisit[]>();
  let impersonated = 0;

  for (const visit of visits) {
    if (visit.impersonated) {
      impersonated += 1;
    }
    const tab = byTab.get(visit.tab) ?? {
      visits: 0,
      members: new Set<string>(),
      dwell: [],
      first: visit.at,
      last: visit.at,
    };
    tab.visits += 1;
    tab.members.add(visit.member_id);
    if (visit.at < tab.first) {
      tab.first = visit.at;
    }
    if (visit.at > tab.last) {
      tab.last = visit.at;
    }
    byTab.set(visit.tab, tab);

    const own = byMember.get(visit.member_id) ?? [];
    own.push(visit);
    byMember.set(visit.member_id, own);
  }

  for (const own of byMember.values()) {
    const ordered = own.toSorted((left, right) => left.at.localeCompare(right.at));
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const current = ordered[index];
      const next = ordered[index + 1];
      if (!current || !next) {
        continue;
      }
      const seconds = (Date.parse(next.at) - Date.parse(current.at)) / 1000;
      // A gap longer than the cap is a sitting that ended, not a tab read for hours; a negative one
      // is clock skew between two devices and is no more timeable than a missing row.
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > ADMINBOT_TAB_DWELL_CAP_SECONDS) {
        continue;
      }
      byTab.get(current.tab)?.dwell.push(seconds);
    }
  }

  const tabs: AdminBotTabVisitRate[] = [...byTab.entries()]
    .map(([tab, counts]) => ({
      tab,
      visits: counts.visits,
      members: counts.members.size,
      visits_per_day: window.days > 0 ? round2(counts.visits / window.days) : counts.visits,
      dwell_seconds_median: Math.round(median(counts.dwell)),
      dwell_seconds_total: Math.round(counts.dwell.reduce((sum, value) => sum + value, 0)),
      dwell_samples: counts.dwell.length,
      first_at: counts.first,
      last_at: counts.last,
    }))
    // Busiest first, then alphabetical so a tie is stable rather than insertion-ordered.
    .toSorted((left, right) => right.visits - left.visits || left.tab.localeCompare(right.tab));

  return {
    from: window.from,
    to: window.to,
    days: window.days,
    visits: visits.length,
    members: byMember.size,
    impersonated_visits: impersonated,
    tabs,
  };
}

function median(values: readonly number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
