// One PaperMentor review, as the lab records it: that it happened, and what shape it was.
//
// PaperMentor is the multi-agent reviewer built into the lab's own Overleaf, and every paper is
// reviewed by it before submission. What it produces lives where the author works -- inline
// comment threads in the project -- and AdminBot deliberately does not hold a copy: the comments
// are unpublished paper content, the thing privacy routing exists to keep on the machine that
// produced it. What AdminBot keeps is the countable part, which is all chasing ever needs. "Nine
// comments, two of them critical, on the 12th" is enough to ask whether the fixes are merged; the
// comments themselves are enough to rewrite the paper, and belong to its authors.
//
// So `summarizePaperMentorReview` is the boundary, and it is written as an allow-list rather than
// a redaction: it copies the handful of fields it knows and cannot carry text it was never taught
// to read. A field the fork adds later arrives here as nothing at all, which is the failure this
// should have.
//
// The shape it reads is the fork's own `review_comments.json`, written per project under
// `/var/lib/overleaf/ai-tutor-cache/<projectId>/` at the end of a run:
//
//   { projectId, model, reviewedAt, classification: { paperType, paperTypeSummary },
//     commentsByDoc: { "<path>": [ ...comments ] },
//     summary: { total, byCategory: {...}, bySeverity: {...} },
//     failedAgents: [ { id, name, reason } ], roleModelPapers?: [ "<name>" ] }

/** What the reviewers label a comment. The fork's own three, in the order they matter. */
export const adminBotPaperMentorSeverities = ["critical", "warning", "suggestion"] as const;

export type AdminBotPaperMentorSeverity = (typeof adminBotPaperMentorSeverities)[number];

/** One document's share of a review. The path, which is a file name, and how many landed in it. */
export type AdminBotPaperMentorDocument = {
  path: string;
  comments: number;
};

/**
 * A review, summarized. The counting half of `review_comments.json` and nothing else.
 */
export type AdminBotPaperMentorRunInput = {
  project_id: string;
  /** RFC3339, the fork's own `reviewedAt` -- when the review ran, not when we heard about it. */
  reviewed_at: string;
  model?: string;
  paper_type?: string;
  comments_total: number;
  /** Keyed by severity, then by the reviewers' own categories. Counts only. */
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
  by_document: AdminBotPaperMentorDocument[];
  /** Agent names that failed or skipped, so a thin review is visible as a thin review. */
  failed_agents: string[];
};

export type AdminBotPaperMentorRun = AdminBotPaperMentorRunInput & {
  /** `<project id>:<reviewed_at>`. The run's own identity, so re-reading the cache writes nothing. */
  id: string;
  paper_id: string;
  /** When AdminBot heard about it, which is not when it happened. */
  ingested_at: string;
};

/** Caps, so a malformed or hostile file cannot become a large row. */
const MAX_KEY_LENGTH = 64;
const MAX_BUCKETS = 40;
const MAX_DOCUMENTS = 40;
const MAX_PATH_LENGTH = 200;
const MAX_FAILED_AGENTS = 20;

/**
 * The run's identity, from the two things that make it one run.
 *
 * The cache file is overwritten by the next review of the same project, so the collector re-reads
 * the same review every time it runs until a new one replaces it. Keying on when the review
 * happened is what turns that into one row rather than one row per pass.
 */
export function adminBotPaperMentorRunId(projectId: string, reviewedAt: string): string {
  return `${projectId}:${reviewedAt}`;
}

/**
 * Read a PaperMentor review down to its counts, or nothing when it is not one.
 *
 * Pure and total: any input at all is either a summary or `undefined`. The collector runs this on
 * the Overleaf host and sends the result, so this function is also the promise that no comment
 * text leaves that machine -- which is why it never touches `commentsByDoc`'s values beyond their
 * length, and why every string it does copy is trimmed and capped.
 */
export function summarizePaperMentorReview(
  value: unknown,
): AdminBotPaperMentorRunInput | undefined {
  const review = asRecord(value);
  if (!review) {
    return undefined;
  }
  const projectId = asString(review.projectId, MAX_KEY_LENGTH);
  const reviewedAt = asString(review.reviewedAt, 40);
  if (!projectId || !reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) {
    return undefined;
  }
  const summary = asRecord(review.summary) ?? {};
  const bySeverity = countMap(summary.bySeverity);
  const byCategory = countMap(summary.byCategory);
  const byDocument = documentCounts(review.commentsByDoc);
  // The fork's own total wins whenever it has one -- including zero, which is a real answer and
  // not a missing one: a review that found nothing must not be recorded as however many comments
  // some other field happens to mention. The two fallbacks are for a file written by an older
  // version that had no `summary.total`.
  const total =
    asCount(summary.total) ??
    (byDocument.length
      ? byDocument.reduce((sum, entry) => sum + entry.comments, 0)
      : sumCounts(bySeverity));
  const classification = asRecord(review.classification) ?? {};
  const paperType = asString(classification.paperType, MAX_KEY_LENGTH);
  const model = asString(review.model, MAX_KEY_LENGTH);
  return {
    project_id: projectId,
    reviewed_at: new Date(reviewedAt).toISOString(),
    ...(model ? { model } : {}),
    ...(paperType ? { paper_type: paperType } : {}),
    comments_total: total,
    by_severity: bySeverity,
    by_category: byCategory,
    by_document: byDocument,
    failed_agents: failedAgentNames(review.failedAgents),
  };
}

