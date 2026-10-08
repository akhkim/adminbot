/** Shared load, failover, and offline-queue contracts for AdminBot and PaperMentor. */

export const adminBotLlmDefaultMaxLocal = 8;
export const adminBotLlmDefaultMaxPublic = 100;
export const adminBotLlmDefaultMaxPublicCeiling = 100;

export type AdminBotLlmNodeGpu = "RTX6000" | "H100" | "other";

export type AdminBotLlmNode = {
  id: "aurora" | "maple" | "conserto3" | string;
  baseUrl: string;
  gpu: AdminBotLlmNodeGpu;
};

export type AdminBotLlmSlotKind = "local" | "public";

export type AdminBotLlmLoadStatus = {
  local_active: number;
  public_active: number;
  queued: number;
  max_local: number;
  max_public: number;
  nodes: AdminBotLlmNode[];
};

export type AdminBotFailedExternalRequestStatus =
  | "recorded"
  | "aws_retry_failed"
  | "escalated_to_human"
  | "resolved";

export type AdminBotFailedExternalRequest = {
  id: string;
  service_type: string;
  payload: Record<string, unknown>;
  error_message: string;
  status: AdminBotFailedExternalRequestStatus;
  attempt_count: number;
  created_at: string;
  updated_at: string;
};

export type AdminBotOfflineOutboxItem = {
  id: string;
  method: "POST" | "PUT" | "DELETE";
  path: string;
  payload?: unknown;
  created_at: number;
  retry_count: number;
  /** Read-only cache vs queued write. On-device SLM drafts use `llm_draft`. */
  kind: "mutation" | "llm_draft";
};
