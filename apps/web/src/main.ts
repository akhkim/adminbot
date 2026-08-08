import { AdminBotAppShell } from "./app-shell.js";
import { AdminBotLoginApp } from "./login-app.js";
import { AdminBotRegistrationApp } from "./registration-app.js";
import { AdminBotRegistrationReviewApp } from "./registration-review-app.js";
import { AdminBotDeadlineBoard } from "./deadline-board.js";
import { AdminBotPaperWorkspace } from "./paper-workspace.js";

if (!customElements.get("adminbot-login-app")) {
  customElements.define("adminbot-login-app", AdminBotLoginApp);
}

if (!customElements.get("adminbot-registration-app")) {
  customElements.define("adminbot-registration-app", AdminBotRegistrationApp);
}

if (!customElements.get("adminbot-registration-review-app")) {
  customElements.define("adminbot-registration-review-app", AdminBotRegistrationReviewApp);
}

if (!customElements.get("adminbot-deadline-board")) {
  customElements.define("adminbot-deadline-board", AdminBotDeadlineBoard);
}

if (!customElements.get("adminbot-paper-workspace")) {
  customElements.define("adminbot-paper-workspace", AdminBotPaperWorkspace);
}

if (!customElements.get("adminbot-app")) {
  customElements.define("adminbot-app", AdminBotAppShell);
}
