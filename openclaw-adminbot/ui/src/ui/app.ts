// Control UI module implements app behavior.
import { LitElement } from "lit";
import { state } from "lit/decorators.js";
import { i18n, I18nController, isSupportedLocale, t } from "../i18n/index.ts";
import type { ActivityEntry, ActivityStatus } from "./activity-model.ts";
import {
  type LoginMode,
  type MemberAuthFailure,
  type RosterError,
  closeChangePassword as closeChangePasswordInternal,
  loadRoster as loadRosterInternal,
  openChangePassword as openChangePasswordInternal,
  signOutMember as signOutMemberInternal,
  submitChangePassword as submitChangePasswordInternal,
  submitMemberAuth as submitMemberAuthInternal,
} from "./adminbot/auth/flow.ts";
import type {
  MemberOnboarding,
  MemberRegistration,
  RosterMember,
  CalendarEvent,
  LocationDrift,
  MeetingRecord,
  CalendarEventDraft,
  LabCalendar,
} from "./adminbot/auth/session.ts";
import type { AudienceFilter } from "./adminbot/calendar-audience.ts";
import {
  createEmptyAdminBotDashboardData,
  createEmptyAdminBotMemberNudgeState,
  createEmptyAdminBotReimbursementState,
  type AdminBotDashboardData,
  type AdminBotMemberNudgeState,
  type AdminBotReimbursementState,
  sendOnboardingGuide as sendOnboardingGuideController,
} from "./adminbot/controllers/admin.ts";
import {
  inviteAdminBotCalendarAudience,
  loadAdminBotCalendar,
  requestAdminBotCalendarDraft,
  saveAdminBotCalendarEvent,
} from "./adminbot/controllers/calendar.ts";
import { EMPTY_TRIP_DRAFT, type TripDraft } from "./adminbot/views/time-availability.trips.ts";
import {
  answerAdminBotLocationPrompt,
  loadAdminBotLocationDrifts,
  loadAdminBotLocationPrompt,
} from "./adminbot/controllers/location-prompt.ts";
import {
  fileAdminBotMeeting,
  loadAdminBotMeetings,
  setAdminBotMeetingAttendance,
} from "./adminbot/controllers/meetings.ts";
import {
  createFactRow,
  createSchoolRow,
  restoreAdminBotLettersDraft,
  restoreAdminBotLogisticsDraft,
  restoreAdminBotMeetingDraft,
  type LetterFact,
  type MeetingRequestRow,
  type RecommendationSchool,
} from "./adminbot/data/logistics-draft.ts";
import type { LogisticsRequest } from "./adminbot/data/logistics-requests.ts";
import type { MemberMap } from "./adminbot/data/member-map.ts";
import type { RegistrationsLoadError } from "./adminbot/data/registrations.ts";
import type { BlockerSort } from "./adminbot/views/admin.ts";
import type { LogisticsMode, LogisticsTemplate } from "./adminbot/views/logistics.ts";
import type { Blocker, BlockerDraft } from "./adminbot/views/my-work.ts";
import type { ProfileAccountCheck } from "./adminbot/views/profile-account-check.ts";
import {
  EMPTY_MILESTONE_DRAFT,
  EMPTY_TIME_AVAILABILITY_DRAFT,
  type MilestoneDraft,
  type TimeAvailabilityDraft,
  type TimeAvailabilityRange,
} from "./adminbot/views/time-availability.ts";
import {
  handleChannelConfigReload as handleChannelConfigReloadInternal,
  handleChannelConfigSave as handleChannelConfigSaveInternal,
  handleNostrProfileCancel as handleNostrProfileCancelInternal,
  handleNostrProfileEdit as handleNostrProfileEditInternal,
  handleNostrProfileFieldChange as handleNostrProfileFieldChangeInternal,
  handleNostrProfileImport as handleNostrProfileImportInternal,
  handleNostrProfileSave as handleNostrProfileSaveInternal,
  handleNostrProfileToggleAdvanced as handleNostrProfileToggleAdvancedInternal,
  handleWhatsAppLogout as handleWhatsAppLogoutInternal,
  handleWhatsAppStart as handleWhatsAppStartInternal,
  handleWhatsAppWait as handleWhatsAppWaitInternal,
} from "./app-channels.ts";
import {
  handleAbortChat as handleAbortChatInternal,
  handleChatDraftChange as handleChatDraftChangeInternal,
  handleChatInputHistoryKey as handleChatInputHistoryKeyInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
  resetChatInputHistoryNavigation as resetChatInputHistoryNavigationInternal,
  retryQueuedChatMessage as retryQueuedChatMessageInternal,
  steerQueuedChatMessage as steerQueuedChatMessageInternal,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
} from "./app-chat.ts";
import {
  DEFAULT_CRON_FORM,
  DEFAULT_LOG_LEVEL_FILTERS,
  DEFAULT_SESSIONS_FILTERS,
} from "./app-defaults.ts";
import type { EventLogEntry } from "./app-events.ts";
import { connectGateway as connectGatewayInternal } from "./app-gateway.ts";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle.ts";
import { initNativeBridge } from "./app-native-bridge.ts";
import { createChatSession as createChatSessionInternal } from "./app-render.helpers.ts";
import { renderApp } from "./app-render.ts";
import {
  exportLogs as exportLogsInternal,
  handleActivityScroll as handleActivityScrollInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
  scheduleActivityScroll as scheduleActivityScrollInternal,
  scheduleChatScroll as scheduleChatScrollInternal,
} from "./app-scroll.ts";
import {
  applySettings as applySettingsInternal,
  applyLocalUserIdentity as applyLocalUserIdentityInternal,
  loadCron as loadCronInternal,
  loadOverview as loadOverviewInternal,
  setTab as setTabInternal,
  setTheme as setThemeInternal,
  setThemeMode as setThemeModeInternal,
  onPopState as onPopStateInternal,
} from "./app-settings.ts";
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
  type CompactionStatus,
  type FallbackStatus,
} from "./app-tool-stream.ts";
import type { AppViewState } from "./app-view-state.ts";
import { normalizeAssistantIdentity } from "./assistant-identity.ts";
import { restoreChatComposerState } from "./chat/composer-persistence.ts";
import { exportChatMarkdown } from "./chat/export.ts";
import type { ChatRunUiStatus } from "./chat/run-lifecycle.ts";
import type { ChatMessageCache } from "./chat/session-message-cache.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import {
  loadToolsEffective as loadToolsEffectiveInternal,
  refreshVisibleToolsEffectiveForCurrentSession as refreshVisibleToolsEffectiveForCurrentSessionInternal,
} from "./controllers/agents.ts";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type {
  DreamingStatus,
  WikiImportInsights,
  WikiMemoryPalace,
} from "./controllers/dreaming.ts";
import {
  dismissExecApprovalPrompt,
  isStaleApprovalResolutionError,
  refreshPendingApprovalQueue,
  type ExecApprovalRequest,
} from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type {
  ClawHubSearchResult,
  ClawHubSkillSecurityVerdict,
  ClawHubSkillDetail,
  SkillMessage,
} from "./controllers/skills.ts";
import { importCustomThemeFromUrl } from "./custom-theme.ts";
import {
  clearActiveFloatingTooltips,
  prepareActiveFloatingTooltipsForRender,
  promoteNativeTitleTooltip,
  refreshActiveFloatingTooltip,
  restoreNativeTitleTooltip,
} from "./dom-tooltips.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import { resolveAgentIdFromSessionKey } from "./session-key.ts";
import type { SidebarContent } from "./sidebar-content.ts";
import { loadLocalUserIdentity, loadSettings, type UiSettings } from "./storage.ts";
import { VALID_THEME_NAMES, type ResolvedTheme, type ThemeMode, type ThemeName } from "./theme.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ConfigSnapshot,
  ConfigUiHints,
  ChatModelOverride,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSummary,
  LogEntry,
  LogLevel,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionCompactionCheckpoint,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
  NostrProfile,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "./types.ts";
