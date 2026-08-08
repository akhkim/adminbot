import { AdminBotRegistrationApp } from "./registration-app.js";

if (!customElements.get("adminbot-registration-app")) {
  customElements.define("adminbot-registration-app", AdminBotRegistrationApp);
}
