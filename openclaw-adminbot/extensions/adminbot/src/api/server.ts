import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createOllamaEmbedder } from "../connectors/embeddings.js";
import { createIpinfoGeolocator } from "../connectors/ip-geolocation.js";
import { createOpenReviewNotesReader } from "../connectors/openreview-notes.js";
import { createLinkedInDraftRunner } from "../connectors/social-draft.js";
import {
  adminBotRegistrationStatuses,
  redactConfidentialMemberFields,
} from "../contracts/actions.js";
import type {
  AdminBotActionProposal,
  AdminBotCvScanResult,
  AdminBotApprovalRequest,
  AdminBotExecutionRequest,
  AdminBotLabMemberInput,
  AdminBotMeetingAttendee,
  AdminBotMeetingRecordInput,
  AdminBotMemberNudgeChannel,
  AdminBotMemberNudgeRequest,
  AdminBotPaperRecordInput,
  AdminBotPrivacyTaskRequest,
  AdminBotRegistrationStatus,
  AdminBotRemovePendingRequest,
  AdminBotSettingsInput,
} from "../contracts/actions.js";
import {
  adminBotBadgeNominationStatuses,
  type AdminBotBadgeDefinitionInput,
  type AdminBotBadgeNominationStatus,
} from "../contracts/badges.js";
import { resolveAdminBotControlUiUrl } from "../contracts/control-ui.js";
import type { DeadlineProposalInput } from "../contracts/deadline-proposals.js";
import { groupMeetingSeriesId, resolveGroupMeetingEventId } from "../contracts/group-meeting.js";
import type { GroupMeetingSchedule } from "../contracts/group-meeting.js";
import type { AdminBotPaperSlotInput } from "../contracts/paper-slots.js";
import {
  buildNewsletterDraft,
  draftMemberBlurb,
  runAdminBotCvScan,
  type AdminBotCvScanDeps,
} from "../cv-scan.js";
import { askGuidebook } from "../guidebook/ask.js";
import {
  AdminBotMemoryStore,
  AdminBotService,
  type AdminBotActionExecutor,
  type AdminBotServiceOptions,
  type AdminBotServiceResponse,
  type AdminBotServiceStore,
  type AdminBotSlackChannelNamingEvent,
} from "../kernel/service.js";
import { createAdminBotSqliteService } from "../persistence/sqlite.js";
import { createAdminBotPrivacyBroker, type AdminBotPrivacyBroker } from "../privacy/broker.js";
import {
  createAdminBotSensitiveInfoDocument,
  type AdminBotSensitiveInfoDocument,
} from "../privacy/sensitive-info-doc.js";
import { renderAdminBotWebUi } from "../web/console/index.js";
import { renderMemberMapWebUi } from "../web/member-map/index.js";
import { renderVenuePickerWebUi } from "../web/venue-picker/index.js";
import { createEventDraftRunner } from "../workflows/calendar/event-draft.js";
import { createCalendarEventsReader } from "../workflows/calendar/events.js";
import { resolveLabCalendar } from "../workflows/calendar/lab-calendar.js";
import { toAbsoluteRfc3339 } from "../workflows/calendar/time.js";
import { renderCvDigestDocument } from "../workflows/cv/digest-doc.js";
import { renderDeadlinesWebUi } from "../workflows/deadlines/board.js";
import { DEADLINE_VENUES } from "../workflows/deadlines/generated/dataset.js";
import { createAccountApprovedEmailRunner } from "../workflows/identity/account-approved-email.js";
import {
  AdminBotAuthService,
  type AdminBotAuthResponse,
  type AdminBotMemberPrincipal,
} from "../workflows/identity/auth.js";
import { allowedGatewayScopesForPrivilege } from "../workflows/identity/device-pairing-scopes.js";
import { createPasswordResetEmailRunner } from "../workflows/identity/password-reset-email.js";
import { groupMeetingInviteEmails } from "../workflows/meetings/attendance-nudge.js";
import { toPublicMemberMapSummary } from "../workflows/members/member-map.js";
import { createCalendarInviteRunner } from "../workflows/onboarding/calendar-invite.js";
import { createDcsFormRunner } from "../workflows/onboarding/dcs-form.js";
import { createDriveWorkspaceProvisioner } from "../workflows/onboarding/drive-workspace.js";
import {
  createAdminBotOnboardingSender,
  type AdminBotOnboardingSender,
  type AdminBotOnboardingSendRequest,
} from "../workflows/onboarding/guide-sender.js";
import {
  createAdminBotOpenReviewWorkflow,
  type AdminBotOpenReviewWorkflow,
} from "../workflows/papers/openreview-workflow.js";
import { resolvePaperPdfSource } from "../workflows/papers/paper-pdf-source.js";
import { buildVenueIndex, searchVenue } from "../workflows/papers/venue-index.js";
import { createLocalWorkshopMatcher } from "../workflows/papers/workshop-match-llm.js";
import type {
  AdminBotReimbursementRequest,
  AdminBotReimbursementWorkflow,
} from "../workflows/reimbursements/workflow.js";
import {
  PayloadTooLargeError,
  asString,
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendHtml,
  sendRedirect,
  sendJson,
  sendServiceResult,
} from "./server.http.js";
import { handleLogisticsRoute } from "./server.logistics.js";
import {
  readWorkshopNudgeRun,
  sendWorkshopNudges,
  startWorkshopNudgeRun,
} from "./server.workshop-nudges.js";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:18789",
  "http://127.0.0.1:18789",
];
const SESSION_COOKIE = "adminbot_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 604800;

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

export type AdminBotMockServiceOptions = {
  databasePath?: string;
  auditRetentionDays?: number;
  executor?: AdminBotActionExecutor;
  privacyBroker?: AdminBotPrivacyBroker;
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
  // Injected so the composition root owns the Slack dependency: the invite needs the Slack
  // extension's write client, and a bundled plugin importing another plugin is what the
  // extensions boundary forbids.
  onboardingSender?: AdminBotOnboardingSender;
  inviteToSlackConnect?: import("../workflows/onboarding/guide-sender.js").SlackConnectInviter;
  allowedOrigins?: string[];
  // Fetch/extract/model steps behind the admin CV scan. Injected so tests can drive the scan
  // without a network fetch, a python interpreter, or a running local model.
  cvScanDeps?: AdminBotCvScanDeps;
  // Publishes the rendered CV digest to its Google Doc. Injected so tests never shell out to
  // `gog`, and so a deployment without a configured document simply has no job rather than a
  // button that fails at the CLI.
  cvDigestPublisher?: AdminBotCvDigestPublisher;
  // Reads a venue's accepted papers from OpenReview, and turns text into vectors. Injected so the
  // conference-paper tool is testable without a network and so a deployment without OpenReview
  // credentials simply has no index job rather than a button that fails inside a connector.
  venuePapersReader?: import("../connectors/openreview-notes.js").OpenReviewNotesReader;
  embedder?: import("../connectors/embeddings.js").Embedder;
  embeddingModel?: string;
  workshopMatcher?: import("../workflows/papers/workshop-nudges.js").WorkshopMatcher;
  workshopNudgeNow?: () => Date;
  // Overrides the default `gws` CLI-backed calendar invite runner — used by tests to avoid
  // shelling out to a real `gws` binary.
  calendarInviteRunner?: (email: string) => Promise<void>;
  // Reads upcoming events for the Calendar tab. Injected so tests never shell out to `gog`, and
  // so a deployment without the CLI simply has no picker rather than a broken route.
  calendarEventsReader?: import("../workflows/calendar/events.js").CalendarEventsReader;
  // Drafts an event from a sentence. Defaults to the privacy broker, so a prompt naming a member
  // gets the same placeholder treatment every other reasoning task gets.
  calendarEventDrafter?: import("../workflows/calendar/event-draft.js").EventDraftRunner;
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
  linkedInDraftRunner?: import("../connectors/social-draft.js").LinkedInDraftRunner;
  /** Reads one Drive file as base64, so a draft can use the PDF the paper already names. */
  readDrivePdfBase64?: (fileId: string) => Promise<string>;
  // Overrides the default DCS-form-submission runner outright (tests use this to assert on the
  // call without launching a real browser). If unset, dcsFormScriptPath decides whether one gets
  // built at all.
  dcsFormRunner?: (params: { firstName: string; lastName: string; email: string }) => Promise<void>;
  // Path to scripts/adminbot-dcs-form-submit.ts. Injected from the repo-root composition layer
  // for the same reason openReviewScriptPath is: this factory has no access to the repo root.
  // Absent in unit/mock setups, which leaves DCS form submission silently unwired (no attempt,
  // no audit event) rather than half-working.
  dcsFormScriptPath?: string;
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

type AdminBotPrincipal =
  | { kind: "service" }
  | { kind: "anonymous"; ip?: string }
  | AdminBotMemberPrincipal;

// Routes the anonymous principal may reach, keyed as "METHOD pathname" -- re-checked against this
// list before any handler runs, so a new route cannot become anonymously reachable by being added
// to handleAuthenticatedRoute.
//
// Reimbursement is deliberately usable without an account: the forms carry only the claimant's own
// details, which they are typing in anyway.
//
// GET /member-map is deliberately public too, same spirit as GET /deadlines: the handler itself
// still checks isPrivileged and gives an anonymous (or non-admin) caller a names-stripped, counts-
// only summary -- publishing where people are by name was the thing worth gating, headcounts
// per city were not.
const ANONYMOUS_ROUTES = new Set([
  "POST /reimbursements/converse",
  "POST /reimbursements/generate",
  "GET /member-map",
]);

function isAnonymousRoute(method: string | undefined, pathname: string): boolean {
  return ANONYMOUS_ROUTES.has(`${method} ${pathname}`);
}

// Anonymous callers are unauthenticated by design, so the only abuse control left is volume. These
// caps are per-IP and generous enough that a real claimant filling one packet never notices; they
// exist to stop the open endpoint being used as free inference against the local model.
const ANONYMOUS_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const ANONYMOUS_RATE_LIMIT_MAX_REQUESTS = 60;
const ANONYMOUS_RATE_LIMIT_MAX_TRACKED_IPS = 10_000;

type AnonymousRateLimiter = { check(ip: string | undefined): boolean };

function createAnonymousRateLimiter(): AnonymousRateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(ip) {
      const key = ip ?? "unknown";
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter(
        (at) => now - at < ANONYMOUS_RATE_LIMIT_WINDOW_MS,
      );
      if (recent.length >= ANONYMOUS_RATE_LIMIT_MAX_REQUESTS) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      // Unbounded growth would be its own denial of service, so the map is swept once it is large
      // rather than kept forever for IPs that have gone quiet.
      if (hits.size > ANONYMOUS_RATE_LIMIT_MAX_TRACKED_IPS) {
        for (const [trackedIp, timestamps] of hits) {
          if (timestamps.every((at) => now - at >= ANONYMOUS_RATE_LIMIT_WINDOW_MS)) {
            hits.delete(trackedIp);
          }
        }
      }
      return true;
    },
  };
}

type AdminBotRouteContext = {
  service: AdminBotService;
  // The raw store, for the CV change ledger. Everything else goes through the service; this is
  // append-only bookkeeping with no policy of its own, so it does not earn a service method.
  store: AdminBotServiceStore;
  auth: AdminBotAuthService;
  privacyBroker: AdminBotPrivacyBroker;
  sensitiveInfo: AdminBotSensitiveInfoDocument;
  runEmailAutomation?: () => Promise<unknown>;
  reimbursementWorkflow?: AdminBotReimbursementWorkflow;
  openReviewWorkflow?: AdminBotOpenReviewWorkflow;
  fetchSlackLocations?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string>>;
  cvScanDeps?: AdminBotCvScanDeps;
  cvDigestPublisher?: AdminBotCvDigestPublisher;
  venuePapersReader?: import("../connectors/openreview-notes.js").OpenReviewNotesReader;
  // Always present: the server builds both from the environment, and an absent embedder would
  // make every search path optional-chained for a case that cannot happen.
  embedder: import("../connectors/embeddings.js").Embedder;
  embeddingModel: string;
  workshopMatcher: import("../workflows/papers/workshop-nudges.js").WorkshopMatcher;
  workshopNudgeNow: () => Date;
  fetchSlackTimezones?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string | null>>;
  // Counts each member's messages in the activity window, by reading the channels the lab tracks.
  fetchSlackMessageCounts?: (
    slackUserIds: string[],
    channelIds: string[],
  ) => Promise<ReadonlyMap<string, number>>;
  resolveSlackUserIdsByEmail?: (emails: string[]) => Promise<ReadonlyMap<string, string>>;
  readCalendarEvents?: import("../workflows/calendar/events.js").CalendarEventsReader;
  draftCalendarEvent?: import("../workflows/calendar/event-draft.js").EventDraftRunner;
  // Generates a LinkedIn announcement draft from a paper PDF. Nothing it returns is persisted.
  draftLinkedInPost: import("../connectors/social-draft.js").LinkedInDraftRunner;
  /**
   * Downloads one Drive file and returns it base64-encoded.
   *
   * Injected rather than imported so the route stays testable without a Google session, and so the
   * one place that shells out to gog for this is the host wiring. Absent means the deployment
   * cannot fetch a PDF for itself, and the route says so instead of pretending.
   */
  readDrivePdfBase64?: (fileId: string) => Promise<string>;
  labCalendar: import("../workflows/calendar/lab-calendar.js").AdminBotLabCalendar;
  serviceToken?: string;
  devicePairingApprover?: DevicePairingApprover;
  deviceTokenIssuer?: DeviceTokenIssuer;
  onboardingSender: AdminBotOnboardingSender;
  allowedOrigins: Set<string>;
  refusedOrigins: Set<string>;
  anonymousRateLimiter: AnonymousRateLimiter;
  // Only true when this process is known to sit behind a trusted reverse proxy (Render, Fly,
  // etc.) that sets X-Forwarded-For itself. Otherwise a caller could hand-write that header to
  // spoof the IP rate-limiting and login-location keys off of — see remoteIp().
  trustProxyHeaders: boolean;
};

