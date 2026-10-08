import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { createArxivProbe } from "../connectors/arxiv.js";
import { createOllamaEmbedder } from "../connectors/embeddings.js";
import { appendGogSheetRows, readGogSheetRows } from "../connectors/gog.js";
import { createIpinfoGeolocator } from "../connectors/ip-geolocation.js";
import {
  createOpenReviewForumProbe,
  createOpenReviewNotesReader,
} from "../connectors/openreview-notes.js";
import {
  createGptZeroBibliographyScanner,
  createPublicOpenReviewPdfReader,
} from "../connectors/reference-scan.js";
import { createInterviewChannelProvisioner } from "../connectors/slack-interview.js";
import {
  createLinkedInDraftRunner,
  createXDraftRunner,
  readArxivPdfBase64,
} from "../connectors/social-draft.js";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { resolveInferenceGateConfig } from "../inference/config.js";
import { createInferenceGate, setSharedInferenceGate } from "../inference/gate.js";
import { createLlmLoadRouter, parseLlmNodes } from "../kernel/llm-router.js";
import { ReferenceScans } from "../kernel/reference-scans.js";
import {
  AdminBotMemoryStore,
  AdminBotService,
  type AdminBotActionExecutor,
  type AdminBotExecutorOutcome,
  type AdminBotServiceOptions,
  type AdminBotServiceStore,
} from "../kernel/service.js";
import { createMemoryFailedRequestLedger } from "../persistence/failed-requests.js";
import { createMemberDraftStore } from "../persistence/member-drafts.js";
import { AdminBotSqliteStore, createAdminBotSqliteService } from "../persistence/sqlite.js";
import { createAdminBotPrivacyBroker } from "../privacy/broker.js";
import { createLocalChat } from "../privacy/local-chat.js";
import { createAdminBotSensitiveInfoDocument } from "../privacy/sensitive-info-doc.js";
import { registerServiceTaskHandlers } from "../tasks/http-handlers.js";
import { TaskRuntime } from "../tasks/runtime.js";
import { VisitorSessions } from "../tasks/visitors.js";
import { createEventDraftRunner } from "../workflows/calendar/event-draft.js";
import { createCalendarEventsReader } from "../workflows/calendar/events.js";
import { resolveLabCalendar } from "../workflows/calendar/lab-calendar.js";
import { DEADLINE_VENUES } from "../workflows/deadlines/generated/dataset.js";
import { readDeadlineDataset } from "../workflows/deadlines/runtime-dataset.js";
import { createAccountApprovedEmailRunner } from "../workflows/identity/account-approved-email.js";
import { AdminBotAuthService } from "../workflows/identity/auth.js";
import { createPasswordResetEmailRunner } from "../workflows/identity/password-reset-email.js";
import { createCalendarInviteRunner } from "../workflows/onboarding/calendar-invite.js";
import { createDcsRosterSheetRecorder } from "../workflows/onboarding/dcs-roster-sheet.js";
import { createDriveWorkspaceProvisioner } from "../workflows/onboarding/drive-workspace.js";
import {
  createAdminBotOnboardingSender,
  createSlackConnectOnboardingInviter,
  type AdminBotOnboardingSender,
} from "../workflows/onboarding/guide-sender.js";
import { createImportColumnMapper } from "../workflows/papers/import-columns.js";
import { createPublicationMailingRunner } from "../workflows/papers/mailing-list-email.js";
import { createAdminBotOpenReviewWorkflow } from "../workflows/papers/openreview-workflow.js";
import { createLocalWorkshopMatcher } from "../workflows/papers/workshop-match-llm.js";
import { defaultCallSheet } from "./call-sheet-config.js";
import { memberSheetSource, resolveMemberSheetConfig } from "./member-sheet-config.js";
import {
  warnIfLabCalendarUnconfigured,
  type SlackConnectOnboardingInviter,
  type LabCalendarGrant,
  executorWithOnboardingGuide,
} from "./onboarding-provisioning.js";
import { createPdfReferenceCheckHandler } from "./pdf-reference-check.js";
import { isAnonymousRoute, createAnonymousRateLimiter } from "./routes/anonymous.js";
import { handleAuthRoute } from "./routes/auth.js";
import type {
  AdminBotMemberSheetSource,
  AdminBotPrincipal,
  AdminBotRouteContext,
} from "./routes/context.js";
import type { AdminBotMockServiceOptions } from "./routes/context.js";
import { AUTHENTICATED_ROUTES } from "./routes/index.js";
import { memberEnrollmentContext } from "./routes/onboarding.js";
import { DEFAULT_ALLOWED_ORIGINS, applyCors, parseOrigins, remoteIp } from "./routes/origin.js";
import { createOpenReviewCitationWatch, createIclrIntegrityWatch } from "./routes/reviews.js";
import { dispatchRoute } from "./routes/router.js";
import { resolvePrincipal } from "./routes/session.js";
import { handleTasksRoute, handleVisitorBootstrap } from "./routes/tasks.js";
import { PayloadTooLargeError, sendJson } from "./server.http.js";
import { executeMemberEnrollment } from "./server.member-onboarding.js";
import {
  createPublicDeadlineLimiter,
  handlePublicDeadlineProposal,
} from "./server.public-deadline-proposals.js";
import { servePublicRoute } from "./server.public.js";
import { configureWorkshopTaskRuntime } from "./server.workshop-nudges.js";
export type { AdminBotCvDigestPublisher } from "./routes/context.js";
export type { AdminBotMemberSheetSource } from "./routes/context.js";
export type { DeviceTokenIssuance } from "./routes/context.js";
export type { DeviceTokenIssuer } from "./routes/context.js";
export type { DevicePairingApproval } from "./routes/context.js";
export type { DevicePairingApprover } from "./routes/context.js";
export type { AdminBotMockServiceOptions } from "./routes/context.js";

