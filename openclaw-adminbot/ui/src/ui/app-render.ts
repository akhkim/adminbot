// oxlint-disable max-lines -- grandfathered at 3976 lines; see docs/adr/0006-deferred-monster-splits.md
// Control UI module implements app render behavior.
import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import { styleMap } from "lit/directives/style-map.js";
import { i18n, t } from "../i18n/index.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import {
  canAccessTab,
  resolveAccessRole,
  resolveAccessibleTab,
  visibleTabsForRole,
  type AccessRole,
} from "./adminbot/access.ts";
import {
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  submitFeedback,
} from "./adminbot/auth/session.ts";
import {
  applyAdminBotOwnProfilePhoto,
  approveAdminBotAction,
  runAdminBotCvDigestJob,
  runAdminBotVenueIndexJob,
  searchAdminBotVenuePapers,
  setAdminBotVenue,
  setAdminBotVenueInterests,
  toggleAdminBotVenueAbstract,
  deleteAdminBotPaper,
  executeAdminBotAction,
  generateAdminBotReimbursement,
  loadAdminBot,
  polishAdminBotOwnProfilePhoto,
  removePendingAdminBotAction,
  resetAdminBotReimbursement,
  mergeAdminBotMembers,
  saveAdminBotMember,
  saveAdminBotOwnProfile,
  saveAdminBotOwnSchedule,
  saveAdminBotPaper,
  saveAdminBotSensitiveInfo,
  markAdminBotNudgesSeen,
  saveAdminBotSettings,
  sendAdminBotMemberNudge,
  sendAdminBotReimbursementMessage,
  setAdminBotNudgeChannel,
  setAdminBotNudgeMessage,
  setAdminBotNudgeRecipients,
  setAdminBotNudgeSubject,
  toggleAdminBotNudgeRecipient,
} from "./adminbot/controllers/admin.ts";
import type { AdminBotLoadMode } from "./adminbot/controllers/admin.ts";
import {
  downloadAdminBotLogisticsDocument,
  loadAdminBotLogisticsRequests,
  openAdminBotLogisticsRequest,
  sendAdminBotSignedDocuments,
  setAdminBotLogisticsRequestStatus,
  submitAdminBotLogisticsRequest,
  updateAdminBotLogisticsRequest,
  withdrawAdminBotLogisticsRequest,
} from "./adminbot/controllers/logistics.ts";
import {
  circulateAdminBotSocialDraft,
  loadAdminBotNudgeBatches,
  loadAdminBotPaperSlotOverview,
  nudgeAdminBotPaperAuthors,
  recordAdminBotSocialConsent,
  saveAdminBotPaperSlot,
  saveAdminBotPaperWeeklyUpdate,
  saveAdminBotSocialDraft,
  setAdminBotPaperAttendee,
  setAdminBotPaperReimbursement,
  toggleAdminBotPaperCard,
  toggleAdminBotPaperNudgeRecipient,
} from "./adminbot/controllers/paper-slots.ts";
import {
  loadAdminBotProfileOverview,
  remindAdminBotIncompleteProfiles,
} from "./adminbot/controllers/profile-overview.ts";
import {
  clearLogisticsDraft,
  createFactRow,
  createSchoolRow,
  clearMeetingRequestDraft,
  clearRecommendationLettersDraft,
  logisticsDraftScope,
  restoreAdminBotLettersDraft,
  restoreAdminBotLogisticsDraft,
  restoreAdminBotMeetingDraft,
  saveAdminBotLettersDraft,
  saveAdminBotLogisticsDraft,
  saveAdminBotMeetingDraft,
} from "./adminbot/data/logistics-draft.ts";
import {
  describeSubmitBlock,
  filesToAttachments,
  filledFacts,
  filledMeetings,
  filledSchools,
  lettersRequestInput,
  meetingRequestInput,
  requestToFormState,
  signatureRequestInput,
  type LettersFormState,
  type LogisticsRequestInput,
  type LogisticsRequestKind,
  type MeetingFormState,
  type SignatureFormState,
} from "./adminbot/data/logistics-requests.ts";
import "./components/feedback-widget.ts";
import {
  decideAdminBotRegistration,
  loadAdminBotRegistrations,
} from "./adminbot/data/registrations.ts";
import { feedbackConfigForTab } from "./adminbot/feedback-tab.ts";
import { agoLabel, alertText, nudgeAlerts } from "./adminbot/nudge-alerts.ts";
import { renderAdminBot, type AdminBotPanel } from "./adminbot/views/admin.ts";
import {
  renderChangePasswordPopover,
  renderChangePasswordTrigger,
} from "./adminbot/views/change-password.ts";
import { renderDashboard } from "./adminbot/views/dashboard.ts";
import { renderLabSharing } from "./adminbot/views/lab-sharing.ts";
import { renderLanding } from "./adminbot/views/landing.ts";
import { renderLocationPrompt } from "./adminbot/views/location-prompt.ts";
import { renderLoginGate } from "./adminbot/views/login-gate.ts";
import { renderAdminBotLogistics, type LogisticsTemplate } from "./adminbot/views/logistics.ts";
import { renderAdminBotMeetings } from "./adminbot/views/meetings.ts";
import { ownPapers, renderMyWork, type MyWorkProps } from "./adminbot/views/my-work.ts";
import { renderOnboardingChecklist } from "./adminbot/views/onboarding-checklist.ts";
import { renderAdminBotProfileOverview } from "./adminbot/views/profile-overview.ts";
import { renderProfile } from "./adminbot/views/profile.ts";
import { renderPublicShell } from "./adminbot/views/public-shell.ts";
import { EMPTY_TRIP_DRAFT } from "./adminbot/views/time-availability.trips.ts";
import {
  EMPTY_MILESTONE_DRAFT,
  EMPTY_TIME_AVAILABILITY_DRAFT,
  renderAdminBotTimeAvailability,
} from "./adminbot/views/time-availability.ts";
import {
  createChatSessionsLoadOverrides,
  hasAbortableSessionRun,
  refreshChat,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
} from "./app-chat.ts";
import { renderUsageTab } from "./app-render-usage-tab.ts";
import {
  renderChatControls,
  renderTab,
  resolveAdminBotMode,
  resolveAssistantAttachmentAuthToken,
  resolveDashboardHeaderContext,
  renderSidebarConnectionStatus,
  renderTopbarThemeModeToggle,
  createChatSession,
  dismissChatError,
  switchChatSession,
} from "./app-render.helpers.ts";
import { warnQueryToken } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { reconcileChatRunLifecycle } from "./chat/run-lifecycle.ts";
import { renderChatSessionSelect } from "./chat/session-controls.ts";
import { clearChatMessagesFromCache } from "./chat/session-message-cache.ts";
import {
  controlUiNowMs,
  recordControlUiRenderTiming,
  roundedControlUiDurationMs,
} from "./control-ui-performance.ts";
import { loadAgentFileContent, loadAgentFiles, saveAgentFile } from "./controllers/agent-files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./controllers/agent-identity.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import {
  buildToolsEffectiveRequestKey,
  loadAgents,
  loadToolsCatalog,
  loadToolsEffective,
  resetToolsEffectiveState,
  refreshVisibleToolsEffectiveForCurrentSession,
  saveAgentsConfig,
} from "./controllers/agents.ts";
import { setAssistantAvatarOverride } from "./controllers/assistant-identity.ts";
import { loadChannels } from "./controllers/channels.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import {
  applyConfig,
  ensureAgentConfigEntry,
  findAgentConfigEntryIndex,
  loadConfig,
  openConfigFile,
  resetConfigPendingChanges,
  runUpdate,
  saveConfig,
  stageDefaultAgentConfigEntry,
  stageConfigPreset,
  updateConfigRawValue,
  updateConfigFormValue,
  removeConfigFormValue,
  updateMcpServerEnabled,
} from "./controllers/config.ts";
import {
  buildNewCronForm,
  loadCronJobsPage,
  loadCronRuns,
  loadMoreCronRuns,
  toggleCronJob,
  runCronJob,
  removeCronJob,
  addCronJob,
  startCronEdit,
  startCronClone,
  cancelCronEdit,
  validateCronForm,
  hasCronFormErrors,
  normalizeCronFormState,
  prepareNewCronForm,
  getVisibleCronJobs,
  updateCronJobsFilter,
  updateCronRunsFilter,
} from "./controllers/cron.ts";
import { loadDebug, callDebugMethod } from "./controllers/debug.ts";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices.ts";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";
import {
  branchSessionFromCheckpoint,
  deleteSessionsAndRefresh,
  loadSessions,
  parseSessionsFilterInteger,
  patchSession,
  restoreSessionFromCheckpoint,
  toggleSessionCompactionCheckpoints,
} from "./controllers/sessions.ts";
import {
  closeClawHubDetail,
  installFromClawHub,
  loadSkillCard,
  installSkill,
  loadClawHubDetail,
  loadSkills,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  searchClawHub,
  setClawHubSearchQuery,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
} from "./controllers/skills.ts";
import "./components/dashboard-header.ts";
import { getCronJobPayload } from "./cron-payload.ts";
import { formatTimeMs } from "./format.ts";
import { formatRelativeTimestamp } from "./format.ts";
import { icons } from "./icons.ts";
import { createLazyView, renderLazyView } from "./lazy-view.ts";
import {
  iconForTab,
  isSettingsTab,
  normalizeBasePath,
  pathForTab,
  SETTINGS_TABS,
  TAB_GROUPS,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "./navigation.ts";
import { isCronSessionKey, resolveSessionDisplayName } from "./session-display.ts";
import {
  buildAgentMainSessionKey,
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "./session-key.ts";
import type { SidebarContent } from "./sidebar-content.ts";
import { loadLocalAssistantIdentity } from "./storage.ts";
import { normalizeStringEntries } from "./string-coerce.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import type {
  ArtifactDownloadResult,
  GatewaySessionRow,
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
} from "./types.ts";
import { isRenderableControlUiAvatarUrl } from "./views/agents-utils.ts";
import { agentLogoUrl } from "./views/agents-utils.ts";
import {
  resolveAgentConfig,
  resolveConfiguredCronModelSuggestions,
  resolveEffectiveModelFallbacks,
  resolveModelPrimary,
  sortLocaleStrings,
} from "./views/agents-utils.ts";
import { renderChat } from "./views/chat.ts";
import { renderCommandPalette } from "./views/command-palette.ts";
import { getPresetById } from "./views/config-presets.ts";
import { renderQuickSettings, type QuickSettingsChannel } from "./views/config-quick.ts";
import { renderConfig, type ConfigProps } from "./views/config.ts";
import {
  renderCronQuickCreate,
  createDefaultDraft,
  draftToCronFormPatch,
} from "./views/cron-quick-create.ts";
import { renderExecApprovalPrompt } from "./views/exec-approval.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderGuestReimbursements } from "./views/guest-reimbursements.ts";
import { renderMcp } from "./views/mcp.ts";
import { renderOverview } from "./views/overview.ts";

let pendingUpdate: (() => void) | undefined;

const notifyLazyViewChanged = () => pendingUpdate?.();

function runUiTask<Args extends unknown[]>(
  task: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
  return (...args) => {
    void task(...args);
  };
}

/**
 * Whose drafts the logistics forms are currently showing.
 *
 * Drafts live in IndexedDB, which is per-origin rather than per-account: without a scope, a shared
 * machine hands the next person the last one's half-written request and their attached documents.
 * The submitted requests carry their owner from the service, so this is only about the local half.
 */
function adminBotLogisticsScope(state: AppViewState): string {
  return logisticsDraftScope(state.memberId);
}

/** The three form states, in the shape the request builders and the "can this be sent" check want. */
function adminBotSignatureForm(state: AppViewState): SignatureFormState {
  return {
    files: state.adminBotLogisticsSignatureFiles,
    description: state.adminBotLogisticsDescription,
    attachments: state.adminBotLogisticsAttachments,
  };
}

function adminBotLettersForm(state: AppViewState): LettersFormState {
  return {
    schools: state.adminBotLettersSchools,
    facts: state.adminBotLettersFacts,
    cvOverleafUrl: state.adminBotLettersCvOverleafUrl,
    driveFolderUrl: state.adminBotLettersDriveFolderUrl,
  };
}

/** The form behind one template, in the shape the builders and the "can this be sent" check want. */
function adminBotLogisticsForm(
  state: AppViewState,
  template: LogisticsTemplate,
): SignatureFormState | LettersFormState | MeetingFormState {
  if (template === "documentSignature") {
    return adminBotSignatureForm(state);
  }
  if (template === "recommendationLetters") {
    return adminBotLettersForm(state);
  }
  return { rows: state.adminBotMeetingRows };
}

const LOGISTICS_KIND: Record<LogisticsTemplate, LogisticsRequestKind> = {
  documentSignature: "document_signature",
  recommendationLetters: "recommendation_letters",
  bookMeeting: "book_meeting",
};

/** Whether there is anything on this form to lose, which is what Discard is offered for. */
function adminBotLogisticsHasContent(state: AppViewState, template: LogisticsTemplate): boolean {
  if (template === "documentSignature") {
    return Boolean(
      state.adminBotLogisticsSignatureFiles.length ||
      state.adminBotLogisticsDescription.trim() ||
      state.adminBotLogisticsAttachments.length,
    );
  }
  if (template === "recommendationLetters") {
    return Boolean(
      filledSchools(state.adminBotLettersSchools).length ||
      filledFacts(state.adminBotLettersFacts).length ||
      state.adminBotLettersCvOverleafUrl.trim() ||
      state.adminBotLettersDriveFolderUrl.trim(),
    );
  }
  return filledMeetings(state.adminBotMeetingRows).length > 0;
}

/** Everything a form loses when it is discarded, or when the request it held has been filed. */
function resetAdminBotLogisticsForm(state: AppViewState, template: LogisticsTemplate): void {
  if (template === "documentSignature") {
    state.adminBotLogisticsSignatureFiles = [];
    state.adminBotLogisticsDescription = "";
    state.adminBotLogisticsAttachments = [];
    state.adminBotLogisticsSavedAt = null;
    state.adminBotLogisticsSaveError = null;
    return;
  }
  if (template === "recommendationLetters") {
    // Back to one blank row rather than none: an empty table has nothing to type in.
    state.adminBotLettersSchools = [createSchoolRow()];
    state.adminBotLettersFacts = [createFactRow()];
    state.adminBotLettersCvOverleafUrl = "";
    state.adminBotLettersDriveFolderUrl = "";
    state.adminBotLettersSavedAt = null;
    state.adminBotLettersSaveError = null;
    return;
  }
  // Book Meeting opens empty on purpose: creating a row stamps "submitted", so a blank one would
  // claim a request nobody made.
  state.adminBotMeetingRows = [];
  state.adminBotMeetingSavedAt = null;
  state.adminBotMeetingSaveError = null;
}

async function clearAdminBotLogisticsDraft(
  template: LogisticsTemplate,
  scope: string,
): Promise<void> {
  try {
    if (template === "documentSignature") {
      await clearLogisticsDraft(scope);
    } else if (template === "recommendationLetters") {
      await clearRecommendationLettersDraft(scope);
    } else {
      await clearMeetingRequestDraft(scope);
    }
  } catch {
    // A draft that would not clear is a stale form, not lost work: the member is looking at an
    // empty one either way, and reporting a storage failure here would be noise.
  }
}

function adminBotLogisticsRequestInput(
  state: AppViewState,
  template: LogisticsTemplate,
): Promise<LogisticsRequestInput> {
  if (template === "documentSignature") {
    // The only one that is async: the picked files are read into base64 here.
    return signatureRequestInput(adminBotSignatureForm(state));
  }
  if (template === "recommendationLetters") {
    return Promise.resolve(lettersRequestInput(adminBotLettersForm(state)));
  }
  return Promise.resolve(meetingRequestInput({ rows: state.adminBotMeetingRows }));
}

/**
 * Submit, discard and "why not" for one request template.
 *
 * Shared by all three because the three differ only in which form state they read: the button
 * behaviour -- refuse to double-send, clear the form and its draft once the service has the
 * request, leave everything untouched when it does not -- is the same request either way.
 */
function adminBotLogisticsSubmitProps(
  state: AppViewState,
  requestHostUpdate: (() => void) | undefined,
  template: LogisticsTemplate,
) {
  const form = adminBotLogisticsForm(state, template);
  const kind = LOGISTICS_KIND[template];
  const blocked = state.memberId
    ? describeSubmitBlock(kind, form)
    : // Signing in is the first thing missing, and saying so beats a 401 after the upload.
      ({ reason: "signed-out" } as const);
  return {
    submitting: state.adminBotLogisticsSubmitting,
    submitError: state.adminBotLogisticsSubmitError,
    submitted: Boolean(state.adminBotLogisticsSubmittedId),
    submitBlocked: blocked,
    hasContent: adminBotLogisticsHasContent(state, template),
    editing: Boolean(state.adminBotLogisticsEditingId),
    onCancelEdit: () => {
      state.adminBotLogisticsEditingId = null;
      resetAdminBotLogisticsForm(state, template);
      requestHostUpdate?.();
    },
    onSubmit: () => {
      if (blocked) {
        // Nothing to send yet. The reason is already on screen next to the button, so pressing it
        // is how a member finds out rather than a dead click.
        return;
      }
      void (async () => {
        const input = await adminBotLogisticsRequestInput(state, template);
        const editingId = state.adminBotLogisticsEditingId;
        // A correction is a PUT against the request already in the queue: sending it as a new one
        // would leave the member with two asks for the same thing and an admin deciding which is
        // current.
        const filed = editingId
          ? await updateAdminBotLogisticsRequest(state, editingId, input)
          : Boolean(
              await submitAdminBotLogisticsRequest(state, input, adminBotLogisticsScope(state)),
            );
        if (filed) {
          state.adminBotLogisticsEditingId = null;
          state.adminBotLogisticsSubmittedId = editingId ?? state.adminBotLogisticsSubmittedId;
          resetAdminBotLogisticsForm(state, template);
        }
        requestHostUpdate?.();
      })();
    },
    onDiscard: () => {
      void (async () => {
        resetAdminBotLogisticsForm(state, template);
        state.adminBotLogisticsSubmittedId = null;
        state.adminBotLogisticsSubmitError = null;
        await clearAdminBotLogisticsDraft(template, adminBotLogisticsScope(state));
        requestHostUpdate?.();
      })();
    },
  };
}

function renderSettingsSectionNav(state: AppViewState) {
  if (!isSettingsTab(state.tab)) {
    return nothing;
  }
  return html`
    <nav class="settings-section-nav" aria-label=${t("common.settingsSections")}>
      ${SETTINGS_TABS.map((tab) => {
        const active = state.tab === tab;
        const href = pathForTab(tab, state.basePath);
        return html`
          <a
            href=${href}
            class="settings-section-nav__item ${active ? "settings-section-nav__item--active" : ""}"
            @click=${(event: MouseEvent) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              state.setTab(tab);
            }}
            title=${titleForTab(tab)}
          >
            <span class="settings-section-nav__icon" aria-hidden="true"
              >${icons[iconForTab(tab)]}</span
            >
            <span class="settings-section-nav__label">${titleForTab(tab)}</span>
          </a>
        `;
      })}
    </nav>
  `;
}

