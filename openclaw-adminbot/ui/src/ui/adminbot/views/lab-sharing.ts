// Placeholder for the Lab Sharing surface, which is not built yet.
//
// The tab ships ahead of the feature deliberately: the sidebar is the lab's map of what AdminBot
// does, and an announced-but-empty room is more honest than a surface that appears one day with no
// warning. It states plainly that there is nothing here yet so nobody files a bug against a blank
// page. Replace this whole module when the feature lands -- there is no state to preserve.
import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";

export function renderLabSharing() {
  return html`
    <section class="lab-sharing" data-testid="lab-sharing-placeholder">
      <div class="lab-sharing__icon" aria-hidden="true">${icons.link}</div>
      <h2 class="lab-sharing__title">${t("labSharing.title")}</h2>
      <p class="lab-sharing__body">${t("labSharing.body")}</p>
      <p class="lab-sharing__note">${t("labSharing.note")}</p>
    </section>
  `;
}
