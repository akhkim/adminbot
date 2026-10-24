export type DeadlineRecommendationInput = {
  deadline_id: string;
  recipient_member_id: string;
  paper_ids?: string[];
  reason?: string;
};

export type DeadlineRecommendationPreview = {
  id: string;
  payload_hash: string;
  message: string;
  recommender_name: string;
  recipient_name: string;
  status: "pending" | "sent";
};

export type DeadlineRecommendationDirectory = {
  nextOffset?: number;
  members: Array<{ id: string; name: string; avatar_url?: string; slack_linked: boolean }>;
  papers: Array<{ id: string; title: string; author_member_ids: string[] }>;
  recommendations: Array<{
    deadline_id: string;
    recipient_member_id: string;
    recommender_member_id: string;
  }>;
};

export type DeadlineRecommendationPayload = {
  deadline_id: string;
  recommender_member_id: string;
  recipient_member_id: string;
  recommender_name: string;
  recipient_name: string;
  paper_ids?: string[];
  reason: string;
  deadline_fingerprint: string;
  user_ids: [string, string];
  message: string;
};

export type DeadlineRecommendationQuery = {
  mode?: "summary" | "members" | "papers";
  q?: string;
  offset?: number;
  recipient?: string;
  deadlineIds?: string[];
};
