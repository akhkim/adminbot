// What the lab-wide paper boards put on the wire.
//
// The service reads (listPaperSlotOverview, listConferenceRosters, collectPaperNudgeBatches, ...)
// keep their full shapes because the sweeps and their tests reason over them. These projections
// sit at the route instead and keep only what a list draws, since every one of these rows is
// repeated once per paper and the lab's paper count is what grows. Anything a row drops is either
// already on the paper record the page holds from GET /papers, or is read on GET /papers/:id.

import type {
  AdminBotNudgeBatch,
  AdminBotPaperSlotOverviewRow,
  AdminBotServiceResponse,
} from "../kernel/service.js";
import type {
  ConferenceAttendancePaper,
  ConferenceAttendancePerson,
  ConferenceAttendanceView,
} from "../workflows/papers/conference-attendance.js";
import type {
  LabPaperRelevance,
  LabRelevanceReport,
  LabSegmentScore,
} from "../workflows/papers/lab-relevance.js";
import type { PublicationExclusion } from "../workflows/papers/publication-list.js";

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

/** One person's nudge preview, with a count where the title list was. */
export type NudgeBatchWire = Omit<AdminBotNudgeBatch, "paper_titles"> & { paper_count: number };

/**
 * The preview draws "N items across M papers" from the title list and nothing else; the titles
 * themselves are already spelled out in `message`, which is what the preview shows in full.
 */
export function nudgeBatchWire({ paper_titles, ...batch }: AdminBotNudgeBatch): NudgeBatchWire {
  return { ...batch, paper_count: paper_titles.length };
}

/**
 * The mailing-list preview's exclusions, cut to the ones it lists.
 *
 * The preview names the papers nothing can date and, in venue mode, the papers with no decision
 * yet; the rest of the lab's papers are excluded only for falling outside the range, which the tab
 * never lists and which grows with every paper the lab has ever written. They go out as a count.
 */
export function mailingExclusionsWire(excluded: readonly PublicationExclusion[]): {
  excluded: Array<Pick<PublicationExclusion, "id" | "title" | "reason">>;
  out_of_range_count: number;
} {
  const listed = excluded.filter((entry) => entry.reason !== "out_of_range");
  return {
    excluded: listed.map(({ id, title, reason }) => ({ id, title, reason })),
    out_of_range_count: excluded.length - listed.length,
  };
}

type LabSegmentWire = Pick<LabSegmentScore, "segment_id" | "label" | "band">;

/** One placed paper, as the Lab Papers list draws it. */
export type LabPaperHitWire = Pick<
  LabPaperRelevance,
  "paper_id" | "title" | "margin" | "band" | "matched_terms" | "evidence"
> & { segments: LabSegmentWire[]; best_segment?: LabSegmentWire };

export type LabRelevanceReportWire = Pick<
  LabRelevanceReport,
  "query_kind" | "segment_count" | "scored" | "nothing_relevant"
> & {
  matches: LabPaperHitWire[];
  off_topic_count: number;
  uncovered_segments: Array<{ id: string; label: string }>;
};

function labSegmentWire({ segment_id, label, band }: LabSegmentScore): LabSegmentWire {
  return { segment_id, label, band };
}

/**
 * The relevance report without what the page never draws.
 *
 * `off_topic` is every paper that missed, which at a lab's full history is most of them, and the
 * page shows only how many matched out of how many were scored. The raw and centered scores are
 * diagnostics (the bar is drawn from `margin`), and an uncovered section is listed by its label,
 * not by the text pasted under it, which the caller already has.
 */
export function labRelevanceWire(report: LabRelevanceReport): LabRelevanceReportWire {
  return {
    query_kind: report.query_kind,
    segment_count: report.segment_count,
    scored: report.scored,
    nothing_relevant: report.nothing_relevant,
    matches: report.matches.map((hit) => ({
      paper_id: hit.paper_id,
      title: hit.title,
      margin: hit.margin,
      band: hit.band,
      segments: hit.segments.map(labSegmentWire),
      ...(hit.best_segment ? { best_segment: labSegmentWire(hit.best_segment) } : {}),
      matched_terms: hit.matched_terms,
      evidence: hit.evidence,
    })),
    off_topic_count: report.off_topic.length,
    uncovered_segments: report.uncovered_segments.map(({ id, label }) => ({ id, label })),
  };
}
