// Control UI module implements app view state behavior.
import type { ActivityEntry, ActivityStatus } from "./activity-model.ts";
import type {
  LocationDrift,
  MeetingAttendanceNudgePreview,
  MeetingAttendanceNudgeResult,
  MeetingAttendee,
  MeetingRecord,
  MemberNotification,
} from "./adminbot/auth/session.ts";
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
import type { LogisticsRequest } from "./adminbot/data/logistics-requests.ts";
import type { MemberMap } from "./adminbot/data/member-map.ts";
import type { BlockerSort } from "./adminbot/views/admin.ts";
import type { LogisticsMode } from "./adminbot/views/logistics.ts";
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
  // Membership tab: the lab's member spreadsheet as an editable grid. `memberSheetEdits` holds
  // only the cells actually changed, keyed "row:column", so saving one cell never rewrites the
  // row around it.
  memberSheet?: import("./adminbot/auth/session.ts").MemberSheetView | null;
  /** When the tab last read the sheet on its own; null means it never has. */
  memberSheetLoadedAt?: number | null;
  memberSheetBusy?: boolean;
  memberSheetError?: string | null;
  memberSheetEdits?: Record<string, string>;
  memberSheetBaseline?: Record<string, string>;
  memberSheetSelection?: number[];
  /** Text typed into the roster's search box; matched against every cell, client-side. */
  memberSheetFilter?: string;
  memberSheetSaveResult?: import("./adminbot/auth/session.ts").MemberSheetEditResult | null;
  memberSheetOnboardResult?: import("./adminbot/auth/session.ts").MemberSheetOnboardResult | null;
  loadMemberSheet?: () => void | Promise<void>;
  memberSheetOnboardPreview?: import("./adminbot/auth/session.ts").MemberSheetOnboardPreview | null;
  saveMemberSheetEdits?: () => void | Promise<void>;
  onboardSelectedMemberRows?: () => void | Promise<void>;
  previewOnboardSelectedRows?: () => void | Promise<void>;
  editMemberSheetCell?: (sheetRow: number, column: number, value: string) => void;
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
  loadMeetingNudges?: () => Promise<void>;
  sendMeetingNudges?: () => Promise<void>;
  /** Reads the member's own notifications, and pops the unseen ones in the corner. */
  loadNotifications?: () => Promise<void>;
  markNotificationsRead?: (notificationIds?: readonly string[]) => Promise<void>;
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
  // Set while an admin is viewing the lab as another member; null otherwise. See the banner in
  // app-render, which is the one place the impersonated view admits it is one.
  // The Mailing List tab: the range and recipient an admin has chosen, and the digest that range
  // would send. Null preview means nothing has been read yet -- see the tab's own note on why a
  // preview is cleared whenever the range changes.
  /** Edit history by object, keyed "member:<id>" / "paper:<id>". */
  adminBotRecentEdits: Record<
    string,
    import("./adminbot/controllers/recent-edits.ts").RecentEditsState
  >;
  adminBotMailingListPreview: import("./adminbot/auth/session.ts").PublicationDigestPreview | null;
  adminBotMailingListLoading: boolean;
  adminBotMailingListSending: boolean;
  adminBotMailingListError: string | null;
  adminBotMailingListNotice: string | null;
  adminBotMailingListFrom: string;
  adminBotMailingListTo: string;
  adminBotMailingListEmail: string;
  memberImpersonatedBy: import("./adminbot/auth/session.ts").MemberImpersonator | null;
  memberImpersonationBusy: boolean;
  memberImpersonationError: string | null;
  submitMemberAuth: () => Promise<void>;
  signOutMember: () => Promise<void>;
  beginViewAs: (memberId: string) => Promise<void>;
  endViewAs: () => Promise<void>;
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
  // The attendance nudge, admin-only, on the Meeting Recordings tab. Null until the panel is
  // opened: resolving the audience reads the lab calendar, which is not something to do on a tab
  // most people open only to watch a recording.
  adminBotMeetingNudgePreview?: MeetingAttendanceNudgePreview | null;
  adminBotMeetingNudgeResult?: MeetingAttendanceNudgeResult | null;
  adminBotMeetingNudgeBusy?: boolean;
  adminBotMeetingNudgeError?: string | null;
  // What the lab has told this member. Undefined is "not read yet"; [] is a real "nothing".
  adminBotNotifications?: MemberNotification[];
  adminBotNotificationsError?: string | null;
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
  // The Recommendation Letters form's rows and save state are separate from the signature form's:
  // only one is on screen at a time (the sidebar decides which), and a shared "Saved at" would
  // follow the member across and describe the wrong draft.
  // Make a request, or read the ones already made. Both modes are open to everyone: the service
  // scopes the list to the caller, so a member's is their own requests and an admin's is the lab's.
  adminBotLogisticsMode: LogisticsMode;
  adminBotLogisticsRequests: LogisticsRequest[];
  adminBotLogisticsRequestsLoading: boolean;
  adminBotLogisticsRequestsError: string | null;
  // When the list was last read, and the "ask for it" signal: null means nothing has fetched it
  // for the mode the tab is now in. Not `requests.length`, which would re-ask forever in a lab
  // that has no requests yet.
  adminBotLogisticsRequestsLoadedAt: number | null;
  // Which request is open, and the copy of it that carries the file bytes. The list deliberately
  // has none, so opening one is a second read and the two are held apart.
  adminBotLogisticsOpenRequestId: string | null;
  adminBotLogisticsOpenRequest: LogisticsRequest | null;
  adminBotLogisticsOpenLoading: boolean;
  // The admin's note for the answer they are about to give, parked here so a re-render underneath
  // them -- the request list reloading -- cannot eat half a sentence.
  adminBotLogisticsStatusNote: string;
  // Submitting, shared by the three forms because only one of them is ever on screen.
  adminBotLogisticsSubmitting: boolean;
  adminBotLogisticsSubmitError: string | null;
  adminBotLogisticsSubmittedId: string | null;
  // The request the forms are currently holding a correction to, or null when what is on screen is
  // a new request. Submit sends a PUT for the first and a POST for the second.
  adminBotLogisticsEditingId: string | null;
  // The request whose signed document is being uploaded right now, so its row can say so and no
  // second upload can start against the same one.
  adminBotLogisticsSigningId: string | null;
  // "<requestId>:<fileName>" while that one document is being fetched for download.
  adminBotLogisticsDownloadingId: string | null;
  // What an admin has typed to go with the signed document they are about to send.
  adminBotLogisticsSignedNote: string;
  // Whether the admin queue is showing only what is still outstanding, or everything.
  adminBotLogisticsShowSettled: boolean;
  // Whose drafts are currently on screen. Drafts are per-member (IndexedDB is per-origin, not per
  // account), so this is what tells the render pass that the signed-in member changed and the
  // forms are showing somebody else's work.
  adminBotLogisticsDraftScope: string | null;
  // Profile Overview: how far along every active member's own record is. `loadedAt` is the "ask for
  // it" signal, the same sentinel the logistics queue uses.
  adminBotProfileOverview: import("./adminbot/auth/session.ts").MemberProfileOverviewRow[];
  /** Nudges raised to the head professor and still unanswered. Read with the overview beside it. */
  adminBotEscalatedNudges: import("./adminbot/auth/session.ts").EscalatedNudgeRow[];
  adminBotProfileOverviewFieldCount: number;
  adminBotProfileAdoption?: import("./adminbot/auth/session.ts").MemberAdoptionSummary | null;
  adminBotProfileOverviewLoading: boolean;
  adminBotProfileOverviewError: string | null;
  adminBotProfileOverviewLoadedAt: number | null;
  adminBotProfileOverviewReminding: boolean;
  adminBotProfileOverviewNotice: string | null;
  /** Per-paper draft for the external-coauthor boxes, so a re-render does not clear what was typed. */
  myWorkCoauthorDraft: Record<string, { email: string; name: string }>;
  adminBotProfileOverviewFilter: import("./adminbot/views/profile-overview.ts").ProfileOverviewFilter;
  adminBotPaperFilter: import("./adminbot/views/paper-overview.ts").PaperOverviewFilter;
  adminBotPaperCardId: string | null;
  // My Projects & Papers: what each paper still owes, and the slots of whichever cards are open.
  // `loadedAt` is the same "ask for it" sentinel the overview above uses.
  adminBotPaperSlotOverview: import("./adminbot/auth/session.ts").PaperSlotOverviewRow[];
  adminBotPaperSlots: Record<string, import("./adminbot/auth/session.ts").PaperCycle>;
  adminBotPaperSlotsOpen: string[];
  adminBotPaperSlotsLoading: boolean;
  adminBotPaperSlotsError: string | null;
  adminBotPaperSlotsLoadedAt: number | null;
  adminBotPaperSlotsNudging: boolean;
  adminBotPaperSlotsNotice: string | null;
  adminBotPaperSlotsBusyId: string | null;
  // The nudge preview. Null when closed; opening it sends nothing.
  adminBotPaperNudgeBatches: import("./adminbot/auth/session.ts").PaperNudgeBatch[] | null;
  adminBotPaperNudgeLoading: boolean;
  adminBotPaperNudgeSelected: string[];
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
  /** The span the time chart is drawing, so the commitment tables can follow its pager. */
  adminBotTimeChartWindow:
    | import("./adminbot/views/time-allocation-chart.ts").TimeChartWindow
    | null;
  adminBotTimeAvailabilityDraft: TimeAvailabilityDraft;
  adminBotTimeAwayDraft: TimeAvailabilityDraft;
  adminBotMilestoneDraft: MilestoneDraft;
  adminBotAvailabilityNotesDraft: string | null;
  adminBotActiveCommitmentType: string | null;
  adminBotTimeAvailabilitySaving: boolean;
  adminBotBusyActionId: string | null;
  adminBotNotice: { kind: "success" | "error"; text: string } | null;
  adminBotPhotoPolishBusy: boolean;
  adminBotPhotoApplyBusy: boolean;
  adminBotReimbursement: AdminBotReimbursementState;
  adminBotMemberNudge: AdminBotMemberNudgeState;
  adminBotBlockerSort: BlockerSort;
  adminBotVenueFilter: string;
  nudgeBellOpen: boolean;
  // Last press of the CV digest job on the Cron tab. Session-scoped on purpose: the durable
  // record of a run is the audit row and the document itself, and this only exists so the button
  // can report what it just did.
  adminBotCvDigestJob: import("./adminbot/controllers/admin.ts").AdminBotCvDigestJobState;
  // Find Interesting Papers tab. Held whole rather than as a dozen flat fields: every part of it is
  // replaced together on each search, and a half-updated search is not a state worth expressing.
  adminBotVenuePapers: import("./adminbot/controllers/admin.ts").AdminBotVenuePapersState;
  // Review-only CSV workshop matcher. Drafts remain browser state until explicitly downloaded.
  adminBotWorkshopNudges: import("./adminbot/controllers/admin.ts").WorkshopNudgeReviewState;
  // Last press of the conference index job on the Cron tab. Same shape as the CV digest job: both
  // are "an admin pressed a button and something slow happened".
  adminBotVenueIndexJob: import("./adminbot/controllers/admin.ts").AdminBotCvDigestJobState;
  // Last press of the Slack channel naming sweep, same shape again. What it "did" is file
  // proposals, so the detail line points at Pending Actions rather than reporting a change.
  adminBotChannelNamingJob: import("./adminbot/controllers/admin.ts").AdminBotCvDigestJobState;
  // Prototype-only: blockers a member raises from My Projects & Papers. Held in the browser
  // because the AdminBot service has no blocker route yet -- see views/my-work.ts.
  myWorkBlockerDraft: import("./adminbot/views/my-work.ts").BlockerDraft | null;
  myWorkBlockers: import("./adminbot/views/my-work.ts").Blocker[];
  // Non-null while the "add a project" field is open; holds what has been typed.
  myWorkProjectDraft: string | null;
  myWorkProjectAlias: string;
  /**
   * Why the add-project form refused, or null.
   *
   * The form used to `return` out of submit on every one of these, which files nothing and says
   * nothing: the member is left looking at a filled-in form and an unchanged page. Most often it
   * was the alias -- an apostrophe or a colon carried over from the title cannot be a Slack
   * channel name, so `adminBotNormalizePaperAlias` returns null and the submit gives up silently.
   */
  myWorkProjectError: string | null;
  /**
   * Per-paper drafts for the card's own "project details" editor, keyed by paper id.
   *
   * A title changes over a project's life -- that is the normal case, not an exception -- and until
   * now the three answers the create form insists on could never be revised afterwards. Held per
   * paper because several cards can be open at once.
   */
  myWorkProjectEdits: Record<
    string,
    { title: string; alias: string; startedOn: string; error: string | null }
  >;
  myWorkChannelCheck: import("./adminbot/controllers/admin.ts").SlackChannelCheck;
  /** Venue rows on the add-project form: a paper can be aimed at several, each with its own odds. */
  myWorkProjectVenues: Array<{ venueId: string; year: number; confidence: number }>;
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
  adminBotBadgeDefinitions: import("./adminbot/auth/session.ts").BadgeDefinition[];
  adminBotBadgeDefinitionsLoading: boolean;
  adminBotBadgeDefinitionsLoadedAt: number | null;
  adminBotBadgeDefinitionsError: import("./adminbot/data/badges.ts").BadgeLoadError | null;
  adminBotBadgeNominations: import("./adminbot/auth/session.ts").BadgeNominationView[];
  adminBotBadgeNominationsLoading: boolean;
  adminBotBadgeNominationsLoadedAt: number | null;
  adminBotBadgeNominationsError: import("./adminbot/data/badges.ts").BadgeLoadError | null;
  adminBotBadgeBusyKey: string | null;
  adminBotBadgeNotice: { kind: "success" | "error"; text: string } | null;
  adminBotBadgeAssignRowId: string;
  adminBotBadgeMemberQuery: string;
  adminBotBadgeEditId: string;
  profileBadgeNominations: import("./adminbot/auth/session.ts").BadgeNominationView[];
  profileBadgeNominationsLoading: boolean;
  profileBadgeNominationsLoadedAt: number | null;
  profileBadgeNominationsError: import("./adminbot/data/badges.ts").BadgeLoadError | null;
  profileBadgeBusy: boolean;
  profileBadgeNotice: { kind: "success" | "error"; text: string } | null;
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
