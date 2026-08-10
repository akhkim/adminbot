// The first thing a signed-out visitor sees: who this lab is, and a way in.
//
// It sits in front of the public shell rather than replacing it. A visitor who asked for a
// specific open surface (`/adminbot/deadlines`, `/adminbot/reimbursements`) gets that surface
// directly — a shared link should land where it points. Everyone else, meaning anyone who opened
// the root or followed a link into a members-only tab, lands here first.
import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import { normalizeBasePath, pathForTab, type Tab } from "../../navigation.ts";
import { goToSignedOutView } from "../../signed-out-view.ts";
import { renderSignedOutHeader } from "./signed-out-header.ts";

// The access table opens both of these to `anonymous`; the guest button below lands on the
// first one and the public shell's own sidebar covers the rest — named here rather than derived
// so the landing page states its own offer, with access.ts still the thing that enforces it.
const GUEST_ENTRY_TAB: Tab = "adminbotReimbursements";

export function renderLanding(state: AppViewState) {
  const guestHref = `${normalizeBasePath(state.basePath ?? "")}${pathForTab(GUEST_ENTRY_TAB)}`;
  return html`
    <div class="landing">
      <div class="landing__rules" aria-hidden="true"></div>
      ${renderSignedOutHeader(state, "sign-in")}
      <main class="landing__inner">
        <p class="landing__eyebrow">${t("landing.eyebrow")}</p>
        <h1 class="landing__wordmark">Jinesis<span class="landing__wordmark-tail">Lab</span></h1>
        <p class="landing__tagline">${t("landing.tagline")}</p>
        <div class="landing__actions">
          <button
            type="button"
            class="btn primary landing__cta"
            data-testid="landing-sign-in"
            @click=${() => {
              goToSignedOutView(state, "login");
            }}
          >
            <span class="landing__cta-icon" aria-hidden="true">${icons.lock}</span>
            <span>${t("landing.signIn")}</span>
          </button>
          <a
            class="btn landing__cta landing__cta--guest"
            data-testid="landing-continue-as-guest"
            href=${guestHref}
            @click=${(event: MouseEvent) => {
              // Modified clicks keep the browser's own behaviour so "open in new tab" still works.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                return;
              }
              event.preventDefault();
              state.tab = GUEST_ENTRY_TAB;
            }}
          >
            <span class="landing__cta-icon" aria-hidden="true">${icons.globe}</span>
            <span>${t("landing.continueAsGuest")}</span>
          </a>
        </div>
      </main>
    </div>
  `;
}