function renderSettingsWorkspace(state: AppViewState, body: unknown) {
  return html`
    <section class="settings-workspace">
      ${renderSettingsSectionNav(state)}
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}

function isChatSessionBusy(state: AppViewState) {
  return (
    state.chatLoading ||
    state.chatSending ||
    Boolean(state.chatRunId) ||
    state.chatStream !== null ||
    state.chatQueue.length > 0
  );
}

function resolveChatDefaultAgentId(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  return normalizeAgentId(
    state.agentsList?.defaultId ?? snapshot?.sessionDefaults?.defaultAgentId ?? "main",
  );
}

function resolveChatSelectedAgentId(state: AppViewState): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed) {
    return normalizeAgentId(parsed.agentId);
  }
  const sessionKey = normalizeOptionalString(state.sessionKey)?.toLowerCase();
  const fallbackAgentId =
    sessionKey === "global" || sessionKey === "unknown"
      ? (state.assistantAgentId ?? resolveChatDefaultAgentId(state))
      : resolveChatDefaultAgentId(state);
  return normalizeAgentId(fallbackAgentId);
}

function isChatSessionForSelectedAgent(
  state: AppViewState,
  row: GatewaySessionRow,
  selectedAgentId: string,
): boolean {
  return isSessionKeyTiedToAgent(row.key, selectedAgentId, resolveChatDefaultAgentId(state));
}

function resolveChatRecentSessions(state: AppViewState): GatewaySessionRow[] {
  const selectedAgentId = resolveChatSelectedAgentId(state);
  const shouldFilterByAgent =
    normalizeOptionalString(state.sessionKey)?.toLowerCase() !== "unknown";
  return (state.sessionsResult?.sessions ?? [])
    .filter(
      (row) =>
        !row.archived &&
        row.kind !== "global" &&
        row.kind !== "unknown" &&
        row.kind !== "cron" &&
        !isCronSessionKey(row.key) &&
        !isSubagentSessionKey(row.key) &&
        !row.spawnedBy &&
        (!shouldFilterByAgent || isChatSessionForSelectedAgent(state, row, selectedAgentId)),
    )
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 5);
}

// Session controls belong to the chat tab, not the app shell: creating and
// switching sessions says nothing about Deadlines, Members or Admin. They render
// as a toolbar above the thread, so nav collapse no longer gates them.
function renderChatSessionControls(state: AppViewState) {
  const busy = isChatSessionBusy(state);
  const recent = resolveChatRecentSessions(state);
  const newSessionDisabled = !state.connected || state.sessionsLoading || busy || !state.client;
  const newSessionTitle = !state.connected
    ? "Connect to create a new session"
    : busy
      ? "Finish the active run before creating a new session"
      : "New session";

  return html`
    <section class="chat-sessions" aria-label=${t("chat.runControls.newSession")}>
      <div class="chat-sessions__toolbar">
        <button
          type="button"
          class="chat-sessions__new"
          title=${newSessionTitle}
          aria-label=${t("chat.runControls.newSession")}
          ?disabled=${newSessionDisabled}
          @click=${async () => {
            if (newSessionDisabled) {
              return;
            }
            // createChatSession refuses anything without an explicit user intent,
            // so the button has to declare itself as one.
            if (await createChatSession(state, { source: "user" })) {
              state.setTab("chat" as import("./navigation.ts").Tab);
            }
          }}
        >
          <span class="chat-sessions__new-icon" aria-hidden="true">${icons.plus}</span>
          <span class="chat-sessions__new-label">${t("chat.runControls.newSession")}</span>
        </button>
        <div class="chat-sessions__select">
          ${renderChatSessionSelect(state, switchChatSession, {
            sessionSwitcherOnly: true,
            surface: "sidebar",
          })}
        </div>
      </div>
      ${recent.length === 0
        ? nothing
        : html`
            <div
              class="chat-sessions__recent ${state.settings.recentSessionsCollapsed
                ? "chat-sessions__recent--collapsed"
                : ""}"
              aria-label=${t("overview.cards.recentSessions")}
            >
              <button
                class="chat-sessions__recent-label"
                type="button"
                aria-expanded=${String(!state.settings.recentSessionsCollapsed)}
                @click=${() => {
                  state.applySettings({
                    ...state.settings,
                    recentSessionsCollapsed: !state.settings.recentSessionsCollapsed,
                  });
                }}
              >
                <span class="chat-sessions__recent-label-text"
                  >${t("usage.sessions.recentShort")}</span
                >
                <span class="chat-sessions__recent-chevron"> ${icons.chevronDown} </span>
              </button>
              <div class="chat-sessions__recent-list">
                ${recent.map((row) => renderChatRecentSession(state, row))}
              </div>
            </div>
          `}
    </section>
  `;
}

function renderChatRecentSession(state: AppViewState, row: GatewaySessionRow) {
  const active = row.key === state.sessionKey;
  const label = resolveSessionDisplayName(row.key, row);
  const meta = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a";
  const href = `${pathForTab("chat", state.basePath)}?session=${encodeURIComponent(row.key)}`;
  return html`
    <a
      href=${href}
      class="chat-sessions__recent-item ${active ? "chat-sessions__recent-item--active" : ""}"
      data-session-key=${row.key}
      title=${`${label} · ${row.key}`}
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        if (row.key !== state.sessionKey) {
          switchChatSession(state, row.key);
        }
        state.setTab("chat" as import("./navigation.ts").Tab);
      }}
    >
      <span class="chat-sessions__recent-dot" aria-hidden="true"></span>
      <span class="chat-sessions__recent-body">
        <span class="chat-sessions__recent-name">${label}</span>
        <span class="chat-sessions__recent-meta">${meta}</span>
      </span>
      ${row.hasActiveRun
        ? html`<span
            class="chat-sessions__recent-live"
            aria-label=${t("sessions.sessionDetails.activeRun")}
          ></span>`
        : nothing}
    </a>
  `;
}

// Lazy-loaded view modules are deferred so the initial bundle stays small.
// The shared loader renders visible fallback states instead of leaving a tab blank.
const lazyAgents = createLazyView(() => import("./views/agents.ts"), notifyLazyViewChanged);
const lazyActivity = createLazyView(() => import("./views/activity.ts"), notifyLazyViewChanged);
const lazyChannels = createLazyView(() => import("./views/channels.ts"), notifyLazyViewChanged);
const lazyCron = createLazyView(() => import("./views/cron.ts"), notifyLazyViewChanged);
const lazyDeadlines = createLazyView(
  () => import("./adminbot/views/deadlines.ts"),
  notifyLazyViewChanged,
);
const lazyConferencePapers = createLazyView(
  () => import("./adminbot/views/conference-papers.ts"),
  notifyLazyViewChanged,
);
const lazyDebug = createLazyView(() => import("./views/debug.ts"), notifyLazyViewChanged);
const lazyLogs = createLazyView(() => import("./views/logs.ts"), notifyLazyViewChanged);
const lazyNodes = createLazyView(() => import("./views/nodes.ts"), notifyLazyViewChanged);
const lazySessions = createLazyView(() => import("./views/sessions.ts"), notifyLazyViewChanged);
const lazySkills = createLazyView(() => import("./views/skills.ts"), notifyLazyViewChanged);
const lazyUsage = createLazyView(() => import("./views/usage.ts"), notifyLazyViewChanged);
const lazyAdminBotRegistrations = createLazyView(
  () => import("./adminbot/views/registrations.ts"),
  notifyLazyViewChanged,
);

const lazyAdminBotOnboarding = createLazyView(
  () => import("./adminbot/views/onboarding.ts"),
  notifyLazyViewChanged,
);
const lazyAdminBotCalendar = createLazyView(
  () => import("./adminbot/views/calendar.ts"),
  notifyLazyViewChanged,
);

/**
 * The paper workspace's wiring, shared by the two surfaces that draw it.
 *
 * My Projects & Papers and Active Papers are the same cards over different rows: the member's own
 * papers, or the lab's. Building the handlers once is what keeps that true -- two copies of this
 * object is how the two pages would quietly grow different save paths.
 */
function paperWorkspaceProps(
  state: AppViewState,
  requestHostUpdate: (() => void) | undefined,
): MyWorkProps {
  return {
    onSavePaper: (paper) => void saveAdminBotPaper(state, paper),
    onRerender: () => requestHostUpdate?.(),
    overview: state.adminBotPaperSlotOverview,
    slots: state.adminBotPaperSlots,
    openIds: state.adminBotPaperSlotsOpen,
    slotsBusyId: state.adminBotPaperSlotsBusyId,
    slotsError: state.adminBotPaperSlotsError,
    slotsNotice: state.adminBotPaperSlotsNotice,
    nudging: state.adminBotPaperSlotsNudging,
    // Each surface sets this: Active Papers is where the lab gets chased, and a member's
    // own page never does. The service re-checks; this only hides the affordance.
    canNudge: false,
    onToggleCard: (paperId) => {
      void toggleAdminBotPaperCard(state, paperId).finally(() => requestHostUpdate?.());
    },
    onSaveSlot: (paperId, slot, input) => {
      void saveAdminBotPaperSlot(state, paperId, slot, input).finally(() => requestHostUpdate?.());
    },
    onNudgeAuthors: () => {
      void nudgeAdminBotPaperAuthors(state).finally(() => requestHostUpdate?.());
    },
    nudgeBatches: state.adminBotPaperNudgeBatches,
    nudgeLoading: state.adminBotPaperNudgeLoading,
    nudgeSelected: state.adminBotPaperNudgeSelected,
    onReviewNudges: () => {
      void loadAdminBotNudgeBatches(state).finally(() => requestHostUpdate?.());
    },
    onToggleNudgeRecipient: (memberId: string) => {
      toggleAdminBotPaperNudgeRecipient(state, memberId);
      requestHostUpdate?.();
    },
    memberId: state.memberId ?? null,
    memberName: (memberId: string) =>
      (state.adminBotData?.members ?? []).find((member) => member.id === memberId)?.name ??
      memberId,
    onSaveDraft: (paperId, platform, body) => {
      void saveAdminBotSocialDraft(state, paperId, platform, body).finally(() =>
        requestHostUpdate?.(),
      );
    },
    onCirculateDraft: (paperId, draftId) => {
      void circulateAdminBotSocialDraft(state, paperId, draftId).finally(() =>
        requestHostUpdate?.(),
      );
    },
    onConsent: (paperId, draftId, decision, comment) => {
      void recordAdminBotSocialConsent(state, paperId, draftId, decision, comment).finally(() =>
        requestHostUpdate?.(),
      );
    },
    onSetAttendee: (paperId, name, memberId, attending) => {
      void setAdminBotPaperAttendee(state, paperId, name, memberId, attending).finally(() =>
        requestHostUpdate?.(),
      );
    },
    onSetReimbursement: (paperId, memberId, status) => {
      void setAdminBotPaperReimbursement(state, paperId, memberId, status).finally(() =>
        requestHostUpdate?.(),
      );
    },
    onSaveWeeklyUpdate: (paperId, body) => {
      void saveAdminBotPaperWeeklyUpdate(state, paperId, body).finally(() => requestHostUpdate?.());
    },
  };
}

function adminBotPanelForTab(tab: Tab, mode: AdminBotLoadMode = "admin"): AdminBotPanel | null {
  if (mode === "general") {
    switch (tab) {
      case "adminbotMembers":
        return "members";
      case "adminbotReimbursements":
        return "reimbursements";
      case "adminbot":
      case "adminbotSettings":
      case "adminbotPapers":
      case "adminbotAnnouncements":
        return "papers";
      default:
        return null;
    }
  }
  switch (tab) {
    case "adminbot":
      return "actions";
    case "adminbotSettings":
      return "settings";
    case "adminbotReimbursements":
      return "reimbursements";
    case "adminbotMembers":
      return "members";
    case "adminbotPapers":
      return "papers";
    case "adminbotAnnouncements":
      return "announcements";
    default:
      return null;
  }
}

// A floating bottom-right feedback widget appears on AdminBot feature tabs only. A changed tab
// re-renders the widget element with the new feature id, and the widget itself reloads its stored
// vote when the feature id attribute changes.
function renderFeedbackWidget(state: AppViewState) {
  const config = feedbackConfigForTab(state.tab);
  if (!config) {
    return nothing;
  }
  return html`
    <adminbot-feedback-widget
      feature-id=${config.featureId}
      github-file=${config.githubFile}
      @feedback=${(event: Event) => void sendFeedback(state, event as CustomEvent)}
    >
    </adminbot-feedback-widget>
  `;
}

/**
 * Sends a submitted rating to AdminBot.
 *
 * Two things it deliberately does not do. It does not send the intermediate events -- the widget
 * emits one per star click so it can persist a half-finished vote locally, and only `submitted`
 * marks the member actually pressing Send. And it does not surface a failure: the widget has
 * already thanked the member and dismissed itself by the time this runs, so an error toast would
 * be about a request they never knew they made. The vote survives in their browser either way.
 */
async function sendFeedback(state: AppViewState, event: CustomEvent): Promise<void> {
  const detail = (event.detail ?? {}) as {
    featureId?: string;
    rating?: number;
    comment?: string;
    githubFile?: string;
    submitted?: boolean;
  };
  if (!detail.submitted || !detail.featureId || typeof detail.rating !== "number") {
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  await submitFeedback(
    {
      featureId: detail.featureId,
      rating: detail.rating,
      ...(detail.comment ? { comment: detail.comment } : {}),
      ...(detail.githubFile ? { githubFile: detail.githubFile } : {}),
    },
    stored.sessionToken,
    resolveAdminBotBaseUrl(state.settings),
  );
}

// Deep links and sign-out both leave `state.tab` pointing at a surface the current role may not
// see. Correct it before rendering rather than after: a privileged panel with no data behind it is
// worse than landing on the role's own default.
function withAccessibleTab<T extends AppViewState>(state: T, role: AccessRole): T {
  const allowed = resolveAccessibleTab(state.tab, role);
  if (allowed !== state.tab) {
    state.tab = allowed;
  }
  return state;
}

type ChatWorkspaceFilesState = {
  activeId: string | null;
  agentId: string;
  browserPath: string;
  browserSearch: string;
  browserSearchTimer: ReturnType<typeof globalThis.setTimeout> | null;
  collapsed: boolean;
  error: string | null;
  list: SessionWorkspaceListResult | null;
  loading: boolean;
  pendingReload: boolean;
  requestId: number;
  sessionKey: string;
};

const chatWorkspaceFilesStates = new WeakMap<AppViewState, ChatWorkspaceFilesState>();
const chatWorkspaceFileOpenRequests = new WeakMap<
  AppViewState,
  { agentId: string; id: number; itemId: string; sessionKey: string }
>();

function getChatWorkspaceFilesState(
  state: AppViewState,
  sessionKey: string,
  agentId: string,
): ChatWorkspaceFilesState {
  const current = chatWorkspaceFilesStates.get(state);
  if (current?.sessionKey === sessionKey && current.agentId === agentId) {
    return current;
  }
  const next = {
    activeId: null,
    agentId,
    browserPath: "",
    browserSearch: "",
    browserSearchTimer: null,
    collapsed: true,
    error: null,
    list: null,
    loading: false,
    pendingReload: false,
    requestId: 0,
    sessionKey,
  };
  chatWorkspaceFilesStates.set(state, next);
  return next;
}

export function formatDreamNextCycle(nextRunAtMs: number | undefined): string | null {
  return (
    formatTimeMs(
      nextRunAtMs,
      {
        hour: "numeric",
        minute: "2-digit",
      },
      "",
    ) || null
  );
}

let clawhubSearchTimer: ReturnType<typeof setTimeout> | null = null;

const UPDATE_BANNER_DISMISS_KEY = "openclaw:control-ui:update-banner-dismissed:v1";
const CRON_THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];
const CRON_TIMEZONE_SUGGESTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeSuggestionValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

type DismissedUpdateBanner = {
  latestVersion: string;
  channel: string | null;
  dismissedAtMs: number;
};

function loadDismissedUpdateBanner(): DismissedUpdateBanner | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(UPDATE_BANNER_DISMISS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DismissedUpdateBanner>;
    if (!parsed || typeof parsed.latestVersion !== "string") {
      return null;
    }
    return {
      latestVersion: parsed.latestVersion,
      channel: typeof parsed.channel === "string" ? parsed.channel : null,
      dismissedAtMs: typeof parsed.dismissedAtMs === "number" ? parsed.dismissedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

function isUpdateBannerDismissed(updateAvailable: unknown): boolean {
  const dismissed = loadDismissedUpdateBanner();
  if (!dismissed) {
    return false;
  }
  const info = updateAvailable as {
    latestVersion?: unknown;
    channel?: unknown;
  };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  return Boolean(
    latestVersion && dismissed.latestVersion === latestVersion && dismissed.channel === channel,
  );
}

function dismissUpdateBanner(updateAvailable: unknown) {
  const info = updateAvailable as {
    latestVersion?: unknown;
    channel?: unknown;
  };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  if (!latestVersion) {
    return;
  }
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  const payload: DismissedUpdateBanner = {
    latestVersion,
    channel,
    dismissedAtMs: Date.now(),
  };
  try {
    getSafeLocalStorage()?.setItem(UPDATE_BANNER_DISMISS_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

const COMMUNICATION_SECTION_KEYS = [
  "messages",
  "broadcast",
  "__notifications__",
  "talk",
  "audio",
  "channels",
] as const;
const APPEARANCE_SECTION_KEYS = ["__appearance__", "ui", "wizard"] as const;
const AUTOMATION_SECTION_KEYS = [
  "commands",
  "hooks",
  "bindings",
  "cron",
  "approvals",
  "plugins",
] as const;
const INFRASTRUCTURE_SECTION_KEYS = [
  "gateway",
  "web",
  "browser",
  "nodeHost",
  "canvasHost",
  "discovery",
  "media",
  "acp",
  "mcp",
] as const;
const AI_AGENTS_SECTION_KEYS = [
  "agents",
  "models",
  "skills",
  "tools",
  "memory",
  "session",
] as const;
type ConfigSectionSelection = {
  activeSection: string | null;
  activeSubsection: string | null;
};

type ConfigTabOverrides = Pick<
  ConfigProps,
  | "formMode"
  | "searchQuery"
  | "activeSection"
  | "activeSubsection"
  | "onFormModeChange"
  | "onSearchChange"
  | "onSectionChange"
  | "onSubsectionChange"
> &
  Partial<
    Pick<
      ConfigProps,
      | "showModeToggle"
      | "navRootLabel"
      | "showRootTab"
      | "includeSections"
      | "excludeSections"
      | "includeVirtualSections"
      | "settingsLayout"
      | "onBackToQuick"
      | "webPush"
      | "onWebPushSubscribe"
      | "onWebPushUnsubscribe"
      | "onWebPushTest"
    >
  >;

const SCOPED_CONFIG_SECTION_KEYS = new Set<string>([
  ...COMMUNICATION_SECTION_KEYS,
  ...APPEARANCE_SECTION_KEYS,
  ...AUTOMATION_SECTION_KEYS,
  ...INFRASTRUCTURE_SECTION_KEYS,
  ...AI_AGENTS_SECTION_KEYS,
]);

function normalizeMainConfigSelection(
  activeSection: string | null,
  activeSubsection: string | null,
): ConfigSectionSelection {
  if (activeSection && SCOPED_CONFIG_SECTION_KEYS.has(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  return { activeSection, activeSubsection };
}

function normalizeScopedConfigSelection(
  activeSection: string | null,
  activeSubsection: string | null,
  includedSections: readonly string[],
): ConfigSectionSelection {
  if (activeSection && !includedSections.includes(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  return { activeSection, activeSubsection };
}

function countScopedTopLevelSchemaProperties(
  schema: unknown,
  includeSections?: readonly string[],
  excludeSections?: readonly string[],
): number {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return 0;
  }
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return 0;
  }
  const include = includeSections?.length ? new Set(includeSections) : null;
  const exclude = excludeSections?.length ? new Set(excludeSections) : null;
  return Object.keys(properties).filter((key) => {
    if (include && !include.has(key)) {
      return false;
    }
    if (exclude?.has(key)) {
      return false;
    }
    return true;
  }).length;
}

function renderMeasured<T>(
  state: AppViewState,
  surface: string,
  payload: Record<string, unknown>,
  render: () => T,
): T {
  const startedAtMs = controlUiNowMs();
  const result = render();
  recordControlUiRenderTiming(state, surface, {
    ...payload,
    durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
  });
  return result;
}

function renderGuardedChatControls(state: AppViewState) {
  return guard(
    [
      state.sessionKey,
      state.connected,
      state.client,
      state.onboarding,
      state.chatManualRefreshInFlight,
      state.chatLoading,
      state.chatSending,
      state.chatStream,
      state.chatRunId,
      state.chatMobileControlsOpen,
      state.sessionsHideCron ?? true,
      state.sessionsResult,
      state.sessionsShowArchived,
      state.agentsList,
      state.chatModelOverrides,
      state.chatModelSwitchPromises,
      state.chatModelsLoading,
      state.chatModelCatalog,
      // Provider usage windows arrive async after auth status loads; without this the guarded
      // composer controls never re-render and the quota pill stays absent/stale (#93041).
      state.modelAuthStatusResult,
      state.settings.chatShowThinking,
      state.settings.chatShowToolCalls,
      state.settings.chatAutoScroll,
      state.chatSessionPickerOpen,
      state.chatSessionPickerSurface,
      state.chatSessionPickerQuery,
      state.chatSessionPickerAppliedQuery,
      state.chatSessionPickerLoading,
      state.chatSessionPickerError,
      state.chatSessionPickerResult,
      state.sessionSwitchNotice?.id ?? null,
      state.sessionSwitchNotice?.text ?? null,
      state.sessionSwitchFlashKey,
      i18n.getLocale(),
    ],
    () => renderChatControls(state),
  );
}

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) {
    return undefined;
  }
  if (isRenderableControlUiAvatarUrl(candidate)) {
    return candidate;
  }
  return undefined;
}

function resolveAssistantAvatarOverride(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const ui = (config as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
    return null;
  }
  const assistant = (ui as { assistant?: unknown }).assistant;
  if (!assistant || typeof assistant !== "object" || Array.isArray(assistant)) {
    return null;
  }
  return normalizeOptionalString((assistant as { avatar?: unknown }).avatar) ?? null;
}

function buildAssistantAvatarRoute(basePathValue: string | null | undefined, agentId: string) {
  const basePath = normalizeBasePath(basePathValue ?? "");
  const encoded = encodeURIComponent(agentId);
  return basePath ? `${basePath}/avatar/${encoded}` : `/avatar/${encoded}`;
}

// ── Quick Settings data extraction helpers ──

const KNOWN_CHANNEL_IDS = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "signal", label: "Signal" },
  { id: "imessage", label: "iMessage" },
] as const;

function formatQuickSettingsLabel(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    return "Unknown";
  }
  return trimmed
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractQuickSettingsChannels(state: AppViewState): QuickSettingsChannel[] {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return [];
  }
  const channelsConfig =
    "channels" in config && config.channels && typeof config.channels === "object"
      ? (config.channels as Record<string, unknown>)
      : {};
  const configuredIds = Object.keys(channelsConfig).filter((id) => id.trim().length > 0);
  const channelIds =
    configuredIds.length > 0
      ? configuredIds.toSorted((a, b) => a.localeCompare(b))
      : KNOWN_CHANNEL_IDS.map(({ id }) => id);
  const knownLabels = new Map<string, string>(
    KNOWN_CHANNEL_IDS.map(({ id, label }) => [id, label]),
  );
  const channels: QuickSettingsChannel[] = [];
  for (const id of channelIds) {
    const channelConfig = channelsConfig[id];
    const hasConfig =
      channelConfig != null &&
      typeof channelConfig === "object" &&
      Object.keys(channelConfig).length > 0;
    channels.push({
      id,
      label: knownLabels.get(id) ?? formatQuickSettingsLabel(id),
      connected: hasConfig,
      detail: hasConfig ? "Configured" : undefined,
    });
  }
  return channels;
}

function extractMcpServerCount(state: AppViewState): number {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return 0;
  }
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object") {
    return 0;
  }
  const servers =
    "servers" in mcp && mcp.servers && typeof mcp.servers === "object"
      ? (mcp.servers as Record<string, unknown>)
      : {};
  return Object.keys(servers).length;
}

export function extractQuickSettingsSecurity(state: AppViewState): {
  gatewayAuth: string;
  execPolicy: string;
  deviceAuth: boolean;
  browserEnabled: boolean;
  toolProfile: string;
} {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return {
      gatewayAuth: "unknown",
      execPolicy: "unknown",
      deviceAuth: false,
      browserEnabled: true,
      toolProfile: "full",
    };
  }
  const cfg = config;
  const gateway =
    "gateway" in cfg && cfg.gateway && typeof cfg.gateway === "object"
      ? (cfg.gateway as Record<string, unknown>)
      : null;
  const auth =
    gateway && "auth" in gateway && gateway.auth && typeof gateway.auth === "object"
      ? (gateway.auth as Record<string, unknown>)
      : null;
  let gatewayAuth = "unknown";
  if (auth) {
    const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
    if (mode) {
      gatewayAuth = mode;
    } else if (auth.password) {
      gatewayAuth = "password";
    } else if (auth.token) {
      gatewayAuth = "token";
    } else if (auth.trustedProxy) {
      gatewayAuth = "trusted-proxy";
    } else {
      gatewayAuth = "none";
    }
  }
  let execPolicy = "allowlist";
  let toolProfile = "full";
  const tools = cfg.tools;
  if (tools && typeof tools === "object") {
    const profile = (tools as Record<string, unknown>).profile;
    if (typeof profile === "string") {
      const trimmedProfile = profile.trim();
      if (trimmedProfile) {
        toolProfile = trimmedProfile;
      }
    }
    const exec = (tools as Record<string, unknown>).exec;
    if (exec && typeof exec === "object") {
      const security = (exec as Record<string, unknown>).security;
      if (typeof security === "string") {
        const trimmedSecurity = security.trim();
        if (trimmedSecurity) {
          execPolicy = trimmedSecurity;
        }
      }
    }
  }
  let browserEnabled = true;
  const browser =
    "browser" in cfg && cfg.browser && typeof cfg.browser === "object"
      ? (cfg.browser as Record<string, unknown>)
      : null;
  if (browser && typeof browser.enabled === "boolean") {
    browserEnabled = browser.enabled;
  }
  let deviceAuth = true;
  if (gateway) {
    const controlUi =
      "controlUi" in gateway && gateway.controlUi && typeof gateway.controlUi === "object"
        ? (gateway.controlUi as Record<string, unknown>)
        : null;
    if (controlUi?.dangerouslyDisableDeviceAuth === true) {
      deviceAuth = false;
    }
  }
  return { gatewayAuth, execPolicy, deviceAuth, browserEnabled, toolProfile };
}

function resolveQuickSettingsSessionRow(state: AppViewState) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

function renderCronQuickCreateForTab(
  state: AppViewState,
  requestHostUpdate: (() => void) | undefined,
  modelOptions: string[],
) {
  return renderCronQuickCreate({
    open: state.cronQuickCreateOpen,
    step: state.cronQuickCreateStep,
    modelOptions,
    // What "inherit" actually resolves to for a new job, so the option is not
    // an unlabelled mystery.
    inheritedModelLabel: buildNewCronForm(state).payloadModel,
    draft: state.cronQuickCreateDraft ?? createDefaultDraft(),
    onDraftChange: (patch) => {
      state.cronQuickCreateDraft = {
        ...(state.cronQuickCreateDraft ?? createDefaultDraft()),
        ...patch,
      };
      requestHostUpdate?.();
    },
    onStepChange: (step) => {
      state.cronQuickCreateStep = step;
      requestHostUpdate?.();
    },
    onCreate: () => {
      const draft = state.cronQuickCreateDraft ?? createDefaultDraft();
      const formPatch = draftToCronFormPatch(draft);
      state.cronEditingJobId = null;
      state.cronForm = {
        ...buildNewCronForm(state),
        ...formPatch,
      } as typeof state.cronForm;
      requestHostUpdate?.();
      void (async () => {
        const saved = await addCronJob(state);
        if (!saved) {
          requestHostUpdate?.();
          return;
        }
        state.cronQuickCreateOpen = false;
        state.cronQuickCreateStep = "what";
        state.cronQuickCreateDraft = null;
        requestHostUpdate?.();
      })();
    },
    onAdvancedCreate: () => {
      const draft = state.cronQuickCreateDraft ?? createDefaultDraft();
      const formPatch = draftToCronFormPatch(draft);
      state.cronEditingJobId = null;
      state.cronForm = normalizeCronFormState({
        ...buildNewCronForm(state),
        ...formPatch,
      } as typeof state.cronForm);
      state.cronFieldErrors = validateCronForm(state.cronForm);
      state.cronQuickCreateOpen = false;
      state.cronQuickCreateStep = "what";
      state.cronQuickCreateDraft = null;
      state.cronFormCollapsed = false;
      requestHostUpdate?.();
    },
    onCancel: () => {
      state.cronQuickCreateOpen = false;
      state.cronQuickCreateStep = "what";
      state.cronQuickCreateDraft = null;
      requestHostUpdate?.();
    },
  });
}

function languageForWorkspaceFile(name: string): string {
  const extension = name.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase() ?? "";
  if (extension === "json") {
    return "json";
  }
  if (extension === "mdx") {
    return "mdx";
  }
  if (extension === "tsx" || extension === "jsx") {
    return extension;
  }
  if (extension === "ts" || extension === "js" || extension === "css" || extension === "html") {
    return extension;
  }
  if (extension === "yaml" || extension === "yml") {
    return "yaml";
  }
  if (extension === "toml" || extension === "xml" || extension === "svg") {
    return extension;
  }
  return extension;
}

function buildWorkspaceFileSidebarContent(name: string, content: string): string {
  if (/\.(?:md|markdown|mdx)$/i.test(name)) {
    return content;
  }
  const language = languageForWorkspaceFile(name);
  return `# ${name}\n\n\`\`\`${language}\n${content}\n\`\`\``;
}

