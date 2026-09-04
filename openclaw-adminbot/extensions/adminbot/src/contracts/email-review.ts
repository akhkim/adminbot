import type { AdminBotPaperflowStage } from "./paperflow-stages.js";

/** One inbound message the hourly pass deliberately left for an administrator to decide. */
export type AdminBotEmailReviewItem = {
  message_id: string;
  thread_id: string;
  sender: string;
  subject?: string;
  category: string;
  reason?: string;
  received_at?: string;
  updated_at: string;
};

/** A paper and its one currently open venue stage, offered as a safe attachment target. */
export type AdminBotEmailReviewPaperflowCandidate = {
  paper_id: string;
  title: string;
  stage: AdminBotPaperflowStage;
  stage_label: string;
  venue?: string;
};

export type AdminBotEmailReviewResolution =
  | { kind: "paperflow_evidence"; paper_id: string; stage: string }
  | { kind: "dismissed" };
