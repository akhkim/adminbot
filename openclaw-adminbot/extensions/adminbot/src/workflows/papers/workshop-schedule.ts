// When the lab gets told about a conference's workshops, and the rule that it happens once.
//
// Workshop matching was manual: an administrator opened the tab, pressed Refresh, waited out a
// pass of tens of minutes, ticked recipients and pressed Send. Everything about that is a
// judgement except the timing, and the timing is the part a person is worst at -- the pass is
// worth running in the fortnight before a conference's workshops start closing, and nobody
// remembers to do it on the right week for every conference in the season.
//
// So the clock moves into the code and the judgement stays where it was. The schedule below
// answers one question: which conference is close enough to its first workshop deadline to be
// worth telling the lab about, and has that already happened. It makes no model calls and reads
// nothing but the generated deadline dataset, so it is cheap enough for a daily cron tick to ask.
//
// "Once per conference" is the whole design constraint, and it is why this is a ledger question
// rather than a schedule question. A cron job fires on a cadence; a window ("within two weeks")
// is true on every tick inside it, so a sweep that only checked the window would send the same
// recommendations every morning for a fortnight. What stops that is the record of having already
// done it, which is why `conferencesDueForWorkshopNudge` takes the set of conferences already
// passed and will not return one of them for any reason.

import type { DeadlineWorkshopRecord } from "./workshop-nudges.js";
import { workshopProfilesFromDeadlines } from "./workshop-nudges.js";

/**
 * How far ahead of a conference's first workshop deadline the lab hears about it.
 *
 * Two weeks. Long enough that somebody who wants to submit can still write the thing, short
 * enough that the recommendations are about work the paper is actually in a state to send. The
 * whole season's worth at once would be a list nobody acts on.
 */
export const WORKSHOP_NUDGE_LEAD_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One conference, and when its workshops start closing. */
export type WorkshopConferenceSchedule = {
  key: string;
  label: string;
  /** The earliest still-open workshop deadline under this conference, AoE as the dataset spells it. */
  first_deadline_aoe: string;
  /** Whole days from `now` to that deadline. Negative never occurs: past deadlines are dropped. */
  days_until: number;
  workshop_count: number;
};

/** AoE is noon-UTC-minus-twelve, the same reading `workshop-nudges.ts` uses. */
function aoeInstant(value: string): number {
  return Date.parse(value.replace(" ", "T") + "-12:00");
}

/**
 * Every conference with an open workshop call, and the deadline that comes first.
 *
 * Built from the same profiles the matcher works from, so the schedule can never name a
 * conference the pass would then find no workshops for. `workshopProfilesFromDeadlines` has
 * already dropped everything whose deadline has passed, which is what makes "first" mean the next
 * one rather than the earliest that ever existed -- a conference whose first two workshops have
 * closed is still worth telling people about for its third.
 */
export function workshopConferenceSchedules(
  records: readonly DeadlineWorkshopRecord[],
  now: Date,
): WorkshopConferenceSchedule[] {
  const byKey = new Map<string, WorkshopConferenceSchedule>();
  for (const profile of workshopProfilesFromDeadlines(records, now)) {
    const key = profile.parent_conference_key?.trim();
    if (!key) {
      continue;
    }
    // The earliest route on this workshop. `routes` is already sorted, but a workshop with no
    // route at all would be a dataset fault rather than a reason to throw.
    const earliest = profile.routes
      .map((route) => route.deadline_aoe)
      .filter((value) => Number.isFinite(aoeInstant(value)))
      .toSorted()[0];
    if (!earliest) {
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        label: profile.parent_conference?.trim() || key,
        first_deadline_aoe: earliest,
        days_until: Math.ceil((aoeInstant(earliest) - now.getTime()) / DAY_MS),
        workshop_count: 1,
      });
      continue;
    }
    existing.workshop_count += 1;
    if (aoeInstant(earliest) < aoeInstant(existing.first_deadline_aoe)) {
      existing.first_deadline_aoe = earliest;
      existing.days_until = Math.ceil((aoeInstant(earliest) - now.getTime()) / DAY_MS);
    }
  }
  // Soonest first, which is also the order the sweep wants: the conference closest to its first
  // deadline is the one to spend this tick's model time on.
  return [...byKey.values()].toSorted(
    (left, right) =>
      aoeInstant(left.first_deadline_aoe) - aoeInstant(right.first_deadline_aoe) ||
      left.label.localeCompare(right.label),
  );
}

/**
 * The conferences worth a pass right now: inside the lead window, and never done before.
 *
 * `alreadyNudged` is the only thing standing between this and a fortnight of daily repeats, so it
 * is checked before the window rather than after -- a conference the lab has been told about is
 * not a candidate whose timing then fails, it is not a candidate at all.
 *
 * A conference discovered late -- one whose first deadline is already four days out because the
 * dataset only just picked it up -- still qualifies. Late is worse than on time and much better
 * than never, and the alternative is silently skipping exactly the conferences whose calls
 * appeared at short notice.
 */
export function conferencesDueForWorkshopNudge(params: {
  records: readonly DeadlineWorkshopRecord[];
  now: Date;
  alreadyNudged: ReadonlySet<string>;
  leadDays?: number;
}): WorkshopConferenceSchedule[] {
  const lead = params.leadDays ?? WORKSHOP_NUDGE_LEAD_DAYS;
  return workshopConferenceSchedules(params.records, params.now).filter(
    (entry) => !params.alreadyNudged.has(entry.key) && entry.days_until <= lead,
  );
}
