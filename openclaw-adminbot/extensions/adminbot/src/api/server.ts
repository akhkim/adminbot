import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { createArxivProbe } from "../connectors/arxiv.js";
import { createOllamaEmbedder } from "../connectors/embeddings.js";
import { appendGogSheetRows, readGogSheetRows } from "../connectors/gog.js";
import { createIpinfoGeolocator } from "../connectors/ip-geolocation.js";
import {
  createOpenReviewForumProbe,
  createOpenReviewNotesReader,
} from "../connectors/openreview-notes.js";
import { createOpenReviewSubmissionReader } from "../connectors/openreview-submissions.js";
import { createPangramScorer } from "../connectors/pangram.js";
import {
  createPdfReferenceChecker,
  extractPdfFullText,
  requiredDatabasesPausedUntil,
  type PdfReferenceChecker,
} from "../connectors/reference-check.js";
import {
  createGptZeroBibliographyScanner,
  createPublicOpenReviewPdfReader,
} from "../connectors/reference-scan.js";
import { createInterviewChannelProvisioner } from "../connectors/slack-interview.js";
import { createLinkedInDraftRunner } from "../connectors/social-draft.js";
import { adminBotRegistrationStatuses } from "../contracts/actions.js";
import type {
  AdminBotAuditEvent,
  AdminBotRegistrationStatus,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import { resolveAdminBotControlUiUrl } from "../contracts/control-ui.js";
import type { AdminBotDriveProbe } from "../contracts/drive-links.js";
import type { OpenReviewSubmissionReader } from "../contracts/openreview-citation-checks.js";
import type { AdminBotArtifactProbe } from "../contracts/paper-artifact-links.js";
import type { AiTextScorer } from "../contracts/paper-integrity-checks.js";
import type { ReferenceScanDependencies } from "../contracts/reference-scans.js";
import type { AdminBotCvScanDeps } from "../cv-scan.js";
import { createLlmLoadRouter, parseLlmNodes, type LlmLoadRouter } from "../kernel/llm-router.js";
import { ReferenceScans } from "../kernel/reference-scans.js";
import {
  AdminBotMemoryStore,
  AdminBotService,
  type AdminBotActionExecutor,
  type AdminBotExecutorOutcome,
  type AdminBotServiceOptions,
  type AdminBotServiceStore,
} from "../kernel/service.js";
import {
  createMemoryFailedRequestLedger,
  type FailedExternalRequestLedger,
} from "../persistence/failed-requests.js";
import { createMemberDraftStore } from "../persistence/member-drafts.js";
import { AdminBotSqliteStore, createAdminBotSqliteService } from "../persistence/sqlite.js";
import { createAdminBotPrivacyBroker, type AdminBotPrivacyBroker } from "../privacy/broker.js";
import { createLocalChat } from "../privacy/local-chat.js";
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
import { DEADLINE_VENUES } from "../workflows/deadlines/generated/dataset.js";
import { readDeadlineDataset } from "../workflows/deadlines/runtime-dataset.js";
import { createAccountApprovedEmailRunner } from "../workflows/identity/account-approved-email.js";
import { AdminBotAuthService, type AdminBotMemberPrincipal } from "../workflows/identity/auth.js";
import { allowedGatewayScopesForPrivilege } from "../workflows/identity/device-pairing-scopes.js";
import { createPasswordResetEmailRunner } from "../workflows/identity/password-reset-email.js";
import {
  ADMINBOT_LAB_EMAIL_ENV,
  adminBotLabCalendarId,
  type CalendarInviteRunner,
  createCalendarInviteRunner,
} from "../workflows/onboarding/calendar-invite.js";
import { createDcsRosterSheetRecorder } from "../workflows/onboarding/dcs-roster-sheet.js";
import { createDriveWorkspaceProvisioner } from "../workflows/onboarding/drive-workspace.js";
import {
  createAdminBotOnboardingSender,
  createSlackConnectOnboardingInviter,
  type AdminBotOnboardingSender,
  type AdminBotOnboardingSenderOptions,
} from "../workflows/onboarding/guide-sender.js";
import { readInterviewInvitation } from "../workflows/onboarding/interview.js";
import { IclrIntegrityWatch } from "../workflows/papers/iclr-integrity-watch.js";
import {
  createImportColumnMapper,
  type ImportColumnMapper,
} from "../workflows/papers/import-columns.js";
import {
  type PublicationMailingRunner,
  createPublicationMailingRunner,
} from "../workflows/papers/mailing-list-email.js";
import { OpenReviewCitationWatch } from "../workflows/papers/openreview-citation-watch.js";
import { createAdminBotOpenReviewWorkflow } from "../workflows/papers/openreview-workflow.js";
import { createLocalWorkshopMatcher } from "../workflows/papers/workshop-match-llm.js";
import type { AdminBotReimbursementWorkflow } from "../workflows/reimbursements/workflow.js";
import { type CallSheetSource, defaultCallSheet } from "./call-sheet-config.js";
import { memberSheetSource, resolveMemberSheetConfig } from "./member-sheet-config.js";
import { createPdfReferenceCheckHandler } from "./pdf-reference-check.js";
import type {
  AdminBotCvDigestPublisher,
  AdminBotMemberSheetSource,
  AdminBotPrincipal,
  AdminBotRouteContext,
  AnonymousRateLimiter,
  DevicePairingApprover,
  DeviceTokenIssuer,
} from "./routes/context.js";
import {
  approverIdentityFor,
  principalActor,
  requireMemberPrivileged,
  requirePrivileged,
} from "./routes/guards.js";
import { AUTHENTICATED_ROUTES } from "./routes/index.js";
import { memberEnrollmentContext, memberOnboardingDeps } from "./routes/onboarding.js";
import { dispatchRoute } from "./routes/router.js";
import {
  clearSessionCookie,
  requestIsSecure,
  sendAuthResult,
  SESSION_COOKIE,
} from "./routes/session.js";
import {
  PayloadTooLargeError,
  asString,
  readJson,
  readRecord,
  sendHtml,
  sendRedirect,
  sendJson,
} from "./server.http.js";
import {
  enrollNewMember,
  executeMemberEnrollment,
  queueNewMemberGuide,
} from "./server.member-onboarding.js";
import {
  createPublicDeadlineLimiter,
  handlePublicDeadlineProposal,
} from "./server.public-deadline-proposals.js";
export type { AdminBotCvDigestPublisher } from "./routes/context.js";
export type { AdminBotMemberSheetSource } from "./routes/context.js";
export type { DeviceTokenIssuance } from "./routes/context.js";
export type { DeviceTokenIssuer } from "./routes/context.js";
export type { DevicePairingApproval } from "./routes/context.js";
export type { DevicePairingApprover } from "./routes/context.js";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:18789",
  "http://127.0.0.1:18789",
];