function buildArtifactSidebarContent(params: {
  data?: string;
  encoding?: string;
  mimeType: string;
  title: string;
  url?: string;
}): SidebarContent {
  const { data, encoding, mimeType, title, url } = params;
  if (encoding === "base64" && data && mimeType.startsWith("image/")) {
    return {
      kind: "image",
      title,
      src: `data:${mimeType};base64,${data}`,
      mimeType,
      rawText: url ?? null,
    };
  }
  if (encoding === "base64" && data && mimeType === "application/json") {
    const decoded = globalThis.atob(data);
    return {
      kind: "markdown",
      content: `# ${title}\n\n\`\`\`json\n${decoded}\n\`\`\``,
      rawText: decoded,
    };
  }
  if (encoding === "base64" && data && mimeType.startsWith("text/")) {
    const decoded = globalThis.atob(data);
    return {
      kind: "markdown",
      content: `# ${title}\n\n\`\`\`\n${decoded}\n\`\`\``,
      rawText: decoded,
    };
  }
  if (url) {
    const content = `# ${title}\n\n[Open artifact](${url})`;
    return { kind: "markdown", content, rawText: content };
  }
  const content = `# ${title}\n\nArtifact download is not previewable in the sidebar.`;
  return { kind: "markdown", content, rawText: content };
}

/**
 * The bell: how a member finds out an admin asked them for something.
 *
 * It sits in the top bar rather than on the paper card because the point of a notification is to
 * reach someone who is not already looking at the thing.
 *
 * Reading does not delete. The badge counts unread, but the panel keeps every notification the
 * member has ever had, greyed once read -- because the question after you read a reminder is
 * usually "what exactly was I asked, and when", and an inbox that empties itself cannot answer it.
 */
