import { html, LitElement, nothing, type TemplateResult } from "lit";
import type { ClaimablePerson } from "@adminbot/api-contracts";
import {
  RegistrationApiClient,
  RegistrationApiError,
  type RegistrationClient,
} from "./api-client.js";
import {
  BrowserFormError,
  claimInputFromForm,
  signupInputFromForm,
} from "./registration-form-data.js";
import { registrationStyles } from "./registration-styles.js";

type Mode = "claim" | "signup";
type SubmissionState = "idle" | "submitting" | "submitted";

export class AdminBotRegistrationApp extends LitElement {
  static override properties = {
    mode: { state: true },
    roster: { state: true },
    rosterLoading: { state: true },
    rosterError: { state: true },
    filter: { state: true },
    selectedPersonId: { state: true },
    submissionState: { state: true },
    errorMessage: { state: true },
  };

  static override styles = registrationStyles;

  client: RegistrationClient = new RegistrationApiClient({
    serviceOrigin: import.meta.env.VITE_ADMINBOT_API_ORIGIN || window.location.origin,
  });

  declare private mode: Mode;
  declare private roster: readonly ClaimablePerson[];
  declare private rosterLoading: boolean;
  declare private rosterError: string;
  declare private filter: string;
  declare private selectedPersonId: string;
  declare private submissionState: SubmissionState;
  declare private errorMessage: string;

  constructor() {
    super();
    this.mode = "claim";
    this.roster = [];
    this.rosterLoading = true;
    this.rosterError = "";
    this.filter = "";
    this.selectedPersonId = "";
    this.submissionState = "idle";
    this.errorMessage = "";
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadRoster();
  }

  override render(): TemplateResult {
    return html`
      <main>
        <section class="intro" aria-labelledby="page-title">
          <p class="eyebrow">AdminBot workspace</p>
          <h1 id="page-title">A careful way into the lab.</h1>
          <p class="lede">
            Match an existing roster profile or apply as a new collaborator. An administrator
            reviews every request before an account becomes active.
          </p>
        </section>

        <section class="card" aria-label="Request workspace access">
          ${this.submissionState === "submitted" ? this.renderPending() : this.renderForm()}
        </section>
      </main>
    `;
  }

  private renderForm(): TemplateResult {
    return html`
      <nav class="tabs" aria-label="Registration method">
        <button
          type="button"
          aria-selected=${this.mode === "claim"}
          @click=${() => this.selectMode("claim")}
        >
          Claim roster profile
        </button>
        <button
          type="button"
          aria-selected=${this.mode === "signup"}
          @click=${() => this.selectMode("signup")}
        >
          Apply as new
        </button>
      </nav>
      ${this.mode === "claim" ? this.renderClaimForm() : this.renderSignupForm()}
    `;
  }

  private renderClaimForm(): TemplateResult {
    const selected = this.roster.find((person) => person.personId === this.selectedPersonId);
    return html`
      <form @submit=${this.submitClaim} novalidate>
        <h2 class="form-heading">Find your profile</h2>
        <p class="form-note">
          The picker contains only unclaimed names. Selecting a name does not create a session.
        </p>
        <div class="fields">
          <fieldset class="full">
            <label for="roster-filter">Roster name</label>
            <input
              id="roster-filter"
              type="search"
              autocomplete="off"
              placeholder="Search by name"
              .value=${this.filter}
              @input=${this.updateFilter}
            />
            <input type="hidden" name="personId" .value=${this.selectedPersonId} />
            <div class="roster" role="listbox" aria-label="Unclaimed roster profiles">
              ${this.renderRoster()}
            </div>
            ${selected === undefined
              ? nothing
              : html`<span aria-live="polite">Selected: ${selected.displayName}</span>`}
          </fieldset>
          ${this.renderCredentials()}
          ${this.renderError()}
          <button class="submit" type="submit" ?disabled=${this.isSubmitting}>
            ${this.isSubmitting ? "Submitting…" : "Request profile access"}
          </button>
        </div>
      </form>
    `;
  }

