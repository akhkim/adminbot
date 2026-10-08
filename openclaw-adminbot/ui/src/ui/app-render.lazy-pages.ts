// Control UI pages that load on first use, behind same-named shims so app-render's call sites read
// as they always have.
//
// Chat and the gateway settings pages are operator surfaces most members never open; the chat
// renderer alone drags the markdown runtime with it. My Work and the paper card it shares with
// Active Papers carry the whole paper workflow (slots, the cycle checklist, the grid).
import { html, nothing } from "lit";
import type { MyWorkProps } from "./adminbot/views/my-work.ts";
import type { AppViewState } from "./app-view-state.ts";
import { loadChatView } from "./chat/view-reset.ts";
import { createLazyView, notifyLazyViewHost, renderLazyView } from "./lazy-view.ts";
import type { ChatProps } from "./views/chat.ts";
import type { QuickSettingsProps } from "./views/config-quick.ts";
import type { ConfigProps } from "./views/config.ts";

const lazyChat = createLazyView(loadChatView, notifyLazyViewHost);
const lazyConfig = createLazyView(() => import("./views/config.ts"), notifyLazyViewHost);
const lazyQuickSettings = createLazyView(
  () => import("./views/config-quick.ts"),
  notifyLazyViewHost,
);
const lazyMyWork = createLazyView(() => import("./adminbot/views/my-work.ts"), notifyLazyViewHost);
// The reference checker's two elements define themselves on import; the page renders them once
// both are defined.
const lazyReferenceChecker = createLazyView(
  () =>
    Promise.all([
      import("./adminbot/views/reference-checker.ts"),
      import("./adminbot/views/openreview-citation-checks.ts"),
    ]),
  notifyLazyViewHost,
);

export const renderChat = (props: ChatProps) =>
  renderLazyView(lazyChat, (m) => m.renderChat(props));
export const renderConfig = (props: ConfigProps) =>
  renderLazyView(lazyConfig, (m) => m.renderConfig(props));
export const renderQuickSettings = (props: QuickSettingsProps) =>
  renderLazyView(lazyQuickSettings, (m) => m.renderQuickSettings(props));
export const renderMyWork = (state: AppViewState, props: MyWorkProps) =>
  renderLazyView(lazyMyWork, (m) => m.renderMyWork(state, props));

// The card opens on top of a page that is already showing, so it stays out of view until its code
// arrives rather than flashing a loading card.
export const renderPaperCardDialog = (
  params: Parameters<typeof import("./adminbot/views/my-work.ts").renderPaperCardDialog>[0],
) => {
  const myWork = lazyMyWork.read();
  return myWork ? myWork.renderPaperCardDialog(params) : nothing;
};

// Active Papers opens the paper card on a row click; fetch its code while the table is up so the
// card appears on the click, as it did when it shipped in the entry bundle.
export function warmPaperCard(tab: AppViewState["tab"]): void {
  if (tab === "adminbotPapers" || tab === "adminbotProfessor") {
    lazyMyWork.read();
  }
}

export const renderReferenceCheckerPage = (baseUrl: string, sessionToken: string) =>
  renderLazyView(
    lazyReferenceChecker,
    () =>
      html`<adminbot-reference-checker
          .baseUrl=${baseUrl}
          .sessionToken=${sessionToken}
        ></adminbot-reference-checker>
        <adminbot-openreview-citation-checks
          .baseUrl=${baseUrl}
          .sessionToken=${sessionToken}
        ></adminbot-openreview-citation-checks>`,
  );
