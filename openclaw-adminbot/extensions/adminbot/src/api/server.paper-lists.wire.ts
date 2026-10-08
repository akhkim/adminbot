// What the lab-wide paper boards put on the wire.
//
// The service reads (listPaperSlotOverview, listConferenceRosters, collectPaperNudgeBatches, ...)
// keep their full shapes because the sweeps and their tests reason over them. These projections
// sit at the route instead and keep only what a list draws, since every one of these rows is
// repeated once per paper and the lab's paper count is what grows. Anything a row drops is either
// already on the paper record the page holds from GET /papers, or is read on GET /papers/:id.

import type { AdminBotPaperSlotOverviewRow, AdminBotServiceResponse } from "../kernel/service.js";
import type {
  ConferenceAttendancePaper,
  ConferenceAttendancePerson,
  ConferenceAttendanceView,
} from "../workflows/papers/conference-attendance.js";

/** Reshape a successful payload and pass a failure through untouched, status and all. */
export function mapPayload<T, U>(
  result: AdminBotServiceResponse<T>,
  project: (payload: T) => U,
): AdminBotServiceResponse<U> {
  return result.ok ? { ...result, payload: project(result.payload) } : result;
}

/** One paper's evidence count, as the My Projects cards and the admin next-steps list draw it. */
export type PaperSlotOverviewWireRow = Pick<
  AdminBotPaperSlotOverviewRow,
  | "paper_id"
  | "provided_count"
  | "required_count"
  | "dormant"
  | "closed"
  | "cycle_closed"
  | "missing_slots"
  | "escalating"
>;

/**
 * Title, venue, deadline and step repeat the paper record the page already has, and the
 * attendance tally, acceptance gaps, first author and last-nudged stamp are drawn by nothing that
 * reads this list (the conference roster and the paper's own card carry those). Dropping them
 * takes the row from about 450 to about 120 bytes.
 */
export function slotOverviewWireRow(row: AdminBotPaperSlotOverviewRow): PaperSlotOverviewWireRow {
  return {
    paper_id: row.paper_id,
    provided_count: row.provided_count,
    required_count: row.required_count,
    dormant: row.dormant,
    closed: row.closed,
    cycle_closed: row.cycle_closed,
    missing_slots: row.missing_slots,
    escalating: row.escalating,
  };
}

/** One person on a conference roster, with their papers named by id. */
export type ConferenceRosterWirePerson = Omit<ConferenceAttendancePerson, "papers"> & {
  papers: Array<Omit<ConferenceAttendancePaper, "title">>;
};

/**
 * One conference with each paper's title said once.
 *
 * The service names a paper's title under every author on it and again in `papers_awaiting`, so a
 * three-author paper spelled its title four times. `paper_titles` carries it once per conference
 * and the rows point at it by id; the client puts the titles back before anything renders.
 */
export type ConferenceRosterWire = Omit<ConferenceAttendanceView, "people" | "papers_awaiting"> & {
  paper_titles: Record<string, string>;
  people: ConferenceRosterWirePerson[];
  papers_awaiting: Array<{ paper_id: string; unanswered: number }>;
};

export function conferenceRosterWire(conference: ConferenceAttendanceView): ConferenceRosterWire {
  const paperTitles: Record<string, string> = {};
  for (const person of conference.people) {
    for (const paper of person.papers) {
      paperTitles[paper.paper_id] = paper.title;
    }
  }
  for (const paper of conference.papers_awaiting) {
    paperTitles[paper.paper_id] = paper.title;
  }
  return {
    key: conference.key,
    venue: conference.venue,
    year: conference.year,
    label: conference.label,
    paper_count: conference.paper_count,
    going_count: conference.going_count,
    unanswered_count: conference.unanswered_count,
    paper_titles: paperTitles,
    people: conference.people.map(({ papers, avatar_url, ...person }) => ({
      ...person,
      // Only the people going get a face on the deadlines page; the travel board lists names.
      ...(avatar_url && person.attending === "yes" ? { avatar_url } : {}),
      papers: papers.map(({ paper_id, attending }) => ({ paper_id, attending })),
    })),
    papers_awaiting: conference.papers_awaiting.map(({ paper_id, unanswered }) => ({
      paper_id,
      unanswered,
    })),
  };
}
