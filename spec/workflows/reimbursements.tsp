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
  packetArtifactId: ArtifactId;
  destination: string;
}