import type { ChatAttachment, ChatQueueItem, CronFormState } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";

declare global {
  interface Window {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
    // Set by a statically hosted deployment's index.html: the gateway this page connects to by
    // default, since such a page is not served by its gateway and cannot derive one.
    __OPENCLAW_CONTROL_UI_GATEWAY_URL__?: string;
  }
}

const bootAssistantIdentity = normalizeAssistantIdentity({});
const bootLocalUserIdentity = loadLocalUserIdentity();
const FULL_MESSAGE_SIDEBAR_MAX_CHARS = 500_000;

function isSidebarMarkdownLike(content: SidebarContent | null): content is SidebarContent {
  return Boolean(content && (content.kind === "markdown" || content.kind === "canvas"));
}

function resolveSidebarUnavailableReason(
  reason: "not_found" | "oversized" | "not_visible" | null | undefined,
): string {
  switch (reason) {
    case "oversized":
      return "Full content is unavailable because the stored transcript entry is too large to return safely.";
    case "not_visible":
      return "Full content is unavailable because this transcript entry does not have a visible WebChat projection.";
    default:
      return "Full content is no longer available for this transcript entry.";
  }
}

function resolveOnboardingMode(): boolean {
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export class OpenClawApp extends LitElement {
  readonly i18nController = new I18nController(this);
  clientInstanceId = generateUUID();
  connectGeneration = 0;
  @state() settings: UiSettings = loadSettings();
  constructor() {
    super();
    if (isSupportedLocale(this.settings.locale)) {
      void i18n.setLocale(this.settings.locale);
    }
  }
  @state() password = "";
  @state() memberEmail = "";
  @state() memberPassword = "";
  @state() memberPasswordConfirm = "";
  @state() loginMode: LoginMode = "signin";
  @state() passwordResetToken = "";
  @state() passwordResetSent = false;
  @state() passwordResetDone = false;
  @state() loginShowMemberPassword = false;
  @state() memberAuthBusy = false;
  @state() memberAuthFailure: MemberAuthFailure | null = null;
  @state() memberFormError: string | null = null;
  @state() loginPendingNotice = false;
  @state() guestReimbursements = false;
  @state() authGateVisible = false;
  @state() onboardingTemplateId = "interview_invite";
  @state() onboardingName = "";
  @state() onboardingEmail = "";
  @state() onboardingValues: Record<string, string> = {};
  @state() onboardingBusy = false;
  @state() onboardingError: string | null = null;
  @state() onboardingMissing: string[] = [];
  @state() onboardingResult:
    | import("./adminbot/controllers/admin.ts").AdminBotOnboardingResult
    | null = null;
  @state() onboardingDraftSubject = "";
  @state() onboardingDraftBody = "";
  @state() onboardingProjectChannels = "";
  // Calendar tab. Declared here, not merely typed on AppViewState: an undeclared field is not a
  // reactive property, so writing one from a controller changes nothing on screen. That is what
  // made the whole tab inert — events loaded and never appeared, and typing in the assistant did
  // not re-render. The view tests could not catch it because they render with a plain object.
  // Declared here for the same reason as the calendar block above: a controller writing a plain
  // class field would change nothing on screen.
  @state() adminBotTripDraft: TripDraft = EMPTY_TRIP_DRAFT;
  @state() adminBotLocationDrift?: LocationDrift | null;
  @state() adminBotLocationDrifts?: LocationDrift[];
  @state() adminBotLocationSaving = false;
  @state() adminBotLocationError: string | null = null;
  @state() adminBotMeetings?: MeetingRecord[];
  @state() adminBotMeetingsLoading = false;
  @state() adminBotMeetingsSaving = false;
  @state() adminBotMeetingsError: string | null = null;
  @state() calendarEvents?: CalendarEvent[];
  @state() calendarEventsLoading = false;
  @state() calendarEventsError: string | null = null;
  @state() calendarSource: LabCalendar | null = null;
  @state() calendarMonth?: string;
  @state() calendarPrompt = "";
  @state() calendarMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  @state() calendarDraft: CalendarEventDraft | null = null;
  @state() calendarDraftBusy = false;
  @state() calendarDraftError: string | null = null;
  @state() calendarSelectedEventId: string | null = null;
  @state() calendarOpenDay: string | null = null;
  @state() calendarOpenEventId: string | null = null;
  @state() calendarEditingEventId: string | null = null;
  @state() calendarAudience: AudienceFilter = {};
  @state() calendarExcludedMemberIds: string[] = [];
  @state() calendarBusy = false;
  @state() calendarConfirming: "save" | "invite" | null = null;
  @state() rosterMembers: RosterMember[] = [];
  @state() rosterLoading = false;
  @state() rosterError: RosterError = null;
  @state() rosterFilter = "";
  @state() selectedMemberId: string | null = null;
  @state() memberName = "";
  @state() memberSlackUserId = "";
  @state() memberRole = "";
  @state() memberAffiliation = "";
  @state() memberResearchBranch = "";
  @state() memberResearchTopics = "";
  @state() memberProjects = "";
  @state() memberHoursPerWeek = "";
  @state() memberLocation = "";
  @state() memberTimezone = "";
  @state() memberPersonalWebsite = "";
  @state() changePasswordCurrent = "";
  @state() changePasswordNew = "";
  @state() changePasswordConfirm = "";
  @state() changePasswordBusy = false;
  @state() changePasswordError: string | null = null;
  @state() changePasswordNotice: string | null = null;
  @state() memberNotes = "";
  @state() memberPrivilegeLevel: string | null = null;
  @state() memberId: string | null = null;
  @state() adminBotOnboarding: MemberOnboarding | null = null;
  @state() adminBotOnboardingAcknowledged = true;
  @state() adminBotOnboardingBusyStepId: string | null = null;
  @state() adminBotOnboardingError: string | null = null;
  // Where the member is in the single-card walk of the checklist. Must be reactive: Back/Next
  // mutate it alone, so a non-reaction property would let clicks fall through with no repaint.
  @state() adminBotOnboardingStepIndex: number | null = null;
  @state() tab: Tab = "chat";
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeName = this.settings.theme ?? "claw";
  @state() themeMode: ThemeMode = this.settings.themeMode ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() themeOrder: ThemeName[] = this.buildThemeOrder(this.theme);
  @state() customThemeImportUrl = "";
  @state() customThemeImportBusy = false;
  @state() customThemeImportMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() customThemeImportExpanded = false;
  @state() customThemeImportFocusToken = 0;
  private customThemeImportSelectOnSuccess = false;
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() lastErrorCode: string | null = null;
  @state() chatError: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  eventLogBuffer: EventLogEntry[] = [];
  toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  @state() assistantName = bootAssistantIdentity.name;
  @state() assistantAvatar = bootAssistantIdentity.avatar;
  @state() assistantAvatarSource = bootAssistantIdentity.avatarSource ?? null;
  @state() assistantAvatarStatus = bootAssistantIdentity.avatarStatus ?? null;
  @state() assistantAvatarReason = bootAssistantIdentity.avatarReason ?? null;
  @state() assistantAvatarUploadBusy = false;
  @state() assistantAvatarUploadError: string | null = null;
  @state() assistantAgentId = bootAssistantIdentity.agentId ?? null;
  @state() userName = bootLocalUserIdentity.name;
  @state() userAvatar = bootLocalUserIdentity.avatar;
  @state() localMediaPreviewRoots: string[] = [];
  @state() embedSandboxMode: "strict" | "scripts" | "trusted" = "strict";
  @state() allowExternalEmbedUrls = false;
  @state() chatMessageMaxWidth: string | null = null;
  @state() serverVersion: string | null = null;

  @state() sessionKey = this.settings.sessionKey;
  chatSessionMessageSubscriptionKey: string | null = null;
  chatSessionMessageSubscriptionRequestedKey: string | null = null;
  currentSessionId: string | null = null;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  @state() activityEntries: ActivityEntry[] = [];
  @state() activityFilterText = "";
  @state() activityStatusFilters: Record<ActivityStatus, boolean> = {
    running: true,
    done: true,
    error: true,
  };
  @state() activityToolFilter = "";
  @state() activityExpandedIds = new Set<string>();
  @state() activityAutoFollow = true;
  @state() activityAtBottom = true;
  @state() chatStreamSegments: Array<{ text: string; ts: number }> = [];
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() chatSideResult: ChatSideResult | null = null;
  @state() compactionStatus: CompactionStatus | null = null;
  @state() fallbackStatus: FallbackStatus | null = null;
  @state() chatRunStatus: ChatRunUiStatus | null = null;
  chatRunStatusClearTimer: ReturnType<typeof globalThis.setTimeout> | number | null = null;
  @state() chatAvatarUrl: string | null = null;
  @state() chatAvatarSource: string | null = null;
  @state() chatAvatarStatus: "none" | "local" | "remote" | "data" | null = null;
  @state() chatAvatarReason: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatModelOverrides: Record<string, ChatModelOverride | null> = {};
  @state() chatModelSwitchPromises: Record<string, Promise<boolean>> = {};
  @state() chatModelsLoading = false;
  @state() chatModelCatalog: ModelCatalogEntry[] = [];
  @state() sessionSwitchNotice: { id: number; text: string } | null = null;
  @state() sessionSwitchFlashKey: string | null = null;
  @state() chatSessionPickerOpen = false;
  @state() chatSessionPickerSurface: "desktop" | "mobile" | "sidebar" | null = null;
  @state() chatSessionPickerQuery = "";
  @state() chatSessionPickerAppliedQuery = "";
  @state() chatSessionPickerLoading = false;
  @state() chatSessionPickerError: string | null = null;
  @state() chatSessionPickerResult: SessionsListResult | null = null;
  private sessionSwitchNoticeSeq = 0;
  private sessionSwitchNoticeTimer: number | null = null;
  private sessionSwitchFlashTimer: number | null = null;
  chatComposerPersistTimer: ReturnType<typeof globalThis.setTimeout> | number | null = null;
  chatComposerPersistSnapshot: {
    sessionKey: string;
    chatMessage: string;
    chatQueue: ChatQueueItem[];
  } | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatQueueBySession: Record<string, ChatQueueItem[]> = {};
  @state() chatMessagesBySession: ChatMessageCache = new Map();
  @state() chatAttachments: ChatAttachment[] = [];
  private nativeBridgeCleanup: (() => void) | null = null;
  @state() chatManualRefreshInFlight = false;
  @state() chatHeaderControlsHidden = false;
  @state() chatMobileControlsOpen = false;
  private chatMobileControlsTrigger: HTMLElement | null = null;
  @state() navDrawerOpen = false;

  onSlashAction?: (action: string) => void | Promise<void>;
  chatLocalInputHistoryBySession: Record<string, Array<{ text: string; ts: number }>> = {};
  chatInputHistorySessionKey: string | null = null;
  chatInputHistoryItems: string[] | null = null;
  @state() chatInputHistoryIndex = -1;
  chatDraftBeforeHistory: string | null = null;

  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: SidebarContent | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() execApprovalsTargetNodeId: string | null = null;
  @state() execApprovalQueue: ExecApprovalRequest[] = [];
  @state() execApprovalBusy = false;
  @state() execApprovalError: string | null = null;
  @state() execApprovalSecretValue = "";
  @state() pendingGatewayUrl: string | null = null;
  pendingGatewayToken: string | null = null;

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configRawOriginal = "";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() updateRunning = false;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configSchema: unknown = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;
  @state() selectedAgentId: string | null = null;
  @state() dreamingStatusLoading = false;
  @state() dreamingStatusError: string | null = null;
  @state() dreamingStatus: DreamingStatus | null = null;
  @state() dreamingModeSaving = false;
  @state() dreamingRestartConfirmOpen = false;
  @state() dreamingRestartConfirmLoading = false;
  @state() dreamingPendingEnabled: boolean | null = null;
  @state() dreamDiaryLoading = false;
  @state() dreamDiaryActionLoading = false;
  @state() dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() dreamDiaryActionArchivePath: string | null = null;
  @state() dreamDiaryError: string | null = null;
  @state() dreamDiaryPath: string | null = null;
  @state() dreamDiaryContent: string | null = null;
  @state() wikiImportInsightsLoading = false;
  @state() wikiImportInsightsError: string | null = null;
  @state() wikiImportInsights: WikiImportInsights | null = null;
  @state() wikiMemoryPalaceLoading = false;
  @state() wikiMemoryPalaceError: string | null = null;
  @state() wikiMemoryPalace: WikiMemoryPalace | null = null;
  @state() configFormDirty = false;
  @state() configSettingsMode: "quick" | "advanced" = "quick";
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;
  @state() pendingUpdateExpectedVersion: string | null = null;
  @state() pendingUpdateHandoff = false;
  @state() updateStatusBanner: { tone: "danger" | "warn" | "info"; text: string } | null = null;
  @state() communicationsFormMode: "form" | "raw" = "form";
  @state() communicationsSearchQuery = "";
  @state() communicationsActiveSection: string | null = null;
  @state() communicationsActiveSubsection: string | null = null;
  @state() appearanceFormMode: "form" | "raw" = "form";
  @state() appearanceSearchQuery = "";
  @state() appearanceActiveSection: string | null = null;
  @state() appearanceActiveSubsection: string | null = null;
  @state() automationFormMode: "form" | "raw" = "form";
  @state() automationSearchQuery = "";
  @state() automationActiveSection: string | null = null;
  @state() automationActiveSubsection: string | null = null;
  @state() infrastructureFormMode: "form" | "raw" = "form";
  @state() infrastructureSearchQuery = "";
  @state() infrastructureActiveSection: string | null = null;
  @state() infrastructureActiveSubsection: string | null = null;
  @state() aiAgentsFormMode: "form" | "raw" = "form";
  @state() aiAgentsSearchQuery = "";
  @state() aiAgentsActiveSection: string | null = null;
  @state() aiAgentsActiveSubsection: string | null = null;

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() nostrProfileFormState: NostrProfileFormState | null = null;
  @state() nostrProfileAccountId: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;
  @state() agentsSelectedId: string | null = null;
  @state() adminBotLoading = false;
  @state() adminBotError: string | null = null;
  @state() adminBotData: AdminBotDashboardData = createEmptyAdminBotDashboardData();
  // Empty selection means "nobody picked yet"; app-render defaults it to the viewer's own row once
  // the roster arrives, since your own schedule is the one you came to look at.
  @state() adminBotMemberMap: MemberMap | null = null;
  @state() adminBotMemberMapLoading = false;
  @state() adminBotTimeAvailabilityMemberId = "";
  @state() adminBotLogisticsSignatureFiles: File[] = [];
  @state() adminBotLogisticsDescription = "";
  @state() adminBotLogisticsAttachments: File[] = [];
  @state() adminBotLogisticsSaving = false;
  @state() adminBotLogisticsSavedAt: number | null = null;
  @state() adminBotLogisticsSaveError: string | null = null;
  // Document Signature is the template the tab opens on: it is the request members make most, and
  // landing on the picker alone would leave the page with nothing to do.
  @state() adminBotLogisticsTemplate: LogisticsTemplate = "documentSignature";
  // Admins land on the same page members do; reading everyone's requests is a deliberate step.
  @state() adminBotLogisticsMode: LogisticsMode = "make";
  @state() adminBotLogisticsRequests: LogisticsRequest[] = [];
  @state() adminBotLogisticsRequestsLoading = false;
  @state() adminBotLogisticsOpenRequestId: string | null = null;
  // One blank row so the table opens ready to type in rather than empty.
  @state() adminBotLettersSchools: RecommendationSchool[] = [createSchoolRow()];
  // One blank row here too, for the same reason: a table with no row is a table nobody can start.
  @state() adminBotLettersFacts: LetterFact[] = [createFactRow()];
  // Book Meeting opens empty rather than with a blank row: creating a row stamps "submitted", and
  // a stamp nobody asked for would sit at the top of the queue on a request that does not exist.
  @state() adminBotMeetingRows: MeetingRequestRow[] = [];
  @state() adminBotMeetingSaving = false;
  @state() adminBotMeetingSavedAt: number | null = null;
  @state() adminBotMeetingSaveError: string | null = null;
  @state() adminBotLettersCvOverleafUrl = "";
  @state() adminBotLettersDriveFolderUrl = "";
  @state() adminBotLettersSaving = false;
  @state() adminBotLettersSavedAt: number | null = null;
  @state() adminBotLettersSaveError: string | null = null;
  // A month of weekly bins is the span most schedules are planned over: long enough to see a
  // commitment start, short enough that each bar is still a real week.
  @state() adminBotTimeAvailabilityRange: TimeAvailabilityRange = "month";
  // Two independent drafts: the Jinesis form and the time-away form each keep their own, so
  // half-typed input in one survives working in the other.
  @state() adminBotTimeAwayDraft: TimeAvailabilityDraft = {
    ...EMPTY_TIME_AVAILABILITY_DRAFT,
    category: "vacation",
  };
  @state() adminBotTimeAvailabilityDraft: TimeAvailabilityDraft = {
    ...EMPTY_TIME_AVAILABILITY_DRAFT,
  };
  @state() adminBotMilestoneDraft: MilestoneDraft = { ...EMPTY_MILESTONE_DRAFT };
  // The overall availability note while it is being edited. `null` means "not touched since the
  // last load", which is what makes the textarea show the stored note again after a save or after
  // switching members, rather than holding onto a copy of someone else's text.
  @state() adminBotAvailabilityNotesDraft: string | null = null;
  @state() adminBotTimeAvailabilitySaving = false;
  @state() adminBotBusyActionId: string | null = null;
  @state() adminBotNotice: { kind: "success" | "error"; text: string } | null = null;
  @state() adminBotPhotoPolishBusy = false;
  @state() adminBotPhotoApplyBusy = false;
  @state() adminBotReimbursement: AdminBotReimbursementState =
    createEmptyAdminBotReimbursementState();
  @state() adminBotMemberNudge: AdminBotMemberNudgeState = createEmptyAdminBotMemberNudgeState();
  @state() adminBotBlockerSort: BlockerSort = "stage";
  @state() nudgeBellOpen = false;
  @state() myWorkBlockerDraft: BlockerDraft | null = null;
  @state() myWorkBlockers: Blocker[] = [];
  @state() myWorkProjectDraft: string | null = null;
  @state() profileEditingSection: "basics" | null = null;
  @state() profileAccountChecks: Record<string, ProfileAccountCheck> = {};
  @state() registrations: MemberRegistration[] = [];
  @state() registrationsLoading = false;
  @state() registrationsError: RegistrationsLoadError | null = null;
  @state() registrationsBusyId: string | null = null;
  @state() registrationsNotice: { kind: "success" | "error"; text: string } | null = null;
  @state() toolsCatalogLoading = false;
  @state() toolsCatalogError: string | null = null;
  @state() toolsCatalogResult: ToolsCatalogResult | null = null;
  @state() toolsEffectiveLoading = false;
  @state() toolsEffectiveLoadingKey: string | null = null;
  @state() toolsEffectiveResultKey: string | null = null;
  @state() toolsEffectiveError: string | null = null;
  @state() toolsEffectiveResult: ToolsEffectiveResult | null = null;
  @state() agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron" = "files";
  @state() agentFilesLoading = false;
  @state() agentFilesError: string | null = null;
  @state() agentFilesList: AgentsFilesListResult | null = null;
  @state() agentFileContents: Record<string, string> = {};
  @state() agentFileDrafts: Record<string, string> = {};
  @state() agentFileActive: string | null = null;
  @state() agentFileSaving = false;
  @state() agentIdentityLoading = false;
  @state() agentIdentityError: string | null = null;
  @state() agentIdentityById: Record<string, AgentIdentityResult> = {};
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = DEFAULT_SESSIONS_FILTERS.activeMinutes;
  @state() sessionsFilterLimit = DEFAULT_SESSIONS_FILTERS.limit;
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;
  @state() sessionsShowArchived = false;
  @state() sessionsFiltersCollapsed = false;
  @state() sessionsHideCron = true;
  @state() sessionsSearchQuery = "";
  @state() sessionsSortColumn: "key" | "kind" | "updated" | "tokens" = "updated";
  @state() sessionsSortDir: "asc" | "desc" = "desc";
  @state() sessionsPage = 0;
  @state() sessionsPageSize = 25;
  @state() sessionsSelectedKeys: Set<string> = new Set();
  @state() sessionsExpandedCheckpointKey: string | null = null;
  @state() sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]> = {};
  @state() sessionsCheckpointLoadingKey: string | null = null;
  @state() sessionsCheckpointBusyKey: string | null = null;
  @state() sessionsCheckpointErrorByKey: Record<string, string> = {};

  @state() usageLoading = false;
  @state() usageResult: import("./types.js").SessionsUsageResult | null = null;
  @state() usageCostSummary: import("./types.js").CostUsageSummary | null = null;
  @state() usageError: string | null = null;
  @state() usageStartDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageEndDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageScope: "instance" | "family" = "family";
  @state() usageAgentId: string | null = null;
  @state() usageSelectedSessions: string[] = [];
  @state() usageSelectedDays: string[] = [];
  @state() usageSelectedHours: number[] = [];
  @state() usageChartMode: "tokens" | "cost" = "tokens";
  @state() usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeries: import("./types.js").SessionUsageTimeSeries | null = null;
  @state() usageTimeSeriesLoading = false;
  @state() usageTimeSeriesCursorStart: number | null = null;
  @state() usageTimeSeriesCursorEnd: number | null = null;
  @state() usageSessionLogs: import("./views/usage.js").SessionLogEntry[] | null = null;
  @state() usageSessionLogsLoading = false;
  @state() usageSessionLogsExpanded = false;
  // Applied query (used to filter the already-loaded sessions list client-side).
  @state() usageQuery = "";
  // Draft query text (updates immediately as the user types; applied via debounce or "Search").
  @state() usageQueryDraft = "";
  @state() usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors" = "recent";
  @state() usageSessionSortDir: "desc" | "asc" = "desc";
  @state() usageRecentSessions: string[] = [];
  @state() usageTimeZone: "local" | "utc" = "local";
  @state() usageContextExpanded = false;
  @state() usageHeaderPinned = false;
  @state() usageSessionsTab: "all" | "recent" = "all";
  @state() usageVisibleColumns: string[] = [
    "channel",
    "agent",
    "provider",
    "model",
    "messages",
    "tools",
    "errors",
    "duration",
  ];
  @state() usageLogFilterRoles: import("./views/usage.js").SessionLogRole[] = [];
  @state() usageLogFilterTools: string[] = [];
  @state() usageLogFilterHasTools = false;
  @state() usageLogFilterQuery = "";

  // Non-reactive (don’t trigger renders just for timer bookkeeping).
  usageQueryDebounceTimer: number | null = null;

  @state() cronLoading = false;
  @state() cronQuickCreateOpen = false;
  @state() cronQuickCreateStep: import("./views/cron-quick-create.ts").CronQuickCreateStep = "what";
  @state() cronQuickCreateDraft:
    | import("./views/cron-quick-create.ts").CronQuickCreateDraft
    | null = null;
  @state() cronJobsLoadingMore = false;
  cronJobsReloadPending = false;
  cronJobsReloadPendingTableFilters = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronJobsTotal = 0;
  @state() cronJobsHasMore = false;
  @state() cronJobsNextOffset: number | null = null;
  @state() cronJobsLimit = 50;
  @state() cronJobsQuery = "";
  @state() cronJobsEnabledFilter: import("./types.js").CronJobsEnabledFilter = "all";
  @state() cronJobsScheduleKindFilter: import("./controllers/cron.js").CronJobsScheduleKindFilter =
    "all";
  @state() cronJobsLastStatusFilter: import("./controllers/cron.js").CronJobsLastStatusFilter =
    "all";
  @state() cronJobsSortBy: import("./types.js").CronJobsSortBy = "nextRunAtMs";
  @state() cronJobsSortDir: import("./types.js").CronSortDir = "asc";
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronFormCollapsed = true;
  @state() cronFieldErrors: import("./controllers/cron.js").CronFieldErrors = {};
  @state() cronEditingJobId: string | null = null;
  @state() cronRunsJobId: string | null = null;
  @state() cronRunsLoadingMore = false;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronRunsTotal = 0;
  @state() cronRunsHasMore = false;
  @state() cronRunsNextOffset: number | null = null;
  @state() cronRunsLimit = 50;
  @state() cronRunsScope: import("./types.js").CronRunScope = "all";
  @state() cronRunsStatuses: import("./types.js").CronRunsStatusValue[] = [];
  @state() cronRunsDeliveryStatuses: import("./types.js").CronDeliveryStatus[] = [];
  @state() cronRunsStatusFilter: import("./types.js").CronRunsStatusFilter = "all";
  @state() cronRunsQuery = "";
  @state() cronRunsSortDir: import("./types.js").CronSortDir = "desc";
  @state() cronModelSuggestions: string[] = [];
  @state() cronBusy = false;

  @state() updateAvailable: import("./types.js").UpdateAvailable | null = null;

  // Overview dashboard state
  @state() attentionItems: import("./types.js").AttentionItem[] = [];
  @state() paletteOpen = false;
  @state() paletteQuery = "";
  @state() paletteActiveIndex = 0;
  @state() overviewShowGatewayPassword = false;
  @state() overviewLogLines: string[] = [];
  @state() overviewLogCursor = 0;

  @state() skillsLoading = false;
  @state() skillsAgentId: string | null = null;
  skillsAgentRevision = 0;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillsStatusFilter: "all" | "ready" | "needs-setup" | "disabled" = "all";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};
  @state() skillsDetailKey: string | null = null;
  @state() skillsDetailTab: "overview" | "card" = "overview";
  @state() clawhubSearchQuery = "";
  @state() clawhubSearchResults: ClawHubSearchResult[] | null = null;
  @state() clawhubSearchLoading = false;
  @state() clawhubSearchError: string | null = null;
  @state() clawhubDetail: ClawHubSkillDetail | null = null;
  @state() clawhubDetailSlug: string | null = null;
  @state() clawhubDetailLoading = false;
  @state() clawhubDetailError: string | null = null;
  @state() clawhubInstallSlug: string | null = null;
  @state() clawhubInstallMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict> = {};
  @state() clawhubVerdictsLoading = false;
  @state() clawhubVerdictsError: string | null = null;
  @state() skillCardContents: Record<string, string> = {};
  @state() skillCardContentKeys: Record<string, string> = {};
  @state() skillCardLoadingKey: string | null = null;
  @state() skillCardErrors: Record<string, string> = {};

  @state() healthLoading = false;
  @state() healthResult: HealthSummary | null = null;
  @state() healthError: string | null = null;

  @state() modelAuthStatusLoading = false;
  @state() modelAuthStatusResult: ModelAuthStatusResult | null = null;
  @state() modelAuthStatusError: string | null = null;

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSummary | null = null;
  @state() debugModels: ModelCatalogEntry[] = [];
  @state() debugHeartbeat: unknown = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  @state() webPushSupported = false;
  @state() webPushPermission: NotificationPermission | "unsupported" = "unsupported";
  @state() webPushSubscribed = false;
  @state() webPushLoading = false;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  client: GatewayBrowserClient | null = null;
  chatScrollFrame: number | null = null;
  chatScrollTimeout: number | null = null;
  chatLastScrollTop = 0;
  chatHasAutoScrolled = false;
  chatUserNearBottom = true;
  chatFollowLocked = false;
  chatIsProgrammaticScroll = false;
  chatProgrammaticScrollTarget = 0;
  @state() chatNewMessagesBelow = false;
  nodesPollInterval: number | null = null;
  logsPollInterval: number | null = null;
  debugPollInterval: number | null = null;
  sessionsChangedReloadTimer: number | ReturnType<typeof globalThis.setTimeout> | null = null;
  logsScrollFrame: number | null = null;
  activityScrollFrame: number | null = null;
  controlUiResponsivenessObserver: { disconnect: () => void } | null = null;
  toolStreamById = new Map<string, ToolStreamEntry>();
  toolStreamOrder: string[] = [];
  refreshSessionsAfterChat = new Map<string, import("./ui-types.js").ChatSessionRefreshTarget>();
  chatSideResultTerminalRuns = new Set<string>();
  basePath = "";
  popStateHandler = () =>
    onPopStateInternal(this as unknown as Parameters<typeof onPopStateInternal>[0]);
  topbarObserver: ResizeObserver | null = null;
  private globalKeydownHandler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "k") {
      e.preventDefault();
      this.paletteOpen = !this.paletteOpen;
      if (this.paletteOpen) {
        this.paletteQuery = "";
        this.paletteActiveIndex = 0;
      }
    }
  };
  private chatMobileControlsKeydownHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") {
      return;
    }
    if (this.chatSessionPickerOpen) {
      e.preventDefault();
      this.chatSessionPickerOpen = false;
      this.chatSessionPickerSurface = null;
      return;
    }
    const openComposerDetails = this.querySelectorAll<HTMLDetailsElement>(
      ".chat-controls__inline-select[open]",
    );
    if (openComposerDetails.length > 0) {
      e.preventDefault();
      openComposerDetails.forEach((details) => {
        details.open = false;
      });
      return;
    }
    if (!this.chatMobileControlsOpen) {
      return;
    }
    e.preventDefault();
    this.setChatMobileControlsOpen(false, { restoreFocus: true });
  };
  private chatMobileControlsPointerdownHandler = (e: Event) => {
    const path = e.composedPath();
    this.querySelectorAll<HTMLDetailsElement>(".chat-controls__inline-select[open]").forEach(
      (details) => {
        if (!path.includes(details)) {
          details.open = false;
        }
      },
    );
    if (this.chatSessionPickerOpen) {
      const insidePicker = Array.from(this.querySelectorAll(".chat-controls__session-picker")).some(
        (node) => path.includes(node),
      );
      if (!insidePicker) {
        this.chatSessionPickerOpen = false;
        this.chatSessionPickerSurface = null;
      }
    }
    if (!this.chatMobileControlsOpen) {
      return;
    }
    const wrapper =
      this.querySelector(".chat-settings-popover-wrapper") ??
      this.querySelector(".chat-mobile-controls-wrapper");
    if (wrapper && path.includes(wrapper)) {
      return;
    }
    this.setChatMobileControlsOpen(false);
  };
  private nativeTitleTooltipPointerOverHandler = (event: PointerEvent) => {
    promoteNativeTitleTooltip(event.target, this, "pointer");
  };
  private nativeTitleTooltipPointerOutHandler = (event: PointerEvent) => {
    restoreNativeTitleTooltip(event.target, this, "pointer", event.relatedTarget);
  };
  private nativeTitleTooltipFocusInHandler = (event: FocusEvent) => {
    promoteNativeTitleTooltip(event.target, this, "focus");
  };
  private nativeTitleTooltipFocusOutHandler = (event: FocusEvent) => {
    restoreNativeTitleTooltip(event.target, this, "focus", event.relatedTarget);
  };

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.onSlashAction = async (action: string) => {
      switch (action) {
        case "new-session":
          await createChatSessionInternal(this as unknown as AppViewState);
          break;
        case "export":
          exportChatMarkdown(this.chatMessages, this.assistantName);
          break;
        case "refresh-tools-effective": {
          await refreshVisibleToolsEffectiveForCurrentSessionInternal(this);
          break;
        }
      }
    };
    document.addEventListener("keydown", this.globalKeydownHandler);
    document.addEventListener("keydown", this.chatMobileControlsKeydownHandler);
    document.addEventListener("pointerdown", this.chatMobileControlsPointerdownHandler);
    this.addEventListener("pointerover", this.nativeTitleTooltipPointerOverHandler);
    this.addEventListener("pointerout", this.nativeTitleTooltipPointerOutHandler);
    this.addEventListener("focusin", this.nativeTitleTooltipFocusInHandler);
    this.addEventListener("focusout", this.nativeTitleTooltipFocusOutHandler);
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
    this.nativeBridgeCleanup = initNativeBridge(this);
    void this.initWebPushState();
    // Put saved logistics drafts back on screen, one per request template. Fire-and-forget and
    // silent on failure: it is a convenience the member did not ask for on this visit, so it must
    // never block the first paint or surface an error of its own.
    void restoreAdminBotLogisticsDraft(this);
    void restoreAdminBotLettersDraft(this);
    void restoreAdminBotMeetingDraft(this);
  }

  protected override firstUpdated() {
    handleFirstUpdated(this as unknown as Parameters<typeof handleFirstUpdated>[0]);
  }

  protected override willUpdate() {
    prepareActiveFloatingTooltipsForRender(this);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.globalKeydownHandler);
    this.nativeBridgeCleanup?.();
    this.nativeBridgeCleanup = null;
    document.removeEventListener("keydown", this.chatMobileControlsKeydownHandler);
    document.removeEventListener("pointerdown", this.chatMobileControlsPointerdownHandler);
    this.removeEventListener("pointerover", this.nativeTitleTooltipPointerOverHandler);
    this.removeEventListener("pointerout", this.nativeTitleTooltipPointerOutHandler);
    this.removeEventListener("focusin", this.nativeTitleTooltipFocusInHandler);
    this.removeEventListener("focusout", this.nativeTitleTooltipFocusOutHandler);
    clearActiveFloatingTooltips(this);
    if (this.sessionSwitchNoticeTimer !== null) {
      window.clearTimeout(this.sessionSwitchNoticeTimer);
      this.sessionSwitchNoticeTimer = null;
    }
    if (this.sessionSwitchFlashTimer !== null) {
      window.clearTimeout(this.sessionSwitchFlashTimer);
      this.sessionSwitchFlashTimer = null;
    }
    this.chatMobileControlsTrigger = null;
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  protected override updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(this as unknown as Parameters<typeof handleUpdated>[0], changed);
    refreshActiveFloatingTooltip(this);
    // Some render callbacks assign tab directly while preparing nested panel state.
    if (changed.has("tab") && this.tab !== "chat" && this.chatMobileControlsOpen) {
      this.setChatMobileControlsOpen(false);
    }
    if (!changed.has("sessionKey") || this.agentsPanel !== "tools") {
      return;
    }
    const activeSessionAgentId = resolveAgentIdFromSessionKey(this.sessionKey);
    if (this.agentsSelectedId && this.agentsSelectedId === activeSessionAgentId) {
      void loadToolsEffectiveInternal(this, {
        agentId: this.agentsSelectedId,
        sessionKey: this.sessionKey,
      });
      return;
    }
    this.toolsEffectiveResult = null;
    this.toolsEffectiveResultKey = null;
    this.toolsEffectiveError = null;
    this.toolsEffectiveLoading = false;
    this.toolsEffectiveLoadingKey = null;
  }

  connect() {
    connectGatewayInternal(this as unknown as Parameters<typeof connectGatewayInternal>[0]);
  }

  async submitMemberAuth() {
    await submitMemberAuthInternal(
      this as unknown as Parameters<typeof submitMemberAuthInternal>[0],
    );
  }

  async signOutMember() {
    await signOutMemberInternal(this as unknown as Parameters<typeof signOutMemberInternal>[0]);
  }

  openChangePassword() {
    openChangePasswordInternal(this as unknown as Parameters<typeof openChangePasswordInternal>[0]);
  }

  closeChangePassword() {
    closeChangePasswordInternal(
      this as unknown as Parameters<typeof closeChangePasswordInternal>[0],
    );
  }

  async submitChangePassword() {
    await submitChangePasswordInternal(
      this as unknown as Parameters<typeof submitChangePasswordInternal>[0],
    );
  }

  async loadRoster() {
    await loadRosterInternal(this as unknown as Parameters<typeof loadRosterInternal>[0]);
  }

  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      this as unknown as Parameters<typeof handleChatScrollInternal>[0],
      event,
    );
  }

  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(
      this as unknown as Parameters<typeof handleLogsScrollInternal>[0],
      event,
    );
  }

  handleActivityScroll(event: Event) {
    handleActivityScrollInternal(
      this as unknown as Parameters<typeof handleActivityScrollInternal>[0],
      event,
    );
  }

  scheduleActivityScroll(force = false) {
    scheduleActivityScrollInternal(
      this as unknown as Parameters<typeof scheduleActivityScrollInternal>[0],
      force,
    );
  }

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  resetToolStream() {
    resetToolStreamInternal(this as unknown as Parameters<typeof resetToolStreamInternal>[0]);
  }

  resetChatScroll() {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
  }

  scrollToBottom(opts?: { smooth?: boolean }) {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
    scheduleChatScrollInternal(
      this as unknown as Parameters<typeof scheduleChatScrollInternal>[0],
      true,
      Boolean(opts?.smooth),
      { source: "manual" },
    );
  }

  async loadAssistantIdentity(opts?: { sessionKey?: string; expectedSessionKey?: string }) {
    await loadAssistantIdentityInternal(this, opts);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], next);
  }

  applyLocalUserIdentity(next: { name?: string | null; avatar?: string | null }) {
    applyLocalUserIdentityInternal(
      this as unknown as Parameters<typeof applyLocalUserIdentityInternal>[0],
      next,
    );
  }

  setTab(next: Tab) {
    setTabInternal(this as unknown as Parameters<typeof setTabInternal>[0], next);
    if (next !== "chat") {
      this.setChatMobileControlsOpen(false);
    }
    this.navDrawerOpen = false;
  }

  setChatMobileControlsOpen(
    open: boolean,
    options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
  ) {
    if (open) {
      this.chatMobileControlsTrigger = options?.trigger ?? this.chatMobileControlsTrigger;
      this.chatMobileControlsOpen = true;
      return;
    }

    const focusTarget = options?.restoreFocus ? this.chatMobileControlsTrigger : null;
    this.chatMobileControlsOpen = false;
    if (this.chatSessionPickerSurface === "mobile") {
      this.chatSessionPickerOpen = false;
      this.chatSessionPickerSurface = null;
    }
    this.chatMobileControlsTrigger = null;
    if (!(focusTarget instanceof HTMLElement) || !focusTarget.isConnected) {
      return;
    }
    requestAnimationFrame(() => {
      if (focusTarget.isConnected) {
        focusTarget.focus();
      }
    });
  }

  setTheme(next: ThemeName, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(this as unknown as Parameters<typeof setThemeInternal>[0], next, context);
    this.themeOrder = this.buildThemeOrder(next);
  }

  setThemeMode(next: ThemeMode, context?: Parameters<typeof setThemeModeInternal>[2]) {
    setThemeModeInternal(
      this as unknown as Parameters<typeof setThemeModeInternal>[0],
      next,
      context,
    );
  }

  setCustomThemeImportUrl(next: string) {
    this.customThemeImportUrl = next;
    if (this.customThemeImportMessage?.kind === "error") {
      this.customThemeImportMessage = null;
    }
  }

  openCustomThemeImport() {
    this.customThemeImportExpanded = true;
    this.customThemeImportFocusToken += 1;
    if (!this.settings.customTheme) {
      this.customThemeImportSelectOnSuccess = true;
    }
  }

  async importCustomTheme() {
    if (this.customThemeImportBusy) {
      return;
    }
    this.customThemeImportExpanded = true;
    this.customThemeImportBusy = true;
    this.customThemeImportMessage = null;
    try {
      const customTheme = await importCustomThemeFromUrl(this.customThemeImportUrl);
      const shouldSelectImportedTheme =
        this.theme === "custom" ||
        !this.settings.customTheme ||
        this.customThemeImportSelectOnSuccess;
      applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
        ...this.settings,
        theme: shouldSelectImportedTheme ? "custom" : this.settings.theme,
        customTheme,
      });
      this.themeOrder = this.buildThemeOrder(shouldSelectImportedTheme ? "custom" : this.theme);
      this.customThemeImportUrl = "";
      this.customThemeImportSelectOnSuccess = false;
      this.customThemeImportMessage = {
        kind: "success",
        text: `Imported ${customTheme.label}.`,
      };
    } catch (error) {
      this.customThemeImportMessage = {
        kind: "error",
        text: error instanceof Error ? error.message : "Failed to import tweakcn theme.",
      };
    } finally {
      this.customThemeImportBusy = false;
    }
  }

  clearCustomTheme() {
    const nextTheme = this.theme === "custom" ? "claw" : this.theme;
    this.customThemeImportExpanded = true;
    this.customThemeImportSelectOnSuccess = false;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      theme: nextTheme,
      customTheme: undefined,
    });
    this.themeOrder = this.buildThemeOrder(nextTheme);
    this.customThemeImportMessage = {
      kind: "success",
      text: "Cleared custom theme.",
    };
  }

  setBorderRadius(value: number) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      borderRadius: value,
    });
    this.requestUpdate();
  }

  setTextScale(value: number) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      textScale: value as typeof this.settings.textScale,
    });
    this.requestUpdate();
  }

  announceSessionSwitch(sessionKey: string, label: string) {
    const id = ++this.sessionSwitchNoticeSeq;
    if (this.sessionSwitchNoticeTimer !== null) {
      window.clearTimeout(this.sessionSwitchNoticeTimer);
    }
    if (this.sessionSwitchFlashTimer !== null) {
      window.clearTimeout(this.sessionSwitchFlashTimer);
    }
    this.sessionSwitchNotice = {
      id,
      text: t("chat.switchedSession", { session: label }),
    };
    this.sessionSwitchFlashKey = sessionKey;
    this.sessionSwitchFlashTimer = window.setTimeout(() => {
      if (this.sessionSwitchNotice?.id === id) {
        this.sessionSwitchFlashKey = null;
      }
      this.sessionSwitchFlashTimer = null;
    }, 200);
    this.sessionSwitchNoticeTimer = window.setTimeout(() => {
      if (this.sessionSwitchNotice?.id === id) {
        this.sessionSwitchNotice = null;
      }
      this.sessionSwitchNoticeTimer = null;
    }, 2800);
  }

  buildThemeOrder(active: ThemeName): ThemeName[] {
    const all = [...VALID_THEME_NAMES];
    const rest = all.filter((id) => id !== active);
    return [active, ...rest];
  }

  async loadOverview(opts?: { refresh?: boolean }) {
    await loadOverviewInternal(this as unknown as Parameters<typeof loadOverviewInternal>[0], opts);
  }

  async loadCron() {
    await loadCronInternal(this as unknown as Parameters<typeof loadCronInternal>[0]);
  }

  async handleAbortChat(opts?: Parameters<typeof handleAbortChatInternal>[1]) {
    await handleAbortChatInternal(
      this as unknown as Parameters<typeof handleAbortChatInternal>[0],
      opts,
    );
  }

  handleChatDraftChange(next: string) {
    handleChatDraftChangeInternal(
      this as unknown as Parameters<typeof handleChatDraftChangeInternal>[0],
      next,
    );
  }

  handleChatInputHistoryKey(input: ChatInputHistoryKeyInput): ChatInputHistoryKeyResult {
    return handleChatInputHistoryKeyInternal(
      this as unknown as Parameters<typeof handleChatInputHistoryKeyInternal>[0],
      input,
    );
  }

  resetChatInputHistoryNavigation() {
    resetChatInputHistoryNavigationInternal(
      this as unknown as Parameters<typeof resetChatInputHistoryNavigationInternal>[0],
    );
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      this as unknown as Parameters<typeof removeQueuedMessageInternal>[0],
      id,
    );
  }

  async retryQueuedChatMessage(id: string) {
    await retryQueuedChatMessageInternal(
      this as unknown as Parameters<typeof retryQueuedChatMessageInternal>[0],
      id,
    );
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    await handleSendChatInternal(
      this as unknown as Parameters<typeof handleSendChatInternal>[0],
      messageOverride,
      opts,
    );
  }

  async steerQueuedChatMessage(id: string) {
    await steerQueuedChatMessageInternal(
      this as unknown as Parameters<typeof steerQueuedChatMessageInternal>[0],
      id,
    );
  }

  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      const method = active.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
      await this.client.request(method, {
        id: active.id,
        decision,
      });
      dismissExecApprovalPrompt(this, active.id);
    } catch (err) {
      if (isStaleApprovalResolutionError(err)) {
        dismissExecApprovalPrompt(this, active.id);
        await refreshPendingApprovalQueue(this);
        return;
      }
      if (!this.execApprovalQueue.some((entry) => entry.id === active.id)) {
        return;
      }
      this.execApprovalError = `Approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  handleExecApprovalSecretInput(value: string) {
    this.execApprovalSecretValue = value;
  }

  async handleExecApprovalSecretSubmit() {
    const active = this.execApprovalQueue[0];
    if (!active || active.kind !== "secret" || !this.client || this.execApprovalBusy) {
      return;
    }
    if (!this.execApprovalSecretValue) {
      this.execApprovalError = "Password required.";
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      await this.client.request("operator.secret.resolve", {
        id: active.id,
        value: this.execApprovalSecretValue,
      });
      this.execApprovalSecretValue = "";
      dismissExecApprovalPrompt(this, active.id);
    } catch (err) {
      if (!this.execApprovalQueue.some((entry) => entry.id === active.id)) {
        return;
      }
      this.execApprovalError = `Secret prompt failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  async handleExecApprovalSecretCancel() {
    const active = this.execApprovalQueue[0];
    if (!active || active.kind !== "secret" || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      await this.client.request("operator.secret.resolve", {
        id: active.id,
        cancelled: true,
      });
      this.execApprovalSecretValue = "";
      dismissExecApprovalPrompt(this, active.id);
    } catch (err) {
      if (!this.execApprovalQueue.some((entry) => entry.id === active.id)) {
        return;
      }
      this.execApprovalError = `Secret prompt failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  sendOnboardingGuide(options: { preview: boolean }): Promise<void> {
    return sendOnboardingGuideController(
      this as unknown as Parameters<typeof sendOnboardingGuideController>[0],
      options,
    );
  }

  loadCalendarEvents(): Promise<void> {
    return loadAdminBotCalendar(this as unknown as Parameters<typeof loadAdminBotCalendar>[0]);
  }

  loadLocationPrompt(): Promise<void> {
    return loadAdminBotLocationPrompt(
      this as unknown as Parameters<typeof loadAdminBotLocationPrompt>[0],
    );
  }

  loadLocationDrifts(): Promise<void> {
    return loadAdminBotLocationDrifts(
      this as unknown as Parameters<typeof loadAdminBotLocationDrifts>[0],
    );
  }

  answerLocationPrompt(answer: { current_city?: string; timezone?: string }): Promise<void> {
    return answerAdminBotLocationPrompt(
      this as unknown as Parameters<typeof answerAdminBotLocationPrompt>[0],
      answer,
    );
  }

  loadMeetings(): Promise<void> {
    return loadAdminBotMeetings(this as unknown as Parameters<typeof loadAdminBotMeetings>[0]);
  }

  toggleMeetingAttendance(
    meetingId: string,
    attendee: Parameters<typeof setAdminBotMeetingAttendance>[2],
  ): Promise<void> {
    return setAdminBotMeetingAttendance(
      this as unknown as Parameters<typeof setAdminBotMeetingAttendance>[0],
      meetingId,
      attendee,
    );
  }

  async fileMeeting(draft: Parameters<typeof fileAdminBotMeeting>[1]): Promise<void> {
    await fileAdminBotMeeting(this as unknown as Parameters<typeof fileAdminBotMeeting>[0], draft);
  }

  requestCalendarDraft(): Promise<void> {
    return requestAdminBotCalendarDraft(
      this as unknown as Parameters<typeof requestAdminBotCalendarDraft>[0],
    );
  }

  saveCalendarEvent(): Promise<void> {
    return saveAdminBotCalendarEvent(
      this as unknown as Parameters<typeof saveAdminBotCalendarEvent>[0],
    );
  }

  // The view owns the selection, so it composes the addresses and the reason; the controller only
  // sends what it is handed.
  async sendCalendarInvites(): Promise<void> {
    const { calendarInviteSelection } = await import("./adminbot/views/calendar.ts");
    const selection = calendarInviteSelection(this as unknown as AppViewState);
    if (!selection.event || !selection.emails.length) {
      return;
    }
    await inviteAdminBotCalendarAudience(
      this as unknown as Parameters<typeof inviteAdminBotCalendarAudience>[0],
      { event: selection.event, emails: selection.emails, reason: selection.reason },
    );
  }

  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    const nextToken = this.pendingGatewayToken?.trim() || "";
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
      token: nextToken,
    });
    restoreChatComposerState(this, { preserveCurrent: true });
    this.connect();
  }

  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
    restoreChatComposerState(this, { preserveCurrent: true });
  }

  private async maybeUpgradeSidebarToFullMessage(content: SidebarContent) {
    const request = content.fullMessageRequest;
    if (!request || !this.client) {
      return;
    }
    try {
      const result = (await this.client.request("chat.message.get", {
        sessionKey: request.sessionKey,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        messageId: request.messageId,
        maxChars: FULL_MESSAGE_SIDEBAR_MAX_CHARS,
      })) as
        | {
            ok?: boolean;
            message?: unknown;
            unavailableReason?: "not_found" | "oversized" | "not_visible";
          }
        | undefined;

      if (this.sidebarContent !== content) {
        return;
      }

      if (!result?.ok || !result.message || typeof result.message !== "object") {
        this.sidebarContent = {
          ...content,
          unavailableReason: result?.unavailableReason ?? "not_found",
        };
        this.sidebarError = resolveSidebarUnavailableReason(
          result?.unavailableReason ?? "not_found",
        );
        return;
      }

      const message = result.message as Record<string, unknown>;
      const fetchedMessageText =
        typeof message.text === "string"
          ? message.text
          : typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .map((block) =>
                    block &&
                    typeof block === "object" &&
                    typeof (block as { text?: unknown }).text === "string"
                      ? (block as { text: string }).text
                      : null,
                  )
                  .filter((value): value is string => typeof value === "string")
                  .join("\n")
              : null;
      const nextRawText =
        fetchedMessageText ??
        (typeof content.rawText === "string"
          ? content.rawText
          : content.kind === "markdown"
            ? content.content
            : null);

      if (content.kind === "markdown") {
        this.sidebarContent = {
          ...content,
          content: nextRawText || content.content,
          rawText: nextRawText || content.rawText || content.content,
          unavailableReason: null,
        };
      } else {
        this.sidebarContent = {
          ...content,
          rawText: nextRawText || content.rawText || null,
          unavailableReason: null,
        };
      }
      this.sidebarError = null;
    } catch (err) {
      if (this.sidebarContent !== content) {
        return;
      }
      this.sidebarError = `Failed to load full content: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: SidebarContent) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
    if (isSidebarMarkdownLike(content) && content.fullMessageRequest) {
      void this.maybeUpgradeSidebarToFullMessage(content);
    }
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) {
        return;
      }
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  private async initWebPushState() {
    const supported =
      "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    this.webPushSupported = supported;
    this.webPushPermission = supported ? Notification.permission : "unsupported";
    if (supported) {
      try {
        const { getExistingSubscription } = await import("./push-subscription.ts");
        const existing = await getExistingSubscription();
        this.webPushSubscribed = existing !== null;
      } catch {
        // ignore — just means we can't check
      }
    }
  }

  /** Re-register local push subscription with the gateway after connect. */
  async reconcileWebPushState() {
    if (!this.client) {
      return;
    }
    try {
      // Always check PushManager directly — initWebPushState may not have finished
      // yet if gateway connected quickly.
      const { getExistingSubscription } = await import("./push-subscription.ts");
      const existing = await getExistingSubscription();
      if (!existing) {
        return;
      }
      this.webPushSubscribed = true;
      const subJson = existing.toJSON();
      if (subJson.endpoint && subJson.keys?.p256dh && subJson.keys?.auth) {
        await this.client.request("push.web.subscribe", {
          endpoint: subJson.endpoint,
          keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
        });
      }
    } catch {
      // Best-effort — don't block if gateway is unreachable.
    }
  }

  async handleWebPushSubscribe() {
    if (!this.client || this.webPushLoading) {
      return;
    }
    this.webPushLoading = true;
    try {
      const { subscribeToWebPush } = await import("./push-subscription.ts");
      await subscribeToWebPush(this.client);
      this.webPushSubscribed = true;
      this.webPushPermission = Notification.permission;
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.webPushLoading = false;
      // Always refresh permission state — catches denied prompts too.
      if ("Notification" in window) {
        this.webPushPermission = Notification.permission;
      }
    }
  }

  async handleWebPushUnsubscribe() {
    if (!this.client || this.webPushLoading) {
      return;
    }
    this.webPushLoading = true;
    try {
      const { unsubscribeFromWebPush } = await import("./push-subscription.ts");
      await unsubscribeFromWebPush(this.client);
      this.webPushSubscribed = false;
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.webPushLoading = false;
    }
  }

  async handleWebPushTest() {
    if (!this.client) {
      return;
    }
    try {
      const { sendTestWebPush } = await import("./push-subscription.ts");
      await sendTestWebPush(this.client);
    } catch (err) {
      this.lastError = String(err);
    }
  }

  override render() {
    return renderApp(this as unknown as AppViewState);
  }
}

if (!customElements.get("openclaw-app")) {
  customElements.define("openclaw-app", OpenClawApp);
}
