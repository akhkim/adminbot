// The Control UI as a visitor sees it: no session, no gateway connection, and only the surfaces
// the access table opens to `anonymous` (see access.ts).
//
// It is a separate shell rather than the signed-in one with tabs hidden, because the signed-in
// shell is built around a live gateway — session list, presence, chat transport, config snapshots.
// Rendering that chrome with nothing behind it would be a wall of disabled controls. The two
// surfaces a visitor can use need no gateway at all: the reimbursement assistant posts straight to
// AdminBot over HTTP, and the deadline board reads a bundled snapshot.
//
// Panels themselves are the same functions the signed-in tabs render, so the two views cannot
// drift apart — only the chrome around them differs.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import {
  iconForTab,
  normalizeBasePath,
  pathForTab,
  titleForTab,
  type Tab,
} from "../../navigation.ts";
import { goToSignedOutView } from "../../signed-out-view.ts";
import { agentLogoUrl } from "../../views/agents-utils.ts";
import { visibleTabsForRole } from "../access.ts";
import { resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  generateGuestReimbursement,
  resetAdminBotReimbursement,
  sendGuestReimbursementMessage,
  type GuestReimbursementHost,
} from "../controllers/admin.ts";
import { renderDeadlines } from "./deadlines.ts";
import { renderAdminBotReimbursements } from "./reimbursements.ts";

// Proxies the one state slice the guest flow owns back onto the reactive app instance, so
// controller writes still trigger a re-render without handing the controller the whole app.
function guestHost(state: AppViewState): GuestReimbursementHost {
  return {
    get adminBotReimbursement() {
      return state.adminBotReimbursement;
    },
    set adminBotReimbursement(next) {
      state.adminBotReimbursement = next;
    },
    guestReimbursementBaseUrl: resolveAdminBotBaseUrl(state.settings),
  };
}

function renderPublicNavItem(state: AppViewState, tab: Tab) {
  const active = state.tab === tab;
  return html`
    <a
      class="nav-item ${active ? "nav-item--active" : ""}"
      href=${`${normalizeBasePath(state.basePath ?? "")}${pathForTab(tab)}`}
      aria-current=${active ? "page" : nothing}
      @click=${(event: MouseEvent) => {
        // Left-click navigates in place; modified clicks keep the browser's own behaviour so
        // "open in new tab" still works on a public link.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        state.tab = tab;
      }}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      <span class="nav-item__text">${titleForTab(tab)}</span>
    </a>
  `;
}

function renderPublicPanel(state: AppViewState) {
  if (state.tab === "adminbotReimbursements") {
    const host = guestHost(state);
    return renderAdminBotReimbursements({
      // The guest path posts directly to AdminBot over HTTP, so it never waits on a gateway
      // connection the way the signed-in tab does.
      canSubmit: true,
      state: state.adminBotReimbursement,
      onMessage: (message, receipts) => void sendGuestReimbursementMessage(host, message, receipts),
      onGenerate: () => void generateGuestReimbursement(host),
      onReset: () => resetAdminBotReimbursement(host),
    });
  }
  return renderDeadlines();
}

export function renderPublicShell(state: AppViewState) {
  const basePath = normalizeBasePath(state.basePath ?? "");
  const tabs = visibleTabsForRole(["adminbotReimbursements", "adminbotDeadlines"], "anonymous");
  return html`
    <div class="app-shell app-shell--public">
      <header class="topbar topbar--public">
        <div class="topnav-shell">
          <div class="topnav-shell__content"></div>
          <div class="topnav-shell__actions">
            <button
              type="button"
              class="btn primary public-signin"
              data-testid="public-shell-sign-in"
              @click=${() => {
                goToSignedOutView(state, "login");
              }}
            >
              <span class="public-signin__icon" aria-hidden="true">${icons.lock}</span>
              <span>${t("login.member.signIn")}</span>
            </button>
          </div>
        </div>
      </header>
      <div class="public-shell-body">
        <aside class="sidebar sidebar--public">
          <div class="sidebar-shell">
            <div class="sidebar-shell__header">
              <div class="sidebar-brand">
                <img class="sidebar-brand__logo" src=${agentLogoUrl(basePath)} alt="OpenClaw" />
                <span class="sidebar-brand__copy">
                  <span class="sidebar-brand__eyebrow">${t("nav.adminbot")}</span>
                  <span class="sidebar-brand__title">OpenClaw</span>
                </span>
              </div>
            </div>
            <div class="sidebar-shell__body">
              <nav class="sidebar-nav">
                <section class="nav-section">
                  <div class="nav-section__items">
                    ${tabs.map((tab) => renderPublicNavItem(state, tab))}
                  </div>
                </section>
              </nav>
            </div>
            <div class="sidebar-shell__footer">
              <div class="sidebar-utility-group">
                <p class="sidebar-public-hint">${t("login.public.hint")}</p>
              </div>
            </div>
          </div>
        </aside>
        <main class="content content--public">
          <div class="card adminbot-card adminbot-card--wide">
            <div class="card-title">${titleForTab(state.tab)}</div>
            ${renderPublicPanel(state)}
          </div>
        </main>
      </div>
    </div>
  `;
}
