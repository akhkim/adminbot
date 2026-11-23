import type { NudgeItem } from "./paper-slots.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most things one paper may ask for in a single message; the rest wait for the next one. */
export const NUDGE_MAX_ITEMS_PER_PAPER = 3;
/** Most papers one message may cover. A person with six papers is not sent six paragraphs. */
export const NUDGE_MAX_PAPERS_PER_MESSAGE = 2;
/** The first two nudges use the base interval; later ones stretch unless a deadline is close. */
export const NUDGE_QUIET_AFTER_COUNT = 2;
export const NUDGE_QUIET_INTERVAL_MS = 14 * DAY_MS;
/** Inside this window a deadline-bearing item keeps the base cadence however often it was sent. */
export const NUDGE_URGENT_WINDOW_MS = 14 * DAY_MS;

/**
 * How long to leave an item alone after it was last nudged.
 *
 * Nothing changing is the common case, and the third identical reminder is the one people mute.
 * So after `NUDGE_QUIET_AFTER_COUNT` nudges the gap doubles -- except when the item carries a
 * deadline that is close, where staying quiet is the costlier mistake.
 */
export function nudgeIntervalMs(params: {
  baseMs: number;
  nudgeCount: number;
  deadlineBearing: boolean;
  paperDeadline?: string;
  now: Date;
}): number {
  if (params.nudgeCount < NUDGE_QUIET_AFTER_COUNT) {
    return params.baseMs;
  }
  const deadline = params.paperDeadline ? Date.parse(params.paperDeadline) : Number.NaN;
  const urgent =
    params.deadlineBearing &&
    Number.isFinite(deadline) &&
    deadline - params.now.getTime() <= NUDGE_URGENT_WINDOW_MS;
  return urgent ? params.baseMs : Math.max(params.baseMs, NUDGE_QUIET_INTERVAL_MS);
}

type TrimGroup = {
  items: NudgeItem[];
  deadline?: string;
  paperId?: string;
  heading?: string;
  moreItems?: number;
  morePapers?: number;
};

/**
 * Cuts one person's batch down to what is worth a single message.
 *
 * Papers are ranked by nearest deadline (no deadline last) and only the first few kept. Within a
 * paper, deadline-bearing items come first, then the branch order, and only the first few are
 * kept. A profile-style group (heading, no paper) is a single line and is kept.
 *
 * Returns what was dropped so the caller can leave those items unstamped: they were not said, so
 * the ledger must not claim they were.
 */
export function trimNudgeBatch<G extends TrimGroup>(
  groups: ReadonlyMap<string, G>,
  now: Date,
): { groups: Map<string, G>; omittedItems: NudgeItem[]; omittedPapers: number } {
  const entries = [...groups.entries()];
  const papers = entries.filter(([, group]) => !group.heading);
  const extras = entries.filter(([, group]) => group.heading);
  const rank = (group: G) => {
    const t = group.deadline ? Date.parse(group.deadline) : Number.NaN;
    return Number.isFinite(t) && t >= now.getTime() - 7 * DAY_MS ? t : Number.POSITIVE_INFINITY;
  };
  papers.sort(([, a], [, b]) => rank(a) - rank(b));

  const out = new Map<string, G>();
  const omittedItems: NudgeItem[] = [];
  papers.forEach(([title, group], index) => {
    if (index >= NUDGE_MAX_PAPERS_PER_MESSAGE) {
      omittedItems.push(...group.items);
      return;
    }
    const sorted = group.items.toSorted(
      (a, b) => Number(b.deadlineBearing) - Number(a.deadlineBearing) || a.priority - b.priority,
    );
    const kept = sorted.slice(0, NUDGE_MAX_ITEMS_PER_PAPER);
    omittedItems.push(...sorted.slice(NUDGE_MAX_ITEMS_PER_PAPER));
    out.set(title, {
      ...group,
      items: kept,
      ...(sorted.length > kept.length ? { moreItems: sorted.length - kept.length } : {}),
    });
  });
  for (const [title, group] of extras) {
    out.set(title, group);
  }
  const omittedPapers = Math.max(0, papers.length - NUDGE_MAX_PAPERS_PER_MESSAGE);
  const lastPaper = [...out.values()].filter((group) => !group.heading).at(-1);
  if (lastPaper && omittedPapers > 0) {
    lastPaper.morePapers = omittedPapers;
  }
  return {
    groups: out,
    omittedItems,
    omittedPapers,
  };
}
