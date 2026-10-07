// The profile-completion gate around the whole app: a member with required profile fields still
// empty can only use My Profile until they are filled.
//
// Cut from renderApp in app-render.ts; the access decision itself is views/profile-gate.ts.

import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { refreshActiveTab } from "../../app-settings.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { loadAdminBot } from "../controllers/admin.ts";
import { resetBlockedProfileBadgeErrors } from "../data/badges.ts";
import { profileAccessState } from "../views/profile-gate.ts";

type RequestHostUpdate = (() => void) | undefined;

/**
 * Decide the gate once per render. While the member's own row is still unknown, the whole app is
 * the loading view; otherwise `profileBlocked` says whether only My Profile is open, and
 * `renderNotice` draws the callout that stands in for the page tabs while it is.
 */
export function resolveProfileGate(
  state: AppViewState,
  requestHostUpdate: RequestHostUpdate,
):
  | { loadingView: ReturnType<typeof renderProfileLoadingGate> }
  | {
      profileBlocked: boolean;
      renderNotice: () => ReturnType<typeof renderProfileCompletionNotice>;
    } {
  const access = profileAccessState(state);
  if (access === "loading") {
    return { loadingView: renderProfileLoadingGate(state, requestHostUpdate) };
  }
  return {
    profileBlocked: applyProfileGate(state, access === "incomplete"),
    renderNotice: () => renderProfileCompletionNotice(state, requestHostUpdate),
  };
}

/** Unknown is not incomplete: preserve the requested page until the self read finishes. */
function renderProfileLoadingGate(state: AppViewState, requestHostUpdate: RequestHostUpdate) {
  const loadProfile = () => {
    state.adminBotError = null;
    void refreshActiveTab(state).finally(() => requestHostUpdate?.());
  };
  if (!state.adminBotError) {
    void refreshActiveTab(state).finally(() => requestHostUpdate?.());
  }
  return html`<main class="content">
    <div class="card" role="status" data-testid="profile-loading">
      <p>${state.adminBotError || t("common.loading")}</p>
      ${state.adminBotError
        ? html`<button class="btn" @click=${loadProfile}>${t("profile.gate.retry")}</button>`
        : nothing}
      <button class="btn" @click=${() => void state.signOutMember()}>
        ${t("login.member.signOut")}
      </button>
    </div>
  </main>`;
}

/** Per render, once access is known: clear stale badge errors and hold a blocked member on My Profile. */
function applyProfileGate(state: AppViewState, profileBlocked: boolean): boolean {
  resetBlockedProfileBadgeErrors(state);
  if (profileBlocked && state.tab !== "profile") {
    state.setTab("profile");
  }
  return profileBlocked;
}

/** Shown in place of the page tabs while the member is blocked. */
function renderProfileCompletionNotice(state: AppViewState, requestHostUpdate: RequestHostUpdate) {
  return html`<div class="callout danger" role="status" data-testid="profile-completion-notice">
    <strong>${t("profile.gate.title")}</strong>
    <p>${t("profile.gate.description")}</p>
    ${state.adminBotError
      ? html`<p>${state.adminBotError}</p>
          <button
            class="btn"
            @click=${() => {
              state.adminBotError = null;
              void loadAdminBot(state, "general", false).finally(() => requestHostUpdate?.());
            }}
          >
            ${t("profile.gate.retry")}
          </button>`
      : nothing}
  </div>`;
}
