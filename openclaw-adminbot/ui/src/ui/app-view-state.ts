// Control UI module implements app view state behavior.
import type { ActivityEntry, ActivityStatus } from "./activity-model.ts";
import type {
  AdminBotDashboardData,
  AdminBotMemberNudgeState,
  AdminBotReimbursementState,
} from "./adminbot/controllers/admin.ts";
import type {
  LetterFact,
  MeetingRequestRow,
  RecommendationSchool,
} from "./adminbot/data/logistics-draft.ts";
import type {
  LocationDrift,
  MeetingAttendee,
  MeetingRecord,
} from "./adminbot/auth/session.ts";
import type { LogisticsRequest } from "./adminbot/data/logistics-requests.ts";
import type { MemberMap } from "./adminbot/data/member-map.ts";
import type { BlockerSort } from "./adminbot/views/admin.ts";
import type { LogisticsMode, LogisticsTemplate } from "./adminbot/views/logistics.ts";
import type { TripDraft } from "./adminbot/views/time-availability.trips.ts";
import type {
  MilestoneDraft,
  TimeAvailabilityDraft,
  TimeAvailabilityRange,
} from "./adminbot/views/time-availability.ts";
import type { ChatAbortOptions, ChatSendOptions } from "./app-chat.ts";
import type { EventLogEntry } from "./app-events.ts";
import type { CompactionStatus, FallbackStatus } from "./app-tool-stream.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./chat/input-history.ts";
import type { ChatRunUiStatus } from "./chat/run-lifecycle.ts";
import type { ChatMessageCache } from "./chat/session-message-cache.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import type { CronModelSuggestionsState, CronState } from "./controllers/cron.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type {
  ClawHubSearchResult,
  ClawHubSkillSecurityVerdict,
  ClawHubSkillDetail,
  SkillMessage,
} from "./controllers/skills.ts";
import type { EmbedSandboxMode } from "./embed-sandbox.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { SidebarContent } from "./sidebar-content.ts";
import type { UiSettings } from "./storage.ts";
import type { ThemeTransitionContext } from "./theme-transition.ts";
import type { ResolvedTheme, ThemeMode, ThemeName } from "./theme.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  AttentionItem,
  ChannelsStatusSnapshot,
  ConfigSnapshot,
  ConfigUiHints,
  HealthSummary,
  LogEntry,
  LogLevel,
  ChatModelOverride,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  NostrProfile,
  PresenceEntry,
  SessionsUsageResult,
  CostUsageSummary,
  SessionUsageTimeSeries,
  SessionsListResult,
  SessionCompactionCheckpoint,
  SkillStatusReport,
  StatusSummary,
  ToolsCatalogResult,
} from "./types.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";
import type { SessionLogEntry } from "./views/usage.ts";

