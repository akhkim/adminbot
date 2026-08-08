import { html, LitElement, type TemplateResult } from "lit";
import {
  APP_ROUTES,
  NAV_GROUPS,
  appRoute,
  resolveAppRoute,
  routesInGroup,
  type AppRoute,
} from "./app-routes.js";
import { appShellStyles } from "./app-shell-styles.js";
import { readColorTheme, writeColorTheme, type ColorTheme } from "./theme.js";
import { renderOverviewView } from "./views/overview-view.js";
import { renderPendingSurface } from "./views/pending-surface.js";

export class AdminBotAppShell extends LitElement {
  static override properties = {
    activeRoute: { state: true },
    colorTheme: { state: true },
    mobileNavigationOpen: { state: true },
  };

  static override styles = appShellStyles;

  declare private activeRoute: AppRoute;
  declare private colorTheme: ColorTheme;
  declare private mobileNavigationOpen: boolean;

  constructor() {
    super();
    this.activeRoute = resolveAppRoute(window.location.pathname);
    this.colorTheme = readColorTheme(window.localStorage);
    this.mobileNavigationOpen = false;
    this.syncDocumentState();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("popstate", this.handlePopState);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("popstate", this.handlePopState);
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`
      <div class="shell">
        <aside class="sidebar" data-open=${String(this.mobileNavigationOpen)}>
          <a class="brand" href=${appRoute("overview").path} @click=${this.handleRouteClick}>
            <span class="brand-mark" aria-hidden="true">A</span>
            <span class="brand-copy">
              <span class="brand-name">AdminBot</span>
              <span class="brand-subtitle">Lab workspace</span>
            </span>
          </a>
          <nav class="navigation" aria-label="AdminBot">
            ${NAV_GROUPS.map(
              (group) => html`
                <section class="nav-group" aria-labelledby=${`nav-${group.id}`}>
                  <h2 class="nav-group-label" id=${`nav-${group.id}`}>${group.label}</h2>
                  ${routesInGroup(group.id).map((route) => this.renderNavigationItem(route))}
                </section>
              `,
            )}
          </nav>
          <div class="sidebar-footer">
            <strong>Standalone v0alpha</strong>
            Backend-pending pages are inert previews. Every real command remains server-authorized.
          </div>
        </aside>

        <div class="workspace">
          <header class="topbar">
            <div class="topbar-actions">
              <button
                class="icon-button menu-button"
                type="button"
                aria-label="Open navigation"
                @click=${() => {
                  this.mobileNavigationOpen = !this.mobileNavigationOpen;
                }}
              >
                Menu
              </button>
              <div class="route-context">
                <span>${this.activeRoute.eyebrow}</span>
                <strong>${this.activeRoute.shortLabel}</strong>
              </div>
            </div>
            <div class="topbar-actions">
              <span class="environment">v0alpha · local API</span>
              <button
                class="icon-button"
                type="button"
                aria-label=${`Switch to ${this.colorTheme === "dark" ? "light" : "dark"} mode`}
                @click=${this.toggleTheme}
              >
                ${this.colorTheme === "dark" ? "Light" : "Dark"}
              </button>
            </div>
          </header>
          <main class="content" id="main-content">${this.renderActiveRoute()}</main>
        </div>
      </div>
    `;
  }

  protected override updated(): void {
    if (this.colorTheme === "light") this.setAttribute("data-theme", "light");
    else this.removeAttribute("data-theme");
  }

  private renderNavigationItem(route: AppRoute): TemplateResult {
    const sequence = APP_ROUTES.indexOf(route).toString().padStart(2, "0");
    return html`
      <a
        class="nav-item"
        href=${route.path}
        aria-current=${this.activeRoute.id === route.id ? "page" : "false"}
        @click=${this.handleRouteClick}
      >
        <span class="nav-number" aria-hidden="true">${sequence}</span>
        <span class="nav-text">${route.shortLabel}</span>
        <span
          class=${`nav-status ${route.status === "live" ? "nav-status--live" : ""}`}
          title=${route.status === "live" ? "Connected" : "Backend port pending"}
        ></span>
      </a>
    `;
  }

  private renderActiveRoute(): TemplateResult {
    if (this.activeRoute.id === "overview") return renderOverviewView(this.handleRouteClick);
    if (this.activeRoute.id === "access") {
      return html`<section class="registration-frame" aria-label="Request access">
        <adminbot-registration-app></adminbot-registration-app>
      </section>`;
    }
    if (this.activeRoute.status === "backend_pending") {
      return renderPendingSurface(this.activeRoute);
    }
    throw new Error(`Live route ${this.activeRoute.id} has no view implementation`);
  }

  private readonly handleRouteClick = (event: MouseEvent): void => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const anchor = event.currentTarget;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    window.history.pushState({}, "", anchor.pathname);
    this.setActiveRoute(resolveAppRoute(anchor.pathname));
  };

  private readonly handlePopState = (): void => {
    this.setActiveRoute(resolveAppRoute(window.location.pathname));
  };

  private setActiveRoute(route: AppRoute): void {
    this.activeRoute = route;
    this.mobileNavigationOpen = false;
    this.syncDocumentState();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  private syncDocumentState(): void {
    document.title = `${this.activeRoute.label} · AdminBot`;
  }

  private readonly toggleTheme = (): void => {
    this.colorTheme = this.colorTheme === "dark" ? "light" : "dark";
    writeColorTheme(window.localStorage, this.colorTheme);
  };
}
