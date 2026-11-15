// The error log, for admins: what broke for the people using AdminBot, and how many of them.
//
// A self-contained element rather than state threaded through the app: nothing else on the page
// reads this list, so it loads when it is put on screen and forgets when it is taken off. That
// also means signing out drops it without a line of reset code -- the tab stops being offered and
// the element goes with it.
//
// Rows and hairlines, no cards (ui/DESIGN.md): each problem is one row, most recent first, with
// the stack folded away until somebody wants it.
import { LitElement, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../format.ts";
import { loadSettings } from "../../storage.ts";
import {
  authedJson,
  calendarFailure,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";

export type ErrorGroup = {
  id: string;
  kind: "error" | "unhandled_rejection" | "api" | "server";
  message: string;
  name?: string;
  page?: string;
  api_method?: string;
  api_path?: string;
  api_status?: number;
  count: number;
  members: Array<{ id: string; name: string }>;
  members_capped?: boolean;
  first_seen_at: string;
  last_seen_at: string;
  sample_stack?: string;
  build?: string;
  user_agent?: string;
  resolved_at?: string;
};

/** Where it happened, in the words an admin would use to go and look. */
export function errorGroupWhere(group: ErrorGroup): string {
  if (group.api_path) {
    const request = `${group.api_method ?? "GET"} ${group.api_path}`;
    return group.page ? t("errorLog.whereRequestOnPage", { request, page: group.page }) : request;
  }
  return group.page ?? t("errorLog.whereUnknown");
}

/** "Ada, Grace" / "Ada, Grace and others" / "Nobody signed in". */
export function errorGroupPeople(group: ErrorGroup): string {
  if (!group.members.length) {
    return t("errorLog.peopleNone");
  }
  const names = group.members.map((member) => member.name);
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 || group.members_capped
    ? t("errorLog.peopleAndMore", { names: shown })
    : shown;
}

function when(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? formatRelativeTimestamp(at) : iso;
}

function wire(): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  return stored
    ? { token: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(loadSettings()) }
    : null;
}

export class AdminBotErrorLog extends LitElement {
  // Light DOM, so the page's own tokens and button styles apply.
  override createRenderRoot() {
    return this;
  }

  @state() private groups: ErrorGroup[] | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private showResolved = false;
  @state() private resolving: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private failure(response: Response, body: unknown): string {
    if (response.status === 403) {
      return t("errorLog.error.forbidden");
    }
    return calendarFailure(response, body).message ?? t("errorLog.error.failed");
  }

  private async load(): Promise<void> {
    const session = wire();
    if (!session) {
      this.error = t("errorLog.error.signIn");
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const result = await authedJson(
        session.baseUrl,
        `/ops/errors${this.showResolved ? "?resolved=1" : ""}`,
        "GET",
        session.token,
      );
      if ("unreachable" in result) {
        // The list already on screen stays: an unreachable service should not also blank it.
        this.error = t("errorLog.error.unreachable", { url: session.baseUrl });
        return;
      }
      if (!result.response.ok) {
        this.error = this.failure(result.response, result.body);
        return;
      }
      const groups = (result.body as { groups?: unknown } | null)?.groups;
      this.groups = Array.isArray(groups) ? (groups as ErrorGroup[]) : [];
    } finally {
      this.loading = false;
    }
  }

  private async resolve(group: ErrorGroup): Promise<void> {
    const session = wire();
    if (!session) {
      this.error = t("errorLog.error.signIn");
      return;
    }
    this.resolving = group.id;
    this.error = null;
    try {
      const result = await authedJson(
        session.baseUrl,
        `/ops/errors/${encodeURIComponent(group.id)}/resolve`,
        "POST",
        session.token,
      );
      if ("unreachable" in result) {
        this.error = t("errorLog.error.unreachable", { url: session.baseUrl });
        return;
      }
      if (!result.response.ok) {
        this.error = this.failure(result.response, result.body);
        return;
      }
      await this.load();
    } finally {
      this.resolving = null;
    }
  }

  private renderGroup(group: ErrorGroup) {
    const kind = t(`errorLog.kind.${group.kind}`);
    return html`<li class="error-log__row" data-testid=${`error-log-row-${group.id}`}>
      <div class="error-log__main">
        <p class="error-log__message">
          ${group.name && !group.message.startsWith(group.name)
            ? `${group.name}: `
            : ""}${group.message}
        </p>
        <p class="error-log__meta">
          <span>${kind}</span>
          <span>${errorGroupWhere(group)}</span>
          <span class="ab-num">
            ${group.count === 1
              ? t("errorLog.countOne")
              : t("errorLog.count", { count: String(group.count) })}
          </span>
          <span>${errorGroupPeople(group)}</span>
        </p>
        <p class="error-log__meta">
          <span>${t("errorLog.lastSeen", { when: when(group.last_seen_at) })}</span>
          <span>${t("errorLog.firstSeen", { when: when(group.first_seen_at) })}</span>
          ${group.resolved_at
            ? html`<span>${t("errorLog.resolvedAt", { when: when(group.resolved_at) })}</span>`
            : nothing}
        </p>
        ${group.sample_stack || group.build || group.user_agent
          ? html`<details class="error-log__details">
              <summary>${t("errorLog.details")}</summary>
              ${group.sample_stack
                ? html`<pre class="error-log__stack">${group.sample_stack}</pre>`
                : nothing}
              ${group.build
                ? html`<p class="error-log__meta">
                    ${t("errorLog.build", { build: group.build })}
                  </p>`
                : nothing}
              ${group.user_agent
                ? html`<p class="error-log__meta">
                    ${t("errorLog.browser", { browser: group.user_agent })}
                  </p>`
                : nothing}
            </details>`
          : nothing}
      </div>
      ${group.resolved_at
        ? nothing
        : html`<button
            class="btn btn--sm btn--ghost"
            type="button"
            data-testid=${`error-log-resolve-${group.id}`}
            ?disabled=${this.resolving === group.id}
            @click=${() => void this.resolve(group)}
          >
            ${t("errorLog.resolve")}
          </button>`}
    </li>`;
  }

  override render() {
    const groups = this.groups;
    return html`<section class="error-log" data-testid="error-log">
      <div class="error-log__head">
        <div>
          <h2 class="error-log__title">${t("errorLog.title")}</h2>
          <p class="error-log__blurb">${t("errorLog.blurb")}</p>
        </div>
        <div class="error-log__actions">
          <label class="error-log__toggle">
            <input
              type="checkbox"
              data-testid="error-log-show-resolved"
              .checked=${this.showResolved}
              @change=${(event: Event) => {
                this.showResolved = (event.target as HTMLInputElement).checked;
                void this.load();
              }}
            />
            ${t("errorLog.showResolved")}
          </label>
          <button
            class="btn btn--sm btn--ghost"
            type="button"
            data-testid="error-log-refresh"
            ?disabled=${this.loading}
            @click=${() => void this.load()}
          >
            ${t("errorLog.refresh")}
          </button>
        </div>
      </div>

      ${this.error
        ? html`<p class="error-log__error" role="alert" data-testid="error-log-error">
            ${this.error}
          </p>`
        : nothing}
      ${this.loading && !groups
        ? html`<p class="error-log__empty">${t("errorLog.loading")}</p>`
        : nothing}
      ${groups && !groups.length
        ? html`<p class="error-log__empty" data-testid="error-log-empty">
            ${this.showResolved ? t("errorLog.emptyAll") : t("errorLog.empty")}
          </p>`
        : nothing}
      ${groups?.length
        ? html`<ul class="error-log__list">
            ${groups.map((group) => this.renderGroup(group))}
          </ul>`
        : nothing}

      <p class="error-log__caveat">${t("errorLog.caveat")}</p>
    </section>`;
  }
}

if (!customElements.get("adminbot-error-log")) {
  customElements.define("adminbot-error-log", AdminBotErrorLog);
}