/**
 * The lab's own roster, which is the sheet this deployment exists to administer.
 *
 * The defaults, the URL/gid parsing and the gid-to-title resolution live in
 * `member-sheet-config.ts`; this stays a thin seam so `createAdminBotServer` has one call to make.
 */
export function defaultMemberSheet(env: NodeJS.ProcessEnv): AdminBotMemberSheetSource {
  return memberSheetSource(resolveMemberSheetConfig(env));
}

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
  inviteToSlackConnect?: import("../workflows/onboarding/guide-sender.js").SlackConnectInviter;
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
  linkedInDraftRunner?: import("../connectors/social-draft.js").LinkedInDraftRunner;
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
  // The conference-paper surface, which the Control UI opens to visitors along with the rest of
  // General Tools. Both are reads over a published conference programme, ranked against text the
  // caller typed: no lab data, nothing filtered by who is asking, and neither writes. The search
  // does spend an embedding call, which is what the per-IP limiter below is for -- the same reason
  // the reimbursement pair is capped. Indexing a venue stays privileged: it is the expensive half
  // and the only one that writes.
  "GET /venue-papers/sources",
  "GET /venue-papers/categories",
  "POST /venue-papers/search",
  // The Opportunities board, which the Control UI shows to visitors alongside Deadlines. Only
  // approved entries reach an anonymous caller; the handler resolves that from the principal, so
  // being on this list buys the read and nothing else. Every write below needs a member session.
  "GET /opportunities",
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

/**
 * Say once, at startup, that nobody will be granted calendar access.
 *
 * Silence here is what let this go unnoticed for four months: the invite is best-effort by design
 * -- an approval must not fail because Google did -- so an unconfigured deployment approved
 * members, failed the invite, wrote an audit row, and carried on looking healthy. Nothing read
 * those rows until somebody audited them, by which point 155 members had been told in their
 * onboarding checklist that they were already on the calendar.
 *
 * Skipped when a runner is injected: tests and the host supply their own, and it is not this
 * function's business whether that one is configured.
 */
function warnIfLabCalendarUnconfigured(injected: unknown): void {
  if (injected || adminBotLabCalendarId()) {
    return;
  }
  console.warn(
    `[adminbot] ${ADMINBOT_LAB_EMAIL_ENV} is not set: no member will be granted lab calendar ` +
      "access, and every approval will record auth.calendar_invite_failed. Set it, then repair " +
      "the members already approved with POST /lab/members/backfill-calendar-invites.",
  );
}

/** Mints the #friends-and-collaborators Slack Connect invite on its own; see guide-sender.ts. */
type SlackConnectOnboardingInviter = ReturnType<typeof createSlackConnectOnboardingInviter>;

/** What the `calendar.grant_lab_calendar` arm needs, resolved at execute time. */
type LabCalendarGrant = {
  invite: CalendarInviteRunner;
  recordAudit: (event: Pick<AdminBotAuditEvent, "type" | "actor" | "details">) => void;
};

/**
 * The executor arms for `onboarding.send_guide` and `calendar.grant_lab_calendar`.
 *
 * Wraps whatever connector the launcher injected and answers this one type in-process, because the
 * work is not a CLI call: the sender mints a Slack Connect invite, provisions the Drive folder,
 * invites the project channels and files the DCS roster row before the mail goes out. Everything else
 * falls through untouched.
 *
 * `handled: false` when no sender is configured, which is what the service turns into an audited
 * execution failure -- the same answer it gives for any action no connector claimed. Silently
 * reporting success would mark a guide sent that nobody received.
 */
