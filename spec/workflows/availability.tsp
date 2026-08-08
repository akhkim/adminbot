import "../common/primitives.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Workflows.Availability;

@format("uuid")
scalar AvailabilityPlanId extends string;
@format("uuid")
scalar AvailabilityEntryId extends string;

model AvailabilityEntry {
  id: AvailabilityEntryId;
  kind: "available" | "unavailable" | "leave" | "tentative";
  startsAt: utcDateTime;
  endsAt: utcDateTime;
  @minValue(0) @maxValue(100) capacityPercent?: int32;
  label?: string;
  visibility: "administrators" | "members" | "summary_only";
}

model AvailabilityPlan extends VersionedRecord {
  id: AvailabilityPlanId;
  organizationId: OrganizationId;
  personId: PersonId;
  timeZone: string;
  @minValue(0) @maxValue(100) defaultWeeklyCapacityPercent: int32;
  entries: AvailabilityEntry[];
}

model CapacityProjection {
  personId: PersonId;
  weekStarting: plainDate;
  @minValue(0) @maxValue(100) capacityPercent: int32;
  @minValue(0) allocatedPercent: int32;
  availablePercent: int32;
  visibility: "self" | "administrators" | "members_summary";
}

model ReplaceAvailabilityWindowCommand {
  planId: AvailabilityPlanId;
  expectedVersion: int32;
  windowStartsAt: utcDateTime;
  windowEndsAt: utcDateTime;
  entries: AvailabilityEntry[];
}

model ImportAvailabilityCommand {
  sourceReference: string;
  sourceRevision: string;
  dryRun: boolean;
}
