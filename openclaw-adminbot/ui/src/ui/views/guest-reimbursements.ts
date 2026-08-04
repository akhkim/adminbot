// Standalone reimbursement screen shown from the login gate, with no session behind it.
//
// It deliberately renders the same `renderAdminBotReimbursements` body as the signed-in tab rather
// than a parallel copy, so the two cannot drift; only the chrome differs (no nav, no dashboard, and
// an explicit way back to sign-in).
import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { resolveAdminBotBaseUrl } from "../adminbot-auth.ts";
import type { AppViewState } from "../app-view-state.ts";
import {
  generateGuestReimbursement,
  resetAdminBotReimbursement,
  sendGuestReimbursementMessage,
  type GuestReimbursementHost,
} from "../controllers/adminbot.ts";
import { normalizeBasePath } from "../navigation.ts";
import { agentLogoUrl } from "./agents-utils.ts";
import { renderAdminBotReimbursements } from "./adminbot-reimbursements.ts";

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

export function renderGuestReimbursements(state: AppViewState) {
  const basePath = normalizeBasePath(state.basePath ?? "");
  const host = guestHost(state);
  return html`
    <div class="login-gate guest-reimbursements">
      <div class="login-gate__card guest-reimbursements__card">
        <div class="login-gate__header">
          <img class="login-gate__logo" src=${agentLogoUrl(basePath)} alt="OpenClaw" />
          <div class="login-gate__title">${t("login.guest.reimbursements")}</div>
          <div class="login-gate__sub">${t("login.guest.reimbursementsHint")}</div>
        </div>
        ${renderAdminBotReimbursements({
          // The guest path posts directly to AdminBot over HTTP, so it never waits on a gateway
          // connection the way the signed-in tab does.
          canSubmit: true,
          state: state.adminBotReimbursement,
          onMessage: (message, receipts) =>
            void sendGuestReimbursementMessage(host, message, receipts),
          onGenerate: () => void generateGuestReimbursement(host),
          onReset: () => resetAdminBotReimbursement(host),
        })}
        <button
          type="button"
          class="session-link guest-reimbursements__back"
          data-testid="guest-reimbursements-back"
          @click=${() => {
            state.guestReimbursements = false;
          }}
        >
          ${t("login.guest.backToSignIn")}
        </button>
      </div>
    </div>
  `;
}
