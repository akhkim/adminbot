import type {
  WorkshopProfile,
  WorkshopRecommendation,
} from "../workflows/papers/workshop-nudges.js";
import type { WorkshopNudgePreview, WorkshopNudgeRunView } from "./server.workshop-nudges.js";

/**
 * What the review page draws for one workshop.
 *
 * `topics`, `topic_evidence` and `parent_conference_key` fed the matcher and the scheduler; the
 * page never shows them. Route ids are the dataset's own keys, which the page does not link to.
 */
export type WorkshopWire = Omit<
  WorkshopProfile,
  "topics" | "topic_evidence" | "parent_conference_key" | "routes"
> & {
  routes: Array<Omit<WorkshopProfile["routes"][number], "deadline_id">>;
};

/**
 * One paper-to-workshop pair, naming its workshop by id.
 *
 * The same workshop profile -- call text evidence, routes, source links -- used to ride on every
 * pair that named it, then again inside the recipient's draft, so a season of a thousand papers
 * sent each profile hundreds of times. The page looks it up in `workshops` instead.
 */
export type WorkshopRecommendationWire = {
  workshop_id: string;
  final_rank?: number;
  topic_relevance: number;
  topic_evidence: string[];
  rank_explanation: string;
  paper: {
    paper_id: string;
    title: string;
    current_submission_state?: string;
    publication_sources: string[];
    recipient_display_name?: string;
  };
  attendance?: {
    attendance_likelihood?: number;
    source: string;
    last_confirmed_at: string;
  };
};

export type WorkshopNudgePreviewWire = Omit<
  WorkshopNudgePreview,
  "recipients" | "unresolved_recipients"
> & {
  workshops: Record<string, WorkshopWire>;
  recipients: Array<
    Omit<WorkshopNudgePreview["recipients"][number], "recommendations" | "draft"> & {
      recommendations: WorkshopRecommendationWire[];
      /** Only the text: the draft's own pair list repeated `recommendations` verbatim. */
      draft: { text: string } | null;
    }
  >;
  unresolved_recipients: Array<{
    paper: WorkshopRecommendationWire["paper"];
    recommendations: WorkshopRecommendationWire[];
  }>;
};

export type WorkshopNudgeRunWire = Omit<WorkshopNudgeRunView, "preview"> & {
  preview?: WorkshopNudgePreviewWire;
};

function workshopWire(workshop: WorkshopProfile): WorkshopWire {
  const {
    topics: _topics,
    topic_evidence: _evidence,
    parent_conference_key: _key,
    routes,
    ...rest
  } = workshop;
  return {
    ...rest,
    routes: routes.map(({ deadline_id: _id, ...route }) => route),
  };
}

function paperWire(paper: WorkshopRecommendation["paper"]): WorkshopRecommendationWire["paper"] {
  return {
    paper_id: paper.paper_id,
    title: paper.title,
    ...(paper.current_submission_state
      ? { current_submission_state: paper.current_submission_state }
      : {}),
    publication_sources: paper.publication_sources,
    ...(paper.recipient_display_name
      ? { recipient_display_name: paper.recipient_display_name }
      : {}),
  };
}

/**
 * The stored pass as the review page reads it.
 *
 * The stored row keeps the full shape -- send and the scheduled sweep recompute from it -- and only
 * the copy that leaves for the browser is folded. A row stored before this projection existed goes
 * through the same function, so nothing on disk is rewritten.
 */
export function workshopRunWire(view: WorkshopNudgeRunView): WorkshopNudgeRunWire {
  const { preview, ...rest } = view;
  if (!preview) {
    return rest;
  }
  const workshops: Record<string, WorkshopWire> = {};
  const recommendationWire = (entry: WorkshopRecommendation): WorkshopRecommendationWire => {
    const id = entry.workshop.workshop_id;
    workshops[id] ??= workshopWire(entry.workshop);
    return {
      workshop_id: id,
      ...(entry.final_rank === undefined ? {} : { final_rank: entry.final_rank }),
      topic_relevance: entry.topic_relevance,
      topic_evidence: entry.topic_evidence,
      rank_explanation: entry.rank_explanation,
      paper: paperWire(entry.paper),
      ...(entry.attendance
        ? {
            attendance: {
              ...(entry.attendance.attendance_likelihood === undefined
                ? {}
                : {
                    attendance_likelihood: entry.attendance.attendance_likelihood,
                  }),
              source: entry.attendance.source,
              last_confirmed_at: entry.attendance.last_confirmed_at,
            },
          }
        : {}),
    };
  };
  const { recipients, unresolved_recipients, ...summary } = preview;
  return {
    ...rest,
    preview: {
      ...summary,
      recipients: recipients.map(({ recommendations, draft, ...recipient }) => ({
        ...recipient,
        recommendations: recommendations.map(recommendationWire),
        draft: draft ? { text: draft.text } : null,
      })),
      unresolved_recipients: unresolved_recipients.map((entry) => ({
        paper: paperWire(entry.paper),
        recommendations: entry.recommendations.map(recommendationWire),
      })),
      workshops,
    },
  };
}
