/**
 * The "outreach drafts are ready" note the admins get after an OpenReview sync records acceptances.
 *
 * The drafts themselves already exist the moment a paper is recorded as accepted: the Mailing List
 * tab composes them on demand from the stored papers. What was missing is somebody being told, so
 * an acceptance batch no longer waits for an admin to happen to open the tab. This module decides
 * what the note says; the service sends it (propose, policy, execute, audit) and the say-once
 * ledger keeps it to one note per venue.
 *
 * It points at the drafts and nothing else. No outlet is written to from here.
 */

import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import { normalizeVenue, venueGroupKey, venueGroupLabel } from "./venue-normalize.js";
import { acceptedVenueOf } from "./publication-list.js";

export type OutreachReadyVenue = {
  /** The venue group key (`emnlp 2026`): the ledger subject, so one note per venue. */
  key: string;
  /** How the Mailing List venue picker names it (`EMNLP 2026`). */
  label: string;
  /** Every paper on file accepted at this venue, not only this pass's, title order. */
  papers: Array<{ id: string; title: string }>;
  /** How many of them this pass newly recorded. */
  newly_accepted: number;
};

/**
 * The venues a sync's new acceptances fall under, each with every paper on file accepted there.
 *
 * The whole venue rather than only the new ones, because the outreach draft is per venue: a note
 * saying "1 paper accepted" when the draft it links to lists four would read as a mistake. Papers
 * whose acceptance names no venue are left out -- there is no draft to point at for them.
 */
export function outreachReadyVenues(
  papers: readonly AdminBotPaperRecord[],
  newlyAcceptedIds: ReadonlySet<string>,
): OutreachReadyVenue[] {
  const venueOf = (paper: AdminBotPaperRecord) => {
    const accepted = acceptedVenueOf(paper);
    return accepted ? normalizeVenue(accepted, paper.accepted_year) : undefined;
  };
  const wanted = new Map<string, string>();
  for (const paper of papers) {
    if (!newlyAcceptedIds.has(paper.id)) {
      continue;
    }
    const venue = venueOf(paper);
    const key = venueGroupKey(venue);
    if (venue && key && !wanted.has(key)) {
      wanted.set(key, venueGroupLabel(venue));
    }
  }
  const byKey = new Map<string, OutreachReadyVenue>();
  for (const paper of papers) {
    const key = venueGroupKey(venueOf(paper));
    const label = wanted.get(key);
    if (!label) {
      continue;
    }
    const entry = byKey.get(key) ?? { key, label, papers: [], newly_accepted: 0 };
    entry.papers.push({ id: paper.id, title: paper.title });
    if (newlyAcceptedIds.has(paper.id)) {
      entry.newly_accepted += 1;
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((entry) => ({
      ...entry,
      papers: entry.papers.toSorted((a, b) => a.title.localeCompare(b.title)),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

/**
 * The Slack text. Plain mrkdwn, one line per paper, the tab link last. It names the venue to pick
 * because the tab has no deep link to a venue: the picker is the first thing on it.
 */
export function buildOutreachReadyMessage(venue: OutreachReadyVenue, mailingListUrl: string): string {
  const count = venue.papers.length;
  return [
    `:tada: ${count} paper${count === 1 ? "" : "s"} accepted at *${venue.label}* -- the outreach drafts are ready.`,
    ...venue.papers.map((paper) => `• ${paper.title}`),
    "",
    `Pick *${venue.label}* on the Mailing List tab to review them: ${mailingListUrl}`,
    "Nothing has been sent; each draft goes out only when an admin sends it from the tab.",
  ].join("\n");
}
