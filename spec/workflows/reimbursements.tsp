import "../common/primitives.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Workflows.Reimbursements;

@format("uuid")
scalar ReimbursementId extends string;
@format("uuid")
scalar ExpenseItemId extends string;
@pattern("^[A-Z]{3}$")
scalar CurrencyCode extends string;

model Money {
  currency: CurrencyCode;
  minorUnits: int64;
}

model ExpenseItem {
  id: ExpenseItemId;
  incurredOn: plainDate;
  merchant: string;
  category: string;
  amount: Money;
  receiptArtifactIds: ArtifactId[];
  @minValue(0) @maxValue(1) extractedConfidence?: float64;
  humanVerified: boolean;
}

model Reimbursement extends VersionedRecord {
  id: ReimbursementId;
  organizationId: OrganizationId;
  claimantId: PersonId;
  purpose: string;
  costCenter?: string;
  items: ExpenseItem[];
  total: Money;
  state:
    | "intake"
    | "needs_information"
    | "draft_ready"
    | "proposed"
    | "submitted"
    | "paid"
    | "rejected"
    | "cancelled";
  submittedAt?: utcDateTime;
}

model StartReimbursementCommand {
  purpose: string;
  costCenter?: string;
}

model AddExpenseItemCommand {
  reimbursementId: ReimbursementId;
  expectedVersion: int32;
  item: ExpenseItem;
}

model GenerateReimbursementPacketCommand {
  reimbursementId: ReimbursementId;
  expectedVersion: int32;
  templateVersion: SemVer;
}

model SubmitReimbursementActionPayload {
  reimbursementId: ReimbursementId;
  claimantId: PersonId;
  exactTotal: Money;
  packId: "waterloo_travel_v1";
  packetInputDigest: Sha256;
  draft: ReimbursementDraft;
  destination: string;
}

model ProposeReimbursementSubmissionCommand {
  @format("uuid") clientRequestId: string;
  packId: "waterloo_travel_v1";
  draft: ReimbursementDraft;
  @minLength(1) @maxLength(240) destination: string;
  attestedAccurate: boolean;
}

enum ReceiptMediaType {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
}

model ReimbursementReceiptUpload {
  @maxLength(160) filename: string;
  mediaType: ReceiptMediaType;
  dataBase64: string;
}

model ReimbursementConversationMessage {
  role: "user" | "assistant";
  @maxLength(8000) content: string;
}

model ReimbursementExpenseDraft {
  sourceReceipt?: string;
  @minValue(0) @maxValue(1) extractedConfidence?: float64;
  receiptNumber?: string;
  date?: string;
  description?: string;
  category?: string;
  amount?: float64;
  currency?: string;
  region?: "canada" | "usa" | "international";
  taxRegion?:
    | "ontario"
    | "atlantic_canada"
    | "other_canada"
    | "usa_international";
  airfareClass?: "economy" | "above_economy";
  includesTip?: boolean;
  tipAmount?: float64;
}

model ReimbursementDraft {
  claimantName?: string;
  claimantEmail?: string;
  claimantAddress?: string;
  claimantTitle?: string;
  personnelNumber?: string;
  travelPeriod?: string;
  purpose?: string;
  currency?: string;
  otherCurrency?: string;
  tripTitle?: string;
  tripDates?: string;
  tripLocation?: string;
  expenses: ReimbursementExpenseDraft[];
}

model ReimbursementConversationInput {
  @minLength(1) @maxLength(8000) message: string;
  receipts?: ReimbursementReceiptUpload[];
  messages?: ReimbursementConversationMessage[];
  draft?: ReimbursementDraft;
}

model ReimbursementConversationResult {
  assistantMessage: string;
  draft: ReimbursementDraft;
  missingFields: string[];
  ready: boolean;
  receiptNames: string[];
}

model GenerateReimbursementPacketInput {
  packId: "waterloo_travel_v1";
  draft: ReimbursementDraft;
}

model ReimbursementPacketArtifact {
  filename: string;
  mediaType: string;
  dataBase64: string;
}

model ReimbursementPacketResult {
  artifacts: ReimbursementPacketArtifact[];
  warnings: string[];
}
