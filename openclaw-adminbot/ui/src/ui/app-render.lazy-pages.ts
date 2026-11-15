// Control UI pages that load on first use, behind same-named shims so app-render's call sites read
// as they always have.
//
// Chat and the gateway settings pages are operator surfaces most members never open; the chat
// renderer alone drags the markdown runtime with it. The rest are pages one role opens now and
// then (the onboarding checklist, the admins' error log and tab usage, the operator overview, the
// signed-out reimbursement tool), none of which the first screen draws.
import { html, nothing } from "lit";
import type { TabUsageViewProps } from "./adminbot/views/tab-usage.ts";
import type { AppViewState } from "./app-view-state.ts";
import { loadChatView } from "./chat/view-reset.ts";
import { createLazyView, notifyLazyViewHost, renderLazyView } from "./lazy-view.ts";
import type { ChatProps } from "./views/chat.ts";
import type { QuickSettingsProps } from "./views/config-quick.ts";
import type { ConfigProps } from "./views/config.ts";
import type { OverviewProps } from "./views/overview.ts";

const lazyChat = createLazyView(loadChatView, notifyLazyViewHost, { tabs: ["chat"] });
const lazyConfig = createLazyView(() => import("./views/config.ts"), notifyLazyViewHost, {
  tabs: ["config"],
});
const lazyQuickSettings = createLazyView(
  () => import("./views/config-quick.ts"),
  notifyLazyViewHost,
);
// PaperMentor's elements define themselves on import: the review page, the PDF reference checker
// it embeds, and the admins' OpenReview citation checks. The page renders once all are defined.
const lazyPaperMentor = createLazyView(
  () =>
    Promise.all([
      import("./adminbot/views/papermentor.ts"),
      import("./adminbot/views/reference-checker.ts"),
      import("./adminbot/views/openreview-citation-checks.ts"),
    ]),
  notifyLazyViewHost,
  { tabs: ["adminbotPaperMentor"] },
);

const lazyGettingStarted = createLazyView(
  () => import("./adminbot/views/getting-started.ts"),
  notifyLazyViewHost,
  { tabs: ["gettingStarted"] },
);
const lazyTabUsage = createLazyView(
  () => import("./adminbot/views/tab-usage.ts"),
  notifyLazyViewHost,
  { tabs: ["adminbotTabUsage"] },
);
// The error log is an element that defines itself on import.
const lazyErrorLog = createLazyView(
  () => import("./adminbot/views/error-log.ts"),
  notifyLazyViewHost,
  { tabs: ["adminbotErrorLog"] },
);
const lazyOverview = createLazyView(() => import("./views/overview.ts"), notifyLazyViewHost, {
  tabs: ["overview"],
});
// Reached from the landing page by a signed-out visitor, so there is no sidebar link to warm it.
const lazyGuestReimbursements = createLazyView(
  () => import("./views/guest-reimbursements.ts"),
  notifyLazyViewHost,
);

export const renderGettingStarted = (state: AppViewState) =>
  renderLazyView(lazyGettingStarted, (m) => m.renderGettingStarted(state));
export const renderAdminBotTabUsage = (props: TabUsageViewProps) =>
  renderLazyView(lazyTabUsage, (m) => m.renderAdminBotTabUsage(props));
export const renderErrorLogPage = () =>
  renderLazyView(lazyErrorLog, () => html`<adminbot-error-log></adminbot-error-log>`);
export const renderOverview = (props: OverviewProps) =>
  renderLazyView(lazyOverview, (m) => m.renderOverview(props));
export const renderGuestReimbursements = (state: AppViewState) =>
  renderLazyView(lazyGuestReimbursements, (m) => m.renderGuestReimbursements(state));

// The feedback button is an element that defines itself on import. Its tag is drawn straight away
// and stays empty until the code lands, when the browser upgrades it in place with the attributes
// and the listener it was given. A failed download is asked for again on the next render.
let feedbackWidgetRequested = false;
export function loadFeedbackWidget(): void {
  if (feedbackWidgetRequested) {
    return;
  }
  feedbackWidgetRequested = true;
  import("./components/feedback-widget.ts").catch(() => {
    feedbackWidgetRequested = false;
  });
}

export const renderChat = (props: ChatProps) =>
  renderLazyView(lazyChat, (m) => m.renderChat(props));
export const renderConfig = (props: ConfigProps) =>
  renderLazyView(lazyConfig, (m) => m.renderConfig(props));
export const renderQuickSettings = (props: QuickSettingsProps) =>
  renderLazyView(lazyQuickSettings, (m) => m.renderQuickSettings(props));
// OpenReview citation checks are an admin tool; members get PaperMentor and its PDF check alone.
export const renderPaperMentorPage = (
  baseUrl: string,
  sessionToken: string,
  showCitationChecks: boolean,
) =>
  renderLazyView(
    lazyPaperMentor,
    () =>
      html`<adminbot-papermentor
          .baseUrl=${baseUrl}
          .sessionToken=${sessionToken}
        ></adminbot-papermentor>
        ${showCitationChecks
          ? html`<adminbot-openreview-citation-checks
              .baseUrl=${baseUrl}
              .sessionToken=${sessionToken}
            ></adminbot-openreview-citation-checks>`
          : nothing}`,
  );