export type AppViewState = {
  settings: UiSettings;
  password: string;
  memberEmail: string;
  memberPassword: string;
  memberPasswordConfirm: string;
  loginMode: import("./adminbot/auth/flow.ts").LoginMode;
  passwordResetToken: string;
  passwordResetSent: boolean;
  passwordResetDone: boolean;
  loginShowMemberPassword: boolean;
  memberAuthBusy: boolean;
  memberAuthFailure: import("./adminbot/auth/flow.ts").MemberAuthFailure | null;
  memberFormError: string | null;
  loginPendingNotice: boolean;
  // Shows the reimbursement tool standalone, from the login screen, with no session. The
  // reimbursement routes accept anonymous callers, so a claimant can file a packet without an
  // account; every other view still requires signing in.
  guestReimbursements: boolean;
  // Whether the sign-in gate is on screen. A visitor browses the public shell until they ask for
  // it, so the gate is a surface they open rather than a wall they start behind.
  authGateVisible: boolean;
  // Onboarding tab: the form is driven by the selected template's required placeholders.
  onboardingTemplateId?: string;
  onboardingName?: string;
  onboardingEmail?: string;
  onboardingValues?: Record<string, string>;
  onboardingBusy?: boolean;
  /** Unset means "the service decides", which is on for the full-member guide and off elsewhere. */
  onboardingSubmitDcsForm?: boolean;
  onboardingError?: string | null;
  onboardingMissing?: string[];
  onboardingResult?: import("./adminbot/controllers/admin.ts").AdminBotOnboardingResult | null;
  /** The previewed email as the operator edited it; this is what a send delivers. */
  onboardingDraftSubject?: string;
  onboardingDraftBody?: string;
  /** Comma-separated project channels the send invites them to. */
  onboardingProjectChannels?: string;
  sendOnboardingGuide?: (options: { preview: boolean }) => Promise<void>;
  // Calendar tab. Two halves that share the roster the tab already has: a prompt that drafts an
  // event, and a picker that turns member facets into an invite list. Both end in a proposal.
  calendarEvents?: import("./adminbot/auth/session.ts").CalendarEvent[];
  calendarEventsLoading?: boolean;
  calendarEventsError?: string | null;
  calendarPrompt?: string;
  calendarDraft?: import("./adminbot/auth/session.ts").CalendarEventDraft | null;
  calendarDraftBusy?: boolean;
  calendarDraftError?: string | null;
  calendarSelectedEventId?: string | null;
  /** The day whose "N more" card is open, `YYYY-MM-DD`. */
  calendarOpenDay?: string | null;
  /** The event whose detail card is open. */
  calendarOpenEventId?: string | null;
  // Set while the prompt box is being used to change an event rather than compose a new one.
  calendarEditingEventId?: string | null;
  calendarSource?: import("./adminbot/auth/session.ts").LabCalendar | null;
  /** First of the month the grid is showing, `YYYY-MM-01`. Defaults to the month containing today. */
  calendarMonth?: string;
  /** The assistant conversation, oldest first. */
  calendarMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  // Two-step confirm on the sends other people can see, since these buttons really do send.
  calendarConfirming?: "save" | "invite" | null;
  calendarAudience?: import("./adminbot/calendar-audience.ts").AudienceFilter;
  // Ids the operator unticked from the matched list, so a filter that is right for 39 of 40 people
  // does not have to be abandoned for the one exception.
  calendarExcludedMemberIds?: string[];
  calendarBusy?: boolean;
  loadCalendarEvents?: () => Promise<void>;
  loadMeetings?: () => Promise<void>;
  toggleMeetingAttendance?: (meetingId: string, attendee: MeetingAttendee) => Promise<void>;
  fileMeeting?: (draft: {
    topic: string;
    started_at: string;
    share_url: string;
    passcode?: string;
  }) => Promise<void>;
  requestCalendarDraft?: () => Promise<void>;
  saveCalendarEvent?: () => Promise<void>;
  sendCalendarInvites?: () => Promise<void>;
  rosterMembers: import("./adminbot/auth/session.ts").RosterMember[];
  rosterLoading: boolean;
  rosterError: import("./adminbot/auth/flow.ts").RosterError;
  rosterFilter: string;
  selectedMemberId: string | null;
  memberName: string;
  memberSlackUserId: string;
  memberRole: string;
  memberAffiliation: string;
  memberResearchBranch: string;
  memberResearchTopics: string;
  memberProjects: string;
  memberHoursPerWeek: string;
  memberLocation: string;
  memberTimezone: string;
  memberPersonalWebsite: string;
  memberNotes: string;
  changePasswordCurrent: string;
  changePasswordNew: string;
  changePasswordConfirm: string;
  changePasswordBusy: boolean;
  changePasswordError: string | null;
  changePasswordNotice: string | null;
  openChangePassword: () => void;
  closeChangePassword: () => void;
  submitChangePassword: () => Promise<void>;
  // Signed-in member's AdminBot privilege level, persisted app-wide so the
  // Gateway-RPC admin surfaces (Lab Members) can gate on real privilege rather
  // than assuming admin. Null until the member session is loaded.
  memberPrivilegeLevel: string | null;
  // Signed-in member's own roster id, so the Lab Members table can offer a
  // self-edit row and sort it first. Null in break-glass gateway-token-only
  // access, where no row is "mine".
  memberId: string | null;
  // Signed-in member's onboarding checklist (null until loaded/if unavailable), and whether they
  // have explicitly acknowledged the dashboard's standing warning card for it in this browser.
  adminBotOnboarding: import("./adminbot/auth/session.ts").MemberOnboarding | null;
  adminBotOnboardingAcknowledged: boolean;
  adminBotOnboardingBusyStepId: string | null;
  adminBotOnboardingError: string | null;
  // Where the member is in the walk of the checklist (null = not navigated yet; the view opens on
  // the first step that still needs the member).
  adminBotOnboardingStepIndex: number | null;
  submitMemberAuth: () => Promise<void>;
  signOutMember: () => Promise<void>;
  loadRoster: () => Promise<void>;
  tab: Tab;
  onboarding: boolean;
  basePath: string;
  connected: boolean;
  theme: ThemeName;
  themeMode: ThemeMode;
  themeResolved: ResolvedTheme;
  themeOrder: ThemeName[];
  customThemeImportUrl: string;
  customThemeImportBusy: boolean;
  customThemeImportMessage: { kind: "success" | "error"; text: string } | null;
  customThemeImportExpanded: boolean;
  customThemeImportFocusToken: number;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  lastErrorCode: string | null;
  chatError: string | null;
  eventLog: EventLogEntry[];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAvatarUploadBusy: boolean;
  assistantAvatarUploadError: string | null;
  assistantAgentId: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  localMediaPreviewRoots: string[];
  embedSandboxMode: EmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  chatMessageMaxWidth?: string | null;
  sessionKey: string;
  chatSessionMessageSubscriptionKey?: string | null;
  chatSessionMessageSubscriptionRequestedKey?: string | null;
  chatLoading: boolean;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  activityEntries: ActivityEntry[];
  activityFilterText: string;
  activityStatusFilters: Record<ActivityStatus, boolean>;
  activityToolFilter: string;
  activityExpandedIds: Set<string>;
  activityAutoFollow: boolean;
  activityAtBottom: boolean;
  chatStreamSegments: Array<{ text: string; ts: number }>;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunId: string | null;
  chatSideResult: ChatSideResult | null;
  chatSideResultTerminalRuns: Set<string>;
  compactionStatus: CompactionStatus | null;
  fallbackStatus: FallbackStatus | null;
  chatRunStatus: ChatRunUiStatus | null;
  chatRunStatusClearTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
  chatAvatarUrl: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarReason?: string | null;
  chatThinkingLevel: string | null;
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelSwitchPromises: Record<string, Promise<boolean>>;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  sessionSwitchNotice: { id: number; text: string } | null;
  sessionSwitchFlashKey: string | null;
  chatSessionPickerOpen: boolean;
  chatSessionPickerSurface: "desktop" | "mobile" | "sidebar" | null;
  chatSessionPickerQuery: string;
  chatSessionPickerAppliedQuery: string;
  chatSessionPickerLoading: boolean;
  chatSessionPickerError: string | null;
  chatSessionPickerResult: SessionsListResult | null;
  sessionsResultAgentId?: string | null;
  chatAgentSessionRowsByAgent?: Record<string, SessionsListResult["sessions"]>;
  announceSessionSwitch?: (sessionKey: string, label: string) => void;
  chatQueue: ChatQueueItem[];
  chatQueueBySession: Record<string, ChatQueueItem[]>;
  chatMessagesBySession: ChatMessageCache;
  chatLocalInputHistoryBySession: Record<string, Array<{ text: string; ts: number }>>;
  chatInputHistorySessionKey: string | null;
  chatInputHistoryItems: string[] | null;
  chatInputHistoryIndex: number;
  chatDraftBeforeHistory: string | null;
  realtimeTalkOptions: {
    provider: string;
    model: string;
    voice: string;
    transport: string;
    vadThreshold: string;
    silenceDurationMs: string;
    prefixPaddingMs: string;
    reasoningEffort: string;
  };
  resetRealtimeTalkConversation?: () => void;
  updateRealtimeTalkOptions: (next: Partial<AppViewState["realtimeTalkOptions"]>) => void;
  fetchRealtimeTalkCatalog: () => Promise<void>;
  chatManualRefreshInFlight: boolean;
  chatHeaderControlsHidden: boolean;
  chatMobileControlsOpen: boolean;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  chatNewMessagesBelow: boolean;
  navDrawerOpen: boolean;
  sidebarOpen: boolean;
  sidebarContent: SidebarContent | null;
  sidebarError: string | null;
  splitRatio: number;
  scrollToBottom: (opts?: { smooth?: boolean }) => void;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  execApprovalError: string | null;
  execApprovalSecretValue: string;
  pendingGatewayUrl: string | null;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  updateRunning: boolean;
  applySessionKey: string;
  configSnapshot: ConfigSnapshot | null;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  selectedAgentId: string | null;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: import("./controllers/dreaming.js").DreamingStatus | null;
  dreamingModeSaving: boolean;
  dreamingRestartConfirmOpen: boolean;
  dreamingRestartConfirmLoading: boolean;
  dreamingPendingEnabled: boolean | null;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: import("./controllers/dreaming.js").WikiImportInsights | null;
  wikiMemoryPalaceLoading: boolean;
  wikiMemoryPalaceError: string | null;
  wikiMemoryPalace: import("./controllers/dreaming.js").WikiMemoryPalace | null;
  configFormMode: "form" | "raw";
  configSettingsMode: "quick" | "advanced";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  pendingUpdateExpectedVersion: string | null;
  pendingUpdateHandoff: boolean;
  updateStatusBanner: { tone: "danger" | "warn" | "info"; text: string } | null;
  communicationsFormMode: "form" | "raw";
  communicationsSearchQuery: string;
  communicationsActiveSection: string | null;
  communicationsActiveSubsection: string | null;
  appearanceFormMode: "form" | "raw";
  appearanceSearchQuery: string;
  appearanceActiveSection: string | null;
  appearanceActiveSubsection: string | null;
  automationFormMode: "form" | "raw";
  automationSearchQuery: string;
  automationActiveSection: string | null;
  automationActiveSubsection: string | null;
  infrastructureFormMode: "form" | "raw";
  infrastructureSearchQuery: string;
  infrastructureActiveSection: string | null;
  infrastructureActiveSubsection: string | null;
  aiAgentsFormMode: "form" | "raw";
  aiAgentsSearchQuery: string;
  aiAgentsActiveSection: string | null;
  aiAgentsActiveSubsection: string | null;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  nostrProfileFormState: NostrProfileFormState | null;
  nostrProfileAccountId: string | null;
  configFormDirty: boolean;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  agentsSelectedId: string | null;
  adminBotLoading: boolean;
  adminBotError: string | null;
  adminBotData: AdminBotDashboardData;
  // Lab Sharing tab: the project the member is asking for help on, and the draft of their request. The
  // search query for finding other members' requests, and the list of members invited to help on
  // the member's own request. The list of requests the member has already responded to, and the
  // index of the open request in the search results (null = none open).
  labSharingAskProjectId?: string;
  labSharingAskComment?: string;
  labSharingAskMembers?: number;
  labSharingAskHours?: number;
  labSharingAskTags?: string[];
  labSharingSearchQuery?: string;
  labSharingInvitedMemberIds?: string[];
  labSharingRespondedInviteIds?: string[];
  labSharingOpenProjectIndex?: number;
  // Time Availability tab: whose schedule is on screen, which unit its hours are quoted in, and
  // the unsaved "add a commitment" draft. Draft lives here rather than in the view so a re-render
  // (the roster reloading underneath, a notice appearing) does not wipe half-typed input.
  // Where the lab is, for the dashboard card. Null until the first load; the card renders nothing
  // rather than an empty map.
  adminBotMemberMap: MemberMap | null;
  adminBotMemberMapLoading: boolean;
  adminBotTimeAvailabilityMemberId: string;
  // Meeting Recordings tab. The list as the service returned it -- already redacted for a member,
  // full for an admin -- plus the two flags the view needs to distinguish "still loading" from
  // "the lab has not recorded a meeting yet".
  // Undefined is the "never asked" sentinel the render pass keys its one-shot fetch on; a load
  // that genuinely finds nothing sets [], so an empty lab cannot loop.
  adminBotMeetings?: MeetingRecord[];
  adminBotTripDraft?: TripDraft;
  adminBotLocationDrift?: LocationDrift | null;
  adminBotLocationDrifts?: LocationDrift[];
  adminBotLocationSaving?: boolean;
  adminBotLocationError?: string | null;
  loadLocationPrompt?: () => Promise<void>;
  loadLocationDrifts?: () => Promise<void>;
  answerLocationPrompt?: (answer: { current_city?: string; timezone?: string }) => Promise<void>;
  adminBotMeetingsLoading: boolean;
  adminBotMeetingsSaving: boolean;
  adminBotMeetingsError: string | null;
  // Documents picked for a signature request, held here rather than in the view so a re-render
  // does not drop a file the member already chose. Replaced wholesale on every change: lit only
  // sees a @state() array as dirty when the reference changes.
  adminBotLogisticsSignatureFiles: File[];
  adminBotLogisticsDescription: string;
  adminBotLogisticsAttachments: File[];
  // Draft persistence is local-only (IndexedDB on the member's device), so these track the save
  // itself, not a server round trip.
  adminBotLogisticsSaving: boolean;
  adminBotLogisticsSavedAt: number | null;
  adminBotLogisticsSaveError: string | null;
  // Which request template is on screen, and the Recommendation Letters form behind it. Its rows
  // and save state are separate from the signature form's: only one is visible at a time, and a
  // shared "Saved at" would follow the member across and describe the wrong draft.
  adminBotLogisticsTemplate: LogisticsTemplate;
  // Admin-only surface: make a request, or read the saved ones. Held for everyone because the view
  // pins non-admins to "make" rather than the state being trusted to be absent.
  adminBotLogisticsMode: LogisticsMode;
  adminBotLogisticsRequests: LogisticsRequest[];
  adminBotLogisticsRequestsLoading: boolean;
  adminBotLogisticsOpenRequestId: string | null;
  adminBotLettersSchools: RecommendationSchool[];
  adminBotLettersFacts: LetterFact[];
  // Book Meeting's own table and save state, kept apart from the other two for the same reason
  // they are kept apart from each other.
  adminBotMeetingRows: MeetingRequestRow[];
  adminBotMeetingSaving: boolean;
  adminBotMeetingSavedAt: number | null;
  adminBotMeetingSaveError: string | null;
  adminBotLettersCvOverleafUrl: string;
  adminBotLettersDriveFolderUrl: string;
  adminBotLettersSaving: boolean;
  adminBotLettersSavedAt: number | null;
  adminBotLettersSaveError: string | null;
  adminBotTimeAvailabilityRange: TimeAvailabilityRange;
  adminBotTimeAvailabilityDraft: TimeAvailabilityDraft;
  adminBotTimeAwayDraft: TimeAvailabilityDraft;
  adminBotMilestoneDraft: MilestoneDraft;
  adminBotAvailabilityNotesDraft: string | null;
  adminBotTimeAvailabilitySaving: boolean;
  adminBotBusyActionId: string | null;
  adminBotNotice: { kind: "success" | "error"; text: string } | null;
  adminBotPhotoPolishBusy: boolean;
  adminBotPhotoApplyBusy: boolean;
  adminBotReimbursement: AdminBotReimbursementState;
  adminBotMemberNudge: AdminBotMemberNudgeState;
  adminBotBlockerSort: BlockerSort;
  nudgeBellOpen: boolean;
  // Prototype-only: blockers a member raises from My Projects & Papers. Held in the browser
  // because the AdminBot service has no blocker route yet -- see views/my-work.ts.
  myWorkBlockerDraft: import("./adminbot/views/my-work.ts").BlockerDraft | null;
  myWorkBlockers: import("./adminbot/views/my-work.ts").Blocker[];
  // Non-null while the "add a project" field is open; holds what has been typed.
  myWorkProjectDraft: string | null;
  // Which profile section is in edit mode, if any.
  profileEditingSection: "basics" | null;
  profileAccountChecks: Record<
    string,
    import("./adminbot/views/profile-account-check.ts").ProfileAccountCheck
  >;
  registrations: import("./adminbot/auth/session.ts").MemberRegistration[];
  registrationsLoading: boolean;
  registrationsError: import("./adminbot/data/registrations.ts").RegistrationsLoadError | null;
  registrationsBusyId: string | null;
  registrationsNotice: { kind: "success" | "error"; text: string } | null;
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveLoadingKey: string | null;
  toolsEffectiveResultKey: string | null;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: import("./types.js").ToolsEffectiveResult | null;
  agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFilesList: AgentsFilesListResult | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileActive: string | null;
  agentFileSaving: boolean;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  threadsLoading: boolean;
  threadsResult: SessionsListResult | null;
  threadsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  sessionsShowArchived: boolean;
  sessionsFiltersCollapsed: boolean;
  sessionsHideCron: boolean;
  sessionsSearchQuery: string;
  sessionsSortColumn: "key" | "kind" | "updated" | "tokens";
  sessionsSortDir: "asc" | "desc";
  sessionsPage: number;
  sessionsPageSize: number;
  sessionsSelectedKeys: Set<string>;
  sessionsExpandedCheckpointKey: string | null;
  sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  sessionsCheckpointLoadingKey: string | null;
  sessionsCheckpointBusyKey: string | null;
  sessionsCheckpointErrorByKey: Record<string, string>;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  usageScope: "instance" | "family";
  usageAgentId: string | null;
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageSelectedHours: number[];
  usageChartMode: "tokens" | "cost";
  usageDailyChartMode: "total" | "by-type";
  usageTimeSeriesMode: "cumulative" | "per-turn";
  usageTimeSeriesBreakdownMode: "total" | "by-type";
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesCursorStart: number | null;
  usageTimeSeriesCursorEnd: number | null;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageSessionLogsExpanded: boolean;
  usageQuery: string;
  usageQueryDraft: string;
  usageQueryDebounceTimer: number | null;
  usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors";
  usageSessionSortDir: "asc" | "desc";
  usageRecentSessions: string[];
  usageTimeZone: "local" | "utc";
  usageContextExpanded: boolean;
  usageHeaderPinned: boolean;
  usageSessionsTab: "all" | "recent";
  usageVisibleColumns: string[];
  usageLogFilterRoles: import("./views/usage.js").SessionLogRole[];
  usageLogFilterTools: string[];
  usageLogFilterHasTools: boolean;
  usageLogFilterQuery: string;
} & Pick<
  CronState,
  | "cronLoading"
  | "cronQuickCreateOpen"
  | "cronQuickCreateStep"
  | "cronQuickCreateDraft"
  | "cronJobsLoadingMore"
  | "cronJobsReloadPending"
  | "cronJobsReloadPendingTableFilters"
  | "cronJobs"
  | "cronJobsTotal"
  | "cronJobsHasMore"
  | "cronJobsNextOffset"
  | "cronJobsLimit"
  | "cronJobsQuery"
  | "cronJobsEnabledFilter"
  | "cronJobsScheduleKindFilter"
  | "cronJobsLastStatusFilter"
  | "cronJobsSortBy"
  | "cronJobsSortDir"
  | "cronStatus"
  | "cronError"
  | "cronForm"
  | "cronFormCollapsed"
  | "cronFieldErrors"
  | "cronEditingJobId"
  | "cronRunsJobId"
  | "cronRunsLoadingMore"
  | "cronRuns"
  | "cronRunsTotal"
  | "cronRunsHasMore"
  | "cronRunsNextOffset"
  | "cronRunsLimit"
  | "cronRunsScope"
  | "cronRunsStatuses"
  | "cronRunsDeliveryStatuses"
  | "cronRunsStatusFilter"
  | "cronRunsQuery"
  | "cronRunsSortDir"
  | "cronBusy"
