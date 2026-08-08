import "../common/primitives.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Workflows.PublicTools;

@format("uuid")
scalar GuideId extends string;

model DecisionGuideAnswer {
  label: string;
  nextNodeId?: string;
  resultCode?: string;
}

model DecisionGuideNode {
  id: string;
  prompt: string;
  answers: DecisionGuideAnswer[];
}

model DecisionGuide {
  id: GuideId;
  version: SemVer;
  title: string;
  owner: string;
  reviewedAt: utcDateTime;
  sourceUris: url[];
  nodes: DecisionGuideNode[];
}

model GenerateCalendarArtifactCommand {
  title: string;
  description?: string;
  startsAt: utcDateTime;
  endsAt: utcDateTime;
  timeZone: string;
  location?: string;
}

model GeneratePublicArtifactResult {
  artifactId: ArtifactId;
  mediaType: string;
  templateId?: TemplateId;
}
