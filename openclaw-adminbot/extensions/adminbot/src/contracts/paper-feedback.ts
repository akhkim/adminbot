// Feedback is a request to read a draft, never permission to publish it.
export const paperFeedbackSlots = {
  feedback_arr: "ARR / Overleaf feedback",
  feedback_arxiv: "arXiv feedback",
  feedback_camera_ready: "Camera-ready feedback",
} as const;

/**
 * Whether a slot is a feedback request rather than a piece of evidence.
 *
 * These live in the slot registry for storage only. Their value is a JSON request that just the
 * feedback form builds, so any view that draws every slot as a generic field has to leave them out:
 * a text box there autosaves something the service rejects, and a link cell writes `url`, which
 * the feedback kind ignores and clears the slot over.
 */
export function isPaperFeedbackSlot(slot: string): slot is keyof typeof paperFeedbackSlots {
  return Object.hasOwn(paperFeedbackSlots, slot);
}

const DAY_MS = 86_400_000;

/**
 * How long past its hard deadline an item stays on the PI queue as overdue. Past this it belongs
 * to an earlier cycle: the camera-ready went in (or did not) months ago and the conference has
 * usually been held. Showing it as overdue buried the items she can still act on.
 */
export const STALE_DEADLINE_DAYS = 90;

/** Whether a deadline is so far behind that it is history rather than an overdue item. */
export function isStaleDeadline(deadline: string | undefined, now: Date): boolean {
  const instant = deadline ? Date.parse(deadline) : Number.NaN;
  return Number.isFinite(instant) && now.getTime() - instant > STALE_DEADLINE_DAYS * DAY_MS;
}

export type PaperFeedback = {
  reason: string;
  url: string;
  soft_deadline?: string;
  hard_deadline?: string;
  reviewed?: boolean;
  review_note?: string;
};
export function parsePaperFeedback(value: string): PaperFeedback | null {
  try {
    const data = JSON.parse(value);
    if (
      !data ||
      typeof data.reason !== "string" ||
      !data.reason.trim() ||
      data.reason.length > 2000 ||
      typeof data.url !== "string"
    ) {
      return null;
    }
    if (
      (data.reviewed !== undefined && typeof data.reviewed !== "boolean") ||
      (data.review_note !== undefined &&
        (typeof data.review_note !== "string" || data.review_note.length > 4000))
    ) {
      return null;
    }
    const url = new URL(data.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    for (const key of ["soft_deadline", "hard_deadline"]) {
      if (
        data[key] !== undefined &&
        (typeof data[key] !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data[key]) ||
          !Number.isFinite(Date.parse(data[key])))
      ) {
        return null;
      }
    }
    if (
      data.soft_deadline &&
      data.hard_deadline &&
      Date.parse(data.soft_deadline) > Date.parse(data.hard_deadline)
    ) {
      return null;
    }
    return {
      reason: data.reason.trim(),
      ...(data.reviewed !== undefined ? { reviewed: data.reviewed } : {}),
      ...(data.review_note !== undefined ? { review_note: data.review_note.trim() } : {}),
      url: url.href,
      ...(data.soft_deadline ? { soft_deadline: new Date(data.soft_deadline).toISOString() } : {}),
      ...(data.hard_deadline ? { hard_deadline: new Date(data.hard_deadline).toISOString() } : {}),
    };
  } catch {
    return null;
  }
}
