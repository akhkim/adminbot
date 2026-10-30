// Personal API tokens on My Profile, and the card that approves an `adminbot auth login`.
//
// Both talk to /auth/api-tokens* and /auth/device/* (extensions/adminbot/src/api/routes/
// api-tokens.ts); the service decides who may hold a token. Being signed in is enough to mint or
// approve, as with gh and Modal: no password prompt. A new token's secret is held in this element only until the member presses
// Done, and is never written to storage, the URL, or the offline read cache.
// See docs/adminbot/api-tokens.md.
import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { loadSettings } from "../../storage.ts";
import { memberAuthHeaders } from "../api/device-clock.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";

export type ApiTokenRow = {
  id: string;
  name: string;
  hint: string;
  created_at: string;
  expires_at: string;
  last_used_at?: string;
  last_used_ip?: string;
  last_used_place?: string;
  ip_count: number;
  current?: boolean;
};

type PendingCliLogin = {
  user_code: string;
  name: string;
  /** Absent: no fixed expiry, the token lives until it sits unused for 90 days. */
  expires_in_days?: number;
  requested_ip?: string;
  expires_at: string;
};

/** One request to the member routes. Never cached: these answers are about live credentials. */
async function tokenRequest<T>(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<T> {
  const session = loadStoredMemberSession();
  if (!session) {
    throw new Error("Sign in to AdminBot first.");
  }
  let response: Response;
  try {
    response = await fetch(`${resolveAdminBotBaseUrl(loadSettings())}${path}`, {
      method,
      cache: "no-store",
      credentials: "omit",
      headers: {
        ...memberAuthHeaders(session.sessionToken),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("AdminBot is unreachable. Check your connection and try again.");
  }
  const result = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(result.error?.message || `AdminBot refused the request (${response.status}).`);
  }
  return result as T;
}

const day = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "never";

// The server stores "no fixed expiry" as the last instant of year 9999.
const expiry = (iso: string) => (iso.startsWith("9999-") ? "When unused 90 days" : day(iso));

const shared = css`
  :host {
    display: block;
    margin-bottom: 20px;
  }
  section {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    background: var(--card);
  }
  h3 {
    margin: 0 0 4px;
    font-size: 1rem;
  }
  p {
    margin: 4px 0 12px;
    color: var(--muted);
    font-size: 0.875rem;
  }
  form {
    display: grid;
    gap: 10px;
    max-width: 420px;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: 0.875rem;
  }
  input,
  select {
    font: inherit;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
  }
  button {
    font: inherit;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-foreground, #fff);
  }
  button.danger {
    color: var(--danger, #c0392b);
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  [role="alert"] {
    color: var(--danger, #c0392b);
    font-size: 0.875rem;
  }
  code {
    font-family: var(--mono, ui-monospace, monospace);
  }
`;

/** The API tokens section of My Profile. Renders nothing for members who may not hold one. */
export class ApiTokensSection extends LitElement {
  @state() private allowed = false;
  @state() private tokens: ApiTokenRow[] = [];
  @state() private busy = false;
  @state() private error = "";
  @state() private creating = false;
  // The one time the secret is shown. Cleared by Done, and by leaving the page.
  @state() private issued: { name: string; token: string } | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.issued = null;
  }

  private async load() {
    try {
      const result = await tokenRequest<{ allowed: boolean; tokens: ApiTokenRow[] }>(
        "/auth/api-tokens",
        "GET",
      );
      this.allowed = result.allowed;
      this.tokens = result.tokens;
    } catch {
      // An older service without these routes, or a signed-out page: show nothing.
      this.allowed = false;
    }
  }

  private async run(action: () => Promise<void>) {
    this.busy = true;
    this.error = "";
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Something went wrong.";
    } finally {
      this.busy = false;
    }
  }

  private create(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const days = Number(data.get("days"));
    void this.run(async () => {
      const result = await tokenRequest<{ token: string; api_token: ApiTokenRow }>(
        "/auth/api-tokens",
        "POST",
        { name, ...(days > 0 ? { expires_in_days: days } : {}) },
      );
      this.issued = { name: result.api_token.name, token: result.token };
      this.creating = false;
      await this.load();
    });
  }

  private revoke(token: ApiTokenRow) {
    if (!confirm(`Revoke "${token.name}"? Anything using it stops working immediately.`)) {
      return;
    }
    void this.run(async () => {
      await tokenRequest(`/auth/api-tokens/${encodeURIComponent(token.id)}`, "DELETE");
      await this.load();
    });
  }

  private revokeAll() {
    if (!confirm("Revoke every API token? Every CLI and agent using one is signed out.")) {
      return;
    }
    void this.run(async () => {
      await tokenRequest("/auth/api-tokens/revoke-all", "POST");
      await this.load();
    });
  }

  private async copy() {
    if (this.issued) {
      await navigator.clipboard?.writeText(this.issued.token).catch(() => {});
    }
  }

  static styles = [
    shared,
    css`
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.875rem;
        margin-bottom: 12px;
      }
      th,
      td {
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      .issued {
        border: 1px solid var(--accent);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .issued input {
        width: 100%;
        box-sizing: border-box;
        font-family: var(--mono, ui-monospace, monospace);
      }
      @media (max-width: 640px) {
        .wide {
          display: none;
        }
      }
    `,
  ];

  render() {
    if (!this.allowed) {
      return nothing;
    }
    return html`<section aria-labelledby="api-tokens-title" data-testid="api-tokens">
      <h3 id="api-tokens-title">API tokens</h3>
      <p>
        Tokens let the AdminBot CLI and your AI agents act as you. Sign a terminal in with
        <code>adminbot auth login</code>, or create a token here for an agent's
        <code>ADMINBOT_TOKEN</code>. Tokens last until you revoke them or leave them unused for 90
        days. A token cannot change your password or email, or impersonate anyone.
      </p>
      ${this.issued
        ? html`<div class="issued" data-testid="api-token-issued">
            <strong
              >Copy the token for "${this.issued.name}" now. It will not be shown again.</strong
            >
            <p>Keep it out of prompts, chat messages and repositories.</p>
            <input readonly .value=${this.issued.token} aria-label="New API token" />
            <div class="row" style="margin-top: 8px">
              <button type="button" @click=${() => void this.copy()}>Copy</button>
              <button type="button" class="primary" @click=${() => (this.issued = null)}>
                Done
              </button>
            </div>
          </div>`
        : nothing}
      ${this.tokens.length
        ? html`<table>
            <thead>
              <tr>
                <th>Name</th>
                <th class="wide">Created</th>
                <th>Last used</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${this.tokens.map(
                (token) =>
                  html`<tr data-testid="api-token-row">
                    <td>${token.name} <code>…${token.hint}</code></td>
                    <td class="wide">${day(token.created_at)}</td>
                    <td>
                      ${day(token.last_used_at)}${token.last_used_place
                        ? html`<br /><small>${token.last_used_place}</small>`
                        : nothing}
                    </td>
                    <td>${expiry(token.expires_at)}</td>
                    <td>
                      <button
                        type="button"
                        class="danger"
                        ?disabled=${this.busy}
                        @click=${() => this.revoke(token)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>`,
              )}
            </tbody>
          </table>`
        : html`<p>No active tokens.</p>`}
      ${this.creating
        ? html`<form @submit=${this.create}>
            <label
              >Name
              <input name="name" required maxlength="80" placeholder="e.g. Claude on my laptop"
            /></label>
            <label
              >Expires after
              <select name="days">
                <option value="0" selected>When unused for 90 days</option>
                <option value="7">After 7 days</option>
                <option value="30">After 30 days</option>
                <option value="365">After a year</option>
              </select></label
            >
            <div class="row">
              <button type="submit" class="primary" ?disabled=${this.busy}>
                ${this.busy ? "Creating…" : "Create token"}
              </button>
              <button type="button" @click=${() => (this.creating = false)}>Cancel</button>
            </div>
          </form>`
        : html`<div class="row">
            <button type="button" @click=${() => (this.creating = true)}>New token</button>
            ${this.tokens.length
              ? html`<button
                  type="button"
                  class="danger"
                  ?disabled=${this.busy}
                  @click=${() => this.revokeAll()}
                >
                  Revoke all
                </button>`
              : nothing}
          </div>`}
      ${this.error ? html`<div role="alert">${this.error}</div>` : nothing}
    </section>`;
  }
}

/**
 * The approval card for `adminbot auth login`. Shows what asked to sign in and from where; one click
 * approves or denies, as with `gh auth login`. Fires `cli-login-done` when the
 * member has answered or dismissed it.
 */
export class CliLoginApproval extends LitElement {
  @property() code = "";
  @state() private pending: PendingCliLogin | null = null;
  @state() private busy = false;
  @state() private error = "";
  @state() private outcome: "approved" | "denied" | null = null;

  // After the first render rather than on connect, so `code` is set however the element was made.
  firstUpdated() {
    void this.lookup();
  }

  private async lookup() {
    try {
      this.pending = await tokenRequest<PendingCliLogin>("/auth/device/lookup", "POST", {
        user_code: this.code,
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : "This sign-in request was not found.";
    }
  }

  private finish() {
    this.dispatchEvent(new CustomEvent("cli-login-done", { bubbles: true, composed: true }));
  }

  private approve() {
    this.busy = true;
    this.error = "";
    void tokenRequest("/auth/device/approve", "POST", { user_code: this.code })
      .then(() => {
        this.outcome = "approved";
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : "Approval failed.";
      })
      .finally(() => {
        this.busy = false;
      });
  }

  private deny() {
    this.busy = true;
    void tokenRequest("/auth/device/deny", "POST", { user_code: this.code })
      .then(() => {
        this.outcome = "denied";
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : "Could not deny the request.";
      })
      .finally(() => {
        this.busy = false;
      });
  }

  static styles = shared;

  render() {
    if (this.outcome) {
      return html`<section role="status" data-testid="cli-login-outcome">
        <h3>${this.outcome === "approved" ? "Signed in" : "Request denied"}</h3>
        <p>
          ${this.outcome === "approved"
            ? "Return to your terminal. You can revoke this token under API tokens below."
            : "The terminal that asked will be told no. Nothing was signed in."}
        </p>
        <button type="button" @click=${() => this.finish()}>Close</button>
      </section>`;
    }
    return html`<section aria-labelledby="cli-login-title" data-testid="cli-login">
      <h3 id="cli-login-title">Sign in the AdminBot CLI?</h3>
      ${this.pending
        ? html`<p>
              <strong>${this.pending.name}</strong> is asking for an API token that acts as you
              ${this.pending.expires_in_days
                ? `for ${this.pending.expires_in_days} days`
                : "until you revoke it or leave it unused for 90 days"}${this.pending.requested_ip
                ? html`, from <code>${this.pending.requested_ip}</code>`
                : nothing}.
            </p>
            <p>
              Check that your terminal shows <code>${this.pending.user_code}</code>. Approve only if
              you ran <code>adminbot auth login</code> yourself just now.
            </p>
            <div class="row">
              <button
                type="button"
                class="primary"
                ?disabled=${this.busy}
                @click=${() => this.approve()}
              >
                Approve
              </button>
              <button
                type="button"
                class="danger"
                ?disabled=${this.busy}
                @click=${() => this.deny()}
              >
                Deny
              </button>
            </div>`
        : this.error
          ? html`<p>
                This code has expired, was already used, or is not yours. Run
                <code>adminbot auth login</code> again.
              </p>
              <button type="button" @click=${() => this.finish()}>Dismiss</button>`
          : html`<p>Checking the code…</p>`}
      ${this.error && this.pending ? html`<div role="alert">${this.error}</div>` : nothing}
    </section>`;
  }
}

if (!customElements.get("adminbot-api-tokens")) {
  customElements.define("adminbot-api-tokens", ApiTokensSection);
}
if (!customElements.get("adminbot-cli-login")) {
  customElements.define("adminbot-cli-login", CliLoginApproval);
}
