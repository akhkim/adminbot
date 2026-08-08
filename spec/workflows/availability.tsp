import "../common/primitives.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Workflows.Availability;

@format("uuid")
scalar AvailabilityPlanId extends string;
@format("uuid")
scalar AvailabilityEntryId extends string;

enum AvailabilityEntryKind {
  allocation,
  openCapacity: "open_capacity",
  timeOff: "time_off",
  tentative,
}

model AvailabilityEntry {
  id: AvailabilityEntryId;
  kind: AvailabilityEntryKind;
  startsOn: plainDate;
  endsOn: plainDate;
  @minValue(0) @maxValue(168) hoursPerWeek?: float32;
  label?: string;
  color?: string;
  timeOffAvailability?: "none" | "partial";
  privateReason?: string;
  supportingUri?: url;
  visibility: "administrators" | "members" | "summary_only";
  source: "manual" | "imported";
  confirmedAt: utcDateTime;
}

model AvailabilityPlan extends VersionedRecord {
  id: AvailabilityPlanId;
  organizationId: OrganizationId;
  personId: PersonId;
  personName: string;
  timeZone: string;
  @minValue(1) @maxValue(168) defaultWeeklyHours: float32;
  entries: AvailabilityEntry[];
}

model AvailabilitySummary {
  personId: PersonId;
  personName: string;
  @minValue(0) allocatedHours: float32;
  @minValue(0) openHours: float32;
  away: "none" | "partial" | "full";
  confirmedAt?: utcDateTime;
  stale: boolean;
}

model AvailabilityWorkspaceProjection {
  viewerPersonId: PersonId;
  viewerRoles: string[];
  ownPlan: AvailabilityPlan;
  visiblePlans: AvailabilityPlan[];
  summaries: AvailabilitySummary[];
  asOf: utcDateTime;
}

model ReplaceAvailabilityPlanCommand {
  planId: AvailabilityPlanId;
  expectedVersion: int32;
  timeZone: string;
  @minValue(1) @maxValue(168) defaultWeeklyHours: float32;
  entries: AvailabilityEntry[];
}

model ImportAvailabilityCommand {
  sourceReference: string;
  sourceRevision: string;
  dryRun: boolean;
}