function renderNudgeBell(state: AppViewState) {
  const papers = ownPapers(state);
  const alerts = nudgeAlerts(papers);
  const unread = alerts.filter((alert) => !alert.read).length;
  const open = state.nudgeBellOpen;
  if (alerts.length === 0) {
    return nothing;
  }
  return html`
    <div class="bell">
      ${open
        ? html`<button
            type="button"
            class="bell__scrim"
            aria-label="Close notifications"
            @click=${() => {
              state.nudgeBellOpen = false;
            }}
          ></button>`
        : nothing}
      <button
        type="button"
        class="bell__button"
        data-testid="nudge-bell"
        aria-label=${`Notifications, ${unread} unread`}
        aria-expanded=${open}
        @click=${() => {
          // Read the flag at click time rather than closing over the value from render: the
          // dashboard refreshes on a timer, so a render can land between paint and click and
          // leave the captured value describing a state that is already gone.
          state.nudgeBellOpen = !state.nudgeBellOpen;
        }}
      >
        <span class="bell__icon" aria-hidden="true">${icons.bell}</span>
        ${unread > 0
          ? html`<span class="bell__badge" data-testid="nudge-bell-count">${unread}</span>`
          : nothing}
      </button>
      ${open
        ? html`
            <div class="bell__panel" data-testid="nudge-bell-panel">
              <div class="bell__panel-head">
                <span>Notifications</span>
                ${unread > 0
                  ? html`<button
                      type="button"
                      class="bell__mark"
                      data-testid="nudge-mark-all"
                      @click=${() => {
                        void markAdminBotNudgesSeen(state);
                      }}
                    >
                      Mark all as read
                    </button>`
                  : nothing}
              </div>
              <div class="bell__list">
                ${alerts.map(
                  (alert) => html`
                    <button
                      type="button"
                      class=${`bell__item ${alert.read ? "bell__item--read" : ""}`}
                      @click=${() => {
                        state.nudgeBellOpen = false;
                        void markAdminBotNudgesSeen(state);
                        state.setTab("myWork");
                      }}
                    >
                      <span class="bell__item-top">
                        <span class="bell__dot" aria-hidden="true"></span>
                        <span class="bell__item-text">
                          <strong>${alert.by}</strong>
                          ${alertText(alert).action}
                          <strong>${alertText(alert).subject}</strong>
                        </span>
                      </span>
                      ${alert.body
                        ? html`<span class="bell__item-body">${alert.body}</span>`
                        : nothing}
                      <span class="bell__item-meta">
                        ${alert.paperTitle} · ${agoLabel(alert.at)}
                      </span>
                    </button>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderApp(state: AppViewState) {
  const updatableState = state as AppViewState & { requestUpdate?: () => void };
  const requestHostUpdate =
    typeof updatableState.requestUpdate === "function"
      ? () => updatableState.requestUpdate?.()
      : undefined;
  pendingUpdate = requestHostUpdate;

  const accessRole = resolveAccessRole({
    // Truthiness, not `!== null`: these fields are absent (undefined) before a session is ever
    // loaded, and treating "absent" as signed-in demoted a connected operator to a member — which
    // then rewrote their tab out from under them.
    signedIn: Boolean(state.memberId) || Boolean(state.memberPrivilegeLevel),
    privilegeLevel: state.memberPrivilegeLevel,
    gatewayConnected: state.connected,
  });

  // A visitor gets the landing page and then the public shell, not a wall: the two surfaces the
  // access table opens to `anonymous` need no gateway, and the sign-in gate is something they open
  // from the landing page or the public topbar.
  // The gateway URL confirmation overlay stays mounted throughout so URL-param flows keep working.
  if (accessRole === "anonymous") {
    if (state.guestReimbursements) {
      return html` ${renderGuestReimbursements(state)} ${renderGatewayUrlConfirmation(state)} `;
    }
    if (state.authGateVisible) {
      return html` ${renderLoginGate(state)} ${renderGatewayUrlConfirmation(state)} `;
    }
    // Read the requested tab before `withAccessibleTab` coerces it. A tab a visitor may not see
    // means they did not ask for one of the open surfaces — they opened the root (which resolves
    // to `chat`) or followed a link into a members-only tab — so the landing page is where they
    // belong. A direct link to an open surface still lands on that surface.
    if (!canAccessTab(state.tab, accessRole)) {
      return html` ${renderLanding(state)} ${renderGatewayUrlConfirmation(state)} `;
    }
    return html`
      ${renderPublicShell(withAccessibleTab(state, accessRole))}
      ${renderGatewayUrlConfirmation(state)}
    `;
  }
  if (!state.connected) {
    return html` ${renderLoginGate(state)} ${renderGatewayUrlConfirmation(state)} `;
  }
  // A deep link into a surface this role may not see lands on their own default instead, so a
  // hidden tab cannot be reached by typing its path.
  withAccessibleTab(state, accessRole);

  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;
  const chatDisabledReason = state.connected ? null : t("chat.disconnected");
  const isChat = state.tab === "chat";
  const adminBotMode: AdminBotLoadMode = resolveAdminBotMode(state.memberPrivilegeLevel);
  const adminBotPanel = adminBotPanelForTab(state.tab, adminBotMode);
  const headerError = !isChat && state.lastError !== state.chatError ? state.lastError : null;
  const chatViewError = state.lastError;
  const chatHeaderHidden = isChat && (state.onboarding || state.chatHeaderControlsHidden);
  const navDrawerOpen = state.navDrawerOpen && !state.onboarding;
  const navCollapsed = state.settings.navCollapsed && !navDrawerOpen;
  const dashboardHeaderContext = resolveDashboardHeaderContext(state);
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const activeAssistantAgentId = resolveChatSelectedAgentId(state);
  const localAssistantAvatarOverride =
    normalizeOptionalString(
      loadLocalAssistantIdentity({ agentId: activeAssistantAgentId }).avatar,
    ) ?? null;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAssistantAvatarStatus = localAssistantAvatarOverride
    ? "data"
    : (state.chatAvatarStatus ?? state.assistantAvatarStatus ?? null);
  const chatAssistantAvatarReason = localAssistantAvatarOverride
    ? null
    : (state.chatAvatarReason ?? state.assistantAvatarReason ?? null);
  const chatAssistantAvatarMissing =
    chatAssistantAvatarStatus === "none" && chatAssistantAvatarReason === "missing";
  const effectiveAssistantAvatar =
    localAssistantAvatarOverride ?? (chatAssistantAvatarMissing ? null : state.assistantAvatar);
  const chatAvatarUrl =
    localAssistantAvatarOverride ??
    state.chatAvatarUrl ??
    (chatAssistantAvatarMissing ? null : (assistantAvatarUrl ?? null));
  const configAssistantAvatarStatus = localAssistantAvatarOverride
    ? "data"
    : (state.assistantAvatarStatus ?? state.chatAvatarStatus ?? null);
  const configAssistantAvatarReason = localAssistantAvatarOverride
    ? null
    : (state.assistantAvatarReason ?? state.chatAvatarReason ?? null);
  const configAssistantAvatarSource =
    localAssistantAvatarOverride ?? state.assistantAvatarSource ?? state.chatAvatarSource ?? null;
  const configAssistantAvatarMissing =
    configAssistantAvatarStatus === "none" && configAssistantAvatarReason === "missing";
  const configAssistantAvatar =
    localAssistantAvatarOverride ??
    (configAssistantAvatarMissing || configAssistantAvatarStatus === "local"
      ? null
      : state.assistantAvatar);
  const configAssistantAvatarUrl =
    localAssistantAvatarOverride ??
    (configAssistantAvatarStatus === "local" && state.assistantAgentId
      ? buildAssistantAvatarRoute(state.basePath, state.assistantAgentId)
      : (state.chatAvatarUrl ??
        (configAssistantAvatarMissing ? null : (assistantAvatarUrl ?? null))));
  const configValue =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const basePath = normalizeBasePath(state.basePath ?? "");
  const resolveSelectedAgentId = () =>
    state.agentsSelectedId ??
    state.agentsList?.defaultId ??
    state.agentsList?.agents?.[0]?.id ??
    null;
  const resolvedAgentId = resolveSelectedAgentId();
  const normalizedChatSessionKey = normalizeOptionalString(state.sessionKey)?.toLowerCase();
  const activeSessionAgentId =
    normalizedChatSessionKey === "global" ? null : resolveAgentIdFromSessionKey(state.sessionKey);
  const scopedChatAgentId = scopedAgentParamsForSession(state, state.sessionKey).agentId;
  const chatFallbackAgentId = normalizeAgentId(
    state.assistantAgentId ??
      state.agentsList?.defaultId ??
      state.agentsList?.agents?.[0]?.id ??
      "main",
  );
  const resolveChatWorkspaceAgentId = () => {
    const normalizedKey = normalizeOptionalString(state.sessionKey)?.toLowerCase();
    const activeAgentId =
      normalizedKey === "global" ? null : resolveAgentIdFromSessionKey(state.sessionKey);
    const scopedAgentId = scopedAgentParamsForSession(state, state.sessionKey).agentId;
    return normalizedKey === "global"
      ? (scopedAgentId ?? chatFallbackAgentId)
      : (activeAgentId ?? scopedAgentId ?? chatFallbackAgentId);
  };
  const chatAgentId =
    normalizedChatSessionKey === "global"
      ? (scopedChatAgentId ?? chatFallbackAgentId)
      : (activeSessionAgentId ?? scopedChatAgentId ?? chatFallbackAgentId);
  const isAdminBotChat = normalizeAgentId(chatAgentId) === "adminbot";
  const toolsPanelUsesActiveSession = Boolean(resolvedAgentId && resolvedAgentId === chatAgentId);
  const chatWorkspaceAgentId = resolveChatWorkspaceAgentId();
  const chatWorkspaceFiles = getChatWorkspaceFilesState(
    state,
    state.sessionKey,
    chatWorkspaceAgentId,
  );
  const currentChatWorkspaceFilesState = () =>
    getChatWorkspaceFilesState(state, state.sessionKey, resolveChatWorkspaceAgentId());
  const currentSessionWorkspaceKey = () => state.sessionKey;
  const getCurrentConfigValue = () =>
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const findAgentIndex = (agentId: string) =>
    findAgentConfigEntryIndex(getCurrentConfigValue(), agentId);
  const ensureAgentIndex = (agentId: string) => ensureAgentConfigEntry(state, agentId);
  const resolveAgentToolsPath = (agentId: string, ensure: boolean) => {
    const index = ensure ? ensureAgentIndex(agentId) : findAgentIndex(agentId);
    return index >= 0 ? (["agents", "list", index, "tools"] as const) : null;
  };
  const resolveAgentModelFormEntry = (index: number) => {
    const list = (getCurrentConfigValue() as { agents?: { list?: unknown[] } } | null)?.agents
      ?.list;
    const existing = Array.isArray(list)
      ? (list[index] as { model?: unknown } | undefined)?.model
      : undefined;
    return {
      basePath: ["agents", "list", index, "model"] as Array<string | number>,
      existing,
    };
  };
  const cronAgentSuggestions = sortLocaleStrings(
    new Set(
      [
        ...(state.agentsList?.agents?.map((entry) => entry.id.trim()) ?? []),
        ...state.cronJobs
          .map((job) => (typeof job.agentId === "string" ? job.agentId.trim() : ""))
          .filter(Boolean),
      ].filter(Boolean),
    ),
  );
  const cronModelSuggestions = sortLocaleStrings(
    new Set(
      [
        ...state.cronModelSuggestions,
        ...resolveConfiguredCronModelSuggestions(configValue),
        ...state.cronJobs
          .map((job) => {
            const payload = getCronJobPayload(job);
            if (payload?.kind !== "agentTurn" || typeof payload.model !== "string") {
              return "";
            }
            return payload.model.trim();
          })
          .filter(Boolean),
      ].filter(Boolean),
    ),
  );
  const visibleCronJobs = getVisibleCronJobs(state);
  const selectedDeliveryChannel =
    state.cronForm.deliveryChannel && state.cronForm.deliveryChannel.trim()
      ? state.cronForm.deliveryChannel.trim()
      : "last";
  const jobToSuggestions = state.cronJobs
    .map((job) => normalizeSuggestionValue(job.delivery?.to))
    .filter(Boolean);
  const accountToSuggestions = (
    selectedDeliveryChannel === "last"
      ? Object.values(state.channelsSnapshot?.channelAccounts ?? {}).flat()
      : (state.channelsSnapshot?.channelAccounts?.[selectedDeliveryChannel] ?? [])
  )
    .flatMap((account) => [
      normalizeSuggestionValue(account.accountId),
      normalizeSuggestionValue(account.name),
    ])
    .filter(Boolean);
  const rawDeliveryToSuggestions = uniquePreserveOrder([
    ...jobToSuggestions,
    ...accountToSuggestions,
  ]);
  const accountSuggestions = uniquePreserveOrder(accountToSuggestions);
  const deliveryToSuggestions =
    state.cronForm.deliveryMode === "webhook"
      ? rawDeliveryToSuggestions.filter((value) => isHttpUrl(value))
      : rawDeliveryToSuggestions;
  const commonConfigProps = {
    raw: state.configRaw,
    originalRaw: state.configRawOriginal,
    valid: state.configValid,
    issues: state.configIssues,
    loading: state.configLoading,
    saving: state.configSaving,
    applying: state.configApplying,
    updating: state.updateRunning,
    connected: state.connected,
    schema: state.configSchema,
    schemaLoading: state.configSchemaLoading,
    uiHints: state.configUiHints,
    formValue: state.configForm,
    originalValue: state.configFormOriginal,
    onRawChange: (next: string) => {
      updateConfigRawValue(state, next);
    },
    onRequestUpdate: requestHostUpdate,
    onFormPatch: (path: Array<string | number>, value: unknown) =>
      updateConfigFormValue(state, path, value),
    onReload: () => void loadConfig(state, { discardPendingChanges: true }),
    onReset: () => resetConfigPendingChanges(state),
    onSave: () => void saveConfig(state),
    onApply: () => void applyConfig(state),
    onUpdate: () => void runUpdate(state),
    onOpenFile: () => void openConfigFile(state),
    version: state.hello?.server?.version ?? "",
    theme: state.theme,
    themeMode: state.themeMode,
    setTheme: (theme, context) => state.setTheme(theme, context),
    setThemeMode: (mode, context) => state.setThemeMode(mode, context),
    hasCustomTheme: Boolean(state.settings.customTheme),
    customThemeLabel: state.settings.customTheme?.label ?? null,
    customThemeSourceUrl: state.settings.customTheme?.sourceUrl ?? null,
    customThemeImportUrl: state.customThemeImportUrl,
    customThemeImportBusy: state.customThemeImportBusy,
    customThemeImportMessage: state.customThemeImportMessage,
    customThemeImportExpanded: state.customThemeImportExpanded,
    customThemeImportFocusToken: state.customThemeImportFocusToken,
    onCustomThemeImportUrlChange: (next) => state.setCustomThemeImportUrl(next),
    onOpenCustomThemeImport: () => state.openCustomThemeImport(),
    onImportCustomTheme: () => void state.importCustomTheme(),
    onClearCustomTheme: () => state.clearCustomTheme(),
    borderRadius: state.settings.borderRadius,
    setBorderRadius: (value) => state.setBorderRadius(value),
    textScale: state.settings.textScale ?? 100,
    setTextScale: (value) => state.setTextScale(value),
    gatewayUrl: state.settings.gatewayUrl,
    assistantName: state.assistantName,
    configPath: state.configSnapshot?.path ?? null,
    rawAvailable:
      typeof state.configSnapshot?.raw === "string" ||
      Boolean(state.configSnapshot?.config) ||
      Boolean(state.configForm),
  } satisfies Omit<
    ConfigProps,
    | "formMode"
    | "searchQuery"
    | "activeSection"
    | "activeSubsection"
    | "onFormModeChange"
    | "onSearchChange"
    | "onSectionChange"
    | "onSubsectionChange"
    | "showModeToggle"
    | "navRootLabel"
    | "includeSections"
    | "excludeSections"
    | "includeVirtualSections"
  >;
  const renderConfigTab = (overrides: ConfigTabOverrides) => {
    const scopedDefaultSection = overrides.includeSections?.[0] ?? null;
    const activeSection = overrides.activeSection ?? scopedDefaultSection;
    const showRootTab = overrides.showRootTab ?? !overrides.includeSections?.length;
    return renderMeasured(
      state,
      "config",
      {
        tab: state.tab,
        formMode: overrides.formMode,
        activeSection,
        activeSubsection: overrides.activeSubsection,
        schemaSectionCount: countScopedTopLevelSchemaProperties(
          commonConfigProps.schema,
          overrides.includeSections,
          overrides.excludeSections,
        ),
        hasSearch: Boolean(overrides.searchQuery?.trim()),
      },
      () =>
        renderConfig({
          ...commonConfigProps,
          includeVirtualSections: false,
          ...overrides,
          activeSection,
          showRootTab,
        }),
    );
  };
  const configSelection = normalizeMainConfigSelection(
    state.configActiveSection,
    state.configActiveSubsection,
  );
  const communicationsSelection = normalizeScopedConfigSelection(
    state.communicationsActiveSection,
    state.communicationsActiveSubsection,
    COMMUNICATION_SECTION_KEYS,
  );
  const appearanceSelection = normalizeScopedConfigSelection(
    state.appearanceActiveSection,
    state.appearanceActiveSubsection,
    APPEARANCE_SECTION_KEYS,
  );
  const automationSelection = normalizeScopedConfigSelection(
    state.automationActiveSection,
    state.automationActiveSubsection,
    AUTOMATION_SECTION_KEYS,
  );
  const infrastructureSelection = normalizeScopedConfigSelection(
    state.infrastructureActiveSection,
    state.infrastructureActiveSubsection,
    INFRASTRUCTURE_SECTION_KEYS,
  );
  const aiAgentsSelection = normalizeScopedConfigSelection(
    state.aiAgentsActiveSection,
    state.aiAgentsActiveSubsection,
    AI_AGENTS_SECTION_KEYS,
  );
  const renderConfigTabForActiveTab = () => {
    switch (state.tab) {
      case "config": {
        // Quick Settings mode — opinionated card layout
        if (state.configSettingsMode === "quick") {
          const configObj = state.configForm ?? state.configSnapshot?.config ?? {};
          const assistantAvatarOverride =
            localAssistantAvatarOverride ?? resolveAssistantAvatarOverride(configObj);
          const agentsDefaults = ((configObj.agents as Record<string, unknown> | undefined)
            ?.defaults ?? {}) as Record<string, unknown>;
          const activeSession = resolveQuickSettingsSessionRow(state);
          const currentModel =
            typeof activeSession?.model === "string"
              ? activeSession.model
              : typeof agentsDefaults.model === "string"
                ? agentsDefaults.model
                : "default";
          const thinkingLevel =
            typeof activeSession?.thinkingLevel === "string"
              ? activeSession.thinkingLevel
              : typeof agentsDefaults.thinkingLevel === "string"
                ? agentsDefaults.thinkingLevel
                : "off";
          const fastMode =
            typeof activeSession?.fastMode === "boolean"
              ? activeSession.fastMode
              : agentsDefaults.fastMode === true;
          return renderQuickSettings({
            currentModel,
            thinkingLevel,
            fastMode,
            onModelChange: () => {
              state.configSettingsMode = "advanced";
              state.aiAgentsActiveSection = "models";
              state.setTab("aiAgents");
            },
            onThinkingChange: (level) => {
              void patchSession(state, state.sessionKey, {
                thinkingLevel: level,
              }).then(() => requestHostUpdate?.());
            },
            onFastModeToggle: () => {
              void patchSession(state, state.sessionKey, {
                fastMode: !fastMode,
              }).then(() => requestHostUpdate?.());
            },
            channels: extractQuickSettingsChannels(state),
            onChannelConfigure: () => {
              state.setTab("channels");
            },
            automation: {
              cronJobCount: state.cronJobs?.length ?? 0,
              skillCount: state.skillsReport?.skills?.length ?? 0,
              mcpServerCount: extractMcpServerCount(state),
            },
            onManageCron: () => {
              state.setTab("cron");
            },
            onBrowseSkills: () => {
              state.setTab("skills");
            },
            onConfigureMcp: () => {
              state.setTab("mcp");
            },
            security: extractQuickSettingsSecurity(state),
            onSecurityConfigure: () => {
              state.configSettingsMode = "advanced";
              state.configActiveSection = "auth";
              requestHostUpdate?.();
            },
            onBrowserEnabledToggle: (enabled) => {
              updateConfigFormValue(state, ["browser", "enabled"], enabled);
              requestHostUpdate?.();
            },
            onToolProfileChange: (profile) => {
              updateConfigFormValue(state, ["tools", "profile"], profile);
              requestHostUpdate?.();
            },
            theme: state.theme,
            themeMode: state.themeMode,
            hasCustomTheme: Boolean(state.settings.customTheme),
            customThemeLabel: state.settings.customTheme?.label ?? null,
            borderRadius: state.settings.borderRadius,
            textScale: state.settings.textScale ?? 100,
            setTheme: (theme, context) => state.setTheme(theme, context),
            onOpenCustomThemeImport: () => {
              state.setTab("appearance");
              state.appearanceFormMode = "form";
              state.appearanceSearchQuery = "";
              state.appearanceActiveSection = "__appearance__";
              state.appearanceActiveSubsection = null;
              state.openCustomThemeImport();
              requestHostUpdate?.();
            },
            setThemeMode: (mode, context) => state.setThemeMode(mode, context),
            setBorderRadius: (value) => state.setBorderRadius(value),
            setTextScale: (value) => state.setTextScale(value),
            userAvatar: state.userAvatar ?? null,
            onUserAvatarChange: (avatar) => state.applyLocalUserIdentity?.({ avatar }),
            assistantAvatar: configAssistantAvatar,
            assistantAvatarUrl: configAssistantAvatarUrl,
            assistantAvatarSource: configAssistantAvatarSource,
            assistantAvatarStatus: configAssistantAvatarStatus,
            assistantAvatarReason: configAssistantAvatarReason,
            assistantAvatarOverride,
            assistantAvatarUploadBusy: state.assistantAvatarUploadBusy,
            assistantAvatarUploadError: state.assistantAvatarUploadError,
            onAssistantAvatarOverrideChange: (dataUrl) => {
              setAssistantAvatarOverride(state, dataUrl, activeAssistantAgentId);
              state.chatAvatarUrl = dataUrl;
              state.chatAvatarSource = dataUrl;
              state.chatAvatarStatus = "data";
              state.chatAvatarReason = null;
              state.assistantAvatarUploadError = null;
              requestHostUpdate?.();
            },
            onAssistantAvatarClearOverride: () => {
              setAssistantAvatarOverride(state, null, activeAssistantAgentId);
              state.chatAvatarUrl = null;
              state.chatAvatarSource = null;
              state.chatAvatarStatus = null;
              state.chatAvatarReason = null;
              state.assistantAvatarUploadError = null;
              const identitySessionKey = buildAgentMainSessionKey({
                agentId: activeAssistantAgentId,
              });
              void state
                .loadAssistantIdentity?.({
                  sessionKey: identitySessionKey,
                  expectedSessionKey: state.sessionKey,
                })
                .finally(() => requestHostUpdate?.());
              requestHostUpdate?.();
            },
            basePath: state.basePath ?? "",
            configObject: configObj,
            savedConfigObject:
              (state.configSnapshot?.config as Record<string, unknown> | null) ?? {},
            configDirty: state.configFormDirty,
            configSaving: state.configSaving,
            configApplying: state.configApplying,
            configReady: Boolean(state.configSnapshot?.hash),
            onSelectPreset: (presetId) => {
              const preset = getPresetById(presetId);
              if (!preset) {
                return;
              }
              stageConfigPreset(state, preset.patch);
              requestHostUpdate?.();
            },
            onResetConfig: () => resetConfigPendingChanges(state),
            onSaveConfig: () => void saveConfig(state),
            onApplyConfig: () => void applyConfig(state),
            onAdvancedSettings: () => {
              state.configSettingsMode = "advanced";
              requestHostUpdate?.();
            },
            connected: state.connected,
            gatewayUrl: state.settings.gatewayUrl,
            assistantName: state.assistantName,
            version: state.hello?.server?.version ?? "",
          });
        }
        // Advanced mode — full config form with accordion groups
        return renderConfigTab({
          formMode: state.configFormMode,
          searchQuery: state.configSearchQuery,
          activeSection: configSelection.activeSection,
          activeSubsection: configSelection.activeSubsection,
          onFormModeChange: (mode) => (state.configFormMode = mode),
          onSearchChange: (query) => (state.configSearchQuery = query),
          onSectionChange: (section) => {
            state.configActiveSection = section;
            state.configActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.configActiveSubsection = section),
          showModeToggle: true,
          settingsLayout: "accordion",
          onBackToQuick: () => {
            state.configSettingsMode = "quick";
            requestHostUpdate?.();
          },
          excludeSections: [
            ...COMMUNICATION_SECTION_KEYS,
            ...AUTOMATION_SECTION_KEYS,
            ...INFRASTRUCTURE_SECTION_KEYS,
            ...AI_AGENTS_SECTION_KEYS,
            "ui",
            "wizard",
          ],
        });
      }
      case "channels":
        return renderLazyView(lazyChannels, (m) =>
          m.renderChannels({
            connected: state.connected,
            loading: state.channelsLoading,
            snapshot: state.channelsSnapshot,
            lastError: state.channelsError,
            lastSuccessAt: state.channelsLastSuccess,
            configSchema: state.configSchema,
            configSchemaLoading: state.configSchemaLoading,
            configForm: state.configForm,
            configUiHints: state.configUiHints,
            configSaving: state.configSaving,
            configFormDirty: state.configFormDirty,
            onRefresh: (probe) => void loadChannels(state, probe),
            onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
            onConfigSave: () => void state.handleChannelConfigSave(),
            onConfigReload: () => void state.handleChannelConfigReload(),
          }),
        );
      case "communications":
        return renderConfigTab({
          formMode: state.communicationsFormMode,
          searchQuery: state.communicationsSearchQuery,
          activeSection: communicationsSelection.activeSection,
          activeSubsection: communicationsSelection.activeSubsection,
          onFormModeChange: (mode) => (state.communicationsFormMode = mode),
          onSearchChange: (query) => (state.communicationsSearchQuery = query),
          onSectionChange: (section) => {
            state.communicationsActiveSection = section;
            state.communicationsActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.communicationsActiveSubsection = section),
          navRootLabel: "Communication",
          includeSections: [...COMMUNICATION_SECTION_KEYS],
          includeVirtualSections: true,
          webPush: {
            supported: state.webPushSupported,
            permission: state.webPushPermission,
            subscribed: state.webPushSubscribed,
            loading: state.webPushLoading,
          },
          onWebPushSubscribe: () => void state.handleWebPushSubscribe(),
          onWebPushUnsubscribe: () => void state.handleWebPushUnsubscribe(),
          onWebPushTest: () => void state.handleWebPushTest(),
        });
      case "appearance":
        return renderConfigTab({
          formMode: state.appearanceFormMode,
          searchQuery: state.appearanceSearchQuery,
          activeSection: appearanceSelection.activeSection,
          activeSubsection: appearanceSelection.activeSubsection,
          onFormModeChange: (mode) => (state.appearanceFormMode = mode),
          onSearchChange: (query) => (state.appearanceSearchQuery = query),
          onSectionChange: (section) => {
            state.appearanceActiveSection = section;
            state.appearanceActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.appearanceActiveSubsection = section),
          navRootLabel: t("tabs.appearance"),
          includeSections: [...APPEARANCE_SECTION_KEYS],
          includeVirtualSections: true,
        });
      case "automation":
        return renderConfigTab({
          formMode: state.automationFormMode,
          searchQuery: state.automationSearchQuery,
          activeSection: automationSelection.activeSection,
          activeSubsection: automationSelection.activeSubsection,
          onFormModeChange: (mode) => (state.automationFormMode = mode),
          onSearchChange: (query) => (state.automationSearchQuery = query),
          onSectionChange: (section) => {
            state.automationActiveSection = section;
            state.automationActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.automationActiveSubsection = section),
          navRootLabel: "Automation",
          includeSections: [...AUTOMATION_SECTION_KEYS],
        });
      case "mcp":
        return renderMcp({
          configObject:
            state.configForm ??
            ((state.configSnapshot?.config as Record<string, unknown> | null) || {}),
          configDirty: state.configFormDirty,
          configSaving: state.configSaving,
          configApplying: state.configApplying,
          connected: state.connected,
          onSaveConfig: () => void saveConfig(state),
          onApplyConfig: () => void applyConfig(state),
          onServerEnabledChange: (name, enabled) => {
            updateMcpServerEnabled(state, name, enabled);
            requestHostUpdate?.();
          },
          editor: renderConfigTab({
            formMode: "form",
            searchQuery: "",
            activeSection: "mcp",
            activeSubsection: null,
            onFormModeChange: () => undefined,
            onSearchChange: () => undefined,
            onSectionChange: () => {
              state.infrastructureActiveSection = "mcp";
              state.infrastructureActiveSubsection = null;
            },
            onSubsectionChange: (section) => (state.infrastructureActiveSubsection = section),
            navRootLabel: "MCP",
            includeSections: ["mcp"],
          }),
        });
      case "infrastructure":
        return renderConfigTab({
          formMode: state.infrastructureFormMode,
          searchQuery: state.infrastructureSearchQuery,
          activeSection: infrastructureSelection.activeSection,
          activeSubsection: infrastructureSelection.activeSubsection,
          onFormModeChange: (mode) => (state.infrastructureFormMode = mode),
          onSearchChange: (query) => (state.infrastructureSearchQuery = query),
          onSectionChange: (section) => {
            state.infrastructureActiveSection = section;
            state.infrastructureActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.infrastructureActiveSubsection = section),
          navRootLabel: "Infrastructure",
          includeSections: [...INFRASTRUCTURE_SECTION_KEYS],
        });
      case "aiAgents":
        return renderConfigTab({
          formMode: state.aiAgentsFormMode,
          searchQuery: state.aiAgentsSearchQuery,
          activeSection: aiAgentsSelection.activeSection,
          activeSubsection: aiAgentsSelection.activeSubsection,
          onFormModeChange: (mode) => (state.aiAgentsFormMode = mode),
          onSearchChange: (query) => (state.aiAgentsSearchQuery = query),
          onSectionChange: (section) => {
            state.aiAgentsActiveSection = section;
            state.aiAgentsActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.aiAgentsActiveSubsection = section),
          navRootLabel: "AI & Agents",
          includeSections: [...AI_AGENTS_SECTION_KEYS],
        });
      default:
        return nothing;
    }
  };
  const loadAgentPanelDataForSelectedAgent = (agentId: string | null) => {
    if (!agentId) {
      return;
    }
    switch (state.agentsPanel) {
      case "files":
        void loadAgentFiles(state, agentId);
        return;
      case "skills":
        void loadAgentSkills(state, agentId);
        return;
      case "tools":
        void loadToolsCatalog(state, agentId);
        void refreshVisibleToolsEffectiveForCurrentSession(state);
      case "overview":
      case "channels":
      case "cron":
    }
  };
  const refreshAgentsPanelSupplementalData = (panel: AppViewState["agentsPanel"]) => {
    if (panel === "channels") {
      void loadChannels(state, false);
      return;
    }
    if (panel === "cron") {
      void state.loadCron();
    }
  };
  const resetAgentFilesState = (clearLoading = false) => {
    state.agentFilesList = null;
    state.agentFilesError = null;
    state.agentFileActive = null;
    state.agentFileContents = {};
    state.agentFileDrafts = {};
    if (clearLoading) {
      state.agentFilesLoading = false;
    }
  };
  const resetAgentSelectionPanelState = () => {
    resetAgentFilesState(true);
    state.agentSkillsReport = null;
    state.agentSkillsError = null;
    state.agentSkillsAgentId = null;
    state.toolsCatalogResult = null;
    state.toolsCatalogError = null;
    state.toolsCatalogLoading = false;
    resetToolsEffectiveState(state);
  };
  if (
    isChat &&
    !chatWorkspaceFiles.collapsed &&
    state.connected &&
    state.agentsList &&
    !chatWorkspaceFiles.loading &&
    !chatWorkspaceFiles.error &&
    chatWorkspaceFiles.list?.sessionKey !== state.sessionKey
  ) {
    loadChatWorkspaceFiles();
  }
  const toggleChatWorkspaceFilesCollapsed = () => {
    chatWorkspaceFiles.collapsed = !chatWorkspaceFiles.collapsed;
    if (!chatWorkspaceFiles.collapsed && chatWorkspaceFiles.list?.sessionKey !== state.sessionKey) {
      loadChatWorkspaceFiles();
    }
    requestHostUpdate?.();
  };
  const refreshChatWorkspaceFiles = () => {
    loadChatWorkspaceFiles({ force: true });
  };
  // The roster and the paper list back the profile landing page -- the attention stack, the
  // member's own record, the work summary -- and not just the Members and Papers tabs. So the load
  // follows the *session*, not the tab: a signed-in member fetches once, on whatever page they land
  // on. Previously this was gated on `adminBotPanel`, which is null for the landing page, so a
  // member saw an empty profile until they happened to open Members or Papers.
  //
  // `state.connected` stays on the gateway-driven half only. A member reads over their own HTTP
  // session (loadAdminBot prefers loadStoredMemberSession), which needs no gateway socket at all --
  // requiring one was the second half of why the landing page came up blank for plain members.
  const hasMemberSession = Boolean(state.memberId);
  // Time Availability needs the roster to fill its member picker but renders its own view, so it
  // deliberately maps to no panel. It has to be named here instead: `adminBotPanel` doubles as the
  // render switch, and borrowing "members" to trigger the fetch drew the whole Lab Members panel
  // underneath the schedule.
  // Meeting Recordings joins this for the same reason: its admin attendance editor lists every
  // member, including the ones no import found, so it needs the roster while rendering its own view.
  const wantsRosterOnly =
    state.tab === "adminbotTimeAvailability" || state.tab === "adminbotMeetings";
  const wantsGatewayAdminBotLoad =
    ((isChat && isAdminBotChat) || adminBotPanel || wantsRosterOnly) && state.connected;
  if (
    (hasMemberSession || wantsGatewayAdminBotLoad) &&
    !state.adminBotLoading &&
    !state.adminBotError &&
    !state.adminBotData.loadedAt
  ) {
    void loadAdminBot(state, adminBotMode).finally(() => requestHostUpdate?.());
  }
  // The Calendar tab's events are a separate read from the roster, and nothing was triggering it:
  // opening the tab drew an empty month and only the Refresh button or a month step would fetch
  // anything. `calendarEvents === undefined` is the "never asked" sentinel — a load that genuinely
  // finds nothing sets [], so this cannot loop on an empty calendar.
  if (
    state.tab === "adminbotCalendar" &&
    adminBotMode === "admin" &&
    hasMemberSession &&
    !state.calendarEventsLoading &&
    !state.calendarEventsError &&
    state.calendarEvents === undefined
  ) {
    void state.loadCalendarEvents?.().finally(() => requestHostUpdate?.());
  }
  // The calendar flags attendees whose whereabouts are in question, so the drift list is fetched
  // alongside the month. Admin-only on the service; a member never opens this tab.
  if (
    state.tab === "adminbotCalendar" &&
    adminBotMode === "admin" &&
    hasMemberSession &&
    state.adminBotLocationDrifts === undefined
  ) {
    void state.loadLocationDrifts?.().finally(() => requestHostUpdate?.());
  }
  // Asked once, when the member opens their own profile -- which is where the banner renders and
  // the only place its answer makes sense. Undefined is "not asked yet"; null is a real "nothing
  // to ask" and must not re-trigger.
  if (state.tab === "profile" && hasMemberSession && state.adminBotLocationDrift === undefined) {
    void state.loadLocationPrompt?.().finally(() => requestHostUpdate?.());
  }
  // Logistics drafts are per-member, and this is where that is enforced. The scope changes when
  // somebody signs in, signs out, or a second person uses the same browser -- and each time, the
  // forms on screen belong to the previous scope and have to be cleared and refilled from that
  // member's own drafts. Doing it here rather than at connect time is what makes a sign-in that
  // happens after first paint restore anything at all.
  const logisticsScope = adminBotLogisticsScope(state);
  // Gated on the tab so a member who never opens Logistics never pays for an IndexedDB read. The
  // scope comparison is what re-runs it when the signed-in member changes underneath an open tab.
  if (state.tab === "adminbotLogistics" && state.adminBotLogisticsDraftScope !== logisticsScope) {
    state.adminBotLogisticsDraftScope = logisticsScope;
    // A correction belongs to the member who opened it. Left set across a scope change it would
    // point the next person's Submit at a request they do not own.
    state.adminBotLogisticsEditingId = null;
    state.adminBotLogisticsSubmittedId = null;
    resetAdminBotLogisticsForm(state, "documentSignature");
    resetAdminBotLogisticsForm(state, "recommendationLetters");
    resetAdminBotLogisticsForm(state, "bookMeeting");
    // Fire-and-forget and silent on failure: putting a draft back is a convenience the member did
    // not ask for on this visit, so it must never block a paint or raise an error of its own.
    void Promise.all([
      restoreAdminBotLogisticsDraft(state, logisticsScope),
      restoreAdminBotLettersDraft(state, logisticsScope),
      restoreAdminBotMeetingDraft(state, logisticsScope),
    ]).finally(() => requestHostUpdate?.());
  }
  // Same "never asked" sentinel as the logistics queue: the overview is read when the tab is
  // opened, and re-read after a reminder run clears the stamp.
  if (
    state.tab === "adminbotProfileOverview" &&
    hasMemberSession &&
    !state.adminBotProfileOverviewLoading &&
    !state.adminBotProfileOverviewError &&
    state.adminBotProfileOverviewLoadedAt === null
  ) {
    state.adminBotProfileOverviewLoadedAt = Date.now();
    void loadAdminBotProfileOverview(state).finally(() => requestHostUpdate?.());
  }
  // My Projects & Papers reads the same way: the overview when the tab opens, and again after a
  // nudge run or a slot write clears the stamp. Individual papers' slots are fetched per card, in
  // the toggle handler, since a closed card needs none of them.
  if (
    // The Admin tab's "Next step per paper" reads the same overview, so opening Admin directly
    // has to fetch it too -- otherwise that list renders empty until someone visits My Work.
    // Active Papers draws the same cards over every paper in the lab, so it needs it as well.
    (state.tab === "myWork" || state.tab === "adminbot" || state.tab === "adminbotPapers") &&
    hasMemberSession &&
    !state.adminBotPaperSlotsLoading &&
    !state.adminBotPaperSlotsError &&
    state.adminBotPaperSlotsLoadedAt === null
  ) {
    state.adminBotPaperSlotsLoadedAt = Date.now();
    void loadAdminBotPaperSlotOverview(state).finally(() => requestHostUpdate?.());
  }
  // The request list is fetched when the tab is opened in view mode -- including on a reload that
  // lands straight on it, which the mode-change handler alone would miss. `requests.length` is not
  // the sentinel: a lab with no requests would re-ask on every render.
  if (
    state.tab === "adminbotLogistics" &&
    state.adminBotLogisticsMode === "view" &&
    hasMemberSession &&
    !state.adminBotLogisticsRequestsLoading &&
    !state.adminBotLogisticsRequestsError &&
    state.adminBotLogisticsRequestsLoadedAt === null
  ) {
    state.adminBotLogisticsRequestsLoadedAt = Date.now();
    void loadAdminBotLogisticsRequests(state).finally(() => requestHostUpdate?.());
  }
  // Same "never asked" sentinel as the calendar above: the meetings list is fetched once when the
  // tab is opened, and a lab that has recorded nothing sets [] rather than looping.
  if (
    state.tab === "adminbotMeetings" &&
    hasMemberSession &&
    !state.adminBotMeetingsLoading &&
    !state.adminBotMeetingsError &&
    state.adminBotMeetings === undefined
  ) {
    void state.loadMeetings?.().finally(() => requestHostUpdate?.());
  }
  const browseChatWorkspacePath = (path: string) => {
    if (chatWorkspaceFiles.browserSearchTimer) {
      globalThis.clearTimeout(chatWorkspaceFiles.browserSearchTimer);
      chatWorkspaceFiles.browserSearchTimer = null;
    }
    chatWorkspaceFiles.browserPath = path;
    chatWorkspaceFiles.browserSearch = "";
    loadChatWorkspaceFiles({ force: true });
  };
  const searchChatWorkspaceFiles = (search: string) => {
    chatWorkspaceFiles.browserSearch = search;
    if (chatWorkspaceFiles.browserSearchTimer) {
      globalThis.clearTimeout(chatWorkspaceFiles.browserSearchTimer);
    }
    chatWorkspaceFiles.browserSearchTimer = globalThis.setTimeout(() => {
      chatWorkspaceFiles.browserSearchTimer = null;
      loadChatWorkspaceFiles({ force: true });
    }, 160);
  };
  const copyChatWorkspacePath = (filePath: string) => {
    void globalThis.navigator?.clipboard?.writeText?.(filePath);
  };
  function loadChatWorkspaceFiles(opts?: { force?: boolean }) {
    if (!state.client || !state.connected) {
      return;
    }
    if (chatWorkspaceFiles.loading) {
      if (opts?.force) {
        chatWorkspaceFiles.pendingReload = true;
      }
      return;
    }
    const requestId = chatWorkspaceFiles.requestId + 1;
    chatWorkspaceFiles.requestId = requestId;
    chatWorkspaceFiles.loading = true;
    chatWorkspaceFiles.error = null;
    if (opts?.force) {
      chatWorkspaceFiles.list = null;
    }
    const requestState = chatWorkspaceFiles;
    requestState.pendingReload = false;
    const sessionKey = state.sessionKey;
    const agentId = chatWorkspaceFiles.agentId;
    void (async () => {
      try {
        const res = await state.client?.request<SessionWorkspaceListResult | null>(
          "sessions.files.list",
          {
            sessionKey,
            path: requestState.browserSearch ? "" : requestState.browserPath,
            search: requestState.browserSearch,
            ...(agentId ? { agentId } : {}),
          },
        );
        const artifacts = await state.client?.request<{
          artifacts?: SessionWorkspaceListResult["artifacts"];
        } | null>("artifacts.list", {
          sessionKey,
          ...(agentId ? { agentId } : {}),
        });
        const current = currentChatWorkspaceFilesState();
        if (current !== requestState || current.requestId !== requestId) {
          return;
        }
        const files = res?.files ?? [];
        const artifactItems = artifacts?.artifacts ?? [];
        current.list = {
          sessionKey,
          ...(res?.root ? { root: res.root } : {}),
          files,
          ...(res?.browser ? { browser: res.browser } : {}),
          artifacts: artifactItems,
        };
        if (
          current.activeId &&
          !files.some((file) => `file:${file.path}` === current.activeId) &&
          !artifactItems.some((artifact) => `artifact:${artifact.id}` === current.activeId)
        ) {
          current.activeId = null;
        }
      } catch (err) {
        const current = currentChatWorkspaceFilesState();
        if (current === requestState && current.requestId === requestId) {
          current.error = String(err);
        }
      } finally {
        const current = currentChatWorkspaceFilesState();
        if (current === requestState && current.requestId === requestId) {
          current.loading = false;
          const shouldReload = current.pendingReload;
          current.pendingReload = false;
          if (shouldReload) {
            loadChatWorkspaceFiles({ force: true });
          }
        }
        requestHostUpdate?.();
      }
    })();
  }
  const startChatWorkspaceFileOpenRequest = (itemId: string) => {
    chatWorkspaceFiles.activeId = itemId;
    const previousRequest = chatWorkspaceFileOpenRequests.get(state);
    const openRequest = {
      agentId: chatWorkspaceFiles.agentId,
      id: (previousRequest?.id ?? 0) + 1,
      itemId,
      sessionKey: currentSessionWorkspaceKey(),
    };
    chatWorkspaceFileOpenRequests.set(state, openRequest);
    const isCurrentOpenRequest = () => {
      const currentRequest = chatWorkspaceFileOpenRequests.get(state);
      const currentFiles = currentChatWorkspaceFilesState();
      return (
        currentRequest?.id === openRequest.id &&
        currentRequest.agentId === resolveChatWorkspaceAgentId() &&
        currentRequest.itemId === itemId &&
        currentRequest.sessionKey === currentSessionWorkspaceKey() &&
        currentFiles?.agentId === openRequest.agentId &&
        currentFiles?.activeId === itemId
      );
    };
    return { isCurrentOpenRequest, openRequest };
  };
  const openChatWorkspaceFile = (filePath: string) => {
    const itemId = `file:${filePath}`;
    const { isCurrentOpenRequest, openRequest } = startChatWorkspaceFileOpenRequest(itemId);
    void (async () => {
      if (!state.client || !state.connected) {
        return;
      }
      chatWorkspaceFiles.error = null;
      try {
        const agentId = openRequest.agentId;
        const res = await state.client.request<SessionWorkspaceGetResult | null>(
          "sessions.files.get",
          {
            sessionKey: openRequest.sessionKey,
            path: filePath,
            ...(agentId ? { agentId } : {}),
          },
        );
        const file = res?.file;
        if (!file || typeof file.content !== "string") {
          if (isCurrentOpenRequest()) {
            chatWorkspaceFiles.error = `Failed to load ${filePath}`;
            requestHostUpdate?.();
          }
          return;
        }
        const content = file.content;
        if (!isCurrentOpenRequest()) {
          return;
        }
        state.handleOpenSidebar({
          kind: "markdown",
          content: buildWorkspaceFileSidebarContent(file.name || filePath, content),
          rawText: content,
        });
      } catch (err) {
        if (isCurrentOpenRequest()) {
          chatWorkspaceFiles.error = String(err);
        }
      } finally {
        requestHostUpdate?.();
      }
    })();
  };
  const openChatWorkspaceArtifact = (artifactId: string) => {
    const itemId = `artifact:${artifactId}`;
    const { isCurrentOpenRequest, openRequest } = startChatWorkspaceFileOpenRequest(itemId);
    void (async () => {
      if (!state.client || !state.connected) {
        return;
      }
      chatWorkspaceFiles.error = null;
      try {
        const agentId = openRequest.agentId;
        const res = await state.client.request<ArtifactDownloadResult | null>(
          "artifacts.download",
          {
            sessionKey: openRequest.sessionKey,
            artifactId,
            ...(agentId ? { agentId } : {}),
          },
        );
        if (!res?.artifact) {
          if (isCurrentOpenRequest()) {
            chatWorkspaceFiles.error = `Failed to load artifact ${artifactId}`;
            requestHostUpdate?.();
          }
          return;
        }
        if (!isCurrentOpenRequest()) {
          return;
        }
        const title = res.artifact.title;
        const mimeType = res.artifact.mimeType ?? "";
        const preview = buildArtifactSidebarContent({
          data: res.data,
          encoding: res.encoding,
          mimeType,
          title,
          url: res.url,
        });
        state.handleOpenSidebar(preview);
      } catch (err) {
        if (isCurrentOpenRequest()) {
          chatWorkspaceFiles.error = String(err);
        }
      } finally {
        requestHostUpdate?.();
      }
    })();
  };

  return html`
    ${renderCommandPalette({
      open: state.paletteOpen,
      query: state.paletteQuery,
      activeIndex: state.paletteActiveIndex,
      onToggle: () => {
        state.paletteOpen = !state.paletteOpen;
      },
      onQueryChange: (q) => {
        state.paletteQuery = q;
      },
      onActiveIndexChange: (i) => {
        state.paletteActiveIndex = i;
      },
      onNavigate: (tab) => {
        state.setTab(tab as import("./navigation.ts").Tab);
      },
      onSlashCommand: (cmd) => {
        state.setTab("chat" as import("./navigation.ts").Tab);
        state.handleChatDraftChange(cmd.endsWith(" ") ? cmd : `${cmd} `);
      },
    })}
    ${state.memberId ? renderChangePasswordPopover(state) : nothing}
    <div
      class="shell ${isChat ? "shell--chat" : ""} ${navCollapsed
        ? "shell--nav-collapsed"
        : ""} ${navDrawerOpen ? "shell--nav-drawer-open" : ""} ${state.onboarding
        ? "shell--onboarding"
        : ""}"
      style=${styleMap(
        state.chatMessageMaxWidth ? { "--chat-message-max-width": state.chatMessageMaxWidth } : {},
      )}
    >
      <button
        type="button"
        class="shell-nav-backdrop"
        aria-label="${t("nav.collapse")}"
        @click=${() => {
          state.navDrawerOpen = false;
        }}
      ></button>
      <header
        class="topbar"
        ?inert=${state.onboarding}
        aria-hidden=${state.onboarding ? "true" : nothing}
      >
        <div class="topnav-shell">
          <button
            type="button"
            class="sidebar-menu-trigger topbar-nav-toggle"
            @click=${() => {
              state.navDrawerOpen = !navDrawerOpen;
            }}
            title="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-label="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-expanded=${navDrawerOpen}
          >
            <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons.menu}</span>
          </button>
          <div class="topnav-shell__content">
            <dashboard-header
              .tab=${state.tab}
              .basePath=${state.basePath}
              .agentLabel=${dashboardHeaderContext.agentLabel}
              @navigate=${(event: CustomEvent<Tab>) => {
                state.setTab(event.detail);
              }}
            ></dashboard-header>
          </div>
          <div class="topnav-shell__actions">
            <button
              class="topbar-search"
              @click=${() => {
                state.paletteOpen = !state.paletteOpen;
              }}
              title=${t("chat.commandPaletteTitle")}
              aria-label=${t("chat.openCommandPalette")}
            >
              <span class="topbar-search__label">${t("common.search")}</span>
              <kbd class="topbar-search__kbd">⌘K</kbd>
            </button>
            ${renderNudgeBell(state)}
            <div class="topbar-status">${renderTopbarThemeModeToggle(state)}</div>
          </div>
        </div>
      </header>
      <div class="shell-nav">
        <aside class="sidebar ${navCollapsed ? "sidebar--collapsed" : ""}">
          <div class="sidebar-shell">
            <div class="sidebar-shell__header">
              <div class="sidebar-brand">
                ${navCollapsed
                  ? nothing
                  : html`
                      <img
                        class="sidebar-brand__logo"
                        src="${agentLogoUrl(basePath)}"
                        alt="AdminBot"
                      />
                      <span class="sidebar-brand__copy">
                        <span class="sidebar-brand__eyebrow">${t("nav.control")}</span>
                        <span class="sidebar-brand__title">AdminBot</span>
                      </span>
                    `}
              </div>
              <button
                type="button"
                class="nav-collapse-toggle"
                @click=${() => {
                  // While the drawer is open, navCollapsed is forced false above, so
                  // toggling the setting here changed nothing visible and left the
                  // drawer open — against this button's own "collapse" label.
                  if (navDrawerOpen) {
                    state.navDrawerOpen = false;
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    navCollapsed: !state.settings.navCollapsed,
                  });
                }}
                title="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
                aria-label="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
              >
                <span class="nav-collapse-toggle__icon" aria-hidden="true"
                  >${navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}</span
                >
              </button>
            </div>
            <div class="sidebar-shell__body">
              <nav class="sidebar-nav">
                ${TAB_GROUPS.map((group) => {
                  const groupTabs = visibleTabsForRole(group.tabs as readonly Tab[], accessRole);
                  // A group whose every tab is out of reach renders nothing at all, header
                  // included: an empty "Settings" heading reads as a broken sidebar.
                  if (groupTabs.length === 0) {
                    return nothing;
                  }
                  const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
                  const showItems = navCollapsed || !isGroupCollapsed;

                  return html`
                    <section class="nav-section ${!showItems ? "nav-section--collapsed" : ""}">
                      ${!navCollapsed
                        ? html`
                            <button
                              class="nav-section__label"
                              @click=${() => {
                                const next = {
                                  ...state.settings.navGroupsCollapsed,
                                };
                                next[group.label] = !isGroupCollapsed;
                                state.applySettings({
                                  ...state.settings,
                                  navGroupsCollapsed: next,
                                });
                              }}
                              aria-expanded=${showItems}
                            >
                              <span class="nav-section__label-text"
                                >${t(`nav.${group.label}`)}</span
                              >
                              <span class="nav-section__chevron"> ${icons.chevronDown} </span>
                            </button>
                          `
                        : nothing}
                      <div class="nav-section__items">
                        ${groupTabs.map((tab) =>
                          renderTab(state, tab, { collapsed: navCollapsed }),
                        )}
                      </div>
                    </section>
                  `;
                })}
              </nav>
            </div>
            <div class="sidebar-shell__footer">
              <div class="sidebar-utility-group">
                <!-- Was an external link to docs.openclaw.ai, which documented the upstream operator
                     tool rather than this lab. Chat holds the slot now, and lives in the footer
                     rather than in a nav group so it stays put at the bottom of the sidebar while
                     the groups above it scroll. -->
                ${visibleTabsForRole(["chat"], accessRole).map((tab) =>
                  renderTab(state, tab, { collapsed: navCollapsed }),
                )}
                <div class="sidebar-mode-switch">${renderTopbarThemeModeToggle(state)}</div>
                ${state.memberId ? renderChangePasswordTrigger(state, navCollapsed) : nothing}
                <button
                  type="button"
                  class="nav-item sidebar-utility-link sidebar-utility-link--signout"
                  title=${t("login.member.signOut")}
                  aria-label=${t("login.member.signOut")}
                  @click=${() => void state.signOutMember()}
                >
                  <span class="nav-item__icon" aria-hidden="true">${icons.logOut}</span>
                  ${!navCollapsed
                    ? html`<span class="nav-item__text">${t("login.member.signOut")}</span>`
                    : nothing}
                </button>
                ${(() => {
                  const version = state.hello?.server?.version ?? "";
                  return version
                    ? html`
                        <div class="sidebar-version" title=${`v${version}`}>
                          ${!navCollapsed
                            ? html`
                                <span class="sidebar-version__label">${t("common.version")}</span>
                                <span class="sidebar-version__text">v${version}</span>
                                ${renderSidebarConnectionStatus(state)}
                              `
                            : html` ${renderSidebarConnectionStatus(state)} `}
                        </div>
                      `
                    : nothing;
                })()}
              </div>
            </div>
          </div>
        </aside>
      </div>
      <main
        class="content ${isChat ? "content--chat" : ""} ${state.tab === "logs"
          ? "content--logs"
          : ""} ${state.tab === "adminbotDeadlines" ? "content--deadlines" : ""}"
      >
        ${state.updateStatusBanner
          ? html`<div class="callout ${state.updateStatusBanner.tone}" role="alert">
              ${state.updateStatusBanner.text}
            </div>`
          : nothing}
        ${state.updateAvailable &&
        state.updateAvailable.latestVersion !== state.updateAvailable.currentVersion &&
        !isUpdateBannerDismissed(state.updateAvailable)
          ? html`<div class="update-banner callout danger" role="alert">
              <strong>${t("chat.updateAvailable")}</strong>
              v${state.updateAvailable.latestVersion}
              (${t("chat.runningVersion", { version: state.updateAvailable.currentVersion })}).
              <button
                class="btn btn--sm update-banner__btn"
                ?disabled=${state.updateRunning || !state.connected}
                @click=${() => runUpdate(state)}
              >
                ${state.updateRunning ? t("chat.updating") : t("chat.updateNow")}
              </button>
              <button
                class="update-banner__close"
                type="button"
                title=${t("common.dismiss")}
                aria-label=${t("chat.dismissUpdateBanner")}
                @click=${() => {
                  dismissUpdateBanner(state.updateAvailable);
                  state.updateAvailable = null;
                }}
              >
                ${icons.x}
              </button>
            </div>`
          : nothing}
        ${state.tab === "config" || isChat || state.tab === "adminbotDeadlines"
          ? nothing
          : html`<section
              class=${chatHeaderHidden
                ? "content-header content-header--chat-hidden"
                : "content-header"}
              ?inert=${chatHeaderHidden}
              aria-hidden=${chatHeaderHidden ? "true" : nothing}
            >
              <div>
                <div class="page-title">${titleForTab(state.tab)}</div>
                <div class="page-sub">${subtitleForTab(state.tab)}</div>
              </div>
              <div class="page-meta">
                <!-- role="alert" because this appears after the page has rendered: a failure
                     that arrives silently is a failure a screen-reader user never hears. -->
                ${headerError
                  ? html`<div class="pill danger" role="alert">${headerError}</div>`
                  : nothing}
              </div>
            </section>`}
        ${state.tab === "dashboard" ? renderDashboard(state, accessRole) : nothing}
        ${state.tab === "profile"
          ? renderLocationPrompt({
              drift: state.adminBotLocationDrift ?? null,
              saving: state.adminBotLocationSaving ?? false,
              error: state.adminBotLocationError ?? null,
              onConfirm: (answer) => {
                void state.answerLocationPrompt?.(answer);
              },
              onDismiss: () => {
                void state.answerLocationPrompt?.({});
              },
            })
          : nothing}
        ${state.tab === "profile"
          ? html`
              ${renderProfile(state, {
                onSave: (memberId, fields) => void saveAdminBotOwnProfile(state, memberId, fields),
                onPolishPhoto: () => void polishAdminBotOwnProfilePhoto(state),
                onApplyPolishedPhoto: (variantId) =>
                  void applyAdminBotOwnProfilePhoto(state, variantId),
              })}
              <!-- Bottom of the page on purpose: the checklist is required reading a member works
                   through once, not the thing they came to this page to do on the other days. -->
              ${renderOnboardingChecklist(state)}
            `
          : nothing}
        ${state.tab === "labSharing" ? renderLabSharing(state) : nothing}
        ${state.tab === "adminbotProfileOverview"
          ? renderAdminBotProfileOverview({
              members: state.adminBotProfileOverview,
              mandatoryFieldCount: state.adminBotProfileOverviewFieldCount,
              loading: state.adminBotProfileOverviewLoading,
              error: state.adminBotProfileOverviewError,
              notice: state.adminBotProfileOverviewNotice,
              reminding: state.adminBotProfileOverviewReminding,
              filter: state.adminBotProfileOverviewFilter,
              onFilterChange: (filter) => {
                state.adminBotProfileOverviewFilter = filter;
                requestHostUpdate?.();
              },
              onRemind: (scope) => {
                void remindAdminBotIncompleteProfiles(state, scope).finally(() =>
                  requestHostUpdate?.(),
                );
              },
              // The follow-up to a thin row is a look at the person, which is Lab Members' job.
              onOpenMember: (memberId: string) => {
                state.selectedMemberId = memberId;
                state.setTab("adminbotMembers");
              },
            })
          : nothing}
        ${state.tab === "adminbotLogistics"
          ? renderAdminBotLogistics({
              role: accessRole,
              mode: state.adminBotLogisticsMode,
              onModeChange: (mode) => {
                state.adminBotLogisticsMode = mode;
                state.adminBotLogisticsOpenRequestId = null;
                state.adminBotLogisticsOpenRequest = null;
                // Clearing the stamp is what asks for a re-read; the effect above does the fetch,
                // so entering the list has one path whether it was reached by this button or by a
                // reload that landed on it. Re-read on every entry rather than once: an admin may
                // have answered a request since the last look.
                state.adminBotLogisticsRequestsLoadedAt = null;
              },
              requests: {
                requests: state.adminBotLogisticsRequests,
                loading: state.adminBotLogisticsRequestsLoading,
                error: state.adminBotLogisticsRequestsError,
                open: state.adminBotLogisticsOpenRequest,
                openLoading: state.adminBotLogisticsOpenLoading,
                viewerIsAdmin: accessRole === "admin",
                viewerMemberId: state.memberId ?? null,
                onOpenRequest: (requestId) => {
                  state.adminBotLogisticsStatusNote = "";
                  void openAdminBotLogisticsRequest(state, requestId).finally(() =>
                    requestHostUpdate?.(),
                  );
                },
                onEdit: (requestId) => {
                  const request = state.adminBotLogisticsOpenRequest;
                  if (!request || request.id !== requestId) {
                    return;
                  }
                  // Loaded from the request that was read in full, so the documents come back with
                  // it rather than having to be picked off the member's disk again.
                  const form = requestToFormState(request);
                  if (form.signature) {
                    state.adminBotLogisticsTemplate = "documentSignature";
                    state.adminBotLogisticsSignatureFiles = form.signature.files;
                    state.adminBotLogisticsDescription = form.signature.description;
                    state.adminBotLogisticsAttachments = form.signature.attachments;
                  } else if (form.letters) {
                    state.adminBotLogisticsTemplate = "recommendationLetters";
                    state.adminBotLettersSchools = [...form.letters.schools];
                    state.adminBotLettersFacts = [...form.letters.facts];
                    state.adminBotLettersCvOverleafUrl = form.letters.cvOverleafUrl;
                    state.adminBotLettersDriveFolderUrl = form.letters.driveFolderUrl;
                  } else if (form.meeting) {
                    state.adminBotLogisticsTemplate = "bookMeeting";
                    state.adminBotMeetingRows = [...form.meeting.rows];
                  }
                  state.adminBotLogisticsEditingId = requestId;
                  state.adminBotLogisticsSubmittedId = null;
                  state.adminBotLogisticsSubmitError = null;
                  state.adminBotLogisticsMode = "make";
                  state.adminBotLogisticsOpenRequest = null;
                  state.adminBotLogisticsOpenRequestId = null;
                },
                onWithdraw: (requestId) => {
                  void withdrawAdminBotLogisticsRequest(state, requestId).finally(() =>
                    requestHostUpdate?.(),
                  );
                },
                onSetStatus: (requestId, status, note) => {
                  void setAdminBotLogisticsRequestStatus(state, requestId, status, note).finally(
                    () => {
                      state.adminBotLogisticsStatusNote = "";
                      requestHostUpdate?.();
                    },
                  );
                },
                statusNote: state.adminBotLogisticsStatusNote,
                onStatusNoteChange: (note) => {
                  state.adminBotLogisticsStatusNote = note;
                },
              },
              queue: {
                requests: state.adminBotLogisticsRequests,
                loading: state.adminBotLogisticsRequestsLoading,
                error: state.adminBotLogisticsRequestsError,
                showSettled: state.adminBotLogisticsShowSettled,
                onShowSettledChange: (showSettled) => {
                  state.adminBotLogisticsShowSettled = showSettled;
                },
                signingId: state.adminBotLogisticsSigningId,
                downloadingId: state.adminBotLogisticsDownloadingId,
                onDownload: (requestId, fileName) => {
                  void downloadAdminBotLogisticsDocument(state, requestId, fileName).finally(() =>
                    requestHostUpdate?.(),
                  );
                },
                signedNote: state.adminBotLogisticsSignedNote,
                onSignedNoteChange: (note) => {
                  state.adminBotLogisticsSignedNote = note;
                },
                onSendSigned: (requestId, files) => {
                  void (async () => {
                    const documents = await filesToAttachments(files);
                    const sent = await sendAdminBotSignedDocuments(
                      state,
                      requestId,
                      documents,
                      state.adminBotLogisticsSignedNote,
                    );
                    if (sent) {
                      // The note belonged to the request that just went out; leaving it in the box
                      // would attach it to whichever one is signed next.
                      state.adminBotLogisticsSignedNote = "";
                    }
                    requestHostUpdate?.();
                  })();
                },
                onOpenRequest: (requestId) => {
                  state.adminBotLogisticsStatusNote = "";
                  void openAdminBotLogisticsRequest(state, requestId).finally(() =>
                    requestHostUpdate?.(),
                  );
                },
                onSetStatus: (requestId, status) => {
                  void setAdminBotLogisticsRequestStatus(state, requestId, status, "").finally(() =>
                    requestHostUpdate?.(),
                  );
                },
              },
              template: state.adminBotLogisticsTemplate,
              onTemplateChange: (template) => {
                state.adminBotLogisticsTemplate = template;
                // Each template owns its own outcome line, so a submit reported on one form must
                // not still be on screen when the member opens another.
                state.adminBotLogisticsSubmittedId = null;
                state.adminBotLogisticsSubmitError = null;
              },
              signature: {
                files: state.adminBotLogisticsSignatureFiles,
                onFilesChange: (files) => {
                  state.adminBotLogisticsSignatureFiles = files;
                },
                description: state.adminBotLogisticsDescription,
                onDescriptionChange: (description) => {
                  state.adminBotLogisticsDescription = description;
                },
                attachments: state.adminBotLogisticsAttachments,
                onAttachmentsChange: (files) => {
                  state.adminBotLogisticsAttachments = files;
                },
                saving: state.adminBotLogisticsSaving,
                savedAt: state.adminBotLogisticsSavedAt,
                saveError: state.adminBotLogisticsSaveError,
                onSave: () =>
                  void saveAdminBotLogisticsDraft(state, adminBotLogisticsScope(state)).finally(
                    () => requestHostUpdate?.(),
                  ),
                ...adminBotLogisticsSubmitProps(state, requestHostUpdate, "documentSignature"),
              },
              meeting: {
                rows: state.adminBotMeetingRows,
                onRowsChange: (rows) => {
                  state.adminBotMeetingRows = rows;
                },
                saving: state.adminBotMeetingSaving,
                savedAt: state.adminBotMeetingSavedAt,
                saveError: state.adminBotMeetingSaveError,
                onSave: () =>
                  void saveAdminBotMeetingDraft(state, adminBotLogisticsScope(state)).finally(() =>
                    requestHostUpdate?.(),
                  ),
                ...adminBotLogisticsSubmitProps(state, requestHostUpdate, "bookMeeting"),
              },
              letters: {
                schools: state.adminBotLettersSchools,
                onSchoolsChange: (schools) => {
                  state.adminBotLettersSchools = schools;
                },
                facts: state.adminBotLettersFacts,
                onFactsChange: (facts) => {
                  state.adminBotLettersFacts = facts;
                },
                onOpenMyProjects: () => state.setTab("myWork"),
                cvOverleafUrl: state.adminBotLettersCvOverleafUrl,
                onCvOverleafUrlChange: (url) => {
                  state.adminBotLettersCvOverleafUrl = url;
                },
                driveFolderUrl: state.adminBotLettersDriveFolderUrl,
                onDriveFolderUrlChange: (url) => {
                  state.adminBotLettersDriveFolderUrl = url;
                },
                saving: state.adminBotLettersSaving,
                savedAt: state.adminBotLettersSavedAt,
                saveError: state.adminBotLettersSaveError,
                onSave: () =>
                  void saveAdminBotLettersDraft(state, adminBotLogisticsScope(state)).finally(() =>
                    requestHostUpdate?.(),
                  ),
                ...adminBotLogisticsSubmitProps(state, requestHostUpdate, "recommendationLetters"),
              },
            })
          : nothing}
        ${state.tab === "adminbotMeetings"
          ? renderAdminBotMeetings({
              meetings: state.adminBotMeetings ?? [],
              loading: state.adminBotMeetingsLoading,
              saving: state.adminBotMeetingsSaving,
              error: state.adminBotMeetingsError,
              viewerIsAdmin: accessRole === "admin",
              viewerMemberId: state.memberId ?? null,
              // Only an admin is offered the roster editor, so only an admin needs the names. A
              // member's own view is built from what the service already redacted for them.
              members:
                accessRole === "admin"
                  ? (state.adminBotData.members ?? []).map((member) => ({
                      id: member.id,
                      name: member.name,
                    }))
                  : [],
              onToggleAttendance: (meetingId, attendee) => {
                void state.toggleMeetingAttendance?.(meetingId, attendee);
              },
              onFileMeeting: (draft) => {
                void state.fileMeeting?.(draft);
              },
            })
          : nothing}
        ${state.tab === "adminbotTimeAvailability"
          ? renderAdminBotTimeAvailability({
              // The trips log's draft lives on the view state so a re-render underneath the
              // typist -- the roster reloading, a save landing -- cannot wipe half-entered input.
              tripDraft: state.adminBotTripDraft ?? EMPTY_TRIP_DRAFT,
              onTripDraftChange: (draft) => {
                state.adminBotTripDraft = draft;
              },
              members: state.adminBotData.members ?? [],
              loading: state.adminBotLoading,
              error: state.adminBotError,
              // Default to your own schedule once the roster lands: it is the one you came for,
              // and it is the only one you can edit. A plain member is pinned to it -- whose time
              // is committed where is planning data for the people who plan, so reading another
              // member's schedule is an admin act (the service strips the fields for everyone
              // else, so a stale selection here would render an empty page anyway).
              selectedMemberId:
                accessRole === "admin"
                  ? state.adminBotTimeAvailabilityMemberId || (state.memberId ?? "")
                  : (state.memberId ?? ""),
              onMemberChange: (memberId) => {
                state.adminBotTimeAvailabilityMemberId = memberId;
                // A different member's schedule carries a different note; keeping the draft would
                // show one person's text over another's record.
                state.adminBotAvailabilityNotesDraft = null;
              },
              range: state.adminBotTimeAvailabilityRange,
              onRangeChange: (range) => {
                state.adminBotTimeAvailabilityRange = range;
              },
              viewerMemberId: state.memberId ?? null,
              viewerIsAdmin: accessRole === "admin",
              draft: state.adminBotTimeAvailabilityDraft,
              onDraftChange: (draft) => {
                state.adminBotTimeAvailabilityDraft = draft;
              },
              awayDraft: state.adminBotTimeAwayDraft,
              onAwayDraftChange: (draft) => {
                state.adminBotTimeAwayDraft = draft;
              },
              milestoneDraft: state.adminBotMilestoneDraft,
              onMilestoneDraftChange: (draft) => {
                state.adminBotMilestoneDraft = draft;
              },
              notesDraft: state.adminBotAvailabilityNotesDraft,
              onNotesDraftChange: (draft) => {
                state.adminBotAvailabilityNotesDraft = draft;
              },
              saving: state.adminBotTimeAvailabilitySaving,
              onSaveSchedule: (memberId, patch) => {
                state.adminBotTimeAvailabilitySaving = true;
                void saveAdminBotOwnSchedule(state, memberId, patch).finally(() => {
                  state.adminBotTimeAvailabilitySaving = false;
                  // Only clear the draft on success, and only the one this save came from: a
                  // rejected row stays in its form so the member can correct it rather than
                  // retype it.
                  if (state.adminBotNotice?.kind === "success") {
                    if (patch.availability_notes !== undefined) {
                      // Back to following the stored value, which the reload has just refreshed.
                      state.adminBotAvailabilityNotesDraft = null;
                    } else if (patch.milestones) {
                      state.adminBotMilestoneDraft = {
                        ...EMPTY_MILESTONE_DRAFT,
                      };
                    } else {
                      state.adminBotTimeAvailabilityDraft = {
                        ...EMPTY_TIME_AVAILABILITY_DRAFT,
                      };
                    }
                  }
                  requestHostUpdate?.();
                });
              },
            })
          : nothing}
        ${state.tab === "myWork"
          ? renderMyWork(state, {
              ...paperWorkspaceProps(state, requestHostUpdate),
              // Chasing the lab is an admin act and it lives on Active Papers now. A member
              // opening their own page gets their work, and nothing pointed at anyone else.
              canNudge: false,
              // The pre-registration and decision banners belong to whoever is reading. Active
              // Papers, which shares this renderer, does not set this.
              personal: true,
            })
          : nothing}
        <!-- Active Papers: the same cards, the same fields and the same writes as a member's own
             page, over every paper in the lab, plus the nudge run that chases them. Sits above the
             admin-only sections below it (stats, the pre-registration board, reminder escalations
             and Add paper), which answer questions about the set rather than about one paper. -->
        ${state.tab === "adminbotPapers" && adminBotMode === "admin"
          ? renderMyWork(state, {
              ...paperWorkspaceProps(state, requestHostUpdate),
              papers: state.adminBotData?.papers ?? [],
              title: "All papers",
              canNudge: true,
            })
          : nothing}
        ${state.tab === "overview"
          ? renderOverview({
              connected: state.connected,
              hello: state.hello,
              settings: state.settings,
              password: state.password,
              lastError: state.lastError,
              lastErrorCode: state.lastErrorCode,
              presenceCount,
              sessionsCount,
              cronEnabled: state.cronStatus?.enabled ?? null,
              cronNext,
              lastChannelsRefresh: state.channelsLastSuccess,
              warnQueryToken,
              modelAuthStatus: state.modelAuthStatusResult,
              usageResult: state.usageResult,
              sessionsResult: state.sessionsResult,
              skillsReport: state.skillsReport,
              cronJobs: state.cronJobs,
              cronStatus: state.cronStatus,
              attentionItems: state.attentionItems,
              eventLog: state.eventLog,
              overviewLogLines: state.overviewLogLines,
              showGatewayPassword: state.overviewShowGatewayPassword,
              onSettingsChange: (next) => state.applySettings(next),
              onPasswordChange: (next) => (state.password = next),
              onSessionKeyChange: (next) => {
                switchChatSession(state, next);
              },
              onToggleGatewayPasswordVisibility: () => {
                state.overviewShowGatewayPassword = !state.overviewShowGatewayPassword;
              },
              onConnect: () => state.connect(),
              onRefresh: () => void state.loadOverview({ refresh: true }),
              onNavigate: (tab) => state.setTab(tab as import("./navigation.ts").Tab),
              onRefreshLogs: () => void state.loadOverview({ refresh: true }),
            })
          : nothing}
        ${state.tab === "activity"
          ? renderLazyView(lazyActivity, (m) =>
              m.renderActivity({
                entries: state.activityEntries,
                filterText: state.activityFilterText,
                statusFilters: state.activityStatusFilters,
                toolFilter: state.activityToolFilter,
                expandedIds: state.activityExpandedIds,
                autoFollow: state.activityAutoFollow,
                onFilterTextChange: (next) => (state.activityFilterText = next),
                onToolFilterChange: (next) => (state.activityToolFilter = next),
                onStatusToggle: (status, enabled) => {
                  state.activityStatusFilters = {
                    ...state.activityStatusFilters,
                    [status]: enabled,
                  };
                },
                onToggleAutoFollow: (next) => {
                  state.activityAutoFollow = next;
                  if (next) {
                    state.scheduleActivityScroll(true);
                  }
                },
                onClear: () => {
                  state.activityEntries = [];
                  state.activityExpandedIds = new Set();
                  state.activityAtBottom = true;
                },
                onExpandAll: () => {
                  state.activityExpandedIds = new Set(
                    state.activityEntries.map((entry) => entry.id),
                  );
                },
                onCollapseAll: () => {
                  state.activityExpandedIds = new Set();
                },
                onEntryToggle: (id, open) => {
                  const next = new Set(state.activityExpandedIds);
                  if (open) {
                    next.add(id);
                  } else {
                    next.delete(id);
                  }
                  state.activityExpandedIds = next;
                },
                onScroll: (event) => state.handleActivityScroll(event),
              }),
            )
          : nothing}
        ${adminBotPanel
          ? renderAdminBot({
              panel: adminBotPanel,
              paperSlotOverview: state.adminBotPaperSlotOverview,
              connected: state.connected,
              loading: state.adminBotLoading,
              error: state.adminBotError,
              data: state.adminBotData,
              busyActionId: state.adminBotBusyActionId,
              notice: state.adminBotNotice,
              mode: adminBotMode,
              signedInMemberId: state.memberId,
              reimbursement: state.adminBotReimbursement,
              onReimbursementMessage: (message, files) =>
                void sendAdminBotReimbursementMessage(state, message, files),
              onGenerateReimbursement: () => void generateAdminBotReimbursement(state),
              onResetReimbursement: () => resetAdminBotReimbursement(state),
              memberNudge: state.adminBotMemberNudge,
              blockerSort: state.adminBotBlockerSort,
              onBlockerSort: (key) => {
                state.adminBotBlockerSort = key;
              },
              venueFilter: state.adminBotVenueFilter,
              onVenueFilter: (venueId) => {
                state.adminBotVenueFilter = venueId;
              },
              onNudgeChannelChange: (channel) => setAdminBotNudgeChannel(state, channel),
              onNudgeMessageChange: (message) => setAdminBotNudgeMessage(state, message),
              onNudgeSubjectChange: (subject) => setAdminBotNudgeSubject(state, subject),
              onNudgeToggleRecipient: (memberId) => toggleAdminBotNudgeRecipient(state, memberId),
              onNudgeSetRecipients: (memberIds) => setAdminBotNudgeRecipients(state, memberIds),
              onSendNudge: () => void sendAdminBotMemberNudge(state),
              onRefresh: () => void loadAdminBot(state, adminBotMode),
              onApprove: (proposal) => void approveAdminBotAction(state, proposal),
              onRemove: (proposal) => void removePendingAdminBotAction(state, proposal),
              onExecute: (proposal) => void executeAdminBotAction(state, proposal),
              onSaveMember: (member) => void saveAdminBotMember(state, member),
              onMergeMembers: (survivorId, duplicateId) =>
                void mergeAdminBotMembers(state, survivorId, duplicateId),
              onSaveOwnProfile: (memberId, fields) =>
                void saveAdminBotOwnProfile(state, memberId, fields),
              // The checklist itself lives at the bottom of the profile page instead of in a
              // popup, so "view onboarding checklist" from Lab Members just goes there.
              onShowOnboardingWelcome: () => state.setTab("profile"),
              onSavePaper: (paper) => void saveAdminBotPaper(state, paper),
              onDeletePaper: (paper) => void deleteAdminBotPaper(state, paper),
              onSaveSettings: (settings) => void saveAdminBotSettings(state, settings),
              onSaveSensitiveInfo: (markdown) => void saveAdminBotSensitiveInfo(state, markdown),
            })
          : nothing}
        ${state.tab === "adminbotRegistrations" && adminBotMode === "admin"
          ? renderLazyView(lazyAdminBotRegistrations, (m) =>
              m.renderAdminBotRegistrations({
                registrations: state.registrations,
                loading: state.registrationsLoading,
                error: state.registrationsError,
                busyId: state.registrationsBusyId,
                notice: state.registrationsNotice,
                onDecide: (registrationId, decision) =>
                  void decideAdminBotRegistration(state, registrationId, decision),
                onRefresh: () => void loadAdminBotRegistrations(state),
              }),
            )
          : nothing}
        ${state.tab === "adminbotOnboarding" && adminBotMode === "admin"
          ? renderLazyView(lazyAdminBotOnboarding, (m) => m.renderAdminBotOnboarding(state))
          : nothing}
        ${state.tab === "adminbotCalendar" && adminBotMode === "admin"
          ? renderLazyView(lazyAdminBotCalendar, (m) => m.renderAdminBotCalendar(state))
          : nothing}
        ${state.tab === "adminbotDeadlines"
          ? renderLazyView(lazyDeadlines, (m) => m.renderDeadlines())
          : nothing}
        ${state.tab === "adminbotConferencePapers"
          ? renderLazyView(lazyConferencePapers, (m) =>
              m.renderConferencePapers({
                state: state.adminBotVenuePapers,
                onVenueChange: (venueId) => setAdminBotVenue(state, venueId),
                onInterestsChange: (interests) => setAdminBotVenueInterests(state, interests),
                onSearch: () => void searchAdminBotVenuePapers(state),
                onToggleAbstract: (paperId) => toggleAdminBotVenueAbstract(state, paperId),
              }),
            )
          : nothing}
        ${state.tab === "sessions"
          ? renderLazyView(lazySessions, (m) => {
              return m.renderSessions({
                loading: state.sessionsLoading,
                result: state.sessionsResult,
                error: state.sessionsError,
                activeMinutes: state.sessionsFilterActive,
                limit: state.sessionsFilterLimit,
                includeGlobal: state.sessionsIncludeGlobal,
                includeUnknown: state.sessionsIncludeUnknown,
                showArchived: state.sessionsShowArchived,
                filtersCollapsed: state.sessionsFiltersCollapsed,
                basePath: state.basePath,
                searchQuery: state.sessionsSearchQuery,
                agentIdentityById: state.agentIdentityById,
                sortColumn: state.sessionsSortColumn,
                sortDir: state.sessionsSortDir,
                page: state.sessionsPage,
                pageSize: state.sessionsPageSize,
                selectedKeys: state.sessionsSelectedKeys,
                expandedCheckpointKey: state.sessionsExpandedCheckpointKey,
                checkpointItemsByKey: state.sessionsCheckpointItemsByKey,
                checkpointLoadingKey: state.sessionsCheckpointLoadingKey,
                checkpointBusyKey: state.sessionsCheckpointBusyKey,
                checkpointErrorByKey: state.sessionsCheckpointErrorByKey,
                onFiltersChange: (next) => {
                  state.sessionsFilterActive = next.activeMinutes;
                  state.sessionsFilterLimit = next.limit;
                  state.sessionsIncludeGlobal = next.includeGlobal;
                  state.sessionsIncludeUnknown = next.includeUnknown;
                  state.sessionsShowArchived = next.showArchived;
                  state.sessionsSelectedKeys = new Set();
                  state.sessionsPage = 0;
                  void loadSessions(state, {
                    activeMinutes: parseSessionsFilterInteger(next.activeMinutes),
                    limit: parseSessionsFilterInteger(next.limit),
                    includeGlobal: next.includeGlobal,
                    includeUnknown: next.includeUnknown,
                    showArchived: next.showArchived,
                  });
                },
                onToggleFiltersCollapsed: () => {
                  state.sessionsFiltersCollapsed = !state.sessionsFiltersCollapsed;
                },
                onClearFilters: () => {
                  state.sessionsFilterActive = "";
                  state.sessionsFilterLimit = "";
                  state.sessionsIncludeGlobal = true;
                  state.sessionsIncludeUnknown = true;
                  state.sessionsShowArchived = true;
                  state.sessionsSearchQuery = "";
                  state.sessionsSelectedKeys = new Set();
                  state.sessionsPage = 0;
                  void loadSessions(state, {
                    activeMinutes: 0,
                    limit: 0,
                    includeGlobal: true,
                    includeUnknown: true,
                    showArchived: true,
                  });
                },
                onSearchChange: (q) => {
                  state.sessionsSearchQuery = q;
                  state.sessionsPage = 0;
                },
                onSortChange: (col, dir) => {
                  state.sessionsSortColumn = col;
                  state.sessionsSortDir = dir;
                  state.sessionsPage = 0;
                },
                onPageChange: (p) => {
                  state.sessionsPage = p;
                },
                onPageSizeChange: (s) => {
                  state.sessionsPageSize = s;
                  state.sessionsPage = 0;
                },
                onRefresh: () => void loadSessions(state),
                onPatch: (key, patch) => void patchSession(state, key, patch),
                onToggleSelect: (key) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onSelectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const k of keys) {
                    next.add(k);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const k of keys) {
                    next.delete(k);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectAll: () => {
                  state.sessionsSelectedKeys = new Set();
                },
                onDeleteSelected: runUiTask(async () => {
                  const keys = [...state.sessionsSelectedKeys];
                  const deleted = await deleteSessionsAndRefresh(state, keys);
                  if (deleted.length > 0) {
                    const next = new Set(state.sessionsSelectedKeys);
                    for (const k of deleted) {
                      next.delete(k);
                      clearChatMessagesFromCache(state.chatMessagesBySession, state, {
                        sessionKey: k,
                      });
                    }
                    state.sessionsSelectedKeys = next;
                  }
                }),
                onNavigateToChat: (sessionKey) => {
                  switchChatSession(state, sessionKey);
                  state.setTab("chat" as import("./navigation.ts").Tab);
                },
                onToggleCheckpointDetails: (sessionKey) =>
                  void toggleSessionCompactionCheckpoints(state, sessionKey),
                onBranchFromCheckpoint: runUiTask(async (sessionKey, checkpointId) => {
                  const nextKey = await branchSessionFromCheckpoint(
                    state,
                    sessionKey,
                    checkpointId,
                  );
                  if (nextKey) {
                    switchChatSession(state, nextKey);
                    state.setTab("chat" as import("./navigation.ts").Tab);
                  }
                }),
                onRestoreCheckpoint: (sessionKey, checkpointId) =>
                  void restoreSessionFromCheckpoint(state, sessionKey, checkpointId),
              });
            })
          : nothing}
        ${renderUsageTab(state, lazyUsage)}
        ${state.tab === "cron"
          ? renderCronQuickCreateForTab(state, requestHostUpdate, cronModelSuggestions)
          : nothing}
        ${state.tab === "cron"
          ? renderLazyView(lazyCron, (m) =>
              m.renderCron({
                basePath: state.basePath,
                commandJobs: [
                  {
                    id: "venue-index",
                    name: "Conference paper index",
                    description:
                      "Fetch every accepted paper from the configured conferences and index them, so members can search them on Conference Papers. Takes a couple of minutes per conference.",
                    status: state.adminBotVenueIndexJob.status,
                    ...(state.adminBotVenueIndexJob.detail
                      ? { detail: state.adminBotVenueIndexJob.detail }
                      : {}),
                    ...(state.adminBotVenueIndexJob.finishedAtMs
                      ? { finishedAtMs: state.adminBotVenueIndexJob.finishedAtMs }
                      : {}),
                  },
                  {
                    id: "cv-digest",
                    name: "CV digest",
                    description:
                      "Re-read every member's linked CV, record what changed, and rewrite the CV Updates doc with today's date.",
                    status: state.adminBotCvDigestJob.status,
                    ...(state.adminBotCvDigestJob.detail
                      ? { detail: state.adminBotCvDigestJob.detail }
                      : {}),
                    ...(state.adminBotCvDigestJob.resultUrl
                      ? {
                          resultUrl: state.adminBotCvDigestJob.resultUrl,
                          resultLabel: "Open the doc",
                        }
                      : {}),
                    ...(state.adminBotCvDigestJob.finishedAtMs
                      ? { finishedAtMs: state.adminBotCvDigestJob.finishedAtMs }
                      : {}),
                  },
                ],
                onRunCommandJob: (id) => {
                  if (id === "cv-digest") {
                    void runAdminBotCvDigestJob(state);
                  }
                  if (id === "venue-index") {
                    void runAdminBotVenueIndexJob(state);
                  }
                },
                loading: state.cronLoading,
                status: state.cronStatus,
                jobs: visibleCronJobs,
                jobsLoadingMore: state.cronJobsLoadingMore,
                jobsTotal: state.cronJobsTotal,
                jobsHasMore: state.cronJobsHasMore,
                jobsQuery: state.cronJobsQuery,
                jobsEnabledFilter: state.cronJobsEnabledFilter,
                jobsScheduleKindFilter: state.cronJobsScheduleKindFilter,
                jobsLastStatusFilter: state.cronJobsLastStatusFilter,
                jobsSortBy: state.cronJobsSortBy,
                jobsSortDir: state.cronJobsSortDir,
                editingJobId: state.cronEditingJobId,
                error: state.cronError,
                busy: state.cronBusy,
                form: state.cronForm,
                cronFormCollapsed: state.cronFormCollapsed,
                channels: state.channelsSnapshot?.channelMeta?.length
                  ? state.channelsSnapshot.channelMeta.map((entry) => entry.id)
                  : (state.channelsSnapshot?.channelOrder ?? []),
                channelLabels: state.channelsSnapshot?.channelLabels ?? {},
                channelMeta: state.channelsSnapshot?.channelMeta ?? [],
                runsJobId: state.cronRunsJobId,
                runs: state.cronRuns,
                runsTotal: state.cronRunsTotal,
                runsHasMore: state.cronRunsHasMore,
                runsLoadingMore: state.cronRunsLoadingMore,
                runsScope: state.cronRunsScope,
                runsStatuses: state.cronRunsStatuses,
                runsDeliveryStatuses: state.cronRunsDeliveryStatuses,
                runsStatusFilter: state.cronRunsStatusFilter,
                runsQuery: state.cronRunsQuery,
                runsSortDir: state.cronRunsSortDir,
                fieldErrors: state.cronFieldErrors,
                canSubmit: !hasCronFormErrors(state.cronFieldErrors),
                agentSuggestions: cronAgentSuggestions,
                modelSuggestions: cronModelSuggestions,
                thinkingSuggestions: CRON_THINKING_SUGGESTIONS,
                timezoneSuggestions: CRON_TIMEZONE_SUGGESTIONS,
                deliveryToSuggestions,
                accountSuggestions,
                onFormChange: (patch) => {
                  state.cronForm = normalizeCronFormState({
                    ...state.cronForm,
                    ...patch,
                  });
                  state.cronFieldErrors = validateCronForm(state.cronForm);
                },
                onRefresh: () => void state.loadCron(),
                onAdd: () => {
                  void (async () => {
                    const saved = await addCronJob(state);
                    if (saved) {
                      state.cronFormCollapsed = true;
                    }
                    requestHostUpdate?.();
                  })();
                },
                onEdit: (job) => {
                  state.cronFormCollapsed = false;
                  startCronEdit(state, job);
                },
                onClone: (job) => {
                  state.cronFormCollapsed = false;
                  startCronClone(state, job);
                },
                onCancelEdit: () => {
                  cancelCronEdit(state);
                  state.cronFormCollapsed = true;
                  requestHostUpdate?.();
                },
                onToggleFormCollapsed: (collapsed) => {
                  state.cronFormCollapsed = collapsed;
                  if (!collapsed) {
                    prepareNewCronForm(state);
                  }
                  requestHostUpdate?.();
                },
                onToggle: (job, enabled) => void toggleCronJob(state, job, enabled),
                onRun: (job, mode) => void runCronJob(state, job, mode ?? "force"),
                onRemove: (job) => void removeCronJob(state, job),
                onQuickCreate: () => {
                  state.cronQuickCreateOpen = true;
                  state.cronQuickCreateStep = "what";
                  state.cronQuickCreateDraft = createDefaultDraft();
                  requestHostUpdate?.();
                },
                onLoadRuns: runUiTask(async (jobId) => {
                  updateCronRunsFilter(state, { cronRunsScope: "job" });
                  await loadCronRuns(state, jobId);
                }),
                onLoadMoreJobs: () =>
                  void loadCronJobsPage(state, {
                    append: true,
                    tableFilters: true,
                  }),
                onJobsFiltersChange: runUiTask(async (patch) => {
                  updateCronJobsFilter(state, patch);
                  const shouldReload =
                    typeof patch.cronJobsQuery === "string" ||
                    Boolean(patch.cronJobsEnabledFilter) ||
                    Boolean(patch.cronJobsScheduleKindFilter) ||
                    Boolean(patch.cronJobsLastStatusFilter) ||
                    Boolean(patch.cronJobsSortBy) ||
                    Boolean(patch.cronJobsSortDir);
                  if (shouldReload) {
                    await loadCronJobsPage(state, {
                      append: false,
                      tableFilters: true,
                    });
                  }
                }),
                onJobsFiltersReset: runUiTask(async () => {
                  updateCronJobsFilter(state, {
                    cronJobsQuery: "",
                    cronJobsEnabledFilter: "all",
                    cronJobsScheduleKindFilter: "all",
                    cronJobsLastStatusFilter: "all",
                    cronJobsSortBy: "nextRunAtMs",
                    cronJobsSortDir: "asc",
                  });
                  await loadCronJobsPage(state, {
                    append: false,
                    tableFilters: true,
                  });
                }),
                onLoadMoreRuns: () => void loadMoreCronRuns(state),
                onRunsFiltersChange: runUiTask(async (patch) => {
                  updateCronRunsFilter(state, patch);
                  if (state.cronRunsScope === "all") {
                    await loadCronRuns(state, null);
                    return;
                  }
                  await loadCronRuns(state, state.cronRunsJobId);
                }),
                onNavigateToChat: (sessionKey) => {
                  switchChatSession(state, sessionKey);
                  state.setTab("chat" as import("./navigation.ts").Tab);
                },
              }),
            )
          : nothing}
        ${state.tab === "agents"
          ? renderLazyView(lazyAgents, (m) =>
              m.renderAgents({
                basePath: state.basePath ?? "",
                loading: state.agentsLoading,
                error: state.agentsError,
                agentsList: state.agentsList,
                selectedAgentId: resolvedAgentId,
                activePanel: state.agentsPanel,
                config: {
                  form: configValue,
                  loading: state.configLoading,
                  saving: state.configSaving,
                  dirty: state.configFormDirty,
                },
                channels: {
                  snapshot: state.channelsSnapshot,
                  loading: state.channelsLoading,
                  error: state.channelsError,
                  lastSuccess: state.channelsLastSuccess,
                },
                cron: {
                  status: state.cronStatus,
                  jobs: state.cronJobs,
                  loading: state.cronLoading,
                  error: state.cronError,
                },
                agentFiles: {
                  list: state.agentFilesList,
                  loading: state.agentFilesLoading,
                  error: state.agentFilesError,
                  active: state.agentFileActive,
                  contents: state.agentFileContents,
                  drafts: state.agentFileDrafts,
                  saving: state.agentFileSaving,
                },
                agentIdentityLoading: state.agentIdentityLoading,
                agentIdentityError: state.agentIdentityError,
                agentIdentityById: state.agentIdentityById,
                agentSkills: {
                  report: state.agentSkillsReport,
                  loading: state.agentSkillsLoading,
                  error: state.agentSkillsError,
                  agentId: state.agentSkillsAgentId,
                  filter: state.skillsFilter,
                },
                toolsCatalog: {
                  loading: state.toolsCatalogLoading,
                  error: state.toolsCatalogError,
                  result: state.toolsCatalogResult,
                },
                toolsEffective: {
                  loading: state.toolsEffectiveLoading,
                  error: state.toolsEffectiveError,
                  result: state.toolsEffectiveResult,
                },
                runtimeSessionKey: state.sessionKey,
                runtimeSessionMatchesSelectedAgent: toolsPanelUsesActiveSession,
                modelCatalog: state.chatModelCatalog ?? [],
                onRefresh: runUiTask(async () => {
                  await loadAgents(state);
                  const agentIds = state.agentsList?.agents?.map((entry) => entry.id) ?? [];
                  if (agentIds.length > 0) {
                    void loadAgentIdentities(state, agentIds);
                  }
                  loadAgentPanelDataForSelectedAgent(resolveSelectedAgentId());
                  refreshAgentsPanelSupplementalData(state.agentsPanel);
                }),
                onSelectAgent: (agentId) => {
                  if (state.agentsSelectedId === agentId) {
                    return;
                  }
                  state.agentsSelectedId = agentId;
                  resetAgentSelectionPanelState();
                  void loadAgentIdentity(state, agentId);
                  loadAgentPanelDataForSelectedAgent(agentId);
                },
                onSelectPanel: (panel) => {
                  state.agentsPanel = panel;
                  if (
                    panel === "files" &&
                    resolvedAgentId &&
                    state.agentFilesList?.agentId !== resolvedAgentId
                  ) {
                    resetAgentFilesState();
                    void loadAgentFiles(state, resolvedAgentId);
                  }
                  if (panel === "skills" && resolvedAgentId) {
                    void loadAgentSkills(state, resolvedAgentId);
                  }
                  if (panel === "tools" && resolvedAgentId) {
                    if (
                      state.toolsCatalogResult?.agentId !== resolvedAgentId ||
                      state.toolsCatalogError
                    ) {
                      void loadToolsCatalog(state, resolvedAgentId);
                    }
                    if (resolvedAgentId === chatAgentId) {
                      const toolsRequestKey = buildToolsEffectiveRequestKey(state, {
                        agentId: resolvedAgentId,
                        sessionKey: state.sessionKey,
                      });
                      if (
                        state.toolsEffectiveResultKey !== toolsRequestKey ||
                        state.toolsEffectiveError
                      ) {
                        void loadToolsEffective(state, {
                          agentId: resolvedAgentId,
                          sessionKey: state.sessionKey,
                        });
                      }
                    } else {
                      resetToolsEffectiveState(state);
                    }
                  }
                  refreshAgentsPanelSupplementalData(panel);
                },
                onLoadFiles: (agentId) => void loadAgentFiles(state, agentId),
                onSelectFile: (name) => {
                  state.agentFileActive = name;
                  if (!resolvedAgentId) {
                    return;
                  }
                  void loadAgentFileContent(state, resolvedAgentId, name);
                },
                onFileDraftChange: (name, content) => {
                  state.agentFileDrafts = {
                    ...state.agentFileDrafts,
                    [name]: content,
                  };
                },
                onFileReset: (name) => {
                  const base = state.agentFileContents[name] ?? "";
                  state.agentFileDrafts = {
                    ...state.agentFileDrafts,
                    [name]: base,
                  };
                },
                onFileSave: (name) => {
                  if (!resolvedAgentId) {
                    return;
                  }
                  const content =
                    state.agentFileDrafts[name] ?? state.agentFileContents[name] ?? "";
                  void saveAgentFile(state, resolvedAgentId, name, content);
                },
                onToolsProfileChange: (agentId, profile, clearAllow) => {
                  const basePathItem = resolveAgentToolsPath(
                    agentId,
                    Boolean(profile || clearAllow),
                  );
                  if (!basePathItem) {
                    return;
                  }
                  if (profile) {
                    updateConfigFormValue(state, [...basePathItem, "profile"], profile);
                  } else {
                    removeConfigFormValue(state, [...basePathItem, "profile"]);
                  }
                  if (clearAllow) {
                    removeConfigFormValue(state, [...basePathItem, "allow"]);
                  }
                },
                onToolsOverridesChange: (agentId, alsoAllow, deny) => {
                  const basePathCandidate = resolveAgentToolsPath(
                    agentId,
                    alsoAllow.length > 0 || deny.length > 0,
                  );
                  if (!basePathCandidate) {
                    return;
                  }
                  if (alsoAllow.length > 0) {
                    updateConfigFormValue(state, [...basePathCandidate, "alsoAllow"], alsoAllow);
                  } else {
                    removeConfigFormValue(state, [...basePathCandidate, "alsoAllow"]);
                  }
                  if (deny.length > 0) {
                    updateConfigFormValue(state, [...basePathCandidate, "deny"], deny);
                  } else {
                    removeConfigFormValue(state, [...basePathCandidate, "deny"]);
                  }
                },
                onConfigReload: () => void loadConfig(state, { discardPendingChanges: true }),
                onConfigSave: () => void saveAgentsConfig(state),
                onChannelsRefresh: () => void loadChannels(state, false),
                onCronRefresh: () => void state.loadCron(),
                onCronRunNow: (jobId) => {
                  const job = state.cronJobs.find((entry) => entry.id === jobId);
                  if (!job) {
                    return;
                  }
                  void runCronJob(state, job, "force");
                },
                onSkillsFilterChange: (next) => (state.skillsFilter = next),
                onSkillsRefresh: () => {
                  if (resolvedAgentId) {
                    void loadAgentSkills(state, resolvedAgentId);
                  }
                },
                onAgentSkillToggle: (agentId, skillName, enabled) => {
                  const index = ensureAgentIndex(agentId);
                  if (index < 0) {
                    return;
                  }
                  const list = (
                    getCurrentConfigValue() as {
                      agents?: { list?: unknown[] };
                    } | null
                  )?.agents?.list;
                  const entry = Array.isArray(list)
                    ? (list[index] as { skills?: unknown })
                    : undefined;
                  const normalizedSkill = skillName.trim();
                  if (!normalizedSkill) {
                    return;
                  }
                  const allSkills =
                    state.agentSkillsReport?.skills?.map((skill) => skill.name).filter(Boolean) ??
                    [];
                  const existing = Array.isArray(entry?.skills)
                    ? normalizeStringEntries(entry.skills)
                    : undefined;
                  const base = existing ?? allSkills;
                  const next = new Set(base);
                  if (enabled) {
                    next.add(normalizedSkill);
                  } else {
                    next.delete(normalizedSkill);
                  }
                  updateConfigFormValue(state, ["agents", "list", index, "skills"], [...next]);
                },
                onAgentSkillsClear: (agentId) => {
                  const index = findAgentIndex(agentId);
                  if (index < 0) {
                    return;
                  }
                  removeConfigFormValue(state, ["agents", "list", index, "skills"]);
                },
                onAgentSkillsDisableAll: (agentId) => {
                  const index = ensureAgentIndex(agentId);
                  if (index < 0) {
                    return;
                  }
                  updateConfigFormValue(state, ["agents", "list", index, "skills"], []);
                },
                onModelChange: (agentId, modelId) => {
                  const index = modelId ? ensureAgentIndex(agentId) : findAgentIndex(agentId);
                  if (index < 0) {
                    return;
                  }
                  const modelEntry = resolveAgentModelFormEntry(index);
                  const { basePath: basePathEntry, existing } = modelEntry;
                  if (!modelId) {
                    removeConfigFormValue(state, basePathEntry);
                  } else if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                    const fallbacks = (existing as { fallbacks?: unknown }).fallbacks;
                    const next = {
                      primary: modelId,
                      ...(Array.isArray(fallbacks) ? { fallbacks } : {}),
                    };
                    updateConfigFormValue(state, basePathEntry, next);
                  } else {
                    updateConfigFormValue(state, basePathEntry, modelId);
                  }
                  void refreshVisibleToolsEffectiveForCurrentSession(state);
                },
                onModelFallbacksChange: (agentId, fallbacks) => {
                  const normalized = normalizeStringEntries(fallbacks);
                  const currentConfig = getCurrentConfigValue();
                  const resolvedConfig = resolveAgentConfig(currentConfig, agentId);
                  const effectivePrimary =
                    resolveModelPrimary(resolvedConfig.entry?.model) ??
                    resolveModelPrimary(resolvedConfig.defaults?.model);
                  const effectiveFallbacks = resolveEffectiveModelFallbacks(
                    resolvedConfig.entry?.model,
                    resolvedConfig.defaults?.model,
                  );
                  const index =
                    normalized.length > 0
                      ? effectivePrimary
                        ? ensureAgentIndex(agentId)
                        : -1
                      : (effectiveFallbacks?.length ?? 0) > 0 || findAgentIndex(agentId) >= 0
                        ? ensureAgentIndex(agentId)
                        : -1;
                  if (index < 0) {
                    return;
                  }
                  const { basePath: basePathResult, existing } = resolveAgentModelFormEntry(index);
                  const resolvePrimary = () => {
                    if (typeof existing === "string") {
                      return existing.trim() || null;
                    }
                    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                      const primary = (existing as { primary?: unknown }).primary;
                      if (typeof primary === "string") {
                        const trimmed = primary.trim();
                        return trimmed || null;
                      }
                    }
                    return null;
                  };
                  const primary = resolvePrimary() ?? effectivePrimary;
                  if (normalized.length === 0) {
                    if (primary) {
                      updateConfigFormValue(state, basePathResult, primary);
                    } else {
                      removeConfigFormValue(state, basePathResult);
                    }
                    return;
                  }
                  if (!primary) {
                    return;
                  }
                  updateConfigFormValue(state, basePathResult, {
                    primary,
                    fallbacks: normalized,
                  });
                },
                onSetDefault: (agentId) => {
                  stageDefaultAgentConfigEntry(state, agentId);
                },
              }),
            )
          : nothing}
        ${state.tab === "skills"
          ? renderLazyView(lazySkills, (m) =>
              m.renderSkills({
                connected: state.connected,
                loading: state.skillsLoading,
                report: state.skillsReport,
                agentsList: state.agentsList,
                selectedAgentId: state.skillsAgentId ?? state.agentsList?.defaultId ?? null,
                error: state.skillsError,
                filter: state.skillsFilter,
                statusFilter: state.skillsStatusFilter,
                edits: state.skillEdits,
                messages: state.skillMessages,
                busyKey: state.skillsBusyKey,
                detailKey: state.skillsDetailKey,
                detailTab: state.skillsDetailTab,
                clawhubVerdicts: state.clawhubVerdicts,
                clawhubVerdictsLoading: state.clawhubVerdictsLoading,
                clawhubVerdictsError: state.clawhubVerdictsError,
                skillCardContents: state.skillCardContents,
                skillCardLoadingKey: state.skillCardLoadingKey,
                skillCardErrors: state.skillCardErrors,
                clawhubQuery: state.clawhubSearchQuery,
                clawhubResults: state.clawhubSearchResults,
                clawhubSearchLoading: state.clawhubSearchLoading,
                clawhubSearchError: state.clawhubSearchError,
                clawhubDetail: state.clawhubDetail,
                clawhubDetailSlug: state.clawhubDetailSlug,
                clawhubDetailLoading: state.clawhubDetailLoading,
                clawhubDetailError: state.clawhubDetailError,
                clawhubInstallSlug: state.clawhubInstallSlug,
                clawhubInstallMessage: state.clawhubInstallMessage,
                onAgentChange: (agentId) => {
                  setSkillsAgentId(state, agentId);
                  void loadSkills(state, { clearMessages: true });
                },
                onFilterChange: (next) => (state.skillsFilter = next),
                onStatusFilterChange: (next) => (state.skillsStatusFilter = next),
                onRefresh: () => {
                  void (async () => {
                    await loadAgents(state);
                    reconcileSkillsAgentId(state, state.agentsList);
                    await loadSkills(state, { clearMessages: true });
                  })();
                },
                onToggle: (key, enabled) => void updateSkillEnabled(state, key, enabled),
                onEdit: (key, value) => updateSkillEdit(state, key, value),
                onSaveKey: (key) => void saveSkillApiKey(state, key),
                onInstall: (skillKey, name, installId) =>
                  void installSkill(state, skillKey, name, installId),
                onDetailOpen: (key) => {
                  state.skillsDetailKey = key;
                  state.skillsDetailTab = "overview";
                },
                onDetailClose: () => (state.skillsDetailKey = null),
                onDetailTabChange: (tab) => {
                  state.skillsDetailTab = tab;
                  if (tab === "card" && state.skillsDetailKey) {
                    void loadSkillCard(state, state.skillsDetailKey);
                  }
                },
                onClawHubQueryChange: (query) => {
                  setClawHubSearchQuery(state, query);
                  if (clawhubSearchTimer) {
                    clearTimeout(clawhubSearchTimer);
                  }
                  clawhubSearchTimer = setTimeout(() => {
                    void searchClawHub(state, query);
                  }, 300);
                },
                onClawHubDetailOpen: (slug) => void loadClawHubDetail(state, slug),
                onClawHubDetailClose: () => closeClawHubDetail(state),
                onClawHubInstall: (slug) => void installFromClawHub(state, slug),
              }),
            )
          : nothing}
        ${state.tab === "nodes"
          ? renderLazyView(lazyNodes, (m) =>
              m.renderNodes({
                loading: state.nodesLoading,
                nodes: state.nodes,
                devicesLoading: state.devicesLoading,
                devicesError: state.devicesError,
                devicesList: state.devicesList,
                configForm:
                  state.configForm ??
                  (state.configSnapshot?.config as Record<string, unknown> | null),
                configLoading: state.configLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                configFormMode: state.configFormMode,
                execApprovalsLoading: state.execApprovalsLoading,
                execApprovalsSaving: state.execApprovalsSaving,
                execApprovalsDirty: state.execApprovalsDirty,
                execApprovalsSnapshot: state.execApprovalsSnapshot,
                execApprovalsForm: state.execApprovalsForm,
                execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
                execApprovalsTarget: state.execApprovalsTarget,
                execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
                onRefresh: () => void loadNodes(state),
                onDevicesRefresh: () => void loadDevices(state),
                onDeviceApprove: (requestId) => void approveDevicePairing(state, requestId),
                onDeviceReject: (requestId) => void rejectDevicePairing(state, requestId),
                onDeviceRotate: (deviceId, role, scopes) =>
                  void rotateDeviceToken(state, { deviceId, role, scopes }),
                onDeviceRevoke: (deviceId, role) =>
                  void revokeDeviceToken(state, { deviceId, role }),
                onLoadConfig: () => void loadConfig(state, { discardPendingChanges: true }),
                onLoadExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? {
                          kind: "node" as const,
                          nodeId: state.execApprovalsTargetNodeId,
                        }
                      : { kind: "gateway" as const };
                  void loadExecApprovals(state, target);
                },
                onBindDefault: (nodeId) => {
                  if (nodeId) {
                    updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
                  } else {
                    removeConfigFormValue(state, ["tools", "exec", "node"]);
                  }
                },
                onBindAgent: (agentIndex, nodeId) => {
                  const basePathLocal = ["agents", "list", agentIndex, "tools", "exec", "node"];
                  if (nodeId) {
                    updateConfigFormValue(state, basePathLocal, nodeId);
                  } else {
                    removeConfigFormValue(state, basePathLocal);
                  }
                },
                onSaveBindings: () => void saveConfig(state),
                onExecApprovalsTargetChange: (kind, nodeId) => {
                  state.execApprovalsTarget = kind;
                  state.execApprovalsTargetNodeId = nodeId;
                  state.execApprovalsSnapshot = null;
                  state.execApprovalsForm = null;
                  state.execApprovalsDirty = false;
                  state.execApprovalsSelectedAgent = null;
                },
                onExecApprovalsSelectAgent: (agentId) => {
                  state.execApprovalsSelectedAgent = agentId;
                },
                onExecApprovalsPatch: (path, value) =>
                  updateExecApprovalsFormValue(state, path, value),
                onExecApprovalsRemove: (path) => removeExecApprovalsFormValue(state, path),
                onSaveExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? {
                          kind: "node" as const,
                          nodeId: state.execApprovalsTargetNodeId,
                        }
                      : { kind: "gateway" as const };
                  void saveExecApprovals(state, target);
                },
              }),
            )
          : nothing}
        ${state.tab === "chat" ? renderChatSessionControls(state) : nothing}
        ${state.tab === "chat"
          ? renderMeasured(
              state,
              "chat",
              {
                messageCount: state.chatMessages.length,
                toolMessageCount: state.chatToolMessages.length,
                streamSegmentCount: state.chatStreamSegments.length,
                queueCount: state.chatQueue.length,
              },
              () =>
                renderChat({
                  sessionKey: state.sessionKey,
                  onSessionKeyChange: (next) => {
                    switchChatSession(state, next);
                  },
                  thinkingLevel: state.chatThinkingLevel,
                  showThinking,
                  showToolCalls,
                  loading: state.chatLoading,
                  sending: state.chatSending,
                  compactionStatus: state.compactionStatus,
                  fallbackStatus: state.fallbackStatus,
                  assistantAvatarUrl: chatAvatarUrl,
                  messages: state.chatMessages,
                  sideResult: state.chatSideResult,
                  toolMessages: state.chatToolMessages,
                  streamSegments: state.chatStreamSegments,
                  stream: state.chatStream,
                  streamStartedAt: state.chatStreamStartedAt,
                  draft: state.chatMessage,
                  queue: state.chatQueue,
                  connected: state.connected,
                  canSend: state.connected,
                  disabledReason: chatDisabledReason,
                  error: chatViewError,
                  runStatus: state.chatRunStatus,
                  onDismissError: () => dismissChatError(state),
                  sessions: state.sessionsResult,
                  composerControls: renderGuardedChatControls(state),
                  sessionWorkspace: {
                    collapsed: chatWorkspaceFiles.collapsed,
                    sessionKey: state.sessionKey,
                    list:
                      chatWorkspaceFiles.list?.sessionKey === state.sessionKey
                        ? chatWorkspaceFiles.list
                        : null,
                    loading: chatWorkspaceFiles.loading,
                    error: chatWorkspaceFiles.error,
                    activeId: chatWorkspaceFiles.activeId,
                    onToggleCollapsed: toggleChatWorkspaceFilesCollapsed,
                    onRefresh: refreshChatWorkspaceFiles,
                    onBrowsePath: browseChatWorkspacePath,
                    onCopyPath: copyChatWorkspacePath,
                    onOpenFile: openChatWorkspaceFile,
                    onSearch: searchChatWorkspaceFiles,
                    onOpenArtifact: openChatWorkspaceArtifact,
                  },
                  adminBot: isAdminBotChat
                    ? {
                        loading: state.adminBotLoading,
                        error: state.adminBotError,
                        data: state.adminBotData,
                        busyActionId: state.adminBotBusyActionId,
                        notice: state.adminBotNotice,
                        onRefresh: () => void loadAdminBot(state, adminBotMode),
                        onApprove: (proposal) => void approveAdminBotAction(state, proposal),
                        onRemove: (proposal) => void removePendingAdminBotAction(state, proposal),
                        onExecute: (proposal) => void executeAdminBotAction(state, proposal),
                      }
                    : undefined,
                  autoExpandToolCalls: false,
                  onRefresh: () => {
                    state.chatSideResult = null;
                    state.resetToolStream();
                    void refreshChat(state, {
                      awaitHistory: true,
                      scheduleScroll: false,
                    });
                  },
                  onChatScroll: (event) => state.handleChatScroll(event),
                  getDraft: () => state.chatMessage,
                  onDraftChange: (next) => state.handleChatDraftChange(next),
                  onRequestUpdate: requestHostUpdate,
                  onHistoryKeydown: (input) => state.handleChatInputHistoryKey(input),
                  attachments: state.chatAttachments,
                  onAttachmentsChange: (next) => (state.chatAttachments = next),
                  onSend: () => void state.handleSendChat(),
                  onCompact: () =>
                    void state.handleSendChat("/compact", {
                      restoreDraft: true,
                    }),
                  onOpenSessionCheckpoints: () => {
                    state.sessionsExpandedCheckpointKey = state.sessionKey;
                    state.setTab("sessions" as import("./navigation.ts").Tab);
                    void loadSessions(state, {
                      ...createChatSessionsLoadOverrides(state),
                      ...scopedAgentListParamsForSession(state, state.sessionKey),
                    });
                  },
                  canAbort: hasAbortableSessionRun(state),
                  onAbort: () => void state.handleAbortChat({ preserveDraft: true }),
                  onQueueRemove: (id) => state.removeQueuedMessage(id),
                  onQueueRetry: (id) => void state.retryQueuedChatMessage(id),
                  onQueueSteer: (id) => void state.steerQueuedChatMessage(id),
                  onDismissSideResult: () => {
                    state.chatSideResult = null;
                  },
                  onClearHistory: runUiTask(async () => {
                    if (!state.client || !state.connected) {
                      return;
                    }
                    const hadActiveRun = hasAbortableSessionRun(state);
                    try {
                      await state.client.request("sessions.reset", {
                        key: state.sessionKey,
                        ...scopedAgentParamsForSession(state, state.sessionKey),
                      });
                      state.chatMessages = [];
                      clearChatMessagesFromCache(state.chatMessagesBySession, state, {
                        sessionKey: state.sessionKey,
                      });
                      state.chatSideResult = null;
                      reconcileChatRunLifecycle(
                        state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
                        {
                          outcome: hadActiveRun ? "interrupted" : undefined,
                          sessionStatus: "killed",
                          runId: state.chatRunId,
                          sessionKey: state.sessionKey,
                          clearLocalRun: true,
                          clearChatStream: true,
                          clearToolStream: true,
                          clearSideResultTerminalRuns: true,
                          clearRunStatus: !hadActiveRun,
                        },
                      );
                      await loadChatHistory(state);
                    } catch (err) {
                      state.lastError = String(err);
                      state.chatError = state.lastError;
                    }
                  }),
                  agentsList: state.agentsList,
                  currentAgentId: chatAgentId,
                  fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
                  onAgentChange: (agentId: string) => {
                    switchChatSession(state, buildAgentMainSessionKey({ agentId }));
                  },
                  onNavigateToAgent: () => {
                    state.agentsSelectedId = resolvedAgentId;
                    state.setTab("agents" as import("./navigation.ts").Tab);
                  },
                  onSessionSelect: (key: string) => {
                    switchChatSession(state, key);
                  },
                  showNewMessages: state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
                  onScrollToBottom: () => state.scrollToBottom(),
                  // Sidebar props for tool output viewing
                  sidebarOpen: state.sidebarOpen,
                  sidebarContent: state.sidebarContent,
                  sidebarError: state.sidebarError,
                  splitRatio: state.splitRatio,
                  canvasPluginSurfaceUrl: state.hello?.pluginSurfaceUrls?.canvas ?? null,
                  onOpenSidebar: (content) => state.handleOpenSidebar(content),
                  onCloseSidebar: () => state.handleCloseSidebar(),
                  onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
                  assistantName: state.assistantName,
                  assistantAvatar: effectiveAssistantAvatar,
                  userName: state.userName ?? null,
                  userAvatar: state.userAvatar ?? null,
                  localMediaPreviewRoots: state.localMediaPreviewRoots,
                  embedSandboxMode: state.embedSandboxMode,
                  allowExternalEmbedUrls: state.allowExternalEmbedUrls,
                  assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state),
                  basePath: state.basePath ?? "",
                }),
            )
          : nothing}
        ${isSettingsTab(state.tab) && state.tab !== "debug" && state.tab !== "logs"
          ? renderSettingsWorkspace(state, renderConfigTabForActiveTab())
          : renderConfigTabForActiveTab()}
        ${state.tab === "debug"
          ? renderSettingsWorkspace(
              state,
              renderLazyView(lazyDebug, (m) =>
                m.renderDebug({
                  loading: state.debugLoading,
                  status: state.debugStatus,
                  health: state.debugHealth,
                  models: state.debugModels,
                  heartbeat: state.debugHeartbeat,
                  eventLog: state.eventLog,
                  methods: (state.hello?.features?.methods ?? []).toSorted(),
                  callMethod: state.debugCallMethod,
                  callParams: state.debugCallParams,
                  callResult: state.debugCallResult,
                  callError: state.debugCallError,
                  onCallMethodChange: (next) => (state.debugCallMethod = next),
                  onCallParamsChange: (next) => (state.debugCallParams = next),
                  onRefresh: () => void loadDebug(state),
                  onCall: () => void callDebugMethod(state),
                }),
              ),
            )
          : nothing}
        ${state.tab === "logs"
          ? renderSettingsWorkspace(
              state,
              renderLazyView(lazyLogs, (m) =>
                m.renderLogs({
                  loading: state.logsLoading,
                  error: state.logsError,
                  file: state.logsFile,
                  entries: state.logsEntries,
                  filterText: state.logsFilterText,
                  levelFilters: state.logsLevelFilters,
                  autoFollow: state.logsAutoFollow,
                  truncated: state.logsTruncated,
                  onFilterTextChange: (next) => (state.logsFilterText = next),
                  onLevelToggle: (level, enabled) => {
                    state.logsLevelFilters = {
                      ...state.logsLevelFilters,
                      [level]: enabled,
                    };
                  },
                  onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
                  onRefresh: () => void loadLogs(state, { reset: true }),
                  onExport: (lines, label) => state.exportLogs(lines, label),
                  onScroll: (event) => state.handleLogsScroll(event),
                }),
              ),
            )
          : nothing}
      </main>
      ${renderFeedbackWidget(state)} ${renderExecApprovalPrompt(state)}
      ${renderGatewayUrlConfirmation(state)} ${nothing}
    </div>
  `;
}
