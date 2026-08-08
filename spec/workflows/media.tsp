import "../common/primitives.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Workflows.Media;

@format("uuid")
scalar MediaJobId extends string;

model TrimWindow {
  @minValue(0) startsAtSeconds: float64;
  @minValue(0) endsAtSeconds: float64;
}

model MediaJob extends VersionedRecord {
  id: MediaJobId;
  organizationId: OrganizationId;
  requestedBy: PersonId;
  inputArtifactId: ArtifactId;
  outputArtifactId?: ArtifactId;
  trim?: TrimWindow;
  state:
    | "draft"
    | "processing"
    | "ready"
    | "publish_proposed"
    | "published"
    | "failed";
  completedAt?: utcDateTime;
}

model PublishMediaActionPayload {
  mediaJobId: MediaJobId;
  artifactId: ArtifactId;
  destination: "youtube" | "drive";
  visibility: "unlisted" | "private";
  title: string;
  description?: string;
}