function executorWithOnboardingGuide(
  serviceRef: () => AdminBotService,
  inner: AdminBotActionExecutor | undefined,
  sender: () => AdminBotOnboardingSender | undefined,
  labCalendar: () => LabCalendarGrant | undefined,
  slackConnect: () => SlackConnectOnboardingInviter | undefined,
  enroll: () =>
    | ((proposal: AdminBotStoredProposal) => Promise<AdminBotExecutorOutcome>)
    | undefined,
): AdminBotActionExecutor {
  return {
    async execute(proposal) {
      const service = serviceRef();
      if (proposal.type === "lab_member.enroll") {
        const run = enroll();
        return run ? run(proposal) : { handled: false, reason: "enrollment is not wired" };
      }
      if (proposal.type === "calendar.grant_lab_calendar") {
        return grantLabCalendar(proposal, labCalendar());
      }
      if (proposal.type === "slack.connect_invite") {
        const invite = slackConnect();
        if (!invite) {
          return { handled: false, reason: "no Slack Connect inviter is configured" };
        }
        const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
        const result = await invite(typeof payload.email === "string" ? payload.email : "");
        return result.ok
          ? {
              handled: true,
              delivered: true,
              artifacts: { channel_id: result.channel_id, reused: String(result.reused) },
            }
          : { handled: true, delivered: false, reason: result.reason };
      }
      if (proposal.type !== "onboarding.send_guide") {
        return inner ? inner.execute(proposal) : { handled: false };
      }
      const send = sender();
      if (!send) {
        return { handled: false, reason: "no onboarding sender is configured" };
      }
      const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
      const templateId = typeof payload.template_id === "string" ? payload.template_id : "";
      const name = typeof payload.name === "string" ? payload.name : "";
      const email = typeof payload.email === "string" ? payload.email : "";
      if (!templateId || !email) {
        return { handled: false, reason: "template_id and email are required" };
      }
      const result = await send({
        template_id: templateId,
        name,
        email,
        ...(payload.interview ? { interview: readInterviewInvitation(payload.interview) } : {}),
        ...(Array.isArray(payload.cc)
          ? { cc: payload.cc.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(typeof payload.reply_to === "string" ? { reply_to: payload.reply_to } : {}),
        ...(typeof payload.body_override === "string"
          ? { body_override: payload.body_override }
          : {}),
        ...(typeof payload.subject_override === "string"
          ? { subject_override: payload.subject_override }
          : {}),
        ...(payload.values && typeof payload.values === "object"
          ? { values: payload.values as Record<string, string | undefined> }
          : {}),
        ...(typeof payload.add_dcs_roster_row === "boolean"
          ? { add_dcs_roster_row: payload.add_dcs_roster_row }
          : {}),
        // The project channels an admin picked on the Members tab. Dropping them here is how
        // every approved guide used to go out with no #proj-xxx invite at all.
        ...(Array.isArray(payload.slack_project_channels)
          ? {
              slack_project_channels: payload.slack_project_channels.filter(
                (channel): channel is string => typeof channel === "string",
              ),
            }
          : {}),
      });
      if (!result.ok) {
        // Refused rather than thrown: an unfilled placeholder or a missing value is a fixable
        // state, and the reason is what an admin needs to see on the failed approval.
        return { handled: true, delivered: false, reason: result.error.message };
      }
      if (payload.interview && result.payload.sent) {
        const existing = service.listLabMembers();
        if (
          existing.ok &&
          !existing.payload.members.some(
            (member) => member.email?.toLowerCase() === email.toLowerCase(),
          )
        ) {
          const saved = service.upsertLabMember({
            id: `interview-${randomUUID()}`,
            name,
            email,
            member_type: "interviewee",
            collaborator_subgroup: "interviewee",
            privilege_level: "external_collaborator",
          });
          if (!saved.ok) {
            return {
              handled: true,
              delivered: true,
              artifacts: {
                template_id: result.payload.template_id,
                subject: result.payload.subject,
                warning: `Invitation sent; candidate record needs attention: ${saved.error.message}`,
              },
            };
          }
        }
      }
      return {
        handled: true,
        delivered: true,
        artifacts: { template_id: result.payload.template_id, subject: result.payload.subject },
      };
    },
  };
}

/**
 * Read access to the lab calendar, as an approved action.
 *
 * Audited as `auth.calendar_invite_sent` / `_failed`, the rows the calendar backfill keys on, so a
 * member granted here is not granted again by the backfill and a failure is visible to it.
 */
async function grantLabCalendar(
  proposal: AdminBotStoredProposal,
  grant: LabCalendarGrant | undefined,
): Promise<AdminBotExecutorOutcome> {
  if (!grant) {
    return { handled: false, reason: "no lab calendar invite runner is configured" };
  }
  const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const memberId = typeof payload.member_id === "string" ? payload.member_id : undefined;
  if (!email) {
    return { handled: false, reason: "email is required" };
  }
  const actor = proposal.approvals.at(-1)?.approver_id ?? "adminbot";
  try {
    await grant.invite(email);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    grant.recordAudit({
      type: "auth.calendar_invite_failed",
      actor,
      details: { ...(memberId ? { member_id: memberId } : {}), email, error: message },
    });
    return { handled: true, delivered: false, reason: message };
  }
  grant.recordAudit({
    type: "auth.calendar_invite_sent",
    actor,
    details: { ...(memberId ? { member_id: memberId } : {}), email },
  });
  return { handled: true, delivered: true, artifacts: { email } };
}

export function createAdminBotMockService(options: AdminBotMockServiceOptions = {}) {
  warnIfLabCalendarUnconfigured(options.calendarInviteRunner);
  let store: AdminBotServiceStore;
  let service: AdminBotService;
  let closeDurable: () => void = () => {};
  // Late-bound on purpose. The onboarding sender is built further down because it reads settings
  // off `service`, and the executor has to be handed to `service` before that. A holder resolved
  // at execute time is what lets one arm of the executor reach forward to it without either
  // construction having to move.
  let referenceScans: ReferenceScans;
  let onboardingSenderRef: AdminBotOnboardingSender | undefined;
  // The two arms onboarding added, bound further down for the same reason as the sender.
  const onboardingArms: {
    labCalendar?: LabCalendarGrant;
    slackConnect?: SlackConnectOnboardingInviter;
    enroll?: (proposal: AdminBotStoredProposal) => Promise<AdminBotExecutorOutcome>;
  } = {};
  const withOnboarding = (executor: AdminBotActionExecutor | undefined) =>
    executorWithOnboardingGuide(
      () => service,
      executor,
      () => onboardingSenderRef,
      () => onboardingArms.labCalendar,
      () => onboardingArms.slackConnect,
      () => onboardingArms.enroll,
    );
  const baseOptions = serviceOptions(options);
  const wiredOptions: AdminBotServiceOptions = {
    ...baseOptions,
    // The arm is installed whether or not a connector was injected: `onboarding.send_guide` is
    // executed in-process by the sender, not by the CLI connector, so a deployment with no
    // executor at all still executes this one.
    executor: {
      execute: (proposal) =>
        referenceScans.executor(withOnboarding(baseOptions.executor)).execute(proposal),
    },
  };
  if (options.databasePath) {
    const durable = createAdminBotSqliteService({
      databasePath: options.databasePath,
      ...wiredOptions,
    });
    store = durable.store;
    service = durable.service;
    closeDurable = durable.close;
  } else {
    store = new AdminBotMemoryStore();
    service = new AdminBotService(store, wiredOptions);
  }
  const memberDrafts =
    store instanceof AdminBotSqliteStore ? store.memberDraftStore() : createMemberDraftStore();
  const failedRequestLedger =
    options.failedRequestLedger ??
    (store instanceof AdminBotSqliteStore
      ? store.failedRequestLedger()
      : createMemoryFailedRequestLedger());
  const llmRouter =
    options.llmRouter ??
    createLlmLoadRouter({
      maxLocal: envInteger("ADMINBOT_LLM_MAX_LOCAL", 8),
      maxPublic: envInteger("ADMINBOT_LLM_MAX_PUBLIC", 100),
      nodes: parseLlmNodes(process.env.ADMINBOT_LLM_NODES),
    });
  const referenceDependencies = options.referenceScanDependencies ?? {
    readPdf: createPublicOpenReviewPdfReader(),
    scanPdf: createGptZeroBibliographyScanner(),
  };
  referenceScans = new ReferenceScans(store, service, referenceDependencies);
  const checkUploadedPdf = createPdfReferenceCheckHandler(
    options.pdfReferenceChecker,
    referenceDependencies.scanPdf,
    ({ actor, ...details }) =>
      store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        type: "reference_check.pdf_checked",
        actor,
        details,
      }),
  );
  const openReviewCitationWatch = createOpenReviewCitationWatch(options, store, service);
  const iclrIntegrityWatch = createIclrIntegrityWatch(options, store, service);
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
  const calendarInviteRunner = options.calendarInviteRunner ?? createCalendarInviteRunner();
  onboardingArms.labCalendar = {
    invite: calendarInviteRunner,
    recordAudit: (event) =>
      store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        ...event,
      }),
  };
  const auth = new AdminBotAuthService({
    store,
    // Prepare the governed profile without writing; approval commits the member, credential, and
    // decision together before the profile hooks run.
    prepareMember: (input) => {
      const result = service.prepareLabMember(input);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.payload;
    },
    afterMemberCreated: (member) => service.afterMemberCreated(member),
    // Warned about at startup rather than left to fail per approval. See adminbotLabCalendarWarning
    // below: the runner is still installed when unconfigured, because a failure that is audited is
    // better than a side effect that is silently skipped.
    inviteToLabCalendar: calendarInviteRunner,
    sendAccountApprovedEmail:
      options.accountApprovedEmailRunner ?? createAccountApprovedEmailRunner(),
    sendPasswordResetEmail: options.passwordResetEmailRunner ?? createPasswordResetEmailRunner(),
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
  // The roster the Membership grid reads. Built from configuration rather than assumed: a
  // deployment that has not named a spreadsheet has no grid at all, which is a clearer answer
  // than a tab that fails at the CLI when somebody opens it.
  const memberSheet = options.memberSheet ?? defaultMemberSheet(process.env);
  // The call queue's own tab in the same workbook. Separate from `memberSheet` because a
  // deployment can point the two at different files, and because the roster's tab title is not
  // this one's.
  const callSheet = options.callSheet ?? defaultCallSheet(process.env);
  // Whether a submitted meeting request proposes its own row. On unless a deployment turns it off,
  // because a queue nobody pushes is the state this replaced -- but it is a switch rather than a
  // constant: it checks a link over the network and reads the workbook on somebody's form submit,
  // and a deployment (or a route test) has to be able to say no to that.
  const autoQueueMeetingRequests =
    options.autoQueueMeetingRequests ?? process.env.ADMINBOT_CALL_SHEET_AUTO_QUEUE !== "0";
  // Files a new full member's row on the sheet the department's sysadmin acts on, and hands back
  // the credentials it wrote so the sender can mail them. Undefined when no spreadsheet is
  // configured, which the sender reports rather than silently skipping.
  //
  // The roster lookup is wired here rather than inside the workflow for the same reason
  // portalLoginEmail is: the extension owns no store, and the row needs the member's id, career
  // stage, UofT affiliation and granted compute access, none of which the send request carries.
  const dcsRosterRecorder =
    options.dcsRosterRecorder ??
    createDcsRosterSheetRecorder({
      spreadsheetId: options.dcsRosterSheetId ?? process.env.ADMINBOT_DCS_ROSTER_SHEET_ID ?? "",
      readRows: (spreadsheetId) => readGogSheetRows(spreadsheetId),
      appendRows: (spreadsheetId, rows) => appendGogSheetRows(spreadsheetId, rows),
      lookupMember: (email) => {
        const wanted = email.trim().toLowerCase();
        const roster = service.listLabMembers();
        if (!wanted || !roster.ok) {
          return undefined;
        }
        return roster.payload.members.find((entry) =>
          [entry.email, entry.correspondence_email, entry.calendar_email]
            .filter((address): address is string => Boolean(address))
            .some((address) => address.trim().toLowerCase() === wanted),
        );
      },
      // Usernames the roster knows about but the sheet may not carry yet: everyone minted before
      // this sheet existed. Without them the first few rows would propose names already in use.
      rosterUsernames: () => {
        const roster = service.listLabMembers();
        return roster.ok
          ? roster.payload.members
              .map((entry) => entry.dcs_username?.trim())
              .filter((entry): entry is string => Boolean(entry))
          : [];
      },
    });
  const onboardingSender =
    options.onboardingSender ??
    createAdminBotOnboardingSender({
      provisionInterviewChannel: createInterviewChannelProvisioner(),
      provisionDriveWorkspace: createDriveWorkspaceProvisioner(),
      ...(dcsRosterRecorder ? { addDcsRosterRow: dcsRosterRecorder } : {}),
      // The number lives in settings, never in the repo (see AGENTS.md: no real phone numbers).
      headProfessorWhatsapp: () => {
        const settings = service.getSettings();
        return settings.ok ? settings.payload.head_professor_whatsapp : undefined;
      },
      ...(options.inviteToSlackConnect
        ? { inviteToSlackConnect: options.inviteToSlackConnect }
        : {}),
      // Which address the reader's portal account is under. The guide goes to the address they
      // read; the account is under the governed one on their roster row, and for anyone with a CS
      // address those are different. Matched on every address the roster holds for them, because
      // the guide is addressed to whichever one the composer picked.
      portalLoginEmail: (recipientEmail: string) => {
        const wanted = recipientEmail.trim().toLowerCase();
        if (!wanted) {
          return undefined;
        }
        const roster = service.listLabMembers();
        if (!roster.ok) {
          return undefined;
        }
        const member = roster.payload.members.find((entry) =>
          [entry.email, entry.correspondence_email, entry.calendar_email]
            .filter((address): address is string => Boolean(address))
            .some((address) => address.trim().toLowerCase() === wanted),
        );
        return member?.email?.trim() || undefined;
      },
      // Remembers each minted invite so a re-send hands out the same link rather than a second
      // invitation. The service owns the store, so the cache is wired here rather than reaching
      // into persistence from the sender.
      slackConnectInviteCache: {
        get: (email, channelId) => service.getSlackConnectInvite(email, channelId),
        save: (invite) => service.saveSlackConnectInvite(invite),
      },
    });
  // Close the late binding opened above: from here, an approved `onboarding.send_guide` executes
  // through exactly the sender the Onboarding tab uses.
  onboardingSenderRef = onboardingSender;
  onboardingArms.slackConnect = createSlackConnectOnboardingInviter({
    ...(options.inviteToSlackConnect ? { inviteToSlackConnect: options.inviteToSlackConnect } : {}),
    slackConnectInviteCache: {
      get: (email, channelId) => service.getSlackConnectInvite(email, channelId),
      save: (invite) => service.saveSlackConnectInvite(invite),
    },
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
      llmRouter,
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
    reimbursementSigningKey: randomBytes(32),
    service,
    store,
    memberDrafts,
    auth,
    privacyBroker,
    localChat: options.localChat ?? createLocalChat(),
    sensitiveInfo,
    referenceScans,
    checkUploadedPdf,
    ...(openReviewCitationWatch ? { openReviewCitationWatch } : {}),
    ...(iclrIntegrityWatch ? { iclrIntegrityWatch } : {}),
    onboardingSender,
    draftLinkedInPost: options.linkedInDraftRunner ?? createLinkedInDraftRunner(),
    ...(options.readDrivePdfBase64 ? { readDrivePdfBase64: options.readDrivePdfBase64 } : {}),
    ...(memberSheet ? { memberSheet } : {}),
    ...(callSheet ? { callSheet } : {}),
    autoQueueMeetingRequests,
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
    publicationMailingRunner: options.publicationMailingRunner ?? createPublicationMailingRunner(),
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
    ...(options.fetchSlackChannelNames
      ? { fetchSlackChannelNames: options.fetchSlackChannelNames }
      : {}),
    // The reader shells out to `gog`, so it is built unconditionally but only ever runs when the
    // Calendar tab asks. The drafter defaults to the same broker `adminbot_reason` uses.
    readCalendarEvents: options.calendarEventsReader ?? createCalendarEventsReader(),
    labCalendar: resolveLabCalendar(),
    inviteToLabCalendar: calendarInviteRunner,
    draftCalendarEvent:
      options.calendarEventDrafter ??
      createEventDraftRunner((request) => privacyBroker.handle(request)),
    // Loopback-only, like every model call here. Built unconditionally and only ever reached when
    // an import leaves a column the local pass could not place.
    importColumnMapper:
      options.importColumnMapper ??
      createImportColumnMapper({ fetchImpl: (input, init) => fetch(input, init) }),
    allowedOrigins,
    refusedOrigins: new Set<string>(),
    anonymousRateLimiter: createAnonymousRateLimiter(),
    publicDeadlineLimiter: createPublicDeadlineLimiter(),
    trustProxyHeaders:
      options.trustProxyHeaders ?? trimmedEnv(process.env.ADMINBOT_TRUST_PROXY) === "1",
    llmRouter,
    failedRequestLedger,
  };
  // Needs the route context -- the member sheet, the Monday meeting reader -- so it is bound last.
  onboardingArms.enroll = (proposal) =>
    executeMemberEnrollment(
      {
        ...memberEnrollmentContext(ctx),
        getMember: (memberId) => store.getLabMember(memberId),
        alreadyEnrolled: (memberId) =>
          store
            .listAuditEvents()
            .some(
              (event) =>
                event.type === "lab_member.member_type_applied" &&
                (event.details as { member_id?: unknown } | undefined)?.member_id === memberId,
            ),
      },
      proposal,
    );
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
    deadlineDataset: () => readDeadlineDataset(),
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
    ...(options.driveProbe ? { driveProbe: options.driveProbe } : {}),
    // Defaulted here rather than injected from the launcher, like `venuePapersReader` above:
    // both are credential-free reads of a public API, so the composition root has nothing to add
    // and a deployment gets them by existing. The Drive probe is the one that needs an account,
    // which is why it is the one that stays injected.
    arxivProbe: options.arxivProbe ?? createArxivProbe(),
    openReviewProbe: options.openReviewProbe ?? createOpenReviewForumProbe(),
  };
}

async function routeRequest(req: IncomingMessage, res: ServerResponse, ctx: AdminBotRouteContext) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!applyCors(req, res, ctx.allowedOrigins, ctx.refusedOrigins)) {
    sendJson(res, 403, { error: { message: "origin is not allowed" } });
    return;
  }
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

  if (req.method === "POST" && url.pathname === "/public/deadline-proposals") {
    await handlePublicDeadlineProposal(
      req,
      res,
      ctx.service,
      ctx.publicDeadlineLimiter,
      remoteIp(req, ctx.trustProxyHeaders),
      DEADLINE_VENUES,
    );
    return;
  }

  const principal = await resolvePrincipal(req, ctx);
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
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length > 80) {
      sendJson(res, 400, { error: { message: "roster search is too long" } });
      return;
    }
    sendJson(res, 200, { members: await ctx.auth.listRoster(query) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/claim") {
    const body = readRecord(await readJson(req));
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    const result = await ctx.auth.claim({
      member_id: asString(body.member_id),
      email: asString(body.email),
      password: asString(body.password),
      ...(ip ? { remoteIp: ip } : {}),
    });
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/signup") {
    const body = readRecord(await readJson(req));
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    const result = await ctx.auth.signup({
      profile: readRecord(body.profile),
      email: asString(body.email),
      password: asString(body.password),
      ...(ip ? { remoteIp: ip } : {}),
    });
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = readRecord(await readJson(req));
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    const result = await ctx.auth.login({
      email: asString(body.email),
      password: asString(body.password),
      ...(ip ? { remoteIp: ip } : {}),
    });
    if (!result.ok && result.code === "pending_approval") {
      // Distinct body so the client can route the applicant to a "waiting for approval" state.
      sendJson(res, result.status, { error: result.error.message, code: result.code });
      return;
    }
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (url.pathname === "/auth/registrations" || url.pathname.startsWith("/auth/registrations/")) {
    await handleRegistrationRoute(req, res, ctx, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/auth/session") {
    const principal = await resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendJson(res, 200, ctx.auth.sessionView(principal));
    return;
  }
  // Open and close a "view as" session. Both are member-authenticated rather than
  // requirePrivileged: the admin check lives in the auth service, which is also where the
  // no-nesting and not-yourself rules are, so all four refusals are stated in one place.
  if (req.method === "POST" && url.pathname === "/auth/impersonate") {
    const principal = await resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendAuthResult(
      res,
      await ctx.auth.startImpersonation({ admin: principal, memberId: asString(body.member_id) }),
      requestIsSecure(req, ctx.trustProxyHeaders),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/impersonate/stop") {
    const token = bearerToken(req) ?? cookieToken(req);
    if (!token) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    // No principal resolution first: an impersonated session that has already expired should still
    // be closable, and the auth service refuses anything that is not an impersonation row anyway.
    sendAuthResult(
      res,
      await ctx.auth.endImpersonation(token),
      requestIsSecure(req, ctx.trustProxyHeaders),
    );
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
    const principal = await resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const token = bearerToken(req) ?? cookieToken(req);
    if (token) {
      await ctx.auth.logout(token);
    }
    clearSessionCookie(res, requestIsSecure(req, ctx.trustProxyHeaders));
    sendJson(res, 200, { logged_out: true });
    return;
  }
  // Both reset routes are deliberately unauthenticated: the whole point is that the caller cannot
  // sign in. The auth service rate-limits them and keeps the response identical for known and
  // unknown addresses, so neither leaks roster membership.
  if (req.method === "POST" && url.pathname === "/auth/password-reset") {
    const body = readRecord(await readJson(req));
    const result = await ctx.auth.requestPasswordReset({
      email: asString(body.email),
      ...(() => {
        const ip = remoteIp(req, ctx.trustProxyHeaders);
        return ip ? { remoteIp: ip } : {};
      })(),
    });
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/password-reset/confirm") {
    const body = readRecord(await readJson(req));
    const result = await ctx.auth.resetPassword({
      token: asString(body.token),
      newPassword: asString(body.new_password),
    });
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/password") {
    const principal = await resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (refuseWhileImpersonating(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    const result = await ctx.auth.changePassword(
      principal.member.id,
      asString(body.current_password),
      asString(body.new_password),
    );
    if (result.ok) {
      clearSessionCookie(res, requestIsSecure(req, ctx.trustProxyHeaders));
    }
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/email") {
    const principal = await resolvePrincipal(req, ctx);
    if (!principal) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (principal.kind !== "member") {
      // The service principal has no credential to reverify; email change is a member-only action.
      sendJson(res, 400, { error: { message: "member principal required" } });
      return;
    }
    if (refuseWhileImpersonating(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    const result = await ctx.auth.changeEmail(
      principal.member.id,
      asString(body.new_email),
      asString(body.current_password),
      remoteIp(req, ctx.trustProxyHeaders),
    );
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
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
  const principal = await resolvePrincipal(req, ctx);
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
    sendJson(res, 200, { registrations: await ctx.auth.listRegistrations(status) });
    return;
  }
  const approve = /^\/auth\/registrations\/([^/]+)\/approve$/u.exec(url.pathname);
  if (req.method === "POST" && approve?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const approved = await ctx.auth.approveRegistration(decodeURIComponent(approve[1]), decidedBy);
    // A sign-up that created a member is onboarded like every other new member: the access its
    // level grants, approved by this admin, and its guide queued. A claim of an existing roster
    // row created nobody, and was onboarded by whichever path added that row.
    const member =
      approved.ok && approved.payload.member_created
        ? ctx.store.getLabMember(approved.payload.member_id)
        : undefined;
    if (member) {
      const deps = memberOnboardingDeps(ctx, principal, approverIdentityFor(principal));
      // The account is already approved and committed; a failed step is audited by the step itself
      // and must not turn that into an error response.
      // The account address, when the record has none: a sign-up's login email lives on its
      // credential, and it is the address every step here has to reach.
      const email = member.email?.trim() || (approved.ok ? approved.payload.email : "");
      try {
        await enrollNewMember(deps, { ...member, email });
        await queueNewMemberGuide(deps, member.id, { email });
      } catch (error) {
        deps.recordAudit({
          type: "lab_member.member_type_applied",
          actor: decidedBy,
          details: {
            member_id: member.id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    sendAuthResult(res, approved, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  const reject = /^\/auth\/registrations\/([^/]+)\/reject$/u.exec(url.pathname);
  if (req.method === "POST" && reject?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendAuthResult(
      res,
      await ctx.auth.rejectRegistration(decodeURIComponent(reject[1]), decidedBy),
      requestIsSecure(req, ctx.trustProxyHeaders),
    );
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

/**
 * Refuse the two routes that change how a member signs in, when the caller is only visiting.
 *
 * Both already demand the member's current password, so an admin cannot reach them anyway -- this
 * turns a confusing "invalid email or password" into an answer, and states the boundary in code
 * rather than leaving it as a property of the password check that a later refactor could drop.
 * The line is between acting *as* an account and taking it over: everything else an impersonated
 * session does is recorded against the admin and can be undone by whoever reads the audit trail,
 * while a changed password or account email locks the member out of their own account.
 */
function refuseWhileImpersonating(
  res: ServerResponse,
  principal: AdminBotMemberPrincipal,
): boolean {
  if (!principal.impersonator) {
    return false;
  }
  sendJson(res, 403, {
    error: {
      message: "sign-in credentials cannot be changed while viewing as another member",
    },
  });
  return true;
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
  const principal = await resolvePrincipal(req, ctx);
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
  const principal = await resolvePrincipal(req, ctx);
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
  if (await dispatchRoute(AUTHENTICATED_ROUTES, { req, res, url, ctx, principal })) {
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

// Escalation-sensitive governance (global settings, sensitive-info read/write, registration
// approve/reject) must be driven by a real member session. The shared service principal is used by
// every agent tool call regardless of which member is chatting, so treating it as admin here would
// let any signed-in member perform these actions through the agent. Require an admin member
// Bearer session and deny the service principal outright.
/**
 * The sweep is opt-in at deployment: it sends the extracted bibliographies of restricted
 * submissions to public scholarly databases, which the operator has to have agreed to.
 */
function createOpenReviewCitationWatch(
  options: AdminBotMockServiceOptions,
  store: AdminBotServiceStore,
  service: AdminBotService,
): OpenReviewCitationWatch | undefined {
  const reader =
    options.openReviewSubmissionReader ??
    (process.env.ADMINBOT_OPENREVIEW_CITATION_CHECKS?.trim() === "1"
      ? createOpenReviewSubmissionReader()
      : undefined);
  if (!reader) {
    return undefined;
  }
  const notifyEmail =
    options.citationWatchNotifyEmail ??
    (process.env.ADMINBOT_CITATION_CHECK_NOTIFY?.trim() ||
      process.env.ADMINBOT_CONTACT_EMAILS?.split(",")[0]?.trim() ||
      undefined);
  // One back-off state for the process: every check the sweep runs honors the same 429s.
  const cooldowns = new Map<string, number>();
  return new OpenReviewCitationWatch({
    store,
    service,
    reader,
    pausedUntil: () => requiredDatabasesPausedUntil(cooldowns),
    pauseBetweenMs: options.citationWatchChecker ? 0 : 60_000,
    maxPauseWaitMs: options.citationWatchChecker ? 0 : 90_000,
    check:
      options.citationWatchChecker ??
      createPdfReferenceChecker({
        maxReferences: 300,
        requireAllDatabases: true,
        allowOversized: true,
        cooldowns,
        // Unattended: a minute's wait for Crossref or DBLP beats a paper left half-checked.
        maxCooldownWaitMs: 90_000,
        ...(process.env.OPENALEX_API_KEY?.trim()
          ? { openAlexApiKey: process.env.OPENALEX_API_KEY.trim() }
          : {}),
      }),
    ...(notifyEmail ? { notifyEmail } : {}),
  });
}

/**
 * Opt-in on its own flag, separate from the citation checks: it sends the main text of restricted
 * ICLR submissions to Pangram, a third-party AI-text detector, which the operator has to have
 * agreed to on top of the citation lookups.
 */
function createIclrIntegrityWatch(
  options: AdminBotMockServiceOptions,
  store: AdminBotServiceStore,
  service: AdminBotService,
): IclrIntegrityWatch | undefined {
  const enabled = process.env.ADMINBOT_ICLR_INTEGRITY_CHECKS?.trim() === "1";
  const apiKey = process.env.PANGRAM_API_KEY?.trim();
  const score =
    options.aiTextScorer ?? (enabled && apiKey ? createPangramScorer({ apiKey }) : undefined);
  const reader =
    options.openReviewSubmissionReader ?? (score ? createOpenReviewSubmissionReader() : undefined);
  if (!score || !reader) {
    return undefined;
  }
  const threshold = Number(process.env.ADMINBOT_ICLR_AI_THRESHOLD);
  // The ICLR 2027 run ends at 08:00 Toronto time on 26 September 2026. A default rather than only an
  // env line, so a host that never had the line set still stops; the env reopens it for a later cycle.
  const until = new Date(
    process.env.ADMINBOT_ICLR_INTEGRITY_UNTIL?.trim() || DEFAULT_ICLR_INTEGRITY_UNTIL,
  );
  return new IclrIntegrityWatch({
    store,
    service,
    reader,
    score,
    extractText: options.integrityTextExtractor ?? ((pdf) => extractPdfFullText(pdf)),
    ...(threshold > 0 && threshold < 1 ? { threshold } : {}),
    // An unparseable date ends the check now rather than letting it run forever.
    until: Number.isNaN(until.getTime()) ? new Date(0) : until,
    // Operator Slack ids for the hourly digest. Anything that is not a user id is dropped rather
    // than handed to Slack.
    reportTo: (process.env.ADMINBOT_ICLR_INTEGRITY_REPORT_SLACK_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[UW][A-Z0-9]{2,}$/u.test(id)),
    ...integritySheet(),
    ...integrityDigestChannel(options.databasePath),
    // Operator Slack ids for confirmed hallucinated citations, filtered the same way.
    citationReportTo: (process.env.ADMINBOT_ICLR_CITATION_REPORT_SLACK_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[UW][A-Z0-9]{2,}$/u.test(id)),
  });
}

const DEFAULT_ICLR_INTEGRITY_UNTIL = "2026-09-26T08:00:00-04:00";

/**
 * The channel the hourly digest lives in, as one message edited each sweep. Which message that is
 * is kept in a small file beside the database, so a restart edits it rather than starting another;
 * without a database (tests, a memory store) it is remembered for the life of the process only.
 */
function integrityDigestChannel(databasePath: string | undefined):
  | {
      reportChannel: {
        channelId: string;
        message: { load: () => string | undefined; save: (ts: string) => void };
      };
    }
  | Record<string, never> {
  const channelId = process.env.ADMINBOT_ICLR_INTEGRITY_REPORT_SLACK_CHANNEL?.trim();
  if (!channelId || !/^[CG][A-Z0-9]{2,}$/u.test(channelId)) {
    return {};
  }
  const file = databasePath
    ? path.join(path.dirname(databasePath), "iclr-integrity-digest.json")
    : undefined;
  let remembered: string | undefined;
  return {
    reportChannel: {
      channelId,
      message: {
        load: () => {
          if (remembered || !file) {
            return remembered;
          }
          try {
            const saved = JSON.parse(fs.readFileSync(file, "utf8")) as {
              channel?: string;
              ts?: string;
            };
            // A digest moved to another channel starts a new message there.
            remembered = saved.channel === channelId ? saved.ts : undefined;
          } catch {
            remembered = undefined;
          }
          return remembered;
        },
        save: (ts) => {
          remembered = ts;
          if (file) {
            try {
              fs.writeFileSync(file, JSON.stringify({ channel: channelId, ts }));
            } catch {
              // Remembered in memory regardless; the worst case after a restart is one new message.
            }
          }
        },
      },
    },
  };
}

/**
 * The lab's paper sheet the integrity sweep writes scores into, when one is configured. The tab
 * defaults to the one the lab keeps its ICLR papers on.
 */
function integritySheet():
  | { sheet: { spreadsheetId: string; tab: string; read: () => Promise<string[][]> } }
  | Record<string, never> {
  const spreadsheetId = process.env.ADMINBOT_ICLR_INTEGRITY_SHEET_ID?.trim();
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/u.test(spreadsheetId)) {
    return {};
  }
  const tab = process.env.ADMINBOT_ICLR_INTEGRITY_SHEET_TAB?.trim() || "Papers-iclr-feedback";
  return {
    sheet: {
      spreadsheetId,
      tab,
      read: () =>
        readGogSheetRows(spreadsheetId, { range: `'${tab.replace(/'/gu, "''")}'!A1:Z1000` }),
    },
  };
}

async function resolvePrincipal(
  req: IncomingMessage,
  ctx: AdminBotRouteContext,
): Promise<AdminBotPrincipal | undefined> {
  const bearer = bearerToken(req);
  if (bearer) {
    // Service-principal check first with a constant-time compare. If the env token is unset the
    // service principal is unavailable and this path fails closed.
    if (ctx.serviceToken && constantTimeEqual(bearer, ctx.serviceToken)) {
      return { kind: "service" };
    }
    const member = await ctx.auth.resolveSession(bearer);
    if (member) {
      // Every authenticated request lands here, which is what makes it the place to notice an
      // account being used from somewhere new. noteAccountUse is a no-op unless the address
      // actually changed, so this costs a map lookup on the hot path.
      ctx.auth.noteAccountUse(member, remoteIp(req, ctx.trustProxyHeaders));
      return member;
    }
  }
  const cookie = cookieToken(req);
  if (cookie) {
    const member = await ctx.auth.resolveSession(cookie);
    if (member) {
      ctx.auth.noteAccountUse(member, remoteIp(req, ctx.trustProxyHeaders));
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
): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") {
    return true;
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
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Idempotency-Key, Prefer",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  return true;
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

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
