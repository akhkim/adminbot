import type { AdminBotCvScanDeps } from "../../cv-scan.js";
import type { LlmLoadRouter } from "../../kernel/llm-router.js";
import { ReferenceScans } from "../../kernel/reference-scans.js";
import { AdminBotService, type AdminBotServiceStore } from "../../kernel/service.js";
import type { FailedExternalRequestLedger } from "../../persistence/failed-requests.js";
import type { MemberDraftStore } from "../../persistence/member-drafts.js";
import type { AdminBotPrivacyBroker } from "../../privacy/broker.js";
import { createLocalChat } from "../../privacy/local-chat.js";
import type { AdminBotSensitiveInfoDocument } from "../../privacy/sensitive-info-doc.js";
import {
  AdminBotAuthService,
  type AdminBotMemberPrincipal,
} from "../../workflows/identity/auth.js";
import type { CalendarInviteRunner } from "../../workflows/onboarding/calendar-invite.js";
import type { AdminBotOnboardingSender } from "../../workflows/onboarding/guide-sender.js";
import { IclrIntegrityWatch } from "../../workflows/papers/iclr-integrity-watch.js";
import type { ImportColumnMapper } from "../../workflows/papers/import-columns.js";
import type { PublicationMailingRunner } from "../../workflows/papers/mailing-list-email.js";
import { OpenReviewCitationWatch } from "../../workflows/papers/openreview-citation-watch.js";
import type { AdminBotOpenReviewWorkflow } from "../../workflows/papers/openreview-workflow.js";
import type { AdminBotReimbursementWorkflow } from "../../workflows/reimbursements/workflow.js";
import type { CallSheetSource } from "../call-sheet-config.js";
import { createPdfReferenceCheckHandler } from "../pdf-reference-check.js";
import type { MemberSheetSource } from "../server.member-sheet.js";
import { createPublicDeadlineLimiter } from "../server.public-deadline-proposals.js";

export type AdminBotPrincipal =
  | { kind: "service" }
  | { kind: "anonymous"; ip?: string }
  | AdminBotMemberPrincipal;

