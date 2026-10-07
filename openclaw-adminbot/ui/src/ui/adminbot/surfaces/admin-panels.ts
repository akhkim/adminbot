// The administrator panels: Lab Members, Reimbursements, Settings, Pending Actions, Active Papers, Announcements.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import {
  loadAdminBot,
  loadAdminBotMemberList,
  loadAdminBotRoster,
  resetAdminBotReimbursement,
  saveAdminBotPaper,
  saveAdminBotSensitiveInfo,
  setAdminBotNudgeChannel,
  setAdminBotNudgeMessage,
  setAdminBotNudgeRecipients,
  setAdminBotNudgeSubject,
  setAdminBotReimbursementFunder,
  setAdminBotSelectedActions,
  toggleAdminBotNudgeRecipient,
  toggleAdminBotSelectedAction,
} from "../controllers/admin.ts";
import { loadSlackChannelNames } from "../controllers/directory.ts";
import { resolveAdminBotEmailReview } from "../controllers/email-review.ts";
import {
  approveAdminBotAction,
  executeAdminBotAction,
  removePendingAdminBotAction,
  removeSelectedPendingAdminBotActions,
} from "../controllers/governance.ts";
import {
  approveAdminBotMemberRequest,
  editAdminBotMemberRequest,
  rejectAdminBotMemberRequest,
  submitAdminBotMemberRequest,
  withdrawAdminBotMemberRequest,
} from "../controllers/member-requests.ts";
import {
  deleteAdminBotMember,
  mergeAdminBotMembers,
  purgeAdminBotMembersWithoutEmail,
  renameAdminBotMember,
  saveAdminBotMember,
  saveAdminBotOwnProfile,
} from "../controllers/members.ts";
import { sendAdminBotMemberNudge } from "../controllers/nudges.ts";
import {
  loadAdminBotPaperSlots,
  saveAdminBotPaperSlot,
  toggleAdminBotPaperCard,
} from "../controllers/paper-slots.ts";
import { deleteAdminBotPaper } from "../controllers/papers.ts";
import { loadAdminBotRecentEdits } from "../controllers/recent-edits.ts";
import {
  generateAdminBotReimbursement,
  sendAdminBotReimbursementMessage,
  submitAdminBotReimbursement,
} from "../controllers/reimbursements.ts";
import { saveAdminBotSettings } from "../controllers/workspace.ts";
import { renderAdminBot } from "../views/admin.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