export function createAdminBotMockService(options: AdminBotMockServiceOptions = {}) {
  let store: AdminBotServiceStore;
  let service: AdminBotService;
  let closeDurable: () => void = () => {};
  if (options.databasePath) {
    const durable = createAdminBotSqliteService({
      databasePath: options.databasePath,
      ...serviceOptions(options),
    });
    store = durable.store;
    service = durable.service;
    closeDurable = durable.close;
  } else {
    store = new AdminBotMemoryStore();
    service = new AdminBotService(store, serviceOptions(options));
  }
  const gatewayToken = trimmedEnv(options.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN);
  // No default: a loopback URL is only reachable by a browser on this host, so guessing one and
  // handing it to a remote member replaced their working gateway URL with a dead one. Left unset,
  // the client keeps the URL it already connects with.
  const gatewayUrl = trimmedEnv(options.gatewayUrl ?? process.env.ADMINBOT_GATEWAY_WS_URL);
  const serviceToken = trimmedEnv(options.serviceToken ?? process.env.ADMINBOT_SERVICE_TOKEN);
  const ipinfoToken = trimmedEnv(options.ipinfoToken ?? process.env.IPINFO_TOKEN);
  // Built here rather than injected from the launcher, like the geolocator above: both are pure
  // functions of the environment, and the composition root has nothing to add to either.
  const venuePapersReader = options.venuePapersReader ?? createOpenReviewNotesReader();
  const embedder = options.embedder ?? createOllamaEmbedder();
  const embeddingModel =
    options.embeddingModel ?? process.env.ADMINBOT_EMBED_MODEL?.trim() ?? "embeddinggemma:latest";
  const allowedOrigins = new Set(
    options.allowedOrigins ??
      parseOrigins(process.env.ADMINBOT_ALLOWED_ORIGINS) ??
      DEFAULT_ALLOWED_ORIGINS,
  );
  const auth = new AdminBotAuthService({
    store,
    // Signup approval mints a roster member through the same governed path as any admin edit so
    // access grants and validation stay identical.
    createMember: (input) => {
      const result = service.upsertLabMember(input);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.payload;
    },
    inviteToLabCalendar: options.calendarInviteRunner ?? createCalendarInviteRunner(),
    sendAccountApprovedEmail:
      options.accountApprovedEmailRunner ?? createAccountApprovedEmailRunner(),
    sendPasswordResetEmail: options.passwordResetEmailRunner ?? createPasswordResetEmailRunner(),
    ...(() => {
      const submitDcsForm =
        options.dcsFormRunner ?? createDcsFormRunner({ scriptPath: options.dcsFormScriptPath });
      return submitDcsForm ? { submitDcsForm } : {};
    })(),
    ...(gatewayToken ? { gatewayToken } : {}),
    ...(gatewayUrl ? { gatewayUrl } : {}),
    // An explicitly injected geolocator wins (tests and the host inject their own);
    // otherwise build the IPinfo Lite one when a token is configured. With neither, the
    // option stays unset and the login path simply skips the stamp.
    ...(options.geolocateIp
      ? { geolocateIp: options.geolocateIp }
      : ipinfoToken
        ? { geolocateIp: createIpinfoGeolocator(ipinfoToken) }
        : {}),
  });
  // The same runner the approval path gets, so an onboarding send and an approval file the DCS
  // request identically. Undefined when no script path is configured, which the sender reports
  // rather than silently skipping.
  const dcsFormRunner =
    options.dcsFormRunner ?? createDcsFormRunner({ scriptPath: options.dcsFormScriptPath });
  const onboardingSender =
    options.onboardingSender ??
    createAdminBotOnboardingSender({
      provisionDriveWorkspace: createDriveWorkspaceProvisioner(),
      ...(dcsFormRunner ? { submitDcsForm: dcsFormRunner } : {}),
      // The number lives in settings, never in the repo (see AGENTS.md: no real phone numbers).
      headProfessorWhatsapp: () => {
        const settings = service.getSettings();
        return settings.ok ? settings.payload.head_professor_whatsapp : undefined;
      },
      ...(options.inviteToSlackConnect
        ? { inviteToSlackConnect: options.inviteToSlackConnect }
        : {}),
    });
  const sensitiveInfo =
    options.sensitiveInfoDocument ??
    createAdminBotSensitiveInfoDocument({
      filePath: options.sensitiveInfoPath,
    });
  const privacyBroker =
    options.privacyBroker ??
    createAdminBotPrivacyBroker(undefined, {
      sensitiveTermsProvider: () => sensitiveInfo.listSensitiveTerms(),
    });
  let activeEmailAutomation: Promise<unknown> | undefined;
  const emailAutomationRunner = options.emailAutomationRunner;
  const runEmailAutomation = emailAutomationRunner
    ? () => {
        activeEmailAutomation ??= emailAutomationRunner().finally(() => {
          activeEmailAutomation = undefined;
        });
        return activeEmailAutomation;
      }
    : undefined;
  const openReviewWorkflow = options.openReviewScriptPath
    ? createAdminBotOpenReviewWorkflow({
        scriptPath: options.openReviewScriptPath,
        ...(options.openReviewPythonCommand
          ? { pythonCommand: options.openReviewPythonCommand }
          : {}),
        service,
        store,
      })
    : undefined;
  const ctx: AdminBotRouteContext = {
    service,
    store,
    auth,
    privacyBroker,
    sensitiveInfo,
    onboardingSender,
    draftLinkedInPost: options.linkedInDraftRunner ?? createLinkedInDraftRunner(),
    ...(options.readDrivePdfBase64 ? { readDrivePdfBase64: options.readDrivePdfBase64 } : {}),
    ...(runEmailAutomation ? { runEmailAutomation } : {}),
    ...(options.reimbursementWorkflow
      ? { reimbursementWorkflow: options.reimbursementWorkflow }
      : {}),
    ...(serviceToken ? { serviceToken } : {}),
    ...(options.devicePairingApprover
      ? { devicePairingApprover: options.devicePairingApprover }
      : {}),
    ...(options.deviceTokenIssuer ? { deviceTokenIssuer: options.deviceTokenIssuer } : {}),
    ...(openReviewWorkflow ? { openReviewWorkflow } : {}),
    ...(options.fetchSlackLocations ? { fetchSlackLocations: options.fetchSlackLocations } : {}),
    ...(options.cvScanDeps ? { cvScanDeps: options.cvScanDeps } : {}),
    ...(options.cvDigestPublisher ? { cvDigestPublisher: options.cvDigestPublisher } : {}),
    ...(venuePapersReader ? { venuePapersReader } : {}),
    embedder,
    embeddingModel,
    workshopMatcher: options.workshopMatcher ?? createLocalWorkshopMatcher(),
    workshopNudgeNow: options.workshopNudgeNow ?? (() => new Date()),
    ...(options.fetchSlackTimezones ? { fetchSlackTimezones: options.fetchSlackTimezones } : {}),
    ...(options.fetchSlackMessageCounts
      ? { fetchSlackMessageCounts: options.fetchSlackMessageCounts }
      : {}),
    ...(options.resolveSlackUserIdsByEmail
      ? { resolveSlackUserIdsByEmail: options.resolveSlackUserIdsByEmail }
      : {}),
    // The reader shells out to `gog`, so it is built unconditionally but only ever runs when the
    // Calendar tab asks. The drafter defaults to the same broker `adminbot_reason` uses.
    readCalendarEvents: options.calendarEventsReader ?? createCalendarEventsReader(),
    labCalendar: resolveLabCalendar(),
    draftCalendarEvent:
      options.calendarEventDrafter ??
      createEventDraftRunner((request) => privacyBroker.handle(request)),
    allowedOrigins,
    refusedOrigins: new Set<string>(),
    anonymousRateLimiter: createAnonymousRateLimiter(),
    trustProxyHeaders:
      options.trustProxyHeaders ?? trimmedEnv(process.env.ADMINBOT_TRUST_PROXY) === "1",
  };
  const slackChannelNamingSweepIntervalMs = options.slackChannelNamingSweepIntervalMs;
  const slackChannelNamingSweepTimer =
    typeof slackChannelNamingSweepIntervalMs === "number" && slackChannelNamingSweepIntervalMs > 0
      ? setInterval(() => {
          void service.runSlackChannelNamingSweep("system:sweep");
        }, slackChannelNamingSweepIntervalMs)
      : undefined;
  slackChannelNamingSweepTimer?.unref();
  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res, ctx);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: { message: error.message } });
        return;
      }
      sendJson(res, 500, {
        error: { message: error instanceof Error ? error.message : "mock service failed" },
      });
    }
  });
  return {
    server,
    service,
    auth,
    // Exposed for the same reason `service` and `auth` are: tests drive this object graph
    // directly to set up state that has no HTTP route, such as an observation dated three days
    // ago. Nothing in production reaches for it.
    store,
    async listen(port = 8765, host = "127.0.0.1") {
      await listen(server, port, host);
      return `http://${host}:${port}`;
    },
    close() {
      if (slackChannelNamingSweepTimer) {
        clearInterval(slackChannelNamingSweepTimer);
      }
      closeDurable();
    },
  };
}