> &
  Pick<CronModelSuggestionsState, "cronModelSuggestions"> & {
    skillsLoading: boolean;
    skillsAgentId: string | null;
    skillsAgentRevision: number;
    skillsReport: SkillStatusReport | null;
    skillsError: string | null;
    skillsFilter: string;
    skillsStatusFilter: "all" | "ready" | "needs-setup" | "disabled";
    skillEdits: Record<string, string>;
    skillMessages: Record<string, SkillMessage>;
    skillsBusyKey: string | null;
    skillsDetailKey: string | null;
    skillsDetailTab: "overview" | "card";
    clawhubSearchQuery: string;
    clawhubSearchResults: ClawHubSearchResult[] | null;
    clawhubSearchLoading: boolean;
    clawhubSearchError: string | null;
    clawhubDetail: ClawHubSkillDetail | null;
    clawhubDetailSlug: string | null;
    clawhubDetailLoading: boolean;
    clawhubDetailError: string | null;
    clawhubInstallSlug: string | null;
    clawhubInstallMessage: { kind: "success" | "error"; text: string } | null;
    clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict>;
    clawhubVerdictsLoading: boolean;
    clawhubVerdictsError: string | null;
    skillCardContents: Record<string, string>;
    skillCardContentKeys: Record<string, string>;
    skillCardLoadingKey: string | null;
    skillCardErrors: Record<string, string>;
    healthLoading: boolean;
    healthResult: HealthSummary | null;
    healthError: string | null;
    modelAuthStatusLoading: boolean;
    modelAuthStatusResult: ModelAuthStatusResult | null;
    modelAuthStatusError: string | null;
    debugLoading: boolean;
    debugStatus: StatusSummary | null;
    debugHealth: HealthSummary | null;
    debugModels: ModelCatalogEntry[];
    debugHeartbeat: unknown;
    debugCallMethod: string;
    debugCallParams: string;
    debugCallResult: string | null;
    debugCallError: string | null;
    logsLoading: boolean;
    logsError: string | null;
    logsFile: string | null;
    logsEntries: LogEntry[];
    logsFilterText: string;
    logsLevelFilters: Record<LogLevel, boolean>;
    logsAutoFollow: boolean;
    logsTruncated: boolean;
    logsCursor: number | null;
    logsLastFetchAt: number | null;
    logsLimit: number;
    logsMaxBytes: number;
    logsAtBottom: boolean;
    updateAvailable: import("./types.js").UpdateAvailable | null;
    attentionItems: AttentionItem[];
    paletteOpen: boolean;
    paletteQuery: string;
    paletteActiveIndex: number;
    streamMode: boolean;
    overviewShowGatewayPassword: boolean;
    overviewLogLines: string[];
    overviewLogCursor: number;
    client: GatewayBrowserClient | null;
    refreshSessionsAfterChat: Map<string, import("./ui-types.js").ChatSessionRefreshTarget>;
    connect: () => void;
    setTab: (tab: Tab) => void;
    setChatMobileControlsOpen: (
      open: boolean,
      options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
    ) => void;
    setTheme: (theme: ThemeName, context?: ThemeTransitionContext) => void;
    setThemeMode: (mode: ThemeMode, context?: ThemeTransitionContext) => void;
    setCustomThemeImportUrl: (next: string) => void;
    openCustomThemeImport: () => void;
    importCustomTheme: () => Promise<void>;
    clearCustomTheme: () => void;
    setBorderRadius: (value: number) => void;
    setTextScale: (value: number) => void;
    applySettings: (next: UiSettings) => void;
    applyLocalUserIdentity?: (next: { name?: string | null; avatar?: string | null }) => void;
    loadOverview: (opts?: { refresh?: boolean }) => Promise<void>;
    loadAssistantIdentity: (opts?: {
      sessionKey?: string;
      expectedSessionKey?: string;
    }) => Promise<void>;
    loadCron: () => Promise<void>;
    handleWhatsAppStart: (force: boolean) => Promise<void>;
    handleWhatsAppWait: () => Promise<void>;
    handleWhatsAppLogout: () => Promise<void>;
    handleChannelConfigSave: () => Promise<void>;
    handleChannelConfigReload: () => Promise<void>;
    handleNostrProfileEdit: (accountId: string, profile: NostrProfile | null) => void;
    handleNostrProfileCancel: () => void;
    handleNostrProfileFieldChange: (field: keyof NostrProfile, value: string) => void;
    handleNostrProfileSave: () => Promise<void>;
    handleNostrProfileImport: () => Promise<void>;
    handleNostrProfileToggleAdvanced: () => void;
    handleExecApprovalDecision: (decision: "allow-once" | "allow-always" | "deny") => Promise<void>;
    handleExecApprovalSecretInput: (value: string) => void;
    handleExecApprovalSecretSubmit: () => Promise<void>;
    handleExecApprovalSecretCancel: () => Promise<void>;
    handleGatewayUrlConfirm: () => void;
    handleGatewayUrlCancel: () => void;
    handleConfigLoad: () => Promise<void>;
    handleConfigSave: () => Promise<void>;
    handleConfigApply: () => Promise<void>;
    handleConfigFormUpdate: (path: string, value: unknown) => void;
    handleConfigFormModeChange: (mode: "form" | "raw") => void;
    handleConfigRawChange: (raw: string) => void;
    handleInstallSkill: (key: string) => Promise<void>;
    handleUpdateSkill: (key: string) => Promise<void>;
    handleToggleSkillEnabled: (key: string, enabled: boolean) => Promise<void>;
    handleUpdateSkillEdit: (key: string, value: string) => void;
    handleSaveSkillApiKey: (key: string, apiKey: string) => Promise<void>;
    handleCronToggle: (jobId: string, enabled: boolean) => Promise<void>;
    handleCronRun: (jobId: string) => Promise<void>;
    handleCronRemove: (jobId: string) => Promise<void>;
    handleCronAdd: () => Promise<void>;
    handleCronRunsLoad: (jobId: string) => Promise<void>;
    handleCronFormUpdate: (path: string, value: unknown) => void;
    handleSessionsLoad: () => Promise<void>;
    handleSessionsPatch: (key: string, patch: unknown) => Promise<void>;
    handleLoadNodes: () => Promise<void>;
    handleLoadPresence: () => Promise<void>;
    handleLoadSkills: () => Promise<void>;
    handleLoadDebug: () => Promise<void>;
    handleLoadLogs: () => Promise<void>;
    handleDebugCall: () => Promise<void>;
    handleRunUpdate: () => Promise<void>;
    setPassword: (next: string) => void;
    setChatMessage: (next: string) => void;
    handleChatDraftChange: (next: string) => void;
    handleChatInputHistoryKey: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
    resetChatInputHistoryNavigation: () => void;
    handleSendChat: (messageOverride?: string, opts?: ChatSendOptions) => Promise<void>;
    toggleRealtimeTalk: () => Promise<void>;
    steerQueuedChatMessage: (id: string) => Promise<void>;
    handleAbortChat: (opts?: ChatAbortOptions) => Promise<void>;
    removeQueuedMessage: (id: string) => void;
    retryQueuedChatMessage: (id: string) => Promise<void>;
    handleChatScroll: (event: Event) => void;
    resetToolStream: () => void;
    resetChatScroll: () => void;
    exportLogs: (lines: string[], label: string) => void;
    handleLogsScroll: (event: Event) => void;
    handleActivityScroll: (event: Event) => void;
    scheduleActivityScroll: (force?: boolean) => void;
    handleOpenSidebar: (content: SidebarContent) => void;
    handleCloseSidebar: () => void;
    handleSplitRatioChange: (ratio: number) => void;
    webPushSupported: boolean;
    webPushPermission: NotificationPermission | "unsupported";
    webPushSubscribed: boolean;
    webPushLoading: boolean;
    handleWebPushSubscribe: () => Promise<void>;
    handleWebPushUnsubscribe: () => Promise<void>;
    handleWebPushTest: () => Promise<void>;
  };