export type AdminBotRouteContext = {
  // A restart invalidates outstanding packages: regenerate and review against the current rules.
  reimbursementSigningKey: Buffer;
  memberDrafts: MemberDraftStore;
  service: AdminBotService;
  // The raw store, for the CV change ledger. Everything else goes through the service; this is
  // append-only bookkeeping with no policy of its own, so it does not earn a service method.
  store: AdminBotServiceStore;
  auth: AdminBotAuthService;
  privacyBroker: AdminBotPrivacyBroker;
  localChat: ReturnType<typeof createLocalChat>;
  sensitiveInfo: AdminBotSensitiveInfoDocument;
  runEmailAutomation?: () => Promise<unknown>;
  reimbursementWorkflow?: AdminBotReimbursementWorkflow;
  openReviewWorkflow?: AdminBotOpenReviewWorkflow;
  fetchSlackLocations?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string>>;
  cvScanDeps?: AdminBotCvScanDeps;
  cvDigestPublisher?: AdminBotCvDigestPublisher;
  /** Sends the publication digest. Absent leaves /papers/mailing-list/send answering 503. */
  publicationMailingRunner?: PublicationMailingRunner;
  venuePapersReader?: import("../../connectors/openreview-notes.js").OpenReviewNotesReader;
  // Always present: the server builds both from the environment, and an absent embedder would
  // make every search path optional-chained for a case that cannot happen.
  embedder: import("../../connectors/embeddings.js").Embedder;
  embeddingModel: string;
  workshopMatcher: import("../../workflows/papers/workshop-nudges.js").WorkshopMatcher;
  workshopNudgeNow: () => Date;
  fetchSlackTimezones?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string | null>>;
  // Counts each member's messages in the activity window, by reading the channels the lab tracks.
  fetchSlackMessageCounts?: (
    slackUserIds: string[],
    channelIds: string[],
  ) => Promise<ReadonlyMap<string, number>>;
  resolveSlackUserIdsByEmail?: (emails: string[]) => Promise<ReadonlyMap<string, string>>;
  fetchSlackChannelNames?: () => Promise<string[]>;
  readCalendarEvents?: import("../../workflows/calendar/events.js").CalendarEventsReader;
  draftCalendarEvent?: import("../../workflows/calendar/event-draft.js").EventDraftRunner;
  /** Suggests a mapping for import columns the local pass could not place. */
  importColumnMapper?: ImportColumnMapper;
  // Generates a LinkedIn announcement draft from a paper PDF. Nothing it returns is persisted.
  draftLinkedInPost: import("../../connectors/social-draft.js").LinkedInDraftRunner;
  /**
   * Downloads one Drive file and returns it base64-encoded.
   *
   * Injected rather than imported so the route stays testable without a Google session, and so the
   * one place that shells out to gog for this is the host wiring. Absent means the deployment
   * cannot fetch a PDF for itself, and the route says so instead of pretending.
   */
  readDrivePdfBase64?: (fileId: string) => Promise<string>;
  memberSheet?: AdminBotMemberSheetSource;
  callSheet?: CallSheetSource;
  /** Resolved switch: does a submitted meeting request propose its own call-sheet row? */
  autoQueueMeetingRequests: boolean;
  labCalendar: import("../../workflows/calendar/lab-calendar.js").AdminBotLabCalendar;
  /** Grants lab-calendar read access, silently. Shared with auth so both use one runner. */
  inviteToLabCalendar: CalendarInviteRunner;
  serviceToken?: string;
  devicePairingApprover?: DevicePairingApprover;
  deviceTokenIssuer?: DeviceTokenIssuer;
  referenceScans: ReferenceScans;
  checkUploadedPdf: ReturnType<typeof createPdfReferenceCheckHandler>;
  openReviewCitationWatch?: OpenReviewCitationWatch;
  iclrIntegrityWatch?: IclrIntegrityWatch;
  onboardingSender: AdminBotOnboardingSender;
  allowedOrigins: Set<string>;
  refusedOrigins: Set<string>;
  anonymousRateLimiter: AnonymousRateLimiter;
  publicDeadlineLimiter: ReturnType<typeof createPublicDeadlineLimiter>;
  // Only true when this process is known to sit behind a trusted reverse proxy (Render, Fly,
  // etc.) that sets X-Forwarded-For itself. Otherwise a caller could hand-write that header to
  // spoof the IP rate-limiting and login-location keys off of — see remoteIp().
  trustProxyHeaders: boolean;
  llmRouter: LlmLoadRouter;
  failedRequestLedger: FailedExternalRequestLedger;
};

/**
 * Where the CV digest is published, and how.
 *
 * `documentUrl` travels with the writer rather than being derived at the call site so the console
 * can link straight to what it just rewrote, without the UI having to know how a Docs URL is
 * spelled.
 */
export type AdminBotCvDigestPublisher = {
  documentUrl: string;
  publish: (markdown: string) => Promise<void>;
};

/**
 * The lab's member spreadsheet, as the Membership grid reads it.
 *
 * The id and tab travel with the reader so the UI can link to the sheet it is showing and so the
 * write path can address cells in it, without either side having to know how the deployment was
 * configured.
 */
export type AdminBotMemberSheetSource = MemberSheetSource;

export type DeviceTokenIssuance =
  | { ok: true; token: string; scopes: string[] }
  | {
      ok: false;
      reason: "unsupported" | "failed";
      message?: string;
    };

export type DeviceTokenIssuer = (params: {
  deviceId: string;
  publicKey: string;
  platform?: string;
  deviceFamily?: string;
  displayName?: string;
  allowedScopes: readonly string[];
  memberId?: string;
}) => Promise<DeviceTokenIssuance>;

export type DevicePairingApproval =
  | { ok: true }
  | {
      ok: false;
      reason: "unknown_request" | "scope_exceeds_privilege" | "failed";
      message?: string;
    };

export type DevicePairingApprover = (params: {
  requestId: string;
  allowedScopes: readonly string[];
}) => Promise<DevicePairingApproval>;

export type AnonymousRateLimiter = { check(ip: string | undefined): boolean };
