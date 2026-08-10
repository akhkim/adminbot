// The one bar a signed-out visitor sees on every full-page surface: the landing hero and the
// sign-in gate. It is shared rather than duplicated so the mark never shifts position between the
// two — opening the gate should read as the same page changing its middle, not a new site.
//
// The right-hand slot is the only thing that differs. On the landing page it is the way in; on the
// gate itself a second "Sign in" would go nowhere, so it becomes the way back out.
import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import { goToSignedOutView } from "../../signed-out-view.ts";

export type SignedOutHeaderAction = "sign-in" | "back";

function renderAction(state: AppViewState, action: SignedOutHeaderAction) {
  if (action === "back") {
    return html`
      <button
        type="button"
        class="btn signed-out-topbar__action"
        data-testid="signed-out-header-back"
        @click=${() => {
          goToSignedOutView(state, "landing");
        }}
      >
        <span class="signed-out-topbar__icon" aria-hidden="true">${icons.arrowLeft}</span>
        <span>${t("common.back")}</span>
      </button>
    `;
  }
  return html`
    <button
      type="button"
      class="btn primary signed-out-topbar__action"
      data-testid="signed-out-header-sign-in"
      @click=${() => {
        goToSignedOutView(state, "login");
      }}
    >
      <span class="signed-out-topbar__icon" aria-hidden="true">${icons.lock}</span>
      <span>${t("login.member.signIn")}</span>
    </button>
  `;
}

export function renderSignedOutHeader(state: AppViewState, action: SignedOutHeaderAction) {
  return html`
    <header class="signed-out-topbar">
      <span class="signed-out-topbar__brand">
        Jinesis<span class="signed-out-topbar__brand-tail">Lab</span>
      </span>
      ${renderAction(state, action)}
    </header>
  `;
}