export function renderAdminPanelsSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const {
    adminBotMode,
    adminBotPanel,
    hasMemberSession,
    needsPapersForTab,
    requestHostUpdate,
    rosterPendingForTab,
  } = scope;
  return adminBotPanel && !rosterPendingForTab
    ? renderAdminBot({
        panel: adminBotPanel,
        onRerender: () => requestHostUpdate?.(),
        paperSlotOverview: state.adminBotPaperSlotOverview,
        // Active Papers' bulk sheet writes evidence the same way the card does.
        paperCycles: state.adminBotPaperSlots,
        onLoadSlots: (paperId: string) => {
          void loadAdminBotPaperSlots(state, paperId).finally(() => requestHostUpdate?.());
        },
        onSaveSlot: (paperId: string, slot: string, input) => {
          void saveAdminBotPaperSlot(state, paperId, slot, input).finally(() =>
            requestHostUpdate?.(),
          );
        },
        // Who has been in each member's record, read from their roster row. The same
        // loader the profile and paper panels use; the service decides who may read it.
        recentEdits: state.adminBotRecentEdits,
        onLoadRecentEdits: (subject, id) => {
          void loadAdminBotRecentEdits(state, subject, id).finally(() => requestHostUpdate?.());
        },
        connected: state.connected,
        loading: state.adminBotLoading,
        error: state.adminBotError,
        data: state.adminBotData,
        memberList: adminBotPanel === "members" ? state.adminBotMemberList : undefined,
        standingMeetings: adminBotPanel === "members" ? state.adminBotStandingMeetings : undefined,
        onboardingSlackChannels: state.myWorkChannelCheck,
        onLoadOnboardingSlackChannels: hasMemberSession
          ? () => {
              const pending = loadSlackChannelNames(state);
              requestHostUpdate?.();
              void pending.finally(() => requestHostUpdate?.());
            }
          : undefined,
        memberRequests:
          adminBotPanel === "members" && hasMemberSession
            ? {
                state: state.adminBotMemberRequests,
                onSubmit: (input) =>
                  submitAdminBotMemberRequest(state, input).finally(() => requestHostUpdate?.()),
                onEdit: (request, input) =>
                  editAdminBotMemberRequest(state, request, input).finally(() =>
                    requestHostUpdate?.(),
                  ),
                onApprove: (request, options) => {
                  void approveAdminBotMemberRequest(state, request, options).finally(() =>
                    requestHostUpdate?.(),
                  );
                },
                onReject: (request, note) => {
                  void rejectAdminBotMemberRequest(state, request, note).finally(() =>
                    requestHostUpdate?.(),
                  );
                },
                onWithdraw: (request) => {
                  void withdrawAdminBotMemberRequest(state, request).finally(() =>
                    requestHostUpdate?.(),
                  );
                },
              }
            : undefined,
        rosterLoadedAt: state.adminBotRosterLoadedAt,
        rosterLoading: state.adminBotRosterLoading,
        rosterError: state.adminBotRosterError,
        onLoadFullRoster: () => {
          void loadAdminBotRoster(state).finally(() => requestHostUpdate?.());
        },
        onMemberListChange: (query, offset) => {
          void loadAdminBotMemberList(state, query, offset).finally(() => requestHostUpdate?.());
        },
        busyActionId: state.adminBotBusyActionId,
        notice: state.adminBotNotice,
        mode: adminBotMode,
        signedInMemberId: state.memberId,
        reimbursement: state.adminBotReimbursement,
        onReimbursementMessage: (message, files) =>
          void sendAdminBotReimbursementMessage(state, message, files),
        onGenerateReimbursement: () => void generateAdminBotReimbursement(state),
        onResetReimbursement: () => resetAdminBotReimbursement(state),
        onReimbursementFunderChange: (funder) => setAdminBotReimbursementFunder(state, funder),
        onSubmitReimbursement: () => {
          void submitAdminBotReimbursement(state).finally(() => requestHostUpdate?.());
        },
        memberNudge: state.adminBotMemberNudge,
        blockerSort: state.adminBotBlockerSort,
        onBlockerSort: (key) => {
          state.adminBotBlockerSort = key;
        },
        venueFilter: state.adminBotVenueFilter,
        onVenueFilter: (venueId) => {
          state.adminBotVenueFilter = venueId;
        },
        preregSort: state.adminBotPreregSort,
        onPreregSort: (key) => {
          state.adminBotPreregSort = key;
        },
        preregSortReversed: state.adminBotPreregSortReversed,
        onPreregSortReversed: (value) => {
          state.adminBotPreregSortReversed = value;
        },
        preregMinConfidence: state.adminBotPreregMinConfidence,
        onPreregMinConfidence: (value) => {
          state.adminBotPreregMinConfidence = value;
        },
        preregMissingEdit: state.adminBotPreregMissingEdit,
        onPreregMissingEdit: (value) => {
          state.adminBotPreregMissingEdit = value;
        },
        onOpenPaperCard: (paperId) => {
          state.adminBotPaperCardId = paperId;
          // The card reads the paper's evidence cycle, which is fetched the first time a
          // card is opened. Toggling it open here is what triggers that read.
          if (!state.adminBotPaperSlotsOpen.includes(paperId)) {
            void toggleAdminBotPaperCard(state, paperId).finally(() => requestHostUpdate?.());
          }
          requestHostUpdate?.();
        },
        paperFilter: state.adminBotPaperFilter,
        onPaperFilter: (filter) => {
          state.adminBotPaperFilter = filter;
          requestHostUpdate?.();
        },
        onNudgeChannelChange: (channel) => setAdminBotNudgeChannel(state, channel),
        onNudgeMessageChange: (message) => setAdminBotNudgeMessage(state, message),
        onNudgeSubjectChange: (subject) => setAdminBotNudgeSubject(state, subject),
        onNudgeToggleRecipient: (memberId) => toggleAdminBotNudgeRecipient(state, memberId),
        onNudgeSetRecipients: (memberIds) => setAdminBotNudgeRecipients(state, memberIds),
        onSendNudge: () => void sendAdminBotMemberNudge(state),
        onRefresh: () => {
          void loadAdminBot(state, adminBotMode, needsPapersForTab);
          if (adminBotPanel === "members") {
            void loadAdminBotMemberList(state).finally(() => requestHostUpdate?.());
          }
        },
        onApprove: (proposal) => void approveAdminBotAction(state, proposal),
        onRemove: (proposal) => void removePendingAdminBotAction(state, proposal),
        selectedActionIds: state.adminBotSelectedActionIds,
        bulkActionBusy: state.adminBotBulkActionBusy,
        onToggleActionSelected: (proposalId) => {
          toggleAdminBotSelectedAction(state, proposalId);
          requestHostUpdate?.();
        },
        onSetSelectedActions: (proposalIds) => {
          setAdminBotSelectedActions(state, proposalIds);
          requestHostUpdate?.();
        },
        onRemoveSelectedActions: () => {
          void removeSelectedPendingAdminBotActions(state).finally(() => requestHostUpdate?.());
          requestHostUpdate?.();
        },
        onExecute: (proposal) => void executeAdminBotAction(state, proposal),
        onResolveEmailReview: (messageId, resolution) =>
          void resolveAdminBotEmailReview(state, messageId, resolution),
        onSaveMember: (member, options) => saveAdminBotMember(state, member, options),
        onMergeMembers: (survivorId, duplicateId) =>
          void mergeAdminBotMembers(state, survivorId, duplicateId),
        onRenameMember: (memberId, newId) => void renameAdminBotMember(state, memberId, newId),
        onDeleteMember: (member) => void deleteAdminBotMember(state, member.id),
        onPurgeMembersWithoutEmail: (dryRun) =>
          void purgeAdminBotMembersWithoutEmail(state, { dryRun }),
        onSaveOwnProfile: (memberId, fields) =>
          void saveAdminBotOwnProfile(state, memberId, fields),
        // The checklist itself lives at the bottom of the profile page instead of in a
        // popup, so "view onboarding checklist" from Lab Members just goes there.
        onShowOnboardingWelcome: () => state.setTab("profile"),
        // Admins only, and not from inside a view that is already somebody else's -- the
        // service refuses both, and leaving the button out says so before it is clicked.
        ...(adminBotMode === "admin" && !state.memberImpersonatedBy
          ? {
              onViewAsMember: (member) => void state.beginViewAs(member.id),
            }
          : {}),
        onSavePaper: (paper) => void saveAdminBotPaper(state, paper),
        onDeletePaper: (paper) => void deleteAdminBotPaper(state, paper),
        onSaveSettings: (settings) => void saveAdminBotSettings(state, settings),
        onSaveSensitiveInfo: (markdown) => void saveAdminBotSensitiveInfo(state, markdown),
      })
    : nothing;
}
