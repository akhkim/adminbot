// What every route is handed: the principal the request resolved to, the service and its
// connectors (AdminBotRouteContext), and the options createAdminBotMockService builds them from.
//
// Cut from server.ts. Types only, so any route module may import it without a cycle.

import type { PdfReferenceChecker } from "../../connectors/reference-check.js";
import type { AdminBotDriveProbe } from "../../contracts/drive-links.js";
import type { OpenReviewSubmissionReader } from "../../contracts/openreview-citation-checks.js";
import type { AdminBotArtifactProbe } from "../../contracts/paper-artifact-links.js";
import type { AiTextScorer } from "../../contracts/paper-integrity-checks.js";
import type { ReferenceScanDependencies } from "../../contracts/reference-scans.js";
import type { AdminBotCvScanDeps } from "../../cv-scan.js";
import type { LlmLoadRouter } from "../../kernel/llm-router.js";
import { ReferenceScans } from "../../kernel/reference-scans.js";
import { AdminBotService, type AdminBotServiceStore } from "../../kernel/service.js";
import type { AdminBotActionExecutor, AdminBotServiceOptions } from "../../kernel/service.js";
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
import type { AdminBotOnboardingSenderOptions } from "../../workflows/onboarding/guide-sender.js";
import { IclrIntegrityWatch } from "../../workflows/papers/iclr-integrity-watch.js";
import type { ImportColumnMapper } from "../../workflows/papers/import-columns.js";
import type { PublicationMailingRunner } from "../../workflows/papers/mailing-list-email.js";
import { OpenReviewCitationWatch } from "../../workflows/papers/openreview-citation-watch.js";
import type { AdminBotOpenReviewWorkflow } from "../../workflows/papers/openreview-workflow.js";
import type { AdminBotReimbursementWorkflow } from "../../workflows/reimbursements/workflow.js";
import type { CallSheetSource } from "../call-sheet-config.js";
import type { createNotificationDraftHandler } from "../notification-drafts.js";
import { createPdfReferenceCheckHandler } from "../pdf-reference-check.js";
import type { MemberSheetSource } from "../server.member-sheet.js";
import { createPublicDeadlineLimiter } from "../server.public-deadline-proposals.js";

export type AdminBotPrincipal =
  | { kind: "service" }
  | { kind: "anonymous"; ip?: string }
  | AdminBotMemberPrincipal;

