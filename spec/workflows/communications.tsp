import "../common/primitives.tsp";
import "../platform/privacy.tsp";

using AdminBot.Contracts.Common;
using AdminBot.Contracts.Privacy;

namespace AdminBot.Contracts.Workflows.Communications;

@format("uuid")
scalar CommunicationDraftId extends string;
@format("uuid")
scalar CalendarEventId extends string;

model Recipient {
  personId?: PersonId;
  address: EmailAddress;
  displayName?: string;
  kind: "to" | "cc" | "bcc";
}

model CommunicationDraft {
  id: CommunicationDraftId;
  channel: "email" | "slack" | "whatsapp" | "openclaw";
  purpose: string;
  recipients: Recipient[];
  subject?: string;
  body: string;
  attachments: ArtifactId[];
  dataClass: DataClass;
  templateId?: TemplateId;
  state: "draft" | "proposed" | "sent" | "cancelled";
}

/** Representative contract spike used to validate HTTP, JSON Schema, and action generation. */
model CalendarEventDraft {
  id: CalendarEventId;
  calendarKey: string;
  @minLength(1) title: string;
  description?: string;
  startsAt: utcDateTime;
  endsAt: utcDateTime;
  timeZone: string;
  attendees: Recipient[];
  location?: string;
  sourceReference?: string;
}

model CreateCalendarEventCommand {
  event: CalendarEventDraft;
}

/** Exact immutable payload shown to approvers and sent to the connector after approval. */
model CreateCalendarEventActionPayload {
  event: CalendarEventDraft;
  sourceCommandRequestId: RequestId;
}

model CalendarEventCreatedResult {
  eventId: CalendarEventId;
  vendorReference: string;
  htmlLink?: string;
  verifiedAt: utcDateTime;
}

model SendCommunicationActionPayload {
  draftId: CommunicationDraftId;
  exactRecipients: Recipient[];
  exactSubject?: string;
  exactBody: string;
  attachmentIds: ArtifactId[];
}

model PublishSignatureActionPayload {
  personId: PersonId;
  accountKey: string;
  html: string;
}

model RecommendationLetterDraft {
  candidateId: PersonId;
  requestedSignerId: PersonId;
  destination: string;
  dueAt?: utcDateTime;
  supportingArtifacts: ArtifactId[];
  draftArtifactId: ArtifactId;
  humanVerified: boolean;
}
