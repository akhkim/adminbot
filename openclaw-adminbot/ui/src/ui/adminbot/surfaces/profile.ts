// My Profile: the member's own record, and the location prompt above it.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import {
  applyAdminBotOwnProfilePhoto,
  loadAdminBotRoster,
  polishAdminBotOwnProfilePhoto,
  saveAdminBotOwnProfile,
} from "../controllers/admin.ts";
import { loadAdminBotRecentEdits } from "../controllers/recent-edits.ts";
import { submitOwnBadgeNomination, submitOwnBadgeSuggestion } from "../data/badges.ts";
import { renderLocationPrompt } from "../views/location-prompt.ts";
import { renderProfile } from "../views/profile.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

export function renderProfileSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const { requestHostUpdate } = scope;
  return html`${state.tab === "profile"
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
    : nothing}${state.tab === "profile"
    ? html`
        ${renderProfile(state, {
          onSave: (memberId, fields) => void saveAdminBotOwnProfile(state, memberId, fields),
          onLoadRecentEdits: (subject, id) => {
            void loadAdminBotRecentEdits(state, subject, id).finally(() => requestHostUpdate?.());
          },
          onPolishPhoto: () => void polishAdminBotOwnProfilePhoto(state),
          onApplyPolishedPhoto: (variantId) => void applyAdminBotOwnProfilePhoto(state, variantId),
          onSubmitBadgeNomination: (badgeId, evidence, memberId) =>
            void submitOwnBadgeNomination(state, badgeId, evidence, memberId),
          onPickBadgeNominee: (memberId) => {
            state.profileBadgeNomineeId = memberId;
            requestHostUpdate?.();
          },
          onOpenBadgeNominee: () => {
            // ponytail: At 10k members this fetches the full summary roster (~9 MB). A
            // paged server-search picker can replace this when needed.
            void loadAdminBotRoster(state).finally(() => requestHostUpdate?.());
          },
          onSubmitBadgeSuggestion: (input) =>
            void submitOwnBadgeSuggestion(state, input).finally(() => requestHostUpdate?.()),
          onToggleBadgeSuggestForm: (open) => {
            state.profileBadgeSuggestOpen = open;
            // Shutting the form drops the last result with it: a success banner left over a
            // collapsed form reads as applying to whatever is opened next.
            if (!open) {
              state.badgeSuggestionNotice = null;
            }
            requestHostUpdate?.();
          },
          onNavigateToTab: (tab) => state.setTab(tab),
        })}
      `
    : nothing}`;
}
