import { html, LitElement, nothing, type TemplateResult } from "lit";
import { AdminBotApiError, SessionApiClient, type SessionClient } from "./api-client.js";
import { sessionChangedEvent } from "./identity-events.js";
import { identityStyles } from "./identity-styles.js";

export class AdminBotLoginApp extends LitElement {
  static override properties = {
    submitting: { state: true },
    passwordVisible: { state: true },
    errorMessage: { state: true },
    approvalPending: { state: true },
  };

  static override styles = identityStyles;

  client: SessionClient = new SessionApiClient({
    serviceOrigin: import.meta.env.VITE_ADMINBOT_API_ORIGIN || window.location.origin,
  });

  declare private submitting: boolean;
  declare private passwordVisible: boolean;
  declare private errorMessage: string;
  declare private approvalPending: boolean;

  constructor() {
    super();
    this.submitting = false;
    this.passwordVisible = false;
    this.errorMessage = "";
    this.approvalPending = false;
  }

  override render(): TemplateResult {
    return html`
      <section class="identity-layout">
        <div class="intro">
          <p class="eyebrow">Identity</p>
          <h1>Welcome back.</h1>
          <p class="lede">
            Sign in to restore your secure AdminBot session. Your access is resolved by the
            server from your account and current lab roles.
          </p>
        </div>
        <div class="card">
          <h2>Sign in</h2>
          <p class="note">Session credentials stay in a secure HTTP-only cookie.</p>
          <form @submit=${this.submit} novalidate>
            <label>Email<input name="email" type="email" autocomplete="email" required /></label>
            <label class="password-field">
              Password
              <input
                name="password"
                type=${this.passwordVisible ? "text" : "password"}
                autocomplete="current-password"
                required
              />
              <button class="reveal" type="button" @click=${this.togglePassword}>
                ${this.passwordVisible ? "Hide" : "Show"}
              </button>
            </label>
            ${this.approvalPending
              ? html`<p class="pending-notice" role="status">
                  Your request is still awaiting administrator approval. No session was created.
                </p>`
              : nothing}
            ${this.errorMessage
              ? html`<p class="error" role="alert">${this.errorMessage}</p>`
              : nothing}
            <button class="primary" type="submit" ?disabled=${this.submitting}>
              ${this.submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p class="note">
            Need an account? <a class="link" href="/access">Request access</a>.
          </p>
        </div>
      </section>
    `;
  }

  private readonly togglePassword = (): void => {
    this.passwordVisible = !this.passwordVisible;
  };

  private readonly submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (this.submitting) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    this.submitting = true;
    this.errorMessage = "";
    this.approvalPending = false;
    try {
      const session = await this.client.login({ email, password });
      this.dispatchEvent(sessionChangedEvent(session));
    } catch (error) {
      if (error instanceof AdminBotApiError && error.code === "account_pending_approval") {
        this.approvalPending = true;
      } else if (error instanceof AdminBotApiError && error.status === 401) {
        this.errorMessage = "The email or password is incorrect.";
      } else if (error instanceof AdminBotApiError && error.status === 429) {
        this.errorMessage = "Too many sign-in attempts. Please wait and try again.";
      } else {
        this.errorMessage = "AdminBot could not sign you in. Try again.";
      }
    } finally {
      this.submitting = false;
    }
  };
}
