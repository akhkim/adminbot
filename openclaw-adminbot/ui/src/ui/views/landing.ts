// The first thing a signed-out visitor sees: who this lab is, and a way in.
//
// It sits in front of the public shell rather than replacing it. A visitor who asked for a
// specific open surface (`/adminbot/deadlines`, `/adminbot/reimbursements`) gets that surface
// directly — a shared link should land where it points. Everyone else, meaning anyone who opened
// the root or followed a link into a members-only tab, lands here first.
import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import { normalizeBasePath, pathForTab, titleForTab, type Tab } from "../navigation.ts";
import { renderSignedOutHeader } from "./signed-out-header.ts";

// The two surfaces the access table opens to `anonymous`. Named here rather than derived so the
// landing page states its own offer; access.ts is still what actually enforces it.
const OPEN_SURFACES: readonly Tab[] = ["adminbotReimbursements", "adminbotDeadlines"];

function renderOpenSurfaceLink(state: AppViewState, tab: Tab) {
  return html`
    <a
      class="landing__surface"
      href=${`${normalizeBasePath(state.basePath ?? "")}${pathForTab(tab)}`}
      @click=${(event: MouseEvent) => {
        // Modified clicks keep the browser's own behaviour so "open in new tab" still works.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        state.tab = tab;
      }}
    >
      ${titleForTab(tab)}
    </a>
  `;
}

export function renderLanding(state: AppViewState) {
  return html`
    <div class="landing">
      <div class="landing__rules" aria-hidden="true"></div>
      ${renderSignedOutHeader(state, "sign-in")}
      <main class="landing__inner">
        <p class="landing__eyebrow">${t("landing.eyebrow")}</p>
        <h1 class="landing__wordmark">
          Jinesis<span class="landing__wordmark-tail">Lab</span>
        </h1>
        <p class="landing__tagline">${t("landing.tagline")}</p>
        <button
          type="button"
          class="btn primary landing__cta"
          data-testid="landing-sign-in"
          @click=${() => {
            state.authGateVisible = true;
          }}
        >
          ${t("landing.signIn")}
        </button>
        <div class="landing__open">
          <span class="landing__open-label">${t("landing.openWithoutAccount")}</span>
          <div class="landing__surfaces">
            ${OPEN_SURFACES.map((tab) => renderOpenSurfaceLink(state, tab))}
          </div>
        </div>
      </main>
    </div>
  `;
}
