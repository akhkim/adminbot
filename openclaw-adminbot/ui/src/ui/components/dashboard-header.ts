// Control UI component implements the dashboard header element.
import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { groupTitleForTab, titleForTab, type Tab } from "../navigation.js";

export class DashboardHeader extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() tab: Tab = "overview";

  override render() {
    const label = titleForTab(this.tab);
    // The trail is where the member already reads the page from: the sidebar group, then the
    // page. The old first two segments were an "OpenClaw" link home and the serving agent's name
    // ("main"), which named the runtime rather than anything on the member's map.
    const group = groupTitleForTab(this.tab);

    return html`
      <div class="dashboard-header">
        <div class="dashboard-header__breadcrumb">
          ${group
            ? html`
                <span class="dashboard-header__breadcrumb-context">${group}</span>
                <span class="dashboard-header__breadcrumb-sep">›</span>
              `
            : nothing}
          <span class="dashboard-header__breadcrumb-current">${label}</span>
        </div>
        <div class="dashboard-header__actions">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("dashboard-header")) {
  customElements.define("dashboard-header", DashboardHeader);
}
