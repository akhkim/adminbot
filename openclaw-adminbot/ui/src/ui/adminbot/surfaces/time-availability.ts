// Time Availability: the member's own schedule, and the lab's capacity read off everyone's.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { loadStoredMemberSession } from "../auth/session.ts";
import { loadAdminBot, saveAdminBotOwnSchedule } from "../controllers/admin.ts";
import { loadCollaboratorSchedules } from "../controllers/collaborator-schedules.ts";
import { EMPTY_TRIP_DRAFT } from "../views/time-availability.trips.ts";
import {
  EMPTY_MILESTONE_DRAFT,
  EMPTY_TIME_AVAILABILITY_DRAFT,
  renderAdminBotTimeAvailability,
} from "../views/time-availability.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

export function renderTimeAvailabilitySurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const { accessRole, adminBotMode, needsPapersForTab, requestHostUpdate, rosterPendingForTab } =
    scope;
  return state.tab === "adminbotTimeAvailability" && !rosterPendingForTab
    ? renderAdminBotTimeAvailability({
        // The trips log's draft lives on the view state so a re-render underneath the
        // typist -- the roster reloading, a save landing -- cannot wipe half-entered input.
        tripDraft: state.adminBotTripDraft ?? EMPTY_TRIP_DRAFT,
        onTripDraftChange: (draft) => {
          state.adminBotTripDraft = draft;
        },
        collaborators:
          state.adminBotCollaboratorSchedulesSession === loadStoredMemberSession()?.sessionToken
            ? state.adminBotCollaboratorSchedules
            : [],
        collaboratorsLoading: state.adminBotCollaboratorSchedulesLoading,
        collaboratorsError: state.adminBotCollaboratorSchedulesError,
        onLoadCollaborators: () => void loadCollaboratorSchedules(state),
        members: state.adminBotData.members ?? [],
        loading: state.adminBotLoading,
        error: state.adminBotError,
        onRefresh: () => void loadAdminBot(state, adminBotMode, needsPapersForTab),
        // Self is editable; separately authorized collaborator snapshots remain read-only.
        selectedMemberId: state.adminBotTimeAvailabilityMemberId || (state.memberId ?? ""),
        onMemberChange: (memberId) => {
          state.adminBotTimeAvailabilityMemberId = memberId;
          // A different member's schedule carries a different note; keeping the draft would
          // show one person's text over another's record.
          state.adminBotAvailabilityNotesDraft = null;
        },
        range: state.adminBotTimeAvailabilityRange,
        onRangeChange: (range) => {
          state.adminBotTimeAvailabilityRange = range;
          // The chart re-anchors on a range change, so the window it reported for the old
          // interval no longer describes what it draws. Cleared rather than kept: the tables
          // show everything for the one frame before the new window arrives.
          state.adminBotTimeChartWindow = null;
        },
        chartWindow: state.adminBotTimeChartWindow,
        onChartWindowChange: (window) => {
          const current = state.adminBotTimeChartWindow;
          if (current?.start === window.start && current?.end === window.end) {
            return; // same span; a re-render here would loop against the chart's own effect
          }
          state.adminBotTimeChartWindow = window;
          requestHostUpdate?.();
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
        activeCommitmentType: state.adminBotActiveCommitmentType,
        onActiveCommitmentChange: (type) => {
          state.adminBotActiveCommitmentType = type;
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
              } else if (patch.time_off) {
                state.adminBotTimeAwayDraft = {
                  ...EMPTY_TIME_AVAILABILITY_DRAFT,
                  category: "vacation",
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
    : nothing;
}
