import "../common/primitives.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Workflows.Projects;

@format("uuid")
scalar ProjectId extends string;
@format("uuid")
scalar ProjectInterestId extends string;
@format("uuid")
scalar CollaborationId extends string;

enum ProjectState {
  idea,
  open,
  staffing,
  active,
  paused,
  completed,
  archived,
}

model Project extends VersionedRecord {
  id: ProjectId;
  organizationId: OrganizationId;
  title: string;
  summary: string;
  state: ProjectState;
  leadIds: PersonId[];
  topicTags: string[];
  desiredSkills: string[];
  desiredCapacityPercent?: int32;
  openToInterest: boolean;
  relatedArtifactIds: ArtifactId[];
}

model ProjectInterest extends VersionedRecord {
  id: ProjectInterestId;
  projectId: ProjectId;
  personId: PersonId;
  note?: string;
  preferredStartDate?: plainDate;
  state:
    | "submitted"
    | "acknowledged"
    | "discussing"
    | "accepted"
    | "declined"
    | "withdrawn";
}

model Collaboration extends VersionedRecord {
  id: CollaborationId;
  projectId: ProjectId;
  personId: PersonId;
  role: string;
  allocationPercent?: int32;
  state: "planned" | "active" | "handoff" | "ended";
}

model UpdateProjectCommand {
  projectId: ProjectId;
  expectedVersion: int32;
  title?: string;
  summary?: string;
  state?: ProjectState;
  leadIds?: PersonId[];
  topicTags?: string[];
  desiredSkills?: string[];
  openToInterest?: boolean;
}

model ExpressProjectInterestCommand {
  projectId: ProjectId;
  note?: string;
  preferredStartDate?: plainDate;
}

model ProposeProjectHandoffCommand {
  projectId: ProjectId;
  fromPersonId: PersonId;
  toPersonId: PersonId;
  responsibilities: string[];
  note?: string;
}
