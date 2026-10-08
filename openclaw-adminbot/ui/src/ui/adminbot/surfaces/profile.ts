// My Profile: the member's own record, and the location prompt above it.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { createLazyView, notifyLazyViewHost, renderLazyView } from "../../lazy-view.ts";
import { loadAdminBotRoster } from "../controllers/admin.ts";
import { prepareProfileLocationPrompt } from "../controllers/location-prompt.ts";
import { saveAdminBotOwnProfile } from "../controllers/members.ts";
import {
  applyAdminBotOwnProfilePhoto,
  polishAdminBotOwnProfilePhoto,
} from "../controllers/profile.ts";
import { loadAdminBotRecentEdits } from "../controllers/recent-edits.ts";
import {
  loadProfileBadgeNominations,
  shouldLoadProfileBadgeNominations,
  submitOwnBadgeNomination,
  submitOwnBadgeSuggestion,
} from "../data/badges.ts";
import { renderLocationPrompt } from "../views/location-prompt.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

// The page's view loads on first visit rather than in the first bundle.
const lazyProfile = createLazyView(() => import("../views/profile.ts"), notifyLazyViewHost);

export function renderProfileSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const { profileBlocked, requestHostUpdate } = scope;
  return html`${state.tab === "profile" && !profileBlocked
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
        ${renderLazyView(lazyProfile, (m) =>
          m.renderProfile(state, {
            badgesDisabled: profileBlocked,
            onSave: (memberId, fields) => void saveAdminBotOwnProfile(state, memberId, fields),
            onLoadRecentEdits: (subject, id) => {
              void loadAdminBotRecentEdits(state, subject, id).finally(() => requestHostUpdate?.());
            },
            onPolishPhoto: () => void polishAdminBotOwnProfilePhoto(state),
            onApplyPolishedPhoto: (variantId) =>
              void applyAdminBotOwnProfilePhoto(state, variantId),
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
          }),
        )}
      `
    : nothing}`;
}

/** The reads only My Profile makes, fired from the render pass; each is self-limiting. */
export function loadProfileSurfaceReads(
  state: AppViewState,
  hasMemberSession: boolean,
  profileBlocked: boolean,
  requestHostUpdate: (() => void) | undefined,
): void {
  if (state.tab !== "profile" || !hasMemberSession) {
    return;
  }
  // Asked once, when the member opens their own profile -- which is where the banner renders and
  // the only place its answer makes sense. Undefined is "not asked yet"; null is a real "nothing
  // to ask" and must not re-trigger.
  if (prepareProfileLocationPrompt(state, profileBlocked)) {
    void state.loadLocationPrompt?.().finally(() => requestHostUpdate?.());
  }
  // Same shouldLoad rule as the other badge reads in renderApp: a failure settles.
  if (shouldLoadProfileBadgeNominations(state)) {
    void loadProfileBadgeNominations(state).finally(() => requestHostUpdate?.());
  }
}