function serviceOptions(options: AdminBotMockServiceOptions): AdminBotServiceOptions {
  return {
    ...(typeof options.auditRetentionDays === "number"
      ? { auditRetentionDays: options.auditRetentionDays }
      : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    ...(options.reviewSlackProfilePhoto
      ? { reviewSlackProfilePhoto: options.reviewSlackProfilePhoto }
      : {}),
    ...(options.polishSlackProfilePhoto
      ? { polishSlackProfilePhoto: options.polishSlackProfilePhoto }
      : {}),
  };
}

async function routeRequest(req: IncomingMessage, res: ServerResponse, ctx: AdminBotRouteContext) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  applyCors(req, res, ctx.allowedOrigins, ctx.refusedOrigins);
  if (req.method === "OPTIONS") {
    // CORS preflight: headers already set by applyCors; body-less 204.
    res.statusCode = 204;
    res.end();
    return;
  }

  // Exempt public surfaces: HTML shells and the auth endpoints themselves.
  //
  // `/` is the address a person types, so it hands them the Control UI rather than the built-in
  // console. The console is a thin operator surface with no sign-in and no member flows (see
  // contracts/control-ui.ts), so landing on it from the bare hostname reads as "this is the
  // product" when it is really the fallback. It keeps its own address at `/adminbot`, which is
  // what makes the redirect safe: when the Control UI deployment is down, the operator surface is
  // still reachable on this origin without touching configuration.
  if (req.method === "GET" && url.pathname === "/") {
    const controlUi = resolveAdminBotControlUiUrl();
    // A Control UI configured to this same origin would redirect to itself forever and leave the
    // service unopenable in a browser. Serving the console is the strictly better failure: the
    // operator sees something, and the misconfiguration is visible rather than fatal.
    if (isForeignOrigin(controlUi, req)) {
      sendRedirect(res, `${controlUi}/`);
      return;
    }
    sendHtml(res, 200, renderAdminBotWebUi());
    return;
  }
  if (req.method === "GET" && url.pathname === "/adminbot") {
    sendHtml(res, 200, renderAdminBotWebUi());
    return;
  }
  if (req.method === "GET" && url.pathname === "/deadlines") {
    sendHtml(
      res,
      200,
      renderDeadlinesWebUi(ctx.service.deadlineReadModel(DEADLINE_VENUES), {
        proposalUrl: `${resolveAdminBotControlUiUrl()}/deadlines`,
      }),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/deadlines/venues.json") {
    sendJson(res, 200, { items: ctx.service.deadlineReadModel(DEADLINE_VENUES) });
    return;
  }
  // Public and login-free by design: the deck asks for the venue guide to be reachable by anyone
  // the guidebook or the chatbot points at it, including collaborators with no AdminBot account.
  // Served here, above resolvePrincipal, for the same reason /deadlines is.
  if (req.method === "GET" && url.pathname === "/venue-picker") {
    sendHtml(res, 200, renderVenuePickerWebUi());
    return;
  }
  if (req.method === "GET" && url.pathname === "/lab_stats/member_map") {
    sendHtml(res, 200, renderMemberMapWebUi());
    return;
  }
  if (url.pathname.startsWith("/auth/")) {
    await handleAuthRoute(req, res, ctx, url);
    return;
  }

  const principal = resolvePrincipal(req, ctx);
  if (!principal) {
    if (!isAnonymousRoute(req.method, url.pathname)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    if (!ctx.anonymousRateLimiter.check(ip)) {
      ctx.service.recordAnonymousReimbursementUse({
        route: url.pathname,
        outcome: "rate_limited",
        ...(ip ? { ip } : {}),
      });
      sendJson(res, 429, {
        error: { message: "too many reimbursement requests; please try again later" },
      });
      return;
    }
    ctx.service.recordAnonymousReimbursementUse({
      route: url.pathname,
      outcome: "accepted",
      ...(ip ? { ip } : {}),
    });
    await handleAuthenticatedRoute(req, res, ctx, url, {
      kind: "anonymous",
      ...(ip ? { ip } : {}),
    });
    return;
  }
  await handleAuthenticatedRoute(req, res, ctx, url, principal);
}

async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/auth/roster") {
    sendJson(res, 200, { members: ctx.auth.listRoster() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/claim") {
    const body = readRecord(await readJson(req));
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    const result = ctx.auth.claim({
      member_id: asString(body.member_id),
      email: asString(body.email),
      password: asString(body.password),
      ...(ip ? { remoteIp: ip } : {}),
    });
    sendAuthResult(res, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/signup") {
    const body = readRecord(await readJson(req));
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    const result = ctx.auth.signup({
      profile: readRecord(body.profile),
      email: asString(body.email),
      password: asString(body.password),
      ...(ip ? { remoteIp: ip } : {}),
    });
    sendAuthResult(res, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = readRecord(await readJson(req));
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    const result = ctx.auth.login({
      email: asString(body.email),
      password: asString(body.password),
      ...(ip ? { remoteIp: ip } : {}),
    });
    if (!result.ok && result.code === "pending_approval") {
      // Distinct body so the client can route the applicant to a "waiting for approval" state.
      sendJson(res, result.status, { error: result.error.message, code: result.code });
      return;
    }
    sendAuthResult(res, result);
    return;
  }
  if (url.pathname === "/auth/registrations" || url.pathname.startsWith("/auth/registrations/")) {
    await handleRegistrationRoute(req, res, ctx, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/auth/session") {
    const principal = resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendJson(res, 200, ctx.auth.sessionView(principal));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/pair-device") {
    await handlePairDeviceRoute(req, res, ctx);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/device-token") {
    await handleDeviceTokenRoute(req, res, ctx);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const principal = resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const token = bearerToken(req) ?? cookieToken(req);
    if (token) {
      ctx.auth.logout(token);
    }
    clearSessionCookie(res);
    sendJson(res, 200, { logged_out: true });
    return;
  }
  // Both reset routes are deliberately unauthenticated: the whole point is that the caller cannot
  // sign in. The auth service rate-limits them and keeps the response identical for known and
  // unknown addresses, so neither leaks roster membership.
  if (req.method === "POST" && url.pathname === "/auth/password-reset") {
    const body = readRecord(await readJson(req));
    const result = ctx.auth.requestPasswordReset({
      email: asString(body.email),
      ...(() => {
        const ip = remoteIp(req, ctx.trustProxyHeaders);
        return ip ? { remoteIp: ip } : {};
      })(),
    });
    sendAuthResult(res, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/password-reset/confirm") {
    const body = readRecord(await readJson(req));
    const result = ctx.auth.resetPassword({
      token: asString(body.token),
      newPassword: asString(body.new_password),
    });
    sendAuthResult(res, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/password") {
    const principal = resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const result = ctx.auth.changePassword(
      principal.member.id,
      asString(body.current_password),
      asString(body.new_password),
    );
    sendAuthResult(res, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/email") {
    const principal = resolvePrincipal(req, ctx);
    if (!principal) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (principal.kind !== "member") {
      // The service principal has no credential to reverify; email change is a member-only action.
      sendJson(res, 400, { error: { message: "member principal required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const result = ctx.auth.changeEmail(
      principal.member.id,
      asString(body.new_email),
      asString(body.current_password),
      remoteIp(req, ctx.trustProxyHeaders),
    );
    sendAuthResult(res, result);
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

// Registration review is admin/service-only, so it resolves a principal even though it lives under
// the otherwise-public /auth/ prefix.
async function handleRegistrationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
): Promise<void> {
  const principal = resolvePrincipal(req, ctx);
  if (!principal) {
    sendJson(res, 401, { error: { message: "authentication required" } });
    return;
  }
  if (!requirePrivileged(res, principal)) {
    return;
  }
  const decidedBy = principalActor(principal);
  if (req.method === "GET" && url.pathname === "/auth/registrations") {
    const raw = url.searchParams.get("status");
    const status = adminBotRegistrationStatuses.includes(raw as AdminBotRegistrationStatus)
      ? (raw as AdminBotRegistrationStatus)
      : "pending";
    sendJson(res, 200, { registrations: ctx.auth.listRegistrations(status) });
    return;
  }
  const approve = /^\/auth\/registrations\/([^/]+)\/approve$/u.exec(url.pathname);
  if (req.method === "POST" && approve?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendAuthResult(res, ctx.auth.approveRegistration(decodeURIComponent(approve[1]), decidedBy));
    return;
  }
  const reject = /^\/auth\/registrations\/([^/]+)\/reject$/u.exec(url.pathname);
  if (req.method === "POST" && reject?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendAuthResult(res, ctx.auth.rejectRegistration(decodeURIComponent(reject[1]), decidedBy));
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

function principalActor(principal: AdminBotPrincipal): string {
  if (principal.kind === "service") {
    return "service";
  }
  return principal.kind === "anonymous" ? "anonymous" : principal.member.id;
}

// Approves a pending gateway device pairing for the signed-in member, with scopes capped by their
// privilege. This is what makes member-side gateway enforcement automatic: the member's own login
// session authorizes their browser's device, and the injected approver binds member-appropriate
// scopes server-side. The shared service principal is denied outright — otherwise any agent tool
// call could pair itself a write-scoped device and re-open the escalation this closes.
async function handlePairDeviceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
): Promise<void> {
  const principal = resolvePrincipal(req, ctx);
  if (!principal || principal.kind !== "member") {
    sendJson(res, 401, { error: { message: "member session required" } });
    return;
  }
  if (!ctx.devicePairingApprover) {
    sendJson(res, 503, { error: { message: "device pairing is not configured" } });
    return;
  }
  const body = readRecord(await readJson(req));
  const requestId = asString(body.requestId);
  if (!requestId) {
    sendJson(res, 400, { error: { message: "requestId is required" } });
    return;
  }
  const allowedScopes = allowedGatewayScopesForPrivilege(principal.member.privilege_level);
  const result = await ctx.devicePairingApprover({ requestId, allowedScopes });
  if (result.ok) {
    sendJson(res, 200, { approved: true, scopes: allowedScopes });
    return;
  }
  if (result.reason === "unknown_request") {
    sendJson(res, 404, { error: { message: "no pending pairing for this request" } });
    return;
  }
  if (result.reason === "scope_exceeds_privilege") {
    sendJson(res, 403, {
      error: {
        message: "this device requested more access than your account allows",
      },
    });
    return;
  }
  sendJson(res, 502, {
    error: { message: result.message ?? "device pairing approval failed" },
  });
}

// Issues the signed-in member's browser a gateway token bound to its own device key, scoped to
// their privilege. Without this the browser can only reach the gateway by holding the shared
// gateway secret, which every member would then possess -- the escalation this whole design
// closes -- and a member with no secret is stuck at a manual "paste a token" prompt instead.
//
// A member can only ever mint a token for a device key they present, capped at their own
// privilege, so claiming someone else's device id buys nothing they could not get with their own.
async function handleDeviceTokenRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
): Promise<void> {
  const principal = resolvePrincipal(req, ctx);
  if (!principal || principal.kind !== "member") {
    sendJson(res, 401, { error: { message: "member session required" } });
    return;
  }
  if (!ctx.deviceTokenIssuer) {
    sendJson(res, 503, { error: { message: "device token issuance is not configured" } });
    return;
  }
  const body = readRecord(await readJson(req));
  const deviceId = asString(body.deviceId);
  const publicKey = asString(body.publicKey);
  if (!deviceId || !publicKey) {
    sendJson(res, 400, { error: { message: "deviceId and publicKey are required" } });
    return;
  }
  const platform = asString(body.platform);
  const deviceFamily = asString(body.deviceFamily);
  const allowedScopes = allowedGatewayScopesForPrivilege(principal.member.privilege_level);
  const result = await ctx.deviceTokenIssuer({
    deviceId,
    publicKey,
    ...(platform ? { platform } : {}),
    ...(deviceFamily ? { deviceFamily } : {}),
    displayName: principal.member.name,
    allowedScopes,
    memberId: principal.member.id,
  });
  if (result.ok) {
    sendJson(res, 200, { token: result.token, scopes: result.scopes, deviceId });
    return;
  }
  // "unsupported" means the gateway has no shared secret to bind the token to, so the browser
  // must keep using whatever credential it already has rather than retry forever.
  sendJson(res, result.reason === "unsupported" ? 501 : 502, {
    error: { message: result.message ?? "device token issuance failed" },
  });
}

// An approval must name a real person, so the shared service principal (which every agent tool
// call authenticates as) cannot supply one.
function approverIdentityFor(
  principal: AdminBotPrincipal,
): { approver_role: string; approver_id: string } | undefined {
  // Only a member principal names a person: the shared service principal is anonymous by
  // construction, and the anonymous reimbursement principal has no account at all.
  if (principal.kind !== "member") {
    return undefined;
  }
  return {
    approver_role: principal.member.privilege_level,
    approver_id: principal.member.id,
  };
}

async function handleAuthenticatedRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
  principal: AdminBotPrincipal,
): Promise<void> {
  // Re-assert the anonymous boundary here rather than trusting the caller: this function is the
  // single entry point for every authenticated route, so a route added later is denied to
  // anonymous callers unless it is explicitly added to ANONYMOUS_ROUTES.
  if (principal.kind === "anonymous" && !isAnonymousRoute(req.method, url.pathname)) {
    sendJson(res, 401, { error: { message: "authentication required" } });
    return;
  }
  const { service, privacyBroker, sensitiveInfo } = ctx;
  if (req.method === "POST" && url.pathname === "/automation/email/run") {
    // Triggers outbound email on behalf of the lab; not a per-member action.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.runEmailAutomation) {
      sendJson(res, 503, { error: { message: "email automation runner is not configured" } });
      return;
    }
    sendJson(res, 200, await ctx.runEmailAutomation());
    return;
  }
  if (req.method === "GET" && url.pathname === "/member-map") {
    // Public in shape (see GET /member-map in ANONYMOUS_ROUTES), but only ever public in a
    // counts-only shape: publishing 100+ people's names and locations is a decision to make
    // deliberately, not a side effect of building the view, so only an admin gets the version
    // with who is where. Everyone else -- anonymous or a signed-in non-admin member alike --
    // gets a headcount per city.
    const result = service.memberMap();
    if (!result.ok) {
      sendServiceResult(res, result);
      return;
    }
    sendJson(
      res,
      200,
      isPrivileged(principal)
        ? { mode: "full", ...result.payload }
        : { mode: "summary", ...toPublicMemberMapSummary(result.payload) },
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/member-map/refresh") {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.fetchSlackLocations) {
      sendJson(res, 503, { error: { message: "slack location lookup is not configured" } });
      return;
    }
    sendServiceResult(
      res,
      await service.refreshMemberMap(ctx.fetchSlackLocations, principalActor(principal)),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/cv/scan") {
    // Reading the roster's CVs exposes career history the roster itself does not carry, so it
    // sits behind the same privileged gate as the member map rather than being open to members.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.cvScanDeps) {
      sendJson(res, 503, { error: { message: "cv scanning is not configured" } });
      return;
    }
    const scan = await scanAndRecordCvs(ctx, service);
    if (!scan.ok) {
      sendServiceResult(res, scan.failure);
      return;
    }
    sendJson(res, 200, scan.result);
    return;
  }
  // Members: which conferences are searchable, and how fresh each index is. Member-level because
  // the whole point of the tool is that a member opens it; nothing here is about a person.
  if (req.method === "GET" && url.pathname === "/venue-papers/sources") {
    if (principal.kind !== "member" && principal.kind !== "service") {
      sendJson(res, 401, { error: { message: "sign in to browse conference papers" } });
      return;
    }
    const settings = service.getSettings();
    const sources = settings.ok ? (settings.payload.venue_sources ?? []) : [];
    const statuses = new Map(
      ctx.store.listVenueIndexStatuses().map((status) => [status.venue_id, status]),
    );
    sendJson(res, 200, {
      // `indexed_at`/`embedding_model` are left undefined for a venue that has never been indexed
      // rather than conditionally spread in: JSON.stringify drops undefined values, so the wire
      // shape is the same and the object is built once instead of twice.
      sources: sources.map((source) => {
        const status = statuses.get(source.id);
        return {
          venue_id: source.id,
          label: source.label,
          paper_count: status?.paper_count ?? 0,
          indexed_at: status?.indexed_at,
          embedding_model: status?.embedding_model,
        };
      }),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/venue-papers/search") {
    if (principal.kind !== "member" && principal.kind !== "service") {
      sendJson(res, 401, { error: { message: "sign in to search conference papers" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const venueId = asString(body.venue_id)?.trim() ?? "";
    const interests = asString(body.interests)?.trim() ?? "";
    if (!venueId) {
      sendJson(res, 400, { error: { message: "venue_id is required" } });
      return;
    }
    if (!interests) {
      sendJson(res, 400, { error: { message: "tell it what you work on first" } });
      return;
    }
    const settings = service.getSettings();
    const source = (settings.ok ? (settings.payload.venue_sources ?? []) : []).find(
      (entry) => entry.id === venueId,
    );
    // Only configured venues are searchable. Without this a member could name any OpenReview id
    // and read whatever happened to be indexed under it.
    if (!source) {
      sendJson(res, 404, { error: { message: "that conference is not on the list" } });
      return;
    }
    const rows = ctx.store.listVenuePapers(venueId);
    if (!rows.length) {
      sendJson(res, 409, {
        error: {
          message: `${source.label} has not been indexed yet — an admin can build it from the Cron tab`,
        },
      });
      return;
    }
    try {
      const ranking = await searchVenue({ rows, interests, embed: ctx.embedder });
      sendJson(res, 200, {
        venue_id: venueId,
        label: source.label,
        searched: rows.length,
        ...ranking,
      });
    } catch (error) {
      sendJson(res, 502, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/workshop-nudges/preview") {
    // Paper titles, author links and exact outgoing text are lab-internal. A service token is
    // deliberately insufficient: only a signed-in administrator may put them in the browser.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    // Reading is free and starts nothing. This used to run the whole match -- thousands of model
    // calls, tens of minutes -- inside the request, so opening the page began a pass nobody could
    // wait for. The answer of the last pass is what the page wants; producing a new one is a
    // separate, deliberate act below.
    sendJson(res, 200, readWorkshopNudgeRun(service));
    return;
  }

  if (req.method === "POST" && url.pathname === "/workshop-nudges/refresh") {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    try {
      sendJson(
        res,
        202,
        startWorkshopNudgeRun({
          service,
          match: ctx.workshopMatcher,
          now: ctx.workshopNudgeNow(),
          ...(principal.kind === "member" ? { startedBy: principal.member.id } : {}),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, message === "no upcoming workshop profiles are available" ? 409 : 502, {
        error: { message },
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/workshop-nudges/send") {
    // Pressing Nudge is the approval. The request carries only a narrowing recipient list; current
    // papers, recommendations and exact messages are recomputed here before any proposal exists.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = readRecord(await readJsonOrEmpty(req));
    const recipientMemberIds = Array.isArray(body.recipient_member_ids)
      ? body.recipient_member_ids
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    if (!recipientMemberIds.length) {
      sendJson(res, 400, { error: { message: "recipient_member_ids must not be empty" } });
      return;
    }
    try {
      sendJson(
        res,
        200,
        await sendWorkshopNudges({
          service,
          match: ctx.workshopMatcher,
          now: ctx.workshopNudgeNow(),
          actor: principalActor(principal),
          recipientMemberIds,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, message === "no upcoming workshop profiles are available" ? 409 : 502, {
        error: { message },
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/venue-papers/index") {
    // Admin-only: a rebuild is minutes of somebody else's API quota and this box's CPU.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.venuePapersReader) {
      sendJson(res, 503, {
        error: {
          message:
            "conference paper indexing is not configured — set OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD",
        },
      });
      return;
    }
    const readVenue = ctx.venuePapersReader;
    const settings = service.getSettings();
    const sources = settings.ok ? (settings.payload.venue_sources ?? []) : [];
    if (!sources.length) {
      sendJson(res, 409, {
        error: { message: "no conferences are configured — add one in Settings first" },
      });
      return;
    }
    const built: unknown[] = [];
    const failed: Array<{ venue_id: string; reason: string }> = [];
    for (const source of sources) {
      try {
        const { papers, result } = await buildVenueIndex(source, {
          readVenue,
          embed: ctx.embedder,
          embeddingModel: ctx.embeddingModel,
          now: () => new Date(),
        });
        // An empty venue is stored as empty rather than skipped: a conference whose decisions were
        // withdrawn should stop returning last year's papers.
        ctx.store.replaceVenueIndex(source.id, papers, result.indexed_at, result.embedding_model);
        built.push(result);
      } catch (error) {
        // One unreachable venue does not abort the rest: they are independent conferences, and a
        // whole-run abort would mean one bad id blocks every other index from refreshing.
        failed.push({
          venue_id: source.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    ctx.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type: "venue_index.rebuilt",
      actor: principalActor(principal),
      details: { built: built.length, failed: failed.length },
    });
    sendJson(res, 200, { built, failed });
    return;
  }

  if (req.method === "POST" && url.pathname === "/cv/publish-digest") {
    // Same privileged gate as the scan it runs: the job reads every member's career history and
    // then writes it somewhere durable, which is strictly more than the scan alone does.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.cvScanDeps) {
      sendJson(res, 503, { error: { message: "cv scanning is not configured" } });
      return;
    }
    if (!ctx.cvDigestPublisher) {
      sendJson(res, 503, {
        error: {
          message:
            "cv digest publishing is not configured — set ADMINBOT_CV_DIGEST_DOC_ID and restart",
        },
      });
      return;
    }
    const publisher = ctx.cvDigestPublisher;
    const scan = await scanAndRecordCvs(ctx, service);
    if (!scan.ok) {
      sendServiceResult(res, scan.failure);
      return;
    }
    // Rendered from the whole ledger, not from the scan that just ran: a scan consumes its own
    // diff, so a quiet week returns nothing and would otherwise blank the document. See
    // workflows/cv/digest-doc.ts.
    const document = renderCvDigestDocument(ctx.store.listCvChangesSince(LEDGER_EPOCH), new Date());
    try {
      await publisher.publish(document.markdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        type: "cv.digest_failed",
        actor: principalActor(principal),
        details: { document_url: publisher.documentUrl, reason: message },
      });
      sendJson(res, 502, { error: { message: `could not write the CV digest doc: ${message}` } });
      return;
    }
    ctx.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type: "cv.digest_published",
      actor: principalActor(principal),
      details: {
        document_url: publisher.documentUrl,
        day_count: document.day_count,
        change_count: document.change_count,
        scanned_at: scan.result.scanned_at,
      },
    });
    sendJson(res, 200, {
      document_url: publisher.documentUrl,
      published_at: scan.result.scanned_at,
      day_count: document.day_count,
      change_count: document.change_count,
      scan: scan.result,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/cv/digest") {
    // Answers "what changed since X" from the ledger rather than from the last scan, which has
    // already consumed its own diff by updating the snapshots.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const since = url.searchParams.get("since")?.trim();
    if (!since || Number.isNaN(Date.parse(since))) {
      sendJson(res, 400, { error: { message: "since must be an ISO timestamp" } });
      return;
    }
    const changes = ctx.store.listCvChangesSince(since);
    sendJson(res, 200, {
      since,
      changes,
      newsletter_draft: buildNewsletterDraft(
        changes.map((change) => ({
          memberName: change.member_name,
          change: { entry: change.entry, recency: change.recency },
        })),
      ),
    });
    return;
  }
  const blurb = /^\/cv\/blurb\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "POST" && blurb?.[1]) {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const member = ctx.store.getLabMember(decodeURIComponent(blurb[1]));
    if (!member) {
      sendJson(res, 404, { error: { message: "member not found" } });
      return;
    }
    const entries = member.cv_snapshot?.entries ?? [];
    if (!entries.length) {
      // Distinct from a model failure: there is nothing wrong, this member's CV has simply never
      // been scanned, and the fix is to scan rather than to retry.
      sendJson(res, 409, {
        error: { message: `${member.name} has no scanned CV yet — run a CV scan first` },
      });
      return;
    }
    try {
      const text = await draftMemberBlurb(
        {
          name: member.name,
          ...(member.role ? { role: member.role } : {}),
          ...(member.research_topics?.length ? { research_topics: member.research_topics } : {}),
        },
        entries,
      );
      sendJson(res, 200, { member_id: member.id, blurb: text });
    } catch (error) {
      sendJson(res, 502, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/members/directory/refresh-slack") {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (
      !ctx.resolveSlackUserIdsByEmail &&
      !ctx.fetchSlackTimezones &&
      !ctx.fetchSlackMessageCounts
    ) {
      sendJson(res, 503, { error: { message: "slack directory sync is not configured" } });
      return;
    }
    sendServiceResult(
      res,
      await service.refreshMemberDirectoryFromSlack(
        {
          ...(ctx.resolveSlackUserIdsByEmail
            ? { resolveSlackUserIdsByEmail: ctx.resolveSlackUserIdsByEmail }
            : {}),
          ...(ctx.fetchSlackTimezones ? { fetchSlackTimezones: ctx.fetchSlackTimezones } : {}),
          ...(ctx.fetchSlackMessageCounts
            ? { fetchSlackMessageCounts: ctx.fetchSlackMessageCounts }
            : {}),
        },
        principalActor(principal),
      ),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/slack/channel-naming/events") {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    const event: AdminBotSlackChannelNamingEvent = {
      event_type: asString(body.event_type) as AdminBotSlackChannelNamingEvent["event_type"],
      channel_id: asString(body.channel_id),
      channel_name: asString(body.channel_name),
      ...(asString(body.owner_user_id) ? { owner_user_id: asString(body.owner_user_id) } : {}),
      ...(asString(body.purpose) ? { purpose: asString(body.purpose) } : {}),
      ...(asString(body.topic) ? { topic: asString(body.topic) } : {}),
    };
    sendServiceResult(
      res,
      await service.processSlackChannelNamingEvent(event, principalActor(principal)),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/slack/channel-naming/sweep/run") {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    const now = asString(body.now);
    sendServiceResult(
      res,
      await service.runSlackChannelNamingSweep(
        principalActor(principal),
        now || new Date().toISOString(),
      ),
    );
    return;
  }
  if (url.pathname.startsWith("/openreview/")) {
    // The whole reviewing-cycle surface is admin-only: it mails conference committees
    // under Zhijing's OpenReview identity and mutates reviewer assignments.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.openReviewWorkflow) {
      sendJson(res, 503, { error: { message: "openreview workflow is not configured" } });
      return;
    }
    const workflow = ctx.openReviewWorkflow;
    if (req.method === "GET" && url.pathname === "/openreview/status") {
      sendServiceResult(res, service.listOpenReviewStatus());
      return;
    }
    if (req.method === "POST" && url.pathname === "/openreview/cycle/run") {
      // Dry run unless the caller explicitly asks to send, so a stray trigger of the
      // route reports what it would have done instead of mailing anyone.
      const body = (await readJson(req)) as { send?: boolean } | undefined;
      sendJson(res, 200, await workflow.runCycle({ dryRun: body?.send !== true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/openreview/load-forms") {
      sendJson(res, 200, { forms: await workflow.loadForms() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/openreview/suggest-reviewers") {
      const venueId = url.searchParams.get("venue");
      if (!venueId) {
        sendJson(res, 400, { error: { message: "venue query parameter is required" } });
        return;
      }
      sendJson(res, 200, { submissions: await workflow.suggestReviewers(venueId) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/openreview/assignments") {
      const body = (await readJson(req)) as {
        venue_id?: string;
        submission?: string;
        reviewer?: string;
        remove?: boolean;
      };
      if (!body?.venue_id || !body?.submission || !body?.reviewer) {
        sendJson(res, 400, {
          error: { message: "venue_id, submission and reviewer are required" },
        });
        return;
      }
      const result = await workflow.applyAssignment({
        venueId: body.venue_id,
        submission: body.submission,
        reviewer: body.reviewer,
        ...(body.remove ? { remove: true } : {}),
      });
      sendJson(res, result.ok === true ? 200 : 502, result);
      return;
    }
  }
  if (req.method === "POST" && url.pathname === "/reimbursements/converse") {
    if (!ctx.reimbursementWorkflow) {
      sendJson(res, 503, { error: { message: "reimbursement workflow is not configured" } });
      return;
    }
    const body = (await readJson(req)) as AdminBotReimbursementRequest;
    sendJson(res, 200, await ctx.reimbursementWorkflow.converse(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/reimbursements/generate") {
    if (!ctx.reimbursementWorkflow) {
      sendJson(res, 503, { error: { message: "reimbursement workflow is not configured" } });
      return;
    }
    const body = (await readJson(req)) as AdminBotReimbursementRequest;
    sendJson(res, 200, await ctx.reimbursementWorkflow.generate(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/deadline-proposals") {
    if (principal.kind !== "member") {
      sendJson(res, 403, { error: { message: "member session required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const idempotencyKey = String(req.headers["idempotency-key"] ?? "").trim();
    sendServiceResult(
      res,
      service.submitDeadlineProposal(
        deadlineProposalInput(body),
        principal.member.id,
        idempotencyKey,
        DEADLINE_VENUES,
      ),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/deadline-proposals") {
    if (principal.kind !== "member") {
      sendJson(res, principal.kind === "anonymous" ? 401 : 403, {
        error: { message: "member session required" },
      });
      return;
    }
    sendServiceResult(
      res,
      service.listDeadlineProposals(
        principal.member.privilege_level === "admin" ? undefined : principal.member.id,
      ),
    );
    return;
  }
  const reviseDeadline = /^\/deadline-proposals\/([^/]+)\/revisions$/u.exec(url.pathname);
  if (req.method === "POST" && reviseDeadline?.[1]) {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.reviseDeadlineProposal(
        decodeURIComponent(reviseDeadline[1]),
        deadlineProposalInput(body),
        principal.member.id,
        DEADLINE_VENUES,
      ),
    );
    return;
  }
  const rejectDeadline = /^\/deadline-proposals\/([^/]+)\/reject$/u.exec(url.pathname);
  if (req.method === "POST" && rejectDeadline?.[1]) {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.rejectDeadlineProposal(
        decodeURIComponent(rejectDeadline[1]),
        principal.member.id,
        asString(body.note),
      ),
    );
    return;
  }
  const publishDeadline = /^\/deadline-proposals\/([^/]+)\/publish$/u.exec(url.pathname);
  if (req.method === "POST" && publishDeadline?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const identity = approverIdentityFor(principal);
    if (!identity) {
      sendJson(res, 403, { error: { message: "a named administrator session is required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      await service.publishDeadlineProposal(
        decodeURIComponent(publishDeadline[1]),
        asString(body.payload_hash),
        { payload_hash: asString(body.payload_hash), ...identity },
      ),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/proposals") {
    const body = (await readJson(req)) as AdminBotActionProposal;
    sendServiceResult(res, service.createProposal(body));
    return;
  }
  // Both calendar routes are admin-member only. They read the lab's calendar and spend model time,
  // which is not something a plain member session or the shared service principal should be able
  // to do — and neither route writes anything: creating an event or inviting anyone still goes
  // through POST /proposals as a typed calendar.* action, approval, and the gog connector.
  if (req.method === "GET" && url.pathname === "/calendar/events") {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    if (!ctx.readCalendarEvents) {
      sendJson(res, 503, { error: { message: "calendar reading is not configured" } });
      return;
    }
    const max = Number(url.searchParams.get("max") ?? "");
    try {
      const calendarId = url.searchParams.get("calendar_id") ?? ctx.labCalendar.id;
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const query = url.searchParams.get("query") ?? "";
      const events = await ctx.readCalendarEvents({
        ...(calendarId ? { calendarId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(query ? { query } : {}),
        ...(Number.isFinite(max) && max > 0 ? { max: Math.min(max, 250) } : {}),
      });
      // The calendar travels with its events so the tab embeds, lists and writes to the same one.
      sendJson(res, 200, { events, calendar: ctx.labCalendar });
    } catch (error) {
      // The CLI is missing, unauthenticated, or its keyring is locked. Say so rather than
      // returning an empty list, which reads as "your calendar is empty".
      sendJson(res, 502, {
        error: {
          message: `could not read the calendar: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
    return;
  }
  // The three writes. Each one creates the typed action, records the signed-in admin as its
  // approver, and executes it in the same call.
  //
  // This is a deliberate exception to "propose, then approve on the Actions tab", made because the
  // tab is admin-only and the person clicking is the person who would have approved it anyway. The
  // exception is in the *number of clicks*, not in the governance: the proposal, the named
  // approver and the execution all still land in the ledger, so "who put this on the calendar" is
  // answerable afterwards exactly as it is for every other action. A non-admin never reaches here
  // — requireMemberPrivileged refuses plain members and the service principal both.
  if (req.method === "POST" && url.pathname === "/calendar/events") {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    const summary = asString(body.summary);
    const timezone = asString(body.timezone) || ctx.labCalendar.timezone;
    // The draft carries a wall-clock time ("2026-09-01T13:00"), which is not RFC3339 and which
    // Google rejects outright as `400 badRequest`. Resolve it against the calendar's zone first.
    const from = toAbsoluteRfc3339(asString(body.start), timezone);
    const to = toAbsoluteRfc3339(asString(body.end), timezone);
    if (!summary || !from || !to) {
      sendJson(res, 400, {
        error: { message: "summary, and a readable start and end time, are required" },
      });
      return;
    }
    const attendees = readStringList(body.attendees);
    await runCalendarAction(res, service, principal, {
      // With attendees the create has to mail them, which is a different action type and a higher
      // tier; without, it is a hold nobody hears about.
      type: attendees.length ? "calendar.send_invite" : "calendar.create_tentative_hold",
      summary: `Create "${summary}"`,
      payload: {
        calendar_id: asString(body.calendar_id) || ctx.labCalendar.id,
        summary,
        from,
        to,
        timezone,
        ...(asString(body.location) ? { location: asString(body.location) } : {}),
        ...(asString(body.description) ? { description: asString(body.description) } : {}),
        ...(attendees.length ? { attendees } : {}),
      },
      rationale: "Created from the Calendar tab by an admin.",
    });
    return;
  }
  const calendarEvent = /^\/calendar\/events\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "POST" && calendarEvent?.[1]) {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const eventId = decodeURIComponent(calendarEvent[1]);
    const body = readRecord(await readJson(req));
    const summary = asString(body.summary);
    const timezone = asString(body.timezone) || ctx.labCalendar.timezone;
    const from = toAbsoluteRfc3339(asString(body.start), timezone);
    const to = toAbsoluteRfc3339(asString(body.end), timezone);
    if (!summary || !from || !to) {
      sendJson(res, 400, {
        error: { message: "summary, and a readable start and end time, are required" },
      });
      return;
    }
    await runCalendarAction(res, service, principal, {
      type: "calendar.reschedule",
      summary: `Update "${summary}"`,
      // No attendees here on purpose: the connector's update path *replaces* the guest list, so an
      // edit that carried one would uninvite everyone the edit did not mention. Inviting is the
      // route below.
      payload: {
        calendar_id: asString(body.calendar_id) || ctx.labCalendar.id,
        event_id: eventId,
        summary,
        from,
        to,
        timezone,
        ...(asString(body.location) ? { location: asString(body.location) } : {}),
        ...(asString(body.description) ? { description: asString(body.description) } : {}),
      },
      rationale: asString(body.rationale) || "Edited from the Calendar tab by an admin.",
    });
    return;
  }
  const calendarInvite = /^\/calendar\/events\/([^/]+)\/invite$/u.exec(url.pathname);
  if (req.method === "POST" && calendarInvite?.[1]) {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const eventId = decodeURIComponent(calendarInvite[1]);
    const body = readRecord(await readJson(req));
    const attendees = readStringList(body.attendees);
    if (!attendees.length) {
      sendJson(res, 400, { error: { message: "attendees are required" } });
      return;
    }
    await runCalendarAction(res, service, principal, {
      type: "calendar.add_attendees",
      summary: `Invite ${attendees.length} to ${asString(body.summary) || eventId}`,
      payload: {
        calendar_id: asString(body.calendar_id) || ctx.labCalendar.id,
        event_id: eventId,
        attendees,
      },
      rationale: asString(body.rationale) || "Invited from the Calendar tab by an admin.",
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/calendar/event-draft") {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    if (!ctx.draftCalendarEvent) {
      sendJson(res, 503, { error: { message: "event drafting is not configured" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const prompt = asString(body.prompt);
    if (!prompt) {
      sendJson(res, 400, { error: { message: "prompt is required" } });
      return;
    }
    try {
      const timezone = asString(body.timezone) || ctx.labCalendar.timezone;
      const now = asString(body.now);
      // An `editing` block turns the same route into "apply this instruction to that event". The
      // caller sends what the event currently says; nothing is read back from Google here, so the
      // model can never be handed an event the operator was not looking at.
      const editingRaw = readRecord(body.editing);
      const editingSummary = asString(editingRaw.summary);
      const editingStart = asString(editingRaw.start);
      const editing =
        editingSummary && editingStart
          ? {
              summary: editingSummary,
              start: editingStart,
              ...(asString(editingRaw.end) ? { end: asString(editingRaw.end) } : {}),
              ...(asString(editingRaw.location) ? { location: asString(editingRaw.location) } : {}),
              ...(asString(editingRaw.description)
                ? { description: asString(editingRaw.description) }
                : {}),
            }
          : undefined;
      const result = await ctx.draftCalendarEvent({
        prompt,
        ...(timezone ? { timezone } : {}),
        ...(now ? { now } : {}),
        ...(editing ? { editing } : {}),
      });
      if (!result.ok) {
        // A model that could not produce a usable event is a 400 naming what was wrong with the
        // draft, so the operator can rewrite the sentence rather than guess.
        sendJson(res, 400, { error: { message: result.error } });
        return;
      }
      sendJson(res, 200, { draft: result.draft });
    } catch (error) {
      sendJson(res, 502, {
        error: {
          message: `the drafting model failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/guidebook/ask") {
    const body = (await readJson(req)) as { question?: unknown; maxResults?: unknown };
    const question = typeof body.question === "string" ? body.question : "";
    if (!question.trim()) {
      sendJson(res, 400, { error: { message: "question is required" } });
      return;
    }
    // Retrieval and synthesis both run on loopback endpoints inside askGuidebook,
    // and only the prose it writes leaves this handler. Guidebook excerpts are
    // deliberately absent from the response so they cannot reach a hosted model
    // through the agent's context.
    try {
      const result = await askGuidebook({
        question,
        ...(typeof body.maxResults === "number" ? { maxResults: body.maxResults } : {}),
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 502, {
        error: {
          message: `the guidebook gate failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/privacy/tasks") {
    const body = (await readJson(req)) as AdminBotPrivacyTaskRequest;
    sendJson(res, 200, await privacyBroker.handle(body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/proposals/pending") {
    // The pending-action queue is a governance surface: plain members must not see what is
    // awaiting approval. Service principal stays allowed so agent tooling can still triage.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    sendServiceResult(res, service.listPending(limit));
    return;
  }
  if (req.method === "GET" && url.pathname === "/badges") {
    if (principal.kind === "anonymous") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendServiceResult(res, service.listBadgeDefinitions());
    return;
  }
  if (req.method === "POST" && url.pathname === "/badges") {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = (await readJson(req)) as AdminBotBadgeDefinitionInput;
    sendServiceResult(res, service.createBadgeDefinition(body, principal.member.id));
    return;
  }
  const updateBadge = /^\/badges\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "PUT" && updateBadge) {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.updateBadgeDefinition(
        decodeURIComponent(updateBadge[1]!),
        body as Partial<AdminBotBadgeDefinitionInput>,
        principal.member.id,
      ),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/badges/assignments") {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.assignBadge(
        asString(body.member_id),
        asString(body.badge_id),
        principal.member.id,
        asString(body.evidence) || undefined,
      ),
    );
    return;
  }
  const removeBadge = /^\/badges\/assignments\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "DELETE" && removeBadge) {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.removeBadge(
        decodeURIComponent(removeBadge[1]!),
        decodeURIComponent(removeBadge[2]!),
        principal.member.id,
      ),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/badges/nominations") {
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const rawStatus = url.searchParams.get("status");
    const status =
      rawStatus && adminBotBadgeNominationStatuses.includes(rawStatus as AdminBotBadgeNominationStatus)
        ? (rawStatus as AdminBotBadgeNominationStatus)
        : undefined;
    const isAdmin = principal.member.privilege_level === "admin";
    sendServiceResult(
      res,
      service.listBadgeNominations({
        ...(!isAdmin
          ? { memberId: principal.member.id }
          : url.searchParams.get("member_id")
            ? { memberId: url.searchParams.get("member_id") ?? undefined }
            : {}),
        ...(status ? { status } : {}),
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/badges/nominations") {
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.submitBadgeNomination(principal.member.id, {
        badge_id: asString(body.badge_id),
        ...(typeof body.evidence === "string" ? { evidence: body.evidence } : {}),
      }),
    );
    return;
  }
  const approveBadgeNomination = /^\/badges\/nominations\/([^/]+)\/approve$/u.exec(url.pathname);
  if (req.method === "POST" && approveBadgeNomination) {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.decideBadgeNomination(
        decodeURIComponent(approveBadgeNomination[1]!),
        "approved",
        principal.member.id,
      ),
    );
    return;
  }
  const rejectBadgeNomination = /^\/badges\/nominations\/([^/]+)\/reject$/u.exec(url.pathname);
  if (req.method === "POST" && rejectBadgeNomination) {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.decideBadgeNomination(
        decodeURIComponent(rejectBadgeNomination[1]!),
        "rejected",
        principal.member.id,
      ),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/lab/members") {
    // The roster is lab-internal but not confidential, with two exceptions. What a member discloses
    // about their health or family is written for one reader, and this response goes to all of
    // them; the service principal drives agent tool calls on behalf of whoever is chatting, so it
    // is not entitled to that either. The schedule fields are the second exception, and a narrower
    // one: they are stripped for member sessions that are neither the member nor an admin, while
    // the service principal keeps them so the importer and the scheduling tools still work.
    const viewer = {
      ...(principal.kind === "member" ? { memberId: principal.member.id } : {}),
      isAdmin: principal.kind === "member" && principal.member.privilege_level === "admin",
      isMemberSession: principal.kind === "member",
    };
    const result = service.listLabMembers();
    sendServiceResult(
      res,
      result.ok
        ? {
            ...result,
            payload: {
              members: result.payload.members.map((member) =>
                redactConfidentialMemberFields(member, viewer),
              ),
            },
          }
        : result,
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/lab/members/duplicates") {
    // Which roster rows look like one person. Privileged: it is a governance read over the whole
    // roster, and it pairs people up by email and Slack id, which the plain roster read redacts
    // for nobody but says nothing about either.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.listDuplicateMembers());
    return;
  }
  if (req.method === "POST" && url.pathname === "/lab/members/merge") {
    // requireMemberPrivileged, not requirePrivileged: a merge retires a person's record, moves
    // their login and cannot be undone from the UI, and the caller names both ids -- so it is
    // exactly the kind of admin-composed write the service principal is kept out of. The same
    // reasoning as /papers/slot-reminder/run.
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.mergeLabMembers({
        survivorId: asString(body.survivor_id),
        duplicateId: asString(body.duplicate_id),
        actorId: principal.member.id,
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/feedback") {
    // Any authenticated principal may leave feedback -- no privilege check, because a rating is
    // the one write in this service that a plain member is *more* entitled to than an admin. It
    // is not on the anonymous allowlist: the widget only renders on tabs behind a login, and an
    // open write endpoint on a publicly tunnelled service is a spam target for no gain. A public
    // surface that needs it later adds one line to ANONYMOUS_ROUTES, and the service already
    // stores anonymous rows (see adminBotFeedbackId).
    //
    // Who said it comes from the session, never from the body: a caller-named member id would let
    // anyone rate on anyone's behalf.
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.recordFeedback({
        featureId: asString(body.feature_id),
        rating: Number(body.rating),
        ...(typeof body.comment === "string" ? { comment: body.comment } : {}),
        ...(typeof body.github_file === "string" ? { githubFile: body.github_file } : {}),
        ...(principal.kind === "member"
          ? { memberId: principal.member.id, memberName: principal.member.name }
          : {}),
      }),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/feedback") {
    // Reading it is privileged: comments are written to the lab, not to the person sitting next to
    // you, and a rating with a name on it is a judgement about somebody's work.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.listFeedback(url.searchParams.get("feature_id") ?? undefined));
    return;
  }
  if (req.method === "GET" && url.pathname === "/settings") {
    // Lab-wide settings (escalation windows, head professor, applicant sheet id) are
    // governance config, not member-facing data.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.getSettings());
    return;
  }
  if (req.method === "PUT" && url.pathname === "/settings") {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as AdminBotSettingsInput;
    sendServiceResult(res, service.updateSettings(body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/sensitive-info") {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendJson(res, 200, await sensitiveInfo.get());
    return;
  }
  if (req.method === "PUT" && url.pathname === "/sensitive-info") {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    sendJson(res, 200, await sensitiveInfo.update(markdown));
    return;
  }
  if (req.method === "POST" && url.pathname === "/onboarding/ack") {
    // Self-service only: the body names a step, never a member, so this can never reach anyone
    // else's checklist. The shared service principal has no checklist of its own and is denied.
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const stepId = asString(body.step_id);
    if (!stepId) {
      sendJson(res, 400, { error: { message: "step_id is required" } });
      return;
    }
    sendServiceResult(res, service.acknowledgeOwnOnboardingStep(principal.member.id, stepId));
    return;
  }
  // Generate a LinkedIn announcement draft. Deliberately NOT a proposal and NOT persisted:
  // the draft is a suggestion a human copies, edits and posts by hand, so storing it would
  // create a stale second copy of something whose only real version ends up on LinkedIn.
  // Nothing here writes -- the PDF is read, the post is returned, both are then forgotten.
  if (req.method === "POST" && url.pathname === "/papers/linkedin-draft") {
    if (principal.kind === "anonymous") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    let pdfBase64 = typeof body.pdf_base64 === "string" ? body.pdf_base64 : "";
    // An upload is no longer required. The author has usually already given the lab this exact
    // file -- `drive_pdf_arxiv` is the Drive copy of the PDF they intend to post, and the card
    // chases them for it -- so asking them to find it again was asking for their own homework.
    // An uploaded file still wins: it is the one the person in front of the dialog chose.
    if (!pdfBase64) {
      const paperId = typeof body.paper_id === "string" ? body.paper_id : "";
      if (!paperId) {
        sendJson(res, 400, {
          error: { message: "attach a PDF, or send paper_id so the Drive copy can be used" },
        });
        return;
      }
      const cycle = service.listPaperSlots(paperId);
      if (!cycle.ok) {
        sendServiceResult(res, cycle);
        return;
      }
      const source = resolvePaperPdfSource(cycle.payload.slots);
      if (source.kind === "none") {
        sendJson(res, 400, { error: { message: source.reason } });
        return;
      }
      if (!ctx.readDrivePdfBase64) {
        sendJson(res, 503, {
          error: {
            message: "this deployment cannot read Drive files; attach the PDF here instead",
          },
        });
        return;
      }
      try {
        pdfBase64 = await ctx.readDrivePdfBase64(source.fileId);
      } catch (error) {
        sendJson(res, 502, {
          error: {
            message: `could not read the Drive copy (${(error as Error).message}); attach the PDF here instead`,
          },
        });
        return;
      }
      if (!pdfBase64) {
        sendJson(res, 502, {
          error: { message: "the Drive copy came back empty; attach the PDF here instead" },
        });
        return;
      }
    }
    const membersResult = service.listLabMembers();
    const members = membersResult.ok ? membersResult.payload.members : [];
    try {
      const draft = await ctx.draftLinkedInPost({
        pdfBase64,
        members,
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(typeof body.venue === "string" ? { venue: body.venue } : {}),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
      });
      sendJson(res, 200, draft);
    } catch (error) {
      // The message names the missing env var or the extraction failure, and it is the only
      // thing the author can act on, so it is surfaced rather than swallowed into a 500.
      sendJson(res, 502, { error: { message: (error as Error).message } });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/profile/location-prompt") {
    // Self only, and deliberately so: "AdminBot thinks you have moved" is a statement about one
    // person's whereabouts inferred from their IP, and it belongs to them before anyone else.
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    sendServiceResult(res, service.memberLocationDrift(principal.member.id));
    return;
  }
  if (req.method === "POST" && url.pathname === "/profile/location-prompt") {
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.answerLocationPrompt(principal.member.id, {
        ...(asString(body.current_city) ? { current_city: asString(body.current_city) } : {}),
        ...(asString(body.timezone) ? { timezone: asString(body.timezone) } : {}),
      }),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/lab/location-drifts") {
    // Who to re-check before scheduling anything. A governance view over other people's
    // whereabouts, so it is admin-only.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.listLocationDrifts());
    return;
  }
  const memberLocations = /^\/lab\/members\/([^/]+)\/locations$/u.exec(url.pathname);
  if (req.method === "GET" && memberLocations?.[1]) {
    const memberId = decodeURIComponent(memberLocations[1]);
    // Your own timeline, or an admin's. Where a colleague has been for the last six months is not
    // roster data — it is a movement history, and it stays with them and the people who schedule.
    const isSelf = principal.kind === "member" && principal.member.id === memberId;
    if (!isSelf && !requirePrivileged(res, principal)) {
      return;
    }
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    sendServiceResult(
      res,
      service.listMemberLocations(memberId, Number.isFinite(limit) ? limit : undefined),
    );
    return;
  }
  if (url.pathname === "/notifications") {
    // Strictly the caller's own. A notification is something the lab said to one person, and the
    // member id comes from the authenticated session rather than from a query parameter -- there is
    // deliberately no way to ask for somebody else's, admin included.
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    if (req.method === "GET") {
      sendServiceResult(res, service.listMemberNotifications(principal.member.id));
      return;
    }
    sendJson(res, 405, { error: { message: "method not allowed" } });
    return;
  }
  if (req.method === "POST" && url.pathname === "/notifications/read") {
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const readBody = readRecord(await readJsonOrEmpty(req));
    const ids = Array.isArray(readBody.notification_ids)
      ? readBody.notification_ids.filter((id): id is string => typeof id === "string")
      : undefined;
    sendServiceResult(
      res,
      service.markMemberNotificationsRead(principal.member.id, ids?.length ? ids : undefined),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/meetings") {
    // Two audiences, one route. A member gets their own attendance and a headcount; the roster is
    // personal data about everyone else and stays with the admins. The service principal reads as
    // a member would -- it drives agent tool calls on behalf of whoever is chatting, so it is not
    // entitled to a roster its caller could not see.
    if (principal.kind === "member" && principal.member.privilege_level === "admin") {
      sendServiceResult(res, service.listMeetings());
      return;
    }
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    sendServiceResult(res, service.listMeetingsForMember(principal.member.id));
    return;
  }
  if (req.method === "POST" && url.pathname === "/meetings") {
    // Filing a meeting by hand: the recovery path for a recording whose notice never arrived, and
    // the way a transcript or an attendance CSV gets attached from the browser.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as AdminBotMeetingRecordInput;
    sendServiceResult(res, service.upsertMeeting({ ...body, source: body.source ?? "manual" }));
    return;
  }
  const meetingAttendance = /^\/meetings\/([^/]+)\/attendance$/u.exec(url.pathname);
  if (req.method === "PUT" && meetingAttendance?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    const attendees = Array.isArray(body.attendees)
      ? (body.attendees as AdminBotMeetingAttendee[])
      : [];
    sendServiceResult(
      res,
      service.setMeetingAttendance(
        decodeURIComponent(meetingAttendance[1]),
        attendees,
        principal.kind === "member" ? principal.member.id : "service",
      ),
    );
    return;
  }
  if (url.pathname === "/meetings/attendance-nudges") {
    // Reading who has stopped coming names people, so both verbs are governance surfaces. The GET
    // is the preview an admin reads before the lab hears anything; the POST is what actually sends,
    // and takes requirePrivileged (which the service principal satisfies) rather than
    // requireMemberPrivileged for the same reason the other cron-driven sweeps do: the message is
    // computed entirely from attendance records, so there is no caller-composed text to protect.
    if (req.method !== "GET" && req.method !== "POST") {
      sendJson(res, 405, { error: { message: "method not allowed" } });
      return;
    }
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const inviteEmails = await readGroupMeetingInvite(ctx, service.groupMeetingSchedule());
    if (req.method === "GET") {
      sendServiceResult(res, service.collectMeetingAttendanceNudges({ inviteEmails }));
      return;
    }
    sendServiceResult(
      res,
      await service.sendMeetingAttendanceNudges(principalActor(principal), { inviteEmails }),
    );
    return;
  }
  const meetingRecord = /^\/meetings\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "DELETE" && meetingRecord?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendServiceResult(
      res,
      service.deleteMeeting(
        decodeURIComponent(meetingRecord[1]),
        principal.kind === "member" ? principal.member.id : "service",
      ),
    );
    return;
  }
  if (url.pathname === "/logistics/requests" || url.pathname.startsWith("/logistics/requests/")) {
    // A request is signed by the member who sent it, so there is nobody to attribute one to when
    // the caller is the service principal driving an agent tool call on somebody's behalf.
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    await handleLogisticsRoute(req, res, url, ctx.service, principal.member);
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/relevant") {
    if (principal.kind !== "member") {
      sendJson(res, 400, { error: { message: "member principal required" } });
      return;
    }
    sendServiceResult(res, service.listPapersRelevantToMember(principal.member.id));
    return;
  }
  const labMember = /^\/lab\/members\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "PUT" && labMember?.[1]) {
    const memberId = decodeURIComponent(labMember[1]);
    const body = readRecord(await readJson(req));
    // Only a genuine admin *member* session (the Control UI's own Bearer) gets the full governance
    // write that can set privilege_level/status/email/access_overrides. The shared service principal
    // drives every agent tool call regardless of which member is chatting, so it must NOT imply
    // admin here; it is limited to the same whitelisted profile fields as a member self-edit (but
    // for any member id, so non-escalation automation can sync those fields). updateOwnProfile
    // rejects governed fields with a clear 4xx and performs no partial write.
    if (principal.kind === "member" && principal.member.privilege_level === "admin") {
      sendServiceResult(
        res,
        service.upsertLabMember(
          { ...(body as AdminBotLabMemberInput), id: memberId },
          // An admin correcting somebody's record is not that member adopting the tool, so this is
          // stamped `admin` and does not count toward their adoption rate. The actor is recorded so
          // "who typed this" has an answer either way.
          { source: "admin", actor: principal.member.id },
        ),
      );
      return;
    }
    if (principal.kind === "service") {
      sendServiceResult(res, service.updateOwnProfile(memberId, body));
      return;
    }
    // Unreachable while this route stays out of ANONYMOUS_ROUTES, but written as an explicit deny
    // so profile writes fail closed rather than depending on a check made elsewhere.
    if (principal.kind === "anonymous") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (principal.member.id !== memberId) {
      sendJson(res, 403, { error: { message: "members can only update their own profile" } });
      return;
    }
    sendServiceResult(res, service.updateOwnProfile(memberId, body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers") {
    sendServiceResult(res, service.listPapers());
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/slot-overview") {
    // Read-only, and the same records GET /papers already returns to any signed-in member -- this
    // just adds what is outstanding on each. The write and the send below are the gated halves.
    sendServiceResult(res, service.listPaperSlotOverview(url.searchParams.get("now") ?? undefined));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/nudge-batches") {
    // The preview. Read-only and computed by the same walk the send uses, so what an admin reads
    // here is what would actually go out rather than a rehearsal of it.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(
      res,
      service.collectPaperNudgeBatches(url.searchParams.get("now") ?? undefined),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/papers/slot-reminder/run") {
    // Messages the whole lab under the presser's authority, so this takes a genuine admin member
    // session and NOT the shared service principal -- unlike the mandatory-fields reminder, which
    // a cron script triggers. There is deliberately no scheduled caller here: nudging is a
    // judgement about timing, and the person making it should be looking at the batches when they
    // do. The message is still composed entirely from state, so pressing the button asks for the
    // standing rule to be applied now rather than composing anything.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    // An empty body is the ordinary case: "send every batch". Only a caller narrowing the send to
    // people picked out of the preview sends anything at all, so requiring a body here would make
    // the plain press the awkward one.
    const body = readRecord(await readJsonOrEmpty(req));
    const recipients = Array.isArray(body.recipient_member_ids)
      ? body.recipient_member_ids.filter((id): id is string => typeof id === "string")
      : undefined;
    sendServiceResult(
      res,
      await service.sendPaperSlotNudges(principalActor(principal), {
        ...(recipients?.length ? { recipientIds: recipients } : {}),
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/meetings/invite-membership/run") {
    // requirePrivileged, like the other cron-triggered sweeps: the route takes no recipient list
    // and no message. It reads the meeting's own attendee list and the roster, and everything it
    // produces is a proposal an admin still has to approve, so there is no caller-supplied content
    // for the member-session gate to protect.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.readCalendarEvents) {
      sendJson(res, 503, { error: { message: "calendar reading is not configured" } });
      return;
    }
    const body = readRecord(await readJsonOrEmpty(req));
    const surface = asString(body.surface) === "lab_calendar" ? "lab_calendar" : "group_meeting";
    const calendarId = asString(body.calendar_id) || ctx.labCalendar.id;
    const seriesId = groupMeetingSeriesId(asString(body.event_id) || resolveGroupMeetingEventId());

    let events: Awaited<ReturnType<NonNullable<typeof ctx.readCalendarEvents>>>;
    try {
      events = await ctx.readCalendarEvents({ calendarId, max: 250 });
    } catch (error) {
      // The plan is computed from this read. A failed read must not become "the meeting has no
      // attendees", which is a proposal to empty it.
      sendJson(res, 502, {
        error: {
          message: `could not read the calendar: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
      return;
    }

    // A recurring meeting comes back as dated occurrences (`<series>_<instant>`); any of them
    // carries the series' attendee list, so the first match is enough.
    const event = events.find((candidate) => groupMeetingSeriesId(candidate.id) === seriesId);
    if (!event) {
      sendJson(res, 404, {
        error: { message: `no event ${seriesId} on calendar ${calendarId} in the read window` },
      });
      return;
    }

    sendServiceResult(
      res,
      service.planInviteMembership({
        surface,
        eventId: seriesId,
        calendarId,
        attendees: event.attendees ?? [],
        actor: principalActor(principal),
      }),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/paperflow-stages") {
    // The preview for the stage sweep, computed by the same walk the send uses. Privileged only:
    // it lists every paper's venue position and who is holding it, which is governance state.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(
      res,
      service.collectPaperflowStageNudges(url.searchParams.get("now") ?? undefined),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/papers/paperflow-stages/run") {
    // requirePrivileged, not requireMemberPrivileged, for the same reason
    // /members/mandatory-fields-reminder/run takes the service principal: the route accepts no
    // message and no recipient list. Both are derived from the author list and the stage registry,
    // so there is no admin-composed content for the member-session gate to protect. This is the
    // route scripts/adminbot-paperflow-nudge-cron.sh authenticates to.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, await service.sendPaperflowStageNudges(principalActor(principal)));
    return;
  }
  const weeklyUpdate = /^\/papers\/([^/]+)\/weekly-updates$/u.exec(url.pathname);
  if (req.method === "POST" && weeklyUpdate?.[1]) {
    // A member writes their own line and nobody else's, so the member id comes from the session
    // rather than the body -- an admin has no exception here, because the whole value of the log
    // is that every line is first-hand. The service principal has no line of its own to write.
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.savePaperWeeklyUpdate({
        paperId: decodeURIComponent(weeklyUpdate[1]),
        memberId: principal.member.id,
        body: asString(body.body),
        ...(typeof body.week_start === "string" ? { weekStart: body.week_start } : {}),
      }),
    );
    return;
  }
  if (req.method === "GET" && weeklyUpdate?.[1]) {
    sendServiceResult(res, service.listPaperWeeklyUpdates(decodeURIComponent(weeklyUpdate[1])));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/weekly-updates/pending") {
    // The preview for the Sunday sweep, computed by the same walk the send uses. Privileged: it
    // lists who has not reported on what, which is governance state.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(
      res,
      service.collectWeeklyUpdateGaps(url.searchParams.get("now") ?? undefined),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/pre-registration/pending") {
    // The preview: who has nothing aimed at the venue, who has some of it done, and whether the
    // meeting window is open. Read-only and computed by the same walk the send uses.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(
      res,
      service.collectPreRegistrationNudges({
        ...(url.searchParams.get("venue")
          ? { venue: url.searchParams.get("venue") as string }
          : {}),
        ...(url.searchParams.get("now") ? { nowIso: url.searchParams.get("now") as string } : {}),
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/papers/pre-registration/run") {
    // requirePrivileged, like the other cron-triggered sweeps: no message and no recipient list
    // comes from the caller. `force` is the one thing a body may say, and it only lifts the
    // twenty-hour window -- it cannot address anybody the walk did not already find.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const body = readRecord(await readJsonOrEmpty(req));
    sendServiceResult(
      res,
      await service.sendPreRegistrationNudges(principalActor(principal), {
        ...(typeof body.venue === "string" ? { venue: body.venue } : {}),
        ...(typeof body.now === "string" ? { nowIso: body.now } : {}),
        ...(body.force === true ? { force: true } : {}),
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/papers/weekly-updates/run") {
    // requirePrivileged rather than requireMemberPrivileged, for the same reason
    // /papers/paperflow-stages/run takes the service principal: the route accepts no message and
    // no recipient list -- both are derived from the author lists and what has been filed -- so
    // there is no admin-composed content for the member-session gate to protect. This is the
    // route scripts/adminbot-weekly-update-cron.sh authenticates to on a Sunday.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(
      res,
      await service.sendWeeklyUpdateNudges(
        principalActor(principal),
        url.searchParams.get("now") ?? undefined,
      ),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/papers/paperflow-evidence") {
    // Written by the hourly email pass when a bcc lands, and by an admin closing a stage by hand.
    // Privileged either way: closing a stage silently stops a chase, which is a governance effect
    // even though it looks like a note.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.recordPaperflowEvidence({
        paperId: typeof body.paper_id === "string" ? body.paper_id : "",
        stage: typeof body.stage === "string" ? body.stage : "",
        actor: principalActor(principal),
        ...(typeof body.message_id === "string" ? { messageId: body.message_id } : {}),
        ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
        ...(typeof body.sender === "string" ? { sender: body.sender } : {}),
        ...(typeof body.confidence === "number" ? { confidence: body.confidence } : {}),
        // An admin closing a stage by hand is not held to the classifier's confidence floor --
        // they are the confirmation the floor exists to demand.
        ...(body.recorded_by === "admin" ? { recordedBy: "admin" as const } : {}),
      }),
    );
    return;
  }
  const paperSlot = /^\/papers\/([^/]+)\/slots\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "PUT" && paperSlot?.[1] && paperSlot[2]) {
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.setPaperSlot({
        paperId: decodeURIComponent(paperSlot[1]),
        slot: decodeURIComponent(paperSlot[2]),
        input: body as AdminBotPaperSlotInput,
        memberId: principal.kind === "member" ? principal.member.id : principalActor(principal),
        privileged: isPrivileged(principal),
      }),
    );
    return;
  }
  const paperSlotWaiver = /^\/papers\/([^/]+)\/slots\/([^/]+)\/waive$/u.exec(url.pathname);
  if (req.method === "POST" && paperSlotWaiver?.[1] && paperSlotWaiver[2]) {
    // A waiver is how a required artifact stops being required, so it takes a genuine admin
    // session rather than the shared service principal: the agent must not be able to excuse a
    // paper from evidence it is supposed to produce.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as { reason?: string };
    sendServiceResult(
      res,
      service.waivePaperSlot({
        paperId: decodeURIComponent(paperSlotWaiver[1]),
        slot: decodeURIComponent(paperSlotWaiver[2]),
        reason: String(body?.reason ?? ""),
        memberId: principalActor(principal),
      }),
    );
    return;
  }
  const paperSlots = /^\/papers\/([^/]+)\/slots$/u.exec(url.pathname);
  if (req.method === "GET" && paperSlots?.[1]) {
    // The viewer decides whether the arXiv password comes back at all -- authors and admins only.
    sendServiceResult(
      res,
      service.listPaperSlots(decodeURIComponent(paperSlots[1]), {
        ...(principal.kind === "member" ? { memberId: principal.member.id } : {}),
        isAdmin: isPrivileged(principal),
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/papers/slots/backfill") {
    // Rewrites evidence across every paper in the lab, so it takes a genuine admin session rather
    // than the shared service principal: unlike the nudge pass, this is a one-off an operator
    // chooses to run, and `dryRun` exists so they can look before they do.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as { dry_run?: boolean; quiet_days?: number };
    sendServiceResult(
      res,
      service.backfillPaperSlots(principalActor(principal), {
        dryRun: body?.dry_run === true,
        ...(typeof body?.quiet_days === "number" ? { quietDays: body.quiet_days } : {}),
      }),
    );
    return;
  }
  const paperDrafts = /^\/papers\/([^/]+)\/social-drafts$/u.exec(url.pathname);
  if (req.method === "POST" && paperDrafts?.[1]) {
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.saveSocialDraft({
        paperId: decodeURIComponent(paperDrafts[1]),
        platform: String(body.platform ?? ""),
        body: String(body.body ?? ""),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        memberId: principal.kind === "member" ? principal.member.id : principalActor(principal),
        privileged: isPrivileged(principal),
      }),
    );
    return;
  }
  const draftCirculate = /^\/papers\/social-drafts\/([^/]+)\/circulate$/u.exec(url.pathname);
  if (req.method === "POST" && draftCirculate?.[1]) {
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendServiceResult(
      res,
      service.circulateSocialDraft({
        draftId: decodeURIComponent(draftCirculate[1]),
        memberId: principal.kind === "member" ? principal.member.id : principalActor(principal),
        privileged: isPrivileged(principal),
      }),
    );
    return;
  }
  const draftConsent = /^\/papers\/social-drafts\/([^/]+)\/consent$/u.exec(url.pathname);
  if (req.method === "POST" && draftConsent?.[1]) {
    // Consent is personal: it takes a member session and records that member's answer, never one
    // supplied in the body. The service principal has nobody to speak for here.
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.recordSocialConsent({
        draftId: decodeURIComponent(draftConsent[1]),
        memberId: principal.member.id,
        decision: String(body.decision ?? ""),
        ...(typeof body.comment === "string" ? { comment: body.comment } : {}),
      }),
    );
    return;
  }
  const paperAttendees = /^\/papers\/([^/]+)\/attendees$/u.exec(url.pathname);
  if (req.method === "PUT" && paperAttendees?.[1]) {
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.setConferenceAttendee({
        paperId: decodeURIComponent(paperAttendees[1]),
        name: String(body.name ?? ""),
        ...(typeof body.member_id === "string" ? { memberId: body.member_id } : {}),
        attending: String(body.attending ?? ""),
        actorId: principal.kind === "member" ? principal.member.id : principalActor(principal),
        privileged: isPrivileged(principal),
      }),
    );
    return;
  }
  const paperReimbursement = /^\/papers\/([^/]+)\/reimbursements\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "PUT" && paperReimbursement?.[1] && paperReimbursement[2]) {
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.setPaperReimbursement({
        paperId: decodeURIComponent(paperReimbursement[1]),
        memberId: decodeURIComponent(paperReimbursement[2]),
        status: String(body.status ?? ""),
        actorId: principal.kind === "member" ? principal.member.id : principalActor(principal),
        privileged: isPrivileged(principal),
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/nudges/snooze") {
    // A member pushes back their own nudges and nobody else's, so the id comes from the session.
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.snoozeNudge({
        domain: String(body.domain ?? ""),
        subjectId: String(body.subject_id ?? ""),
        memberId: principal.member.id,
        until: String(body.until ?? ""),
      }),
    );
    return;
  }
  const paper = /^\/papers\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "PUT" && paper?.[1]) {
    const paperId = decodeURIComponent(paper[1]);
    // Admins and automation write any paper. A plain member gets the narrower self-service path:
    // their own submissions only, and without the governance fields the paper flow owns.
    if (isPrivileged(principal)) {
      const body = (await readJson(req)) as AdminBotPaperRecordInput;
      // Automation principals have no member to name; they fall through as an unattributed write.
      sendServiceResult(
        res,
        service.upsertPaper(
          { ...body, id: paperId },
          principal.kind === "member" ? { source: "admin", actor: principal.member.id } : {},
        ),
      );
      return;
    }
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(res, service.upsertOwnPaper(principal.member.id, { ...body, id: paperId }));
    return;
  }
  if (req.method === "DELETE" && paper?.[1]) {
    const paperId = decodeURIComponent(paper[1]);
    // Same split as the PUT above: an admin removes any paper, a member only one they authored.
    // Without the member branch the only way to undo a mistyped submission was to ask an admin.
    if (isPrivileged(principal)) {
      sendServiceResult(
        res,
        service.deletePaper(
          paperId,
          principal.kind === "member" ? { source: "admin", actor: principal.member.id } : {},
        ),
      );
      return;
    }
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendServiceResult(res, service.deleteOwnPaper(principal.member.id, paperId));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/nudges") {
    sendServiceResult(res, service.listPaperNudges(url.searchParams.get("now") ?? undefined));
    return;
  }
  const onboardingStep = /^\/lab\/members\/([^/]+)\/onboarding\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "POST" && onboardingStep?.[1] && onboardingStep[2]) {
    const memberId = decodeURIComponent(onboardingStep[1]);
    // Members tick off their own checklist; admins can correct anyone's. The service principal
    // is allowed so the agent can mark a step done when it observes the work (e.g. it just sent
    // the calendar invite) -- this is roster bookkeeping, not an outbound action. An anonymous
    // caller never reaches here: this route is not in ANONYMOUS_ROUTES.
    if (principal.kind === "member" && principal.member.id !== memberId) {
      if (!requirePrivileged(res, principal)) {
        return;
      }
    }
    const body = (await readJson(req)) as { complete?: boolean };
    sendServiceResult(
      res,
      service.setOnboardingStep(
        memberId,
        decodeURIComponent(onboardingStep[2]),
        body.complete !== false,
        principalActor(principal),
      ),
    );
    return;
  }
  const onboardingPending = /^\/onboarding\/([^/]+)\/pending$/u.exec(url.pathname);
  if (req.method === "GET" && onboardingPending?.[1]) {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(
      res,
      service.listOnboardingStepPending(decodeURIComponent(onboardingPending[1])),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/onboarding/guide") {
    // Sends real mail to an arbitrary address and provisions a Drive folder and a Slack invite
    // along the way, so it needs a genuine admin member session. The shared service principal is
    // denied outright: it authenticates every agent tool call regardless of who is chatting, so
    // accepting it here would let anyone talking to AdminBot in Slack onboard anyone they like.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as AdminBotOnboardingSendRequest;
    const result = await ctx.onboardingSender(body);
    if (!result.ok) {
      sendJson(res, result.error.status, {
        error: {
          message: result.error.message,
          ...(result.error.missing ? { missing: result.error.missing } : {}),
        },
      });
      return;
    }
    service.recordOnboardingGuideSent({
      actor: principalActor(principal),
      template_id: result.payload.template_id,
      email: body.email,
      sent: result.payload.sent,
    });
    // The DCS request moved here from registration approval, and its audit trail moves with it:
    // the request is filed on someone else's system with no receipt, so the only record that it
    // happened at all is this one.
    if (result.payload.dcs_form) {
      service.recordDcsFormAttempt({
        actor: principalActor(principal),
        template_id: result.payload.template_id,
        email: body.email,
        submitted: result.payload.dcs_form.submitted,
        ...(result.payload.dcs_form.error ? { error: result.payload.dcs_form.error } : {}),
      });
    }
    sendJson(res, 200, result.payload);
    return;
  }
  const onboardingNudge = /^\/onboarding\/([^/]+)\/nudge$/u.exec(url.pathname);
  if (req.method === "POST" && onboardingNudge?.[1]) {
    // Same reasoning as /nudges/send: this fans out real Slack/email messages to a set of
    // members, so it needs a genuine admin session, not the shared service principal.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as {
      channel?: AdminBotMemberNudgeChannel;
      message?: string;
    };
    sendServiceResult(
      res,
      await service.nudgeOnboardingStep(
        {
          step_id: decodeURIComponent(onboardingNudge[1]),
          channel: body.channel ?? "slack",
          ...(body.message ? { message: body.message } : {}),
        },
        principalActor(principal),
      ),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/nudges/send") {
    // Same reasoning as /settings and /sensitive-info: this fans out real Slack/email sends to a
    // chosen set of members, so it must be driven by a genuine admin member session,
    // never the shared service principal every agent tool call authenticates as.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as AdminBotMemberNudgeRequest;
    // `important` is dropped rather than honored. It is the flag that puts the head professor in a
    // group DM five days later, and the reason that escalation can auto-execute is that nothing
    // but a server-computed sweep can raise it -- see escalateStaleNudges. This is the one nudge
    // route whose text and recipients come from a browser, so letting it set the flag would make
    // "AdminBot escalated this" mean "an admin typed something and waited".
    const { important: _ignored, ...request } = body;
    sendServiceResult(res, await service.sendMemberNudge(request, principalActor(principal)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/papers/author-links/backfill") {
    // Rewrites the author list of every paper in the lab, so it takes a genuine admin member
    // session rather than the service principal -- and it simulates unless the body says
    // otherwise, for the same reason the execution path does.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = readRecord(await readJsonOrEmpty(req));
    sendServiceResult(
      res,
      service.backfillPaperAuthorLinks({
        actor: principalActor(principal),
        dryRun: body.dry_run !== false,
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/members/notes/migrate") {
    // Rewrites stored member records, so it takes a genuine admin session rather than the shared
    // service principal: unlike the cron-driven routes, the caller chooses when this happens.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.migrateMemberNotesToFields(principalActor(principal)));
    return;
  }
  if (req.method === "GET" && url.pathname === "/members/mandatory-fields-incomplete") {
    // Read-only roster scan (same shape as /papers/nudges), so no privilege gate: it powers the
    // dashboard's own-profile warning too, which any signed-in member may load.
    sendServiceResult(res, service.listMembersWithIncompleteMandatoryFields());
    return;
  }
  if (req.method === "GET" && url.pathname === "/members/profile-overview") {
    // Everybody's completeness at once is a governance read, unlike the incomplete-fields scan
    // above which answers "is my own profile done" for any signed-in member's dashboard.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.listMemberProfileOverview());
    return;
  }
  if (req.method === "POST" && url.pathname === "/members/mandatory-fields-reminder/run") {
    // Unlike /nudges/send, this takes no message from the caller -- the text is computed entirely
    // from roster state, so requireMemberPrivileged's protection (stop an admin-composed or
    // agent-composed message going out under a borrowed session) doesn't apply. requirePrivileged
    // (which the service principal satisfies) is what scripts/adminbot-mandatory-fields-cron.sh
    // authenticates as; see /openreview/cycle/run for the identical reasoning applied to another
    // cron-triggered auto-send.
    //
    // The body only ever *narrows*: `include` picks which gap to chase and `recipient_member_ids`
    // subtracts from a list the service computes for itself, so neither can address somebody the
    // roster does not already say is owed a reminder.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const reminderBody = readRecord(await readJsonOrEmpty(req));
    const rawInclude = asString(reminderBody.include);
    const include =
      rawInclude === "profile" || rawInclude === "timeline" || rawInclude === "both"
        ? rawInclude
        : undefined;
    const reminderRecipients = Array.isArray(reminderBody.recipient_member_ids)
      ? reminderBody.recipient_member_ids.filter((id): id is string => typeof id === "string")
      : undefined;
    sendServiceResult(
      res,
      await service.sendMandatoryFieldsReminders(principalActor(principal), {
        ...(include ? { include } : {}),
        ...(reminderRecipients?.length ? { recipientIds: reminderRecipients } : {}),
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/members/graduations/run") {
    // Reads finishing months off the roster and the admin list; nothing about who is messaged or
    // what is said comes from the caller. It never changes a status -- it asks an admin to.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, await service.sweepGraduations(principalActor(principal)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/members/thesis-milestones/run") {
    // Reads the members' own timelines and the head-professor setting; nothing about who is
    // messaged or what is said comes from the caller.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, await service.sweepThesisMilestones(principalActor(principal)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/members/city-channels/sync") {
    // Who goes in which channel is computed here from the roster and the four-member threshold, so
    // this takes requirePrivileged like the other cron-triggered sweeps.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, await service.syncCityChannels(principalActor(principal)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/onboarding/chase/run") {
    // Recipients and text are computed entirely from each member's own checklist and its cycle
    // clock, so this takes requirePrivileged like the other cron-triggered sweeps.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, await service.chaseOpenOnboarding(principalActor(principal)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/nudges/escalate/run") {
    // Recipients and message content are fully server-computed from the notification log and the
    // head-professor setting, so this takes requirePrivileged like the other cron-triggered sweeps
    // rather than requireMemberPrivileged: there is no caller-supplied text to protect.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, await service.escalateStaleNudges(principalActor(principal)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/profile-photo/review/run") {
    // Recipients and message content are fully server-computed, same safety model as
    // /members/mandatory-fields-reminder/run.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(
      res,
      await service.runProfilePhotoReviewAndReminders(principalActor(principal)),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/profile-photo/polish") {
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    sendServiceResult(res, await service.polishOwnProfilePhoto(principal.member.id));
    return;
  }
  if (req.method === "POST" && url.pathname === "/profile-photo/apply") {
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const variantId = asString(body.variant_id);
    if (!variantId) {
      sendJson(res, 400, { error: { message: "variant_id is required" } });
      return;
    }
    sendServiceResult(
      res,
      await service.applyOwnPolishedProfilePhoto(principal.member.id, variantId),
    );
    return;
  }
  const remove = /^\/proposals\/([^/]+)\/remove$/u.exec(url.pathname);
  if (req.method === "POST" && remove?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const actionId = decodeURIComponent(remove[1]);
    const body = (await readJson(req)) as AdminBotRemovePendingRequest;
    sendServiceResult(res, service.removePending(actionId, body));
    return;
  }
  const approve = /^\/approvals\/([^/]+)\/approve$/u.exec(url.pathname);
  if (req.method === "POST" && approve?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const actionId = decodeURIComponent(approve[1]);
    const body = (await readJson(req)) as AdminBotApprovalRequest;
    // Role and approver id come from the session, never the body: a client-chosen role would make
    // the policy check self-attested, and a client-chosen id would let one person fill a
    // two-person quorum alone.
    const identity = approverIdentityFor(principal);
    if (!identity) {
      sendJson(res, 403, {
        error: {
          message:
            "approvals require an admin or core member session and cannot be recorded by the service principal",
        },
      });
      return;
    }
    sendServiceResult(res, service.approve(actionId, { ...body, ...identity }));
    return;
  }
  const execute = /^\/actions\/([^/]+)\/execute$/u.exec(url.pathname);
  if (req.method === "POST" && execute?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const actionId = decodeURIComponent(execute[1]);
    const body = (await readJson(req)) as AdminBotExecutionRequest;
    sendServiceResult(res, await service.execute(actionId, body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/audit") {
    // Audit events carry auth activity (incl. failed-login emails); admin/core only.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendJson(res, 200, { events: service.listAuditEvents() });
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

// Sensitive routes: service principal, or admin privilege.
function isPrivileged(principal: AdminBotPrincipal): boolean {
  if (principal.kind === "service") {
    return true;
  }
  if (principal.kind === "anonymous") {
    return false;
  }
  const level = principal.member.privilege_level;
  return level === "admin";
}

function requirePrivileged(res: ServerResponse, principal: AdminBotPrincipal): boolean {
  if (isPrivileged(principal)) {
    return true;
  }
  sendJson(res, 403, { error: { message: "insufficient privileges" } });
  return false;
}

// The oldest timestamp any ledger row can carry, so "list everything" reuses the same
// `detected_at >= ?` query the since-filter uses rather than needing a second statement.
const LEDGER_EPOCH = "1970-01-01T00:00:00.000Z";

type CvScanFailure = Extract<AdminBotServiceResponse<never>, { ok: false }>;

type CvScanOutcome =
  | { ok: true; result: AdminBotCvScanResult }
  | { ok: false; failure: CvScanFailure };

/**
 * Runs a CV scan over the roster, persists each member's new snapshot, and appends what changed to
 * the ledger.
 *
 * Shared by `/cv/scan` and `/cv/publish-digest` because the digest job is "scan, then publish":
 * two copies would let the button and the scan disagree about what a scan even does, and the
 * ordering below (snapshots before ledger) is load-bearing enough that it should exist once.
 */
async function scanAndRecordCvs(
  ctx: AdminBotRouteContext,
  service: AdminBotService,
): Promise<CvScanOutcome> {
  const members = service.listLabMembers();
  if (!members.ok) {
    return { ok: false, failure: members };
  }
  // Read at scan time rather than captured at boot, so changing the window takes effect on the
  // next scan instead of the next restart.
  const cvSettings = service.getSettings();
  const { result, snapshots } = await runAdminBotCvScan(
    members.payload.members,
    // Callers check this before calling; asserted here so the helper has one contract.
    ctx.cvScanDeps as AdminBotCvScanDeps,
    cvSettings.ok ? cvSettings.payload.cv_recency_window_months : undefined,
  );
  // Snapshots are written through upsertLabMember rather than straight to the store so the scan
  // cannot bypass member validation, and so a bad extraction fails one member's save instead of
  // corrupting the roster.
  for (const member of members.payload.members) {
    const snapshot = snapshots.get(member.id);
    if (!snapshot) {
      continue;
    }
    const saved = service.upsertLabMember({ ...member, cv_snapshot: snapshot });
    if (!saved.ok) {
      const failed = result.results.find((entry) => entry.member_id === member.id);
      if (failed) {
        failed.status = "failed";
        failed.reason = `could not save cv snapshot: ${saved.error.message}`;
      }
    }
  }
  // Recorded after the snapshots are saved, so a member whose snapshot failed to store does not
  // leave a change on the ledger the next scan would then never re-detect.
  ctx.store.recordCvChanges(
    result.results
      .filter((entry) => entry.status === "changed" || entry.status === "first_scan")
      .flatMap((entry) =>
        entry.added.map((change) => ({
          member_id: entry.member_id,
          member_name: entry.member_name,
          detected_at: result.scanned_at,
          recency: change.recency,
          entry: change.entry,
        })),
      ),
  );
  return { ok: true, result };
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
}

/**
 * Files a calendar action, records the caller as its approver, and executes it.
 *
 * The approval is recorded against the member id and role of the person who clicked, not against a
 * generic "system" actor — that is what keeps the ledger answerable. Execution is the same path
 * every other action takes, so a missing `gog`, a locked keyring or a Google refusal comes back as
 * the same execution failure it would anywhere else, and the proposal stays in the queue rather
 * than being reported as done.
 */
/**
 * The addresses on the lab's group-meeting invite, or an empty list when the calendar cannot say.
 *
 * Deliberately swallows every failure. The calendar read shells out to gog, which is missing on
 * some boxes, unauthenticated on others and occasionally just slow -- and the attendance nudge has
 * a working audience without it (the roster's own full members). Turning a locked keyring into a
 * 502 would mean nobody is ever reminded to come to the meeting.
 */
async function readGroupMeetingInvite(
  ctx: AdminBotRouteContext,
  schedule: GroupMeetingSchedule,
): Promise<string[]> {
  if (!ctx.readCalendarEvents) {
    return [];
  }
  try {
    // A fortnight forward: long enough to catch the next occurrence of a weekly series even when
    // one week is cancelled, short enough that a recurring event does not expand into hundreds.
    const from = new Date();
    const to = new Date(from.getTime() + 14 * 86_400_000);
    const events = await ctx.readCalendarEvents({
      calendarId: ctx.labCalendar.id,
      from: from.toISOString(),
      to: to.toISOString(),
      max: 50,
    });
    return groupMeetingInviteEmails(events, schedule);
  } catch {
    return [];
  }
}

async function runCalendarAction(
  res: ServerResponse,
  service: AdminBotService,
  principal: Extract<AdminBotPrincipal, { kind: "member" }>,
  action: {
    type: string;
    summary: string;
    payload: Record<string, unknown>;
    rationale: string;
  },
): Promise<void> {
  const created = service.createProposal({
    type: action.type as AdminBotActionProposal["type"],
    summary: action.summary,
    proposed_payload: action.payload,
    rationale: action.rationale,
  });
  if (!created.ok) {
    sendServiceResult(res, created);
    return;
  }
  const approved = service.approve(created.payload.id, {
    payload_hash: created.payload.payload_hash,
    approver_role: "admin",
    approver_id: principal.member.id,
    note: "Admin acted directly from the Calendar tab.",
  });
  if (!approved.ok) {
    sendServiceResult(res, approved);
    return;
  }
  const executed = await service.execute(created.payload.id, { dry_run: false });
  if (!executed.ok) {
    sendServiceResult(res, executed);
    return;
  }
  sendJson(res, 200, {
    action_id: created.payload.id,
    status: executed.payload.status,
    executed_at: executed.payload.executed_at,
  });
}

// Escalation-sensitive governance (global settings, sensitive-info read/write, registration
// approve/reject) must be driven by a real member session. The shared service principal is used by
// every agent tool call regardless of which member is chatting, so treating it as admin here would
// let any signed-in member perform these actions through the agent. Require an admin member
// Bearer session and deny the service principal outright.
function requireMemberPrivileged(res: ServerResponse, principal: AdminBotPrincipal): boolean {
  if (principal.kind === "service") {
    sendJson(res, 403, {
      error: {
        message:
          "this action requires an admin or core member session and cannot be performed by the service principal",
      },
    });
    return false;
  }
  return requirePrivileged(res, principal);
}

function deadlineProposalInput(body: Record<string, unknown>): DeadlineProposalInput {
  return {
    name: asString(body.name),
    parentConference: asString(body.parentConference),
    parentYear: asString(body.parentYear),
    entryType: asString(body.entryType) as DeadlineProposalInput["entryType"],
    deadlineDate: asString(body.deadlineDate),
    deadlineTime: asString(body.deadlineTime),
    timezone: asString(body.timezone),
    homepageUrl: asString(body.homepageUrl),
    cfpUrl: asString(body.cfpUrl),
    openReviewUrl: asString(body.openReviewUrl),
    note: asString(body.note),
  };
}

function resolvePrincipal(
  req: IncomingMessage,
  ctx: AdminBotRouteContext,
): AdminBotPrincipal | undefined {
  const bearer = bearerToken(req);
  if (bearer) {
    // Service-principal check first with a constant-time compare. If the env token is unset the
    // service principal is unavailable and this path fails closed.
    if (ctx.serviceToken && constantTimeEqual(bearer, ctx.serviceToken)) {
      return { kind: "service" };
    }
    const member = ctx.auth.resolveSession(bearer);
    if (member) {
      return member;
    }
  }
  const cookie = cookieToken(req);
  if (cookie) {
    const member = ctx.auth.resolveSession(cookie);
    if (member) {
      return member;
    }
  }
  return undefined;
}

/**
 * Whether `target` is a different origin from the one this request arrived on.
 *
 * Used to keep the `/` redirect from pointing at itself. The comparison is on host and protocol
 * only: behind the tunnel the request arrives as plain HTTP on 127.0.0.1 with the public host in
 * `x-forwarded-host`/`x-forwarded-proto`, so the forwarded pair is what a browser actually typed
 * and the socket is not. An unparseable target counts as foreign — the configured value is then
 * a URL this code cannot reason about, and refusing to redirect would strand the operator on the
 * console with no signal about why.
 */
function isForeignOrigin(target: string, req: IncomingMessage): boolean {
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return true;
  }
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
  const host = forwardedHost ?? req.headers.host;
  if (!host) {
    return true;
  }
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const proto = forwardedProto ?? "http";
  return targetUrl.host !== host || targetUrl.protocol !== `${proto}:`;
}

/** A header can arrive repeated or comma-joined; the first value is the original client's. */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(",")[0]?.trim();
  return first || undefined;
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: Set<string>,
  // Origins already reported, so the warning fires once each rather than once per request. Held by
  // the service rather than the module so two services in one process cannot silence each other.
  refusedOrigins: Set<string>,
): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string") {
    return;
  }
  if (!allowedOrigins.has(origin)) {
    // A refused origin is otherwise completely silent: the service answers normally, the browser
    // discards the response for want of a header, and the page reports only that it could not
    // reach anything. Naming the rejected origin next to the allowed ones turns "it does not work"
    // into a diff — a scheme, a subdomain or a port is usually the whole story. Once per origin,
    // so a misconfigured client cannot flood the log.
    if (!refusedOrigins.has(origin)) {
      refusedOrigins.add(origin);
      console.warn(
        `[adminbot] refused cross-origin request from ${origin}; ADMINBOT_ALLOWED_ORIGINS is ${
          [...allowedOrigins].join(", ") || "(empty)"
        }`,
      );
    }
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function sendAuthResult<T>(res: ServerResponse, result: AdminBotAuthResponse<T>): void {
  if (result.ok) {
    if (result.sessionToken) {
      setSessionCookie(res, result.sessionToken);
    }
    sendJson(res, result.status, result.payload);
    return;
  }
  const body =
    typeof result.retry_after_seconds === "number"
      ? { error: result.error, retry_after_seconds: result.retry_after_seconds }
      : { error: result.error };
  sendJson(res, result.status, body);
}

// No Secure attribute: the AdminBot service is reached over loopback plain HTTP, where a Secure
// cookie would never be sent back. SameSite=Lax + HttpOnly still block third-party/script access.
function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  );
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/u.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function cookieToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string") {
    return undefined;
  }
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) {
      continue;
    }
    if (pair.slice(0, index).trim() === SESSION_COOKIE) {
      return pair.slice(index + 1).trim() || undefined;
    }
  }
  return undefined;
}

// Behind a reverse proxy (Render, Fly, etc.), req.socket.remoteAddress is the proxy's own
// address, not the real caller's — the actual IP only shows up in X-Forwarded-For, which the
// proxy sets and the app must not trust unless it knows every request actually passes through
// that proxy (otherwise a direct caller could hand-write the header to spoof it).
function remoteIp(req: IncomingMessage, trustProxyHeaders: boolean): string | undefined {
  if (trustProxyHeaders) {
    const header = req.headers["x-forwarded-for"];
    const first = (Array.isArray(header) ? header[0] : header)?.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket.remoteAddress ?? undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

function trimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseOrigins(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
