// Control UI pages that load on first use, behind same-named shims so app-render's call sites read
// as they always have.
//
// Chat and the gateway settings pages are operator surfaces most members never open; the chat
// renderer alone drags the markdown runtime with it.
import { html, nothing } from "lit";
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
// OpenReview citation checks are an admin tool; members get the reference checker alone.
export const renderReferenceCheckerPage = (
  baseUrl: string,
  sessionToken: string,
  showCitationChecks: boolean,
) =>
  renderLazyView(
    lazyReferenceChecker,
    () =>
      html`<adminbot-reference-checker
          .baseUrl=${baseUrl}
          .sessionToken=${sessionToken}
        ></adminbot-reference-checker>
        ${showCitationChecks
          ? html`<adminbot-openreview-citation-checks
              .baseUrl=${baseUrl}
              .sessionToken=${sessionToken}
            ></adminbot-openreview-citation-checks>`
          : nothing}`,
  );
