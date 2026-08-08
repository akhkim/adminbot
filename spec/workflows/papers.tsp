import "../common/primitives.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Workflows.Papers;

@format("uuid")
scalar PaperId extends string;
@format("uuid")
scalar PaperCheckId extends string;

enum PaperStageKind {
  idea,
  outline,
  drafting,
  internalReview: "internal_review",
  submissionReady: "submission_ready",
  submitted,
  revision,
  accepted,
  cameraReady: "camera_ready",
  published,
  archived,
}

model Paper extends VersionedRecord {
  id: PaperId;
  organizationId: OrganizationId;
  title: string;
  authorIds: PersonId[];
  correspondingAuthorId?: PersonId;
  stage: PaperStageKind;
  targetVenue?: string | null;
  deadlineAt?: utcDateTime | null;
  sourceUri?: url | null;
  topicTags: string[];
}

model PaperArtifact {
  paperId: PaperId;
  artifactId: ArtifactId;
  kind:
    | "manuscript"
    | "source"
    | "figures"
    | "supplement"
    | "slides"
    | "poster"
    | "video";
  label: string;
  current: boolean;
}

model PaperCheck {
  id: PaperCheckId;
  paperId: PaperId;
  kind: "format" | "anonymity" | "metadata" | "artifact" | "human_review";
  state: "pending" | "passed" | "failed" | "waived";
  safeSummary: string;
  checkedAt?: utcDateTime;
  checkedBy?: PersonId;
}

model PaperReminder {
  paperId: PaperId;
  purpose: string;
  dueAt: utcDateTime;
  recipientIds: PersonId[];
  state: "scheduled" | "proposed" | "sent" | "cancelled";
}

enum PaperTimelineItemState {
  complete,
  current,
  upcoming,
}

model PaperTimelineItem {
  stage: PaperStageKind;
  label: string;
  offsetStartBusinessDay: int32;
  durationBusinessDays: int32;
  state: PaperTimelineItemState;
}

model PaperTimeline {
  progressPercent: int32;
  totalEstimatedBusinessDays: int32;
  items: PaperTimelineItem[];
}

model PaperProjection {
  paper: Paper;
  authorNames: string[];
  timeline: PaperTimeline;
}

model PaperNudgeProjection {
  paperId: PaperId;
  title: string;
  stage: PaperStageKind;
  dueAt: utcDateTime;
  recipientIds: PersonId[];
  recipientNames: string[];
  kind: "author_nudge" | "administrator_escalation";
  message: string;
}

model PaperWorkspaceProjection {
  papers: PaperProjection[];
  nudges: PaperNudgeProjection[];
  viewerPersonId: PersonId;
  viewerRoles: string[];
}

model CreatePaperCommand {
  title: string;
  authorIds: PersonId[];
  stage?: PaperStageKind;
  targetVenue?: string;
  deadlineAt?: utcDateTime;
  sourceUri?: url;
  topicTags?: string[];
}

model UpdatePaperCommand {
  paperId: PaperId;
  expectedVersion: int32;
  title?: string;
  authorIds?: PersonId[];
  correspondingAuthorId?: PersonId;
  targetVenue?: string | null;
  deadlineAt?: utcDateTime | null;
  sourceUri?: url | null;
  topicTags?: string[];
  stage?: PaperStageKind;
}

model DeletePaperCommand {
  paperId: PaperId;
  expectedVersion: int32;
}

model TransitionPaperStageCommand {
  paperId: PaperId;
  expectedVersion: int32;
  from: PaperStageKind;
  to: PaperStageKind;
  evidenceArtifactIds?: ArtifactId[];
  note?: string;
}

model ApplyOverleafPatchActionPayload {
  paperId: PaperId;
  projectReference: string;
  baseRevision: string;
  patchArtifactId: ArtifactId;
}

model PublishPaperPostActionPayload {
  paperId: PaperId;
  network: "linkedin" | "x" | "bluesky";
  exactText: string;
  mediaArtifactIds: ArtifactId[];
}
