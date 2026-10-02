// Feedback is a request to read a draft, never permission to publish it.
export const paperFeedbackSlots = {
  feedback_arr: "ARR / Overleaf feedback",
  feedback_arxiv: "arXiv feedback",
  feedback_camera_ready: "Camera-ready feedback",
} as const;
export type PaperFeedback = {
  reason: string;
  url: string;
  soft_deadline?: string;
  hard_deadline?: string;
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
      url: url.href,
      ...(data.soft_deadline ? { soft_deadline: new Date(data.soft_deadline).toISOString() } : {}),
      ...(data.hard_deadline ? { hard_deadline: new Date(data.hard_deadline).toISOString() } : {}),
    };
  } catch {
    return null;
  }
}
