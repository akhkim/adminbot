import type { SessionView } from "@adminbot/api-contracts";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { SessionApiClient, type SessionClient } from "./api-client.js";
import {
  APP_ROUTES,
  NAV_GROUPS,
  appRoute,
  resolveAppRoute,
  routesInGroup,
  type AppRoute,
  type AppRouteGroup,
} from "./app-routes.js";
import { appShellStyles } from "./app-shell-styles.js";
import { SESSION_CHANGED_EVENT, type SessionChangedDetail } from "./identity-events.js";
import { readColorTheme, writeColorTheme, type ColorTheme } from "./theme.js";
import { renderOverviewView } from "./views/overview-view.js";
import { renderPendingSurface } from "./views/pending-surface.js";

export class AdminBotAppShell extends LitElement {
  static override properties = {
    activeRoute: { state: true },
    colorTheme: { state: true },
    mobileNavigationOpen: { state: true },
    session: { state: true },
    sessionLoading: { state: true },
    sessionError: { state: true },
  };

  static override styles = appShellStyles;

  declare private activeRoute: AppRoute;
  declare private colorTheme: ColorTheme;
  declare private mobileNavigationOpen: boolean;
  declare private session: SessionView | undefined;
  declare private sessionLoading: boolean;
  declare private sessionError: string;

  sessionClient: SessionClient = new SessionApiClient({
    serviceOrigin: import.meta.env.VITE_ADMINBOT_API_ORIGIN || window.location.origin,
  });

  constructor() {
    super();
    this.activeRoute = resolveAppRoute(window.location.pathname);
    this.colorTheme = readColorTheme(window.localStorage);
    this.mobileNavigationOpen = false;
    this.session = undefined;
    this.sessionLoading = true;
    this.sessionError = "";
    this.syncDocumentState();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("popstate", this.handlePopState);
    this.addEventListener(SESSION_CHANGED_EVENT, this.handleSessionChanged as EventListener);
    void this.restoreSession();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("popstate", this.handlePopState);
    this.removeEventListener(SESSION_CHANGED_EVENT, this.handleSessionChanged as EventListener);
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
                  ${this.visibleRoutes(group.id).map((route) => this.renderNavigationItem(route))}
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
              ${this.session === undefined
                ? nothing
                : html`
                    <span class="session-person">${this.session.person.displayName}</span>
                    <button class="icon-button" type="button" @click=${this.signOut}>Sign out</button>
                  `}
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
    if (this.sessionLoading && this.activeRoute.audience !== "public") {
      return this.renderAccessState("Restoring your secure session…");
    }
    if (this.activeRoute.audience === "member" && this.session === undefined) {
      return this.renderAccessState("Sign in to open the lab workspace.", true);
    }
    if (this.activeRoute.audience === "administrator" && !this.isAdministrator) {
      return this.renderAccessState(
        this.session === undefined
          ? "Sign in with an administrator account to continue."
          : "This area requires the administrator role.",
        this.session === undefined,
      );
    }
    if (this.activeRoute.audience === "governance" && !this.canReviewActions) {
      return this.renderAccessState(
        this.session === undefined
          ? "Sign in with an administrator or approver account to continue."
          : "This area requires the administrator or approver role.",
        this.session === undefined,
      );
    }
    if (this.activeRoute.id === "overview") return renderOverviewView(this.handleRouteClick);
    if (this.activeRoute.id === "signIn") {
      if (this.session !== undefined) {
        return this.renderAccessState(`Signed in as ${this.session.person.displayName}.`);
      }
      return html`<section class="registration-frame" aria-label="Sign in">
        <adminbot-login-app></adminbot-login-app>
      </section>`;
    }
    if (this.activeRoute.id === "access") {
      return html`<section class="registration-frame" aria-label="Request access">
        <adminbot-registration-app></adminbot-registration-app>
      </section>`;
    }
    if (this.activeRoute.id === "registrations") {
      return html`<section class="registration-frame" aria-label="Registration review">
        <adminbot-registration-review-app></adminbot-registration-review-app>
      </section>`;
    }
    if (this.activeRoute.id === "deadlines") {
      return html`<adminbot-deadline-board></adminbot-deadline-board>`;
    }
    if (this.activeRoute.id === "reimbursements") {
      return html`<adminbot-reimbursement-app></adminbot-reimbursement-app>`;
    }
    if (this.activeRoute.id === "papers") {
      return html`<adminbot-paper-workspace></adminbot-paper-workspace>`;
    }
    if (this.activeRoute.id === "availability") {
      return html`<adminbot-availability-workspace></adminbot-availability-workspace>`;
    }
    if (this.activeRoute.id === "actions") {
      return html`<adminbot-governance-actions></adminbot-governance-actions>`;
    }
    if (this.activeRoute.id === "settings") {
      return html`<adminbot-policy-settings></adminbot-policy-settings>`;
    }
    if (this.activeRoute.id === "members") {
      return html`<adminbot-member-workspace></adminbot-member-workspace>`;
    }
    if (this.activeRoute.status === "backend_pending") {
      return renderPendingSurface(this.activeRoute);
    }
    throw new Error(`Live route ${this.activeRoute.id} has no view implementation`);
  }

  private renderAccessState(message: string, signIn = false): TemplateResult {
    return html`
      <section class="access-state">
        <span class="empty-state-mark" aria-hidden="true">ID</span>
        <h1>${signIn ? "Authentication required" : "Session"}</h1>
        <p>${message}</p>
        ${this.sessionError === ""
          ? nothing
          : html`<p class="access-error" role="alert">${this.sessionError}</p>`}
        ${signIn
          ? html`<a class="primary-link" href=${appRoute("signIn").path} @click=${this.handleRouteClick}>Sign in</a>`
          : nothing}
      </section>
    `;
  }

  private visibleRoutes(group: AppRouteGroup): readonly AppRoute[] {
    return routesInGroup(group).filter((route) => {
      if (route.id === "signIn") return this.session === undefined;
      if (route.audience === "public") return true;
      if (route.audience === "member") return this.session !== undefined;
      if (route.audience === "governance") return this.canReviewActions;
      return this.isAdministrator;
    });
  }

  private get isAdministrator(): boolean {
    return this.session?.roles.includes("administrator") ?? false;
  }

  private get canReviewActions(): boolean {
    return this.session?.roles.some((role) => role === "administrator" || role === "approver") ?? false;
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

  private readonly handleSessionChanged = (event: CustomEvent<SessionChangedDetail>): void => {
    this.session = event.detail.session;
    this.sessionError = "";
    if (this.session !== undefined && this.activeRoute.id === "signIn") {
      window.history.replaceState({}, "", appRoute("overview").path);
      this.setActiveRoute(appRoute("overview"));
    }
  };

  private async restoreSession(): Promise<void> {
    this.sessionLoading = true;
    try {
      this.session = await this.sessionClient.restore();
      this.sessionError = "";
    } catch {
      this.session = undefined;
      this.sessionError = "AdminBot could not check the current session.";
    } finally {
      this.sessionLoading = false;
    }
  }

  private readonly signOut = async (): Promise<void> => {
    try {
      await this.sessionClient.logout();
      this.session = undefined;
      this.sessionError = "";
      window.history.pushState({}, "", appRoute("signIn").path);
      this.setActiveRoute(appRoute("signIn"));
    } catch {
      this.sessionError = "AdminBot could not sign out. Try again.";
    }
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
