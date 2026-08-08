import type {
  ReimbursementConversationMessage,
  ReimbursementDraft,
  ReimbursementPacketArtifact,
  ReimbursementReceiptUpload,
} from "@adminbot/api-contracts";

export interface ValidatedReceipt {
  readonly filename: string;
  readonly mediaType: ReimbursementReceiptUpload["mediaType"];
  readonly data: Uint8Array;
}

export interface ReimbursementReasoningRequest {
  readonly message: string;
  readonly receipts: readonly ValidatedReceipt[];
  readonly messages: readonly ReimbursementConversationMessage[];
  readonly draft: ReimbursementDraft;
}

export interface ReimbursementReasoningResult {
  readonly assistantMessage?: string;
  readonly draft: ReimbursementDraft;
}

export interface ReimbursementRuntime {
  reason(request: ReimbursementReasoningRequest): Promise<ReimbursementReasoningResult>;
  generate(draft: ReimbursementDraft): Promise<readonly ReimbursementPacketArtifact[]>;
}

export interface ReimbursementRequestContext {
  readonly remoteAddress?: string;
}
