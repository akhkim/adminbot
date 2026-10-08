// Meeting Records: the lab's meetings and who attended.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { loadAdminBotMeetingRoster } from "../controllers/meetings.ts";
import { renderAdminBotMeetings } from "../views/meetings.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

export function renderMeetingsSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const { accessRole, requestHostUpdate } = scope;
  return state.tab === "adminbotMeetings"
    ? renderAdminBotMeetings({
        meetings: state.adminBotMeetings ?? [],
        visibleCount: state.adminBotMeetingsVisibleCount,
        onShowMore: (nextCount) => {
          if (nextCount <= (state.adminBotMeetings?.length ?? 0)) {
            state.adminBotMeetingsVisibleCount = nextCount;
          } else {
            void state.loadMoreMeetings?.();
          }
        },
        hasMore: Boolean(state.adminBotMeetingsNextCursor),
        loadingMore: state.adminBotMeetingsLoadingMore,
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
        // An admin's rows come without rosters; each is read when its fold is about to open and
        // kept for the session. A member's row already holds everything their fold shows.
        ...(accessRole === "admin"
          ? {
              rosters: state.adminBotMeetingRosters ?? {},
              onRosterIntent: (meetingId: string, opened: boolean) => {
                void loadAdminBotMeetingRoster(state, meetingId, { report: opened }).finally(() =>
                  requestHostUpdate?.(),
                );
              },
            }
          : {}),
        onToggleAttendance: (meetingId, attendee) => {
          void state.toggleMeetingAttendance?.(meetingId, attendee);
        },
        onFileMeeting: (draft) => {
          void state.fileMeeting?.(draft);
        },
        // Admin-only, and only offered when the host can actually run it: under break-glass
        // gateway access there is no member session to authenticate the send with.
        ...(accessRole === "admin" && state.loadMeetingNudges
          ? {
              nudge: {
                preview: state.adminBotMeetingNudgePreview ?? null,
                result: state.adminBotMeetingNudgeResult ?? null,
                busy: state.adminBotMeetingNudgeBusy ?? false,
                error: state.adminBotMeetingNudgeError ?? null,
                onPreview: () => {
                  void state.loadMeetingNudges?.().finally(() => requestHostUpdate?.());
                },
                onSend: () => {
                  void state.sendMeetingNudges?.().finally(() => requestHostUpdate?.());
                },
              },
            }
          : {}),
      })
    : nothing;
}
