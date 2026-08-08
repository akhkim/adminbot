import { AdminBotAppShell } from "./app-shell.js";
import { AdminBotAvailabilityWorkspace } from "./availability-workspace.js";
import { AdminBotLoginApp } from "./login-app.js";
import { AdminBotRegistrationApp } from "./registration-app.js";
import { AdminBotRegistrationReviewApp } from "./registration-review-app.js";
import { AdminBotDeadlineBoard } from "./deadline-board.js";
import { AdminBotPaperWorkspace } from "./paper-workspace.js";
import { AdminBotReimbursementApp } from "./reimbursement-app.js";
import { AdminBotGovernanceActionsApp } from "./governance-actions-app.js";
import { AdminBotPolicySettingsApp } from "./policy-settings-app.js";
import { AdminBotMemberWorkspace } from "./member-workspace.js";

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

if (!customElements.get("adminbot-availability-workspace")) {
  customElements.define("adminbot-availability-workspace", AdminBotAvailabilityWorkspace);
}

if (!customElements.get("adminbot-app")) {
  customElements.define("adminbot-app", AdminBotAppShell);
}

if (!customElements.get("adminbot-reimbursement-app")) {
  customElements.define("adminbot-reimbursement-app", AdminBotReimbursementApp);
}

if (!customElements.get("adminbot-governance-actions")) {
  customElements.define("adminbot-governance-actions", AdminBotGovernanceActionsApp);
}

if (!customElements.get("adminbot-policy-settings")) {
  customElements.define("adminbot-policy-settings", AdminBotPolicySettingsApp);
}

if (!customElements.get("adminbot-member-workspace")) {
  customElements.define("adminbot-member-workspace", AdminBotMemberWorkspace);
}