/**
 * The same summary arriving over the wire rather than off a disk.
 *
 * The collector runs `summarizePaperMentorReview` on the Overleaf host and posts what it returns,
 * so this is that shape again -- and it is re-read here rather than trusted, through the same
 * helpers and the same caps. The service is on the other side of a network boundary from the
 * script, and "the collector already checked" is not a property the service can verify.
 */
export function parsePaperMentorRunInput(value: unknown): AdminBotPaperMentorRunInput | undefined {
  const body = asRecord(value);
  if (!body) {
    return undefined;
  }
  const projectId = asString(body.project_id, MAX_KEY_LENGTH);
  const reviewedAt = asString(body.reviewed_at, 40);
  if (!projectId || !reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) {
    return undefined;
  }
  const byDocument = Array.isArray(body.by_document)
    ? body.by_document
        .flatMap((entry) => {
          const document = asRecord(entry);
          const path = document ? asString(document.path, MAX_PATH_LENGTH) : undefined;
          const comments = document ? asCount(document.comments) : undefined;
          return path && comments !== undefined ? [{ path, comments }] : [];
        })
        .slice(0, MAX_DOCUMENTS)
    : [];
  const model = asString(body.model, MAX_KEY_LENGTH);
  const paperType = asString(body.paper_type, MAX_KEY_LENGTH);
  return {
    project_id: projectId,
    reviewed_at: new Date(reviewedAt).toISOString(),
    ...(model ? { model } : {}),
    ...(paperType ? { paper_type: paperType } : {}),
    comments_total: asCount(body.comments_total) ?? 0,
    by_severity: countMap(body.by_severity),
    by_category: countMap(body.by_category),
    by_document: byDocument,
    failed_agents: Array.isArray(body.failed_agents)
      ? body.failed_agents
          .flatMap((entry) => {
            const name = asString(entry, MAX_KEY_LENGTH);
            return name ? [name] : [];
          })
          .slice(0, MAX_FAILED_AGENTS)
      : [],
  };
}

/** Whether a stored run says the reviewers found something somebody still has to answer. */
export function adminBotPaperMentorOpenSeverity(
  run: Pick<AdminBotPaperMentorRun, "by_severity">,
): number {
  return (run.by_severity.critical ?? 0) + (run.by_severity.warning ?? 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().slice(0, max);
  return trimmed || undefined;
}

/** A count, or nothing. Negative, fractional and absurd values are not counts. */
function asCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

/** `{ critical: 2, warning: 7 }`, with keys the reviewers chose and values we trust as numbers only. */
function countMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const [rawKey, rawCount] of Object.entries(record).slice(0, MAX_BUCKETS)) {
    const key = asString(rawKey, MAX_KEY_LENGTH);
    const count = asCount(rawCount);
    if (key && count !== undefined) {
      counts[key] = count;
    }
  }
  return counts;
}

/**
 * How many comments landed in each file.
 *
 * The values of `commentsByDoc` are the comments themselves; the only thing read from them is how
 * many there are. Sorted by weight so a truncated list is the part worth reading.
 */
function documentCounts(value: unknown): AdminBotPaperMentorDocument[] {
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  return Object.entries(record)
    .flatMap(([rawPath, comments]) => {
      const path = asString(rawPath, MAX_PATH_LENGTH);
      return path && Array.isArray(comments) ? [{ path, comments: comments.length }] : [];
    })
    .toSorted(
      (left, right) => right.comments - left.comments || left.path.localeCompare(right.path),
    )
    .slice(0, MAX_DOCUMENTS);
}

/** Agent names only: `reason` is a model's own error prose and is not worth carrying off the box. */
function failedAgentNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((entry) => {
      const agent = asRecord(entry);
      const name = agent ? asString(agent.name ?? agent.id, MAX_KEY_LENGTH) : undefined;
      return name ? [name] : [];
    })
    .slice(0, MAX_FAILED_AGENTS);
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}