/**
 * The lab's own roster, which is the sheet this deployment exists to administer.
 *
 * The defaults, the URL/gid parsing and the gid-to-title resolution live in
 * `member-sheet-config.ts`; this stays a thin seam so `createAdminBotServer` has one call to make.
 */
export function defaultMemberSheet(env: NodeJS.ProcessEnv): AdminBotMemberSheetSource {
  return memberSheetSource(resolveMemberSheetConfig(env));
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
  // The shared GPU gate uses a connection-local queue unless restart persistence is enabled.
  // The task runner owns application recovery; model rows remain transport diagnostics.
  // It is also installed as a compatibility default for standalone callers. Service-owned callers receive
  // it explicitly; replacing that default does not hot-swap an existing service or its factories.
  const inferenceConfig = resolveInferenceGateConfig(process.env);
  const persistTasks =
    options.inferenceGate?.settings().persist_across_restarts ??
    inferenceConfig.persistAcrossRestarts;
  const inferenceGate =
    options.inferenceGate ??
    createInferenceGate({
      ...(store instanceof AdminBotSqliteStore ? { db: store.inferenceDatabase() } : {}),
      config: { ...inferenceConfig, persistAcrossRestarts: false },
      localApiKeyEnv: "VLLM_API_KEY",
      alert: (line) => console.warn(line),
      onEscalate: async (escalation) => {
        const proposed = service.proposeInferenceEscalation({
          ...escalation,
          firedAt: new Date().toISOString(),
        });
        if (!proposed.ok) {
          // No admin with a Slack id, most likely. The alert above already went to the console;
          // the audit row the gate writes carries this reason.
          throw new Error(proposed.error.message);
        }
        return { proposal_id: proposed.payload.id };
      },
    });
  setSharedInferenceGate(inferenceGate);
  // Task checkpoints own recovery; legacy model-only rows must never dispatch independently.
  const recovered = inferenceGate.start({ recoverExisting: false });
  if (recovered.interrupted > 0 || recovered.expired > 0 || recovered.readmitted > 0) {
    console.warn(
      `[adminbot] inference queue recovered: ${recovered.readmitted} re-admitted, ` +
        `${recovered.expired} expired, ${recovered.interrupted} interrupted (see audit).`,
    );
  }
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
      gate: inferenceGate,
      // The broker's fallbacks used to be invisible. Recorded through the store so they land in
      // the same audit table as every other inference event.
      recordAudit: (event) =>
        store.recordAudit({
          id: `aud_${randomUUID()}`,
          timestamp: new Date().toISOString(),
          ...event,
        }),
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
  const reimbursementWorkflow =
    options.reimbursementWorkflow ?? options.reimbursementWorkflowFactory?.(inferenceGate);
  const cvScanDeps = options.cvScanDeps ?? options.cvScanDepsFactory?.(inferenceGate);
  const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const ownTaskDb = !(store instanceof AdminBotSqliteStore);
  const taskDb =
    store instanceof AdminBotSqliteStore
      ? store.inferenceDatabase()
      : new sqlite.DatabaseSync(":memory:");
  const taskRuntime = new TaskRuntime({
    db: taskDb,
    persist: persistTasks,
    maxQueued: inferenceConfig.queue.maxDepth,
    maxInFlightPerOwner: inferenceConfig.queue.maxPerOwner,
    maxInputBytes: inferenceConfig.queue.maxPayloadBytes,
    maxResultBytes: inferenceConfig.queue.maxPayloadBytes,
    maxRetainedBytes: inferenceConfig.queue.maxRetainedBytes,
    admissionNotice: (id) => inferenceGate.admissionNotice(id),
    canDispatch: () => {
      const stats = inferenceGate.settings();
      return !stats.paused && !stats.shutting_down;
    },
    canStart: () => {
      const stats = inferenceGate.stats();
      return !stats.paused && !stats.shutting_down && stats.in_flight < stats.capacity;
    },
  });
  const visitors = new VisitorSessions(taskDb, persistTasks);
  const ctx: AdminBotRouteContext = {
    reimbursementSigningKey: randomBytes(32),
    taskRuntime,
    visitors,
    inferenceGate,
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
    draftXPost: options.xDraftRunner ?? createXDraftRunner(),
    readArxivPdfBase64: options.readArxivPdfBase64 ?? readArxivPdfBase64,
    ...(options.readDrivePdfBase64 ? { readDrivePdfBase64: options.readDrivePdfBase64 } : {}),
    ...(memberSheet ? { memberSheet } : {}),
    ...(callSheet ? { callSheet } : {}),
    autoQueueMeetingRequests,
    ...(runEmailAutomation ? { runEmailAutomation } : {}),
    ...(reimbursementWorkflow ? { reimbursementWorkflow } : {}),
    ...(serviceToken ? { serviceToken } : {}),
    ...(options.devicePairingApprover
      ? { devicePairingApprover: options.devicePairingApprover }
      : {}),
    ...(options.deviceTokenIssuer ? { deviceTokenIssuer: options.deviceTokenIssuer } : {}),
    ...(openReviewWorkflow ? { openReviewWorkflow } : {}),
    ...(options.fetchSlackLocations ? { fetchSlackLocations: options.fetchSlackLocations } : {}),
    ...(cvScanDeps ? { cvScanDeps } : {}),
    ...(options.cvDigestPublisher ? { cvDigestPublisher: options.cvDigestPublisher } : {}),
    publicationMailingRunner: options.publicationMailingRunner ?? createPublicationMailingRunner(),
    ...(venuePapersReader ? { venuePapersReader } : {}),
    embedder,
    embeddingModel,
    workshopMatcher: options.workshopMatcher ?? createLocalWorkshopMatcher({ gate: inferenceGate }),
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
      createImportColumnMapper({
        fetchImpl: (input, init) => fetch(input, init),
        gate: inferenceGate,
      }),
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
  registerServiceTaskHandlers(taskRuntime, ctx);
  configureWorkshopTaskRuntime(service, taskRuntime, ctx.workshopMatcher);
  taskRuntime.start();
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
  let closing: Promise<void> | undefined;
  return {
    server,
    service,
    auth,
    inferenceGate,
    taskRuntime,
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
      closing ??= (async () => {
        // Keep operator controls reachable while inference drains, including live grace edits.
        await Promise.all([
          inferenceGate.shutdown(),
          taskRuntime.shutdown({ graceMs: () => inferenceGate.settings().shutdown_grace_ms }),
        ]);
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            server.closeAllConnections();
            resolve();
          }, 5_000);
          server.close(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
        if (ownTaskDb) {
          taskDb.close();
        }
        closeDurable();
      })();
      return closing;
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

  // Login-free pages, the deadline feed and photos (./server.public.ts).
  if (servePublicRoute(req, res, url, ctx)) {
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

  if (req.method === "POST" && url.pathname === "/tasks/visitor") {
    handleVisitorBootstrap(req, res, ctx);
    return;
  }
  const principal = await resolvePrincipal(req, ctx);
  // Before the anonymous boundary: a visitor owns tasks without being a principal.
  if (url.pathname === "/tasks" || url.pathname.startsWith("/tasks/")) {
    await handleTasksRoute(req, res, url, ctx, principal);
    return;
  }
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

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
