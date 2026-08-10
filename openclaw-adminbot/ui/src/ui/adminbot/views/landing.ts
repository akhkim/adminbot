// The first thing a signed-out visitor sees: who this lab is, and a way in.
//
// It sits in front of the public shell rather than replacing it. A visitor who asked for a
// specific open surface (`/adminbot/deadlines`, `/adminbot/reimbursements`) gets that surface
// directly — a shared link should land where it points. Everyone else, meaning anyone who opened
// the root or followed a link into a members-only tab, lands here first.
import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { normalizeBasePath, pathForTab, titleForTab, type Tab } from "../../navigation.ts";
import { goToSignedOutView } from "../../signed-out-view.ts";
import { renderSignedOutHeader } from "./signed-out-header.ts";

// The two surfaces the access table opens to `anonymous`. Named here rather than derived so the
// landing page states its own offer; access.ts is still what actually enforces it.
const OPEN_SURFACES: readonly Tab[] = ["adminbotReimbursements", "adminbotDeadlines"];

function renderOpenSurfaceLink(state: AppViewState, tab: Tab, label?: string) {
  return html`
    <a
      class="landing__surface"
      href=${`${normalizeBasePath(state.basePath ?? "")}${pathForTab(tab)}`}
      @click=${(event: MouseEvent) => {
        // Modified clicks keep the browser's own behaviour so "open in new tab" still works.
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.button !== 0
        ) {
          return;
        }

        event.preventDefault();
        state.tab = tab;
      }}
    >
      ${label ?? titleForTab(tab)}
    </a>
  `;
}

export function renderLanding(state: AppViewState) {
  return html`
    <div class="landing">
      <div class="landing__rules" aria-hidden="true"></div>

      ${renderSignedOutHeader(state, "sign-in")}

      <main class="landing__inner">
        <h1 class="landing__wordmark">
          Jinesis<span class="landing__wordmark-tail">Lab</span>
        </h1>

        <p class="landing__tagline">${t("landing.tagline")}</p>

        <div class="landing__cta">
          <button
            type="button"
            class="btn primary"
            data-testid="landing-sign-in"
            @click=${() => {
              goToSignedOutView(state, "login");
            }}
          >
            ${t("landing.signIn")}
          </button>

          ${renderOpenSurfaceLink(
            state,
            "adminbotReimbursements",
            t("landing.guest"),
          )}
        </div>

        <p class="landing__guest-hint">${t("landing.guestHint")}</p>
      </main>
    </div>
  `;
}