  private renderSignupForm(): TemplateResult {
    return html`
      <form @submit=${this.submitSignup} novalidate>
        <h2 class="form-heading">Tell us about yourself</h2>
        <p class="form-note">
          Only the fields below are accepted. Access level and permissions are assigned by an
          administrator, never by this form.
        </p>
        <div class="fields">
          <label class="full">Name<input name="displayName" maxlength="160" required /></label>
          <label>Role or title<input name="role" maxlength="160" /></label>
          <label>Affiliation<input name="affiliation" maxlength="240" /></label>
          <label>Slack user ID<input name="slackUserId" maxlength="80" /></label>
          <label>Research branch<input name="researchBranch" maxlength="160" /></label>
          <label class="full">
            Research topics
            <input name="researchTopics" maxlength="1200" placeholder="privacy, systems" />
          </label>
          <label class="full">
            Projects
            <input name="projects" maxlength="1200" placeholder="project names, comma separated" />
          </label>
          <label>
            Hours per week
            <input name="hoursPerWeek" type="number" min="0" max="168" step="0.5" />
          </label>
          <label>Location<input name="location" maxlength="240" /></label>
          <label>Timezone<input name="timezone" maxlength="100" placeholder="Europe/London" /></label>
          <label>
            Personal website
            <input name="personalWebsite" type="url" maxlength="2048" />
          </label>
          <label class="full">
            Notes
            <textarea name="notes" maxlength="4000"></textarea>
          </label>
          ${this.renderCredentials()}
          ${this.renderError()}
          <button class="submit" type="submit" ?disabled=${this.isSubmitting}>
            ${this.isSubmitting ? "Submitting…" : "Submit application"}
          </button>
        </div>
      </form>
    `;
  }

  private renderCredentials(): TemplateResult {
    return html`
      <label class="full">
        Email
        <input name="email" type="email" maxlength="254" autocomplete="email" required />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          minlength="10"
          maxlength="1024"
          autocomplete="new-password"
          required
        />
      </label>
      <label>
        Confirm password
        <input
          name="passwordConfirmation"
          type="password"
          minlength="10"
          maxlength="1024"
          autocomplete="new-password"
          required
        />
      </label>
    `;
  }

  private renderRoster(): TemplateResult {
    if (this.rosterLoading) return html`<p class="roster-state">Loading roster…</p>`;
    if (this.rosterError) return html`<p class="roster-state">${this.rosterError}</p>`;
    const filter = this.filter.trim().toLowerCase();
    const people = this.roster.filter((person) =>
      person.displayName.toLowerCase().includes(filter),
    );
    if (people.length === 0) return html`<p class="roster-state">No matching profiles.</p>`;
    return html`${people.map(
      (person) => html`
        <button
          type="button"
          role="option"
          aria-selected=${person.personId === this.selectedPersonId}
          @click=${() => {
            this.selectedPersonId = person.personId;
            this.errorMessage = "";
          }}
        >
          ${person.displayName}
        </button>
      `,
    )}`;
  }

  private renderError(): TemplateResult | typeof nothing {
    return this.errorMessage
      ? html`<p class="error" role="alert">${this.errorMessage}</p>`
      : nothing;
  }

  private renderPending(): TemplateResult {
    return html`
      <div class="pending" role="status">
        <div class="pending-mark" aria-hidden="true">✓</div>
        <h2>Request received</h2>
        <p>
          An administrator will review it. No account session has been created yet; return to the
          sign-in page after your approval notice arrives.
        </p>
      </div>
    `;
  }

  private get isSubmitting(): boolean {
    return this.submissionState === "submitting";
  }

  private selectMode(mode: Mode): void {
    this.mode = mode;
    this.errorMessage = "";
  }

  private updateFilter(event: Event): void {
    this.filter = (event.currentTarget as HTMLInputElement).value;
  }

  private readonly submitClaim = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    await this.submit(() => this.client.submitClaim(claimInputFromForm(form)));
  };

  private readonly submitSignup = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    await this.submit(() => this.client.submitSignup(signupInputFromForm(form)));
  };

  private async submit(request: () => Promise<unknown>): Promise<void> {
    if (this.isSubmitting) return;
    this.errorMessage = "";
    try {
      this.submissionState = "submitting";
      await request();
      this.submissionState = "submitted";
    } catch (error) {
      this.submissionState = "idle";
      this.errorMessage = userFacingError(error);
    }
  }

  private async loadRoster(): Promise<void> {
    this.rosterLoading = true;
    this.rosterError = "";
    try {
      this.roster = await this.client.listClaimablePeople();
    } catch {
      this.rosterError = "The roster is unavailable. You can still apply as a new member.";
    } finally {
      this.rosterLoading = false;
    }
  }
}

function userFacingError(error: unknown): string {
  if (error instanceof BrowserFormError || error instanceof RegistrationApiError) {
    return error.message;
  }
  return "AdminBot could not submit the request. Try again.";
}
