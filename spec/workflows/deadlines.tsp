import "../common/primitives.tsp";
import "./papers.tsp";

using AdminBot.Contracts.Common;
using AdminBot.Contracts.Workflows.Papers;

namespace AdminBot.Contracts.Workflows.Deadlines;

@format("uuid")
scalar VenueId extends string;
@format("uuid")
scalar VenueDeadlineId extends string;

model Venue extends VersionedRecord {
  id: VenueId;
  organizationId: OrganizationId;
  name: string;
  series: string;
  topics: string[];
  officialUri: url;
  curated: boolean;
}

model VenueDeadline extends VersionedRecord {
  id: VenueDeadlineId;
  venueId: VenueId;
  kind:
    | "abstract"
    | "paper"
    | "supplement"
    | "notification"
    | "camera_ready"
    | "event";
  occursAt: utcDateTime;
  timeZone: string;
  sourceUri: url;
  verifiedAt: utcDateTime;
  verifiedBy?: PersonId;
}

model PaperDeadlineMatch {
  paperId: PaperId;
  venueId: VenueId;
  score: float64;
  reasonCodes: string[];
  state: "suggested" | "watching" | "targeted" | "dismissed";
}

model CurateVenueDeadlineCommand {
  venueId: VenueId;
  expectedVersion: int32;
  deadline: VenueDeadline;
}

model SubscribeToDeadlineCommand {
  deadlineId: VenueDeadlineId;
  personId?: PersonId;
  reminderOffsetsHours: int32[];
}