export type AdminBotRouteContext = {
  notificationDrafts: ReturnType<typeof createNotificationDraftHandler>;
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
  draftXPost: import("../../connectors/social-draft.js").XDraftRunner;
  readArxivPdfBase64: (id: string) => Promise<string>;
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

export type AdminBotMockServiceOptions = {
  databasePath?: string;
  auditRetentionDays?: number;
  executor?: AdminBotActionExecutor;
  privacyBroker?: AdminBotPrivacyBroker;
  localChat?: ReturnType<typeof createLocalChat>;
  sensitiveInfoPath?: string;
  sensitiveInfoDocument?: AdminBotSensitiveInfoDocument;
  emailAutomationRunner?: () => Promise<unknown>;
  reimbursementWorkflow?: AdminBotReimbursementWorkflow;
  serviceToken?: string;
  gatewayToken?: string;
  gatewayUrl?: string;
  // Free-tier IPinfo Lite token, used to stamp a coarse (country-level) location on a member's
  // record from the IP their most recent successful login came from. Falls back to
  // process.env.IPINFO_TOKEN; absent either way, login location just never gets recorded.
  ipinfoToken?: string;
  // Trust X-Forwarded-For for the caller's IP (rate limiting, login-location) instead of the raw
  // socket address. Only safe when this process is only reachable through a proxy that sets that
  // header itself (Render, Fly, etc.) — falls back to process.env.ADMINBOT_TRUST_PROXY === "1".
  trustProxyHeaders?: boolean;
  referenceScanDependencies?: ReferenceScanDependencies;
  pdfReferenceChecker?: PdfReferenceChecker;
  // Automatic citation checks of the OpenReview account's own submissions. Injecting a reader
  // enables them; otherwise they need ADMINBOT_OPENREVIEW_CITATION_CHECKS=1 plus credentials.
  openReviewSubmissionReader?: OpenReviewSubmissionReader;
  citationWatchChecker?: PdfReferenceChecker;
  citationWatchNotifyEmail?: string;
  // The ICLR pre-deadline integrity check. Injecting a scorer enables it (with the reader above);
  // otherwise it needs ADMINBOT_ICLR_INTEGRITY_CHECKS=1, PANGRAM_API_KEY and OpenReview credentials.
  aiTextScorer?: AiTextScorer;
  integrityTextExtractor?: (pdf: Uint8Array) => Promise<string>;
  // Injected so the composition root owns the Slack dependency: the invite needs the Slack
  // extension's write client, and a bundled plugin importing another plugin is what the
  // extensions boundary forbids.
  onboardingSender?: AdminBotOnboardingSender;
  inviteToSlackConnect?: import("../../workflows/onboarding/guide-sender.js").SlackConnectInviter;
  allowedOrigins?: string[];
  // Fetch/extract/model steps behind the admin CV scan. Injected so tests can drive the scan
  // without a network fetch, a python interpreter, or a running local model.
  cvScanDeps?: AdminBotCvScanDeps;
  // Publishes the rendered CV digest to its Google Doc. Injected so tests never shell out to
  // `gog`, and so a deployment without a configured document simply has no job rather than a
  // button that fails at the CLI.
  cvDigestPublisher?: AdminBotCvDigestPublisher;
  /** Sends the publication digest. Absent leaves /papers/mailing-list/send answering 503. */
  publicationMailingRunner?: PublicationMailingRunner;
  // Reads a venue's accepted papers from OpenReview, and turns text into vectors. Injected so the
  // conference-paper tool is testable without a network and so a deployment without OpenReview
  // credentials simply has no index job rather than a button that fails inside a connector.
  venuePapersReader?: import("../../connectors/openreview-notes.js").OpenReviewNotesReader;
  embedder?: import("../../connectors/embeddings.js").Embedder;
  embeddingModel?: string;
  workshopMatcher?: import("../../workflows/papers/workshop-nudges.js").WorkshopMatcher;
  workshopNudgeNow?: () => Date;
  // Overrides the default `gws` CLI-backed calendar invite runner — used by tests to avoid
  // shelling out to a real `gws` binary.
  calendarInviteRunner?: (email: string) => Promise<void>;
  // Reads upcoming events for the Calendar tab. Injected so tests never shell out to `gog`, and
  // so a deployment without the CLI simply has no picker rather than a broken route.
  calendarEventsReader?: import("../../workflows/calendar/events.js").CalendarEventsReader;
  // Drafts an event from a sentence. Defaults to the privacy broker, so a prompt naming a member
  // gets the same placeholder treatment every other reasoning task gets.
  calendarEventDrafter?: import("../../workflows/calendar/event-draft.js").EventDraftRunner;
  /** Maps leftover import columns with the local model. Injected so tests need no tunnel. */
  importColumnMapper?: ImportColumnMapper;
  // Same for the `gog` CLI-backed "your account is approved" email.
  accountApprovedEmailRunner?: (params: { email: string; name?: string }) => Promise<void>;
  passwordResetEmailRunner?: (params: {
    email: string;
    name?: string;
    token: string;
    expiresInMinutes: number;
  }) => Promise<void>;
  // Generates a LinkedIn announcement draft from a paper PDF. Injected so tests can assert the
  // route without an OpenRouter round trip; defaults to the real connector.
  linkedInDraftRunner?: import("../../connectors/social-draft.js").LinkedInDraftRunner;
  xDraftRunner?: import("../../connectors/social-draft.js").XDraftRunner;
  readArxivPdfBase64?: (id: string) => Promise<string>;
  /** Reads one Drive file as base64, so a draft can use the PDF the paper already names. */
  readDrivePdfBase64?: (fileId: string) => Promise<string>;
  /**
   * Asks Google whether a Drive file is really there, for the evidence-verification pass.
   *
   * Injected for the same reason `readDrivePdfBase64` is: reaching Google is the composition
   * layer's job, and a deployment without an account simply leaves this unset -- the pass then
   * confirms nothing rather than marking every link as broken.
   */
  driveProbe?: AdminBotDriveProbe;
  /** Asks arXiv and OpenReview about a paper's public record; unset means those slots go unchecked. */
  arxivProbe?: AdminBotArtifactProbe;
  openReviewProbe?: AdminBotArtifactProbe;
  /**
   * The lab's member spreadsheet, as the Membership tab's grid reads and writes it.
   *
   * Injected rather than imported for the same reason as readDrivePdfBase64: the route stays
   * testable without a Google session, and the one place that shells out to gog is the host
   * wiring. Absent means this deployment has no roster to show, and the route says so.
   */
  memberSheet?: AdminBotMemberSheetSource;
  /**
   * The tab Zhijing's WhatsApp call queue lives on. Injected on the same terms as `memberSheet`.
   */
  callSheet?: CallSheetSource;
  /**
   * Propose a call-sheet row the moment a `book_meeting` request is submitted.
   *
   * Defaults on (ADMINBOT_CALL_SHEET_AUTO_QUEUE=0 turns it off). Route tests that submit meeting
   * requests pass false: the push checks a doc-prep link over the network and reads the workbook,
   * and neither belongs in a test about who the wire lets in.
   */
  autoQueueMeetingRequests?: boolean;
  // Overrides the DCS roster-sheet recorder outright (tests use this to assert on the call
  // without touching a real spreadsheet). If unset, dcsRosterSheetId decides whether one gets
  // built at all.
  dcsRosterRecorder?: AdminBotOnboardingSenderOptions["addDcsRosterRow"];
  // The spreadsheet new full members are filed on. Absent in unit/mock setups, which leaves the
  // filing unwired (no attempt, no audit event) rather than half-working -- the same shape the
  // retired DCS form script had, for the same reason.
  dcsRosterSheetId?: string;
  llmRouter?: LlmLoadRouter;
  failedRequestLedger?: FailedExternalRequestLedger;
  // Approves a pending gateway device pairing on behalf of a signed-in member. Injected from the
  // repo-root composition layer (start-adminbot.mjs) so the extension never imports core
  // device-pairing internals. `allowedScopes` is the ceiling derived from the member's privilege;
  // the approver must not grant beyond it. Absent in unit/mock setups that don't test pairing.
  devicePairingApprover?: DevicePairingApprover;
  // Pairs a member's browser device and mints a gateway token bound to it, so the browser never
  // needs the shared gateway secret to open its first connection. Injected from the repo-root
  // composition layer for the same boundary reason as devicePairingApprover.
  deviceTokenIssuer?: DeviceTokenIssuer;
  // Path to scripts/adminbot-openreview.py. Injected as a path rather than a built
  // workflow because the workflow needs the store this factory owns; absent in unit
  // setups, which leaves every /openreview route reporting 503 rather than half-working.
  notificationDraftScriptPath?: string;
  openReviewScriptPath?: string;
  openReviewPythonCommand?: string;
  // Reads each member's location from their Slack profile. Injected from the repo-root
  // composition layer, which owns how Slack is reached; absent here means the map falls
  // back to roster locations for everyone.
  fetchSlackLocations?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string>>;
  // Reads each member's IANA timezone from Slack, for the profile `timezone` field --
  // distinct from fetchSlackLocations, which resolves a human-readable place, not a zone id.
  fetchSlackTimezones?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string | null>>;
  // Counts each member's messages in the activity window, by reading the channels the lab tracks.
  fetchSlackMessageCounts?: (
    slackUserIds: string[],
    channelIds: string[],
  ) => Promise<ReadonlyMap<string, number>>;
  // Backfills `slack_user_id` for members the roster has never linked to Slack, by matching
  // roster email against the workspace directory.
  resolveSlackUserIdsByEmail?: (emails: string[]) => Promise<ReadonlyMap<string, string>>;
  // Every open public channel name in the workspace, for the project form's "this channel already
  // exists" check. Injected like the Slack reads above: reaching Slack is a composition-layer
  // concern, and left unset the route answers 503 so the form can say the check is unavailable
  // rather than quietly passing an alias nobody verified.
  fetchSlackChannelNames?: () => Promise<string[]>;
  // Coarsely geolocates a login's source IP so the roster can show where an account last signed
  // in from. Injected because reaching a public geolocation API is a composition-layer concern,
  // same as the Slack reads above. Left unset, the login path simply skips the stamp — and when
  // IPINFO_TOKEN is configured, createIpinfoGeolocator supplies the default.
  //
  // Country/continent only, and deliberately never written to `location`, which is self-reported.
  geolocateIp?: (
    ip: string,
  ) => Promise<
    { country?: string; continent?: string; city?: string; timezone?: string } | undefined
  >;
  // Periodic sweep cadence for Slack channel naming enforcement. Disabled when unset.
  slackChannelNamingSweepIntervalMs?: number;
  reviewSlackProfilePhoto?: NonNullable<AdminBotServiceOptions["reviewSlackProfilePhoto"]>;
  polishSlackProfilePhoto?: NonNullable<AdminBotServiceOptions["polishSlackProfilePhoto"]>;
};
