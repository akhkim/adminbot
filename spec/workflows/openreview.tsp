import "../common/primitives.tsp";
import "./papers.tsp";

using AdminBot.Contracts.Common;
using AdminBot.Contracts.Workflows.Papers;

namespace AdminBot.Contracts.Workflows.OpenReview;

@format("uuid")
scalar ReviewCycleId extends string;
@format("uuid")
scalar ReviewAssignmentId extends string;
@minLength(1)
scalar ExternalProfileRef extends string;

model ReviewCadenceStep {
  name: string;
  dueAt: utcDateTime;
  purpose:
    | "profile_check"
    | "bidding"
    | "assignment"
    | "review"
    | "discussion"
    | "decision";
  reminderOffsetsHours: int32[];
}

model ReviewCycle extends VersionedRecord {
  id: ReviewCycleId;
  organizationId: OrganizationId;
  venue: string;
  externalGroupReference: string;
  state: "draft" | "active" | "closed" | "archived";
  biddingEndsAt?: utcDateTime;
  reviewEndsAt?: utcDateTime;
  cadence: ReviewCadenceStep[];
}

model ReviewerSuggestion {
  paperId: PaperId;
  personId?: PersonId;
  externalProfileRef?: ExternalProfileRef;
  score: float64;
  reasonCodes: string[];
  conflictState: "clear" | "possible" | "confirmed" | "unknown";
  humanVerified: boolean;
}

model ReviewAssignment extends VersionedRecord {
  id: ReviewAssignmentId;
  cycleId: ReviewCycleId;
  paperId: PaperId;
  reviewer: PersonId | ExternalProfileRef;
  state:
    | "suggested"
    | "proposed"
    | "assigned"
    | "declined"
    | "completed"
    | "withdrawn";
  dueAt: utcDateTime;
}

model GenerateReviewerSuggestionsCommand {
  cycleId: ReviewCycleId;
  paperIds: PaperId[];
  @minValue(1) minimumCandidates: int32;
}

model ReviewerAssignmentInput {
  paperId: PaperId;
  reviewer: PersonId | ExternalProfileRef;
}

model AssignReviewersActionPayload {
  cycleId: ReviewCycleId;
  assignments: ReviewerAssignmentInput[];
}
