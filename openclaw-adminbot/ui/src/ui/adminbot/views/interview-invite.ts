import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { loadSettings } from "../../storage.ts";
import {
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  type LabMember,
} from "../auth/session.ts";

/** Confirming files a proposal; approval owns every external effect. */
export class InterviewInvite extends LitElement {
  @property({ attribute: false }) members: LabMember[] = [];
  @state() private busy = false;
  @state() private notice = "";
  @state() private preview: {
    subject: string;
    body: string;
    email?: string;
    cc?: string[];
  } | null = null;
  private reviewed = "";
  private draftRevision = 0;
  @state() private choices: LabMember[] = [];
  @state() private first = "";
  @state() private second = "";
  private searchRevision = 0;
  private async search() {
    const session = loadStoredMemberSession();
    if (!session) {
      return;
    }
    const revision = ++this.searchRevision;
    const query =
      this.shadowRoot?.querySelector<HTMLInputElement>("#interviewer-search")?.value || "";
    try {
      const response = await fetch(
        `${resolveAdminBotBaseUrl(loadSettings())}/onboarding/interviewers?q=${encodeURIComponent(query)}`,
        { headers: { Authorization: `Bearer ${session.sessionToken}` } },
      );
      const result = await response.json();
      if (
        revision !== this.searchRevision ||
        loadStoredMemberSession()?.sessionToken !== session.sessionToken
      ) {
        return;
      }
      if (!response.ok) {
        throw new Error(result.error?.message || "Could not load interviewers.");
      }
      this.choices = [
        ...this.choices.filter((member) =>
          [this.first, this.second].includes(member.slack_user_id || ""),
        ),
        ...result.members,
      ];
    } catch (error) {
      if (
        revision === this.searchRevision &&
        loadStoredMemberSession()?.sessionToken === session.sessionToken
      ) {
        this.notice = error instanceof Error ? error.message : "Could not load interviewers.";
      }
    }
  }
  static styles = css`
    :host {
      display: block;
      margin-bottom: 20px;
    }
    details {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      background: var(--card);
    }
    summary {
      font-weight: 600;
      cursor: pointer;
      padding: 4px;
    }
    form,
    label {
      display: grid;
      gap: 12px;
    }
    form {
      margin-top: 16px;
    }
    label {
      gap: 6px;
    }
    input,
    textarea,
    select,
    button {
      font: inherit;
      color: inherit;
      box-sizing: border-box;
    }
    input,
    textarea,
    select {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      width: 100%;
    }
    textarea {
      min-height: 180px;
      resize: vertical;
    }
    .pair {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    button {
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      cursor: pointer;
      min-height: 44px;
    }
    .primary {
      background: var(--accent);
      color: var(--accent-foreground, white);
    }
    button:disabled {
      opacity: 0.6;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: inherit;
    }
    p {
      color: var(--muted);
      margin: 0;
    }
    @media (max-width: 500px) {
      .pair {
        grid-template-columns: 1fr;
      }
      details {
        padding: 12px;
      }
    }
  `;
  private async submit(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (!form.reportValidity()) {
      return;
    }
    const data = new FormData(form);
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === "string" ? value : "";
    };
    const payload = {
      name: field("name"),
      email: field("email"),
      interview: {
        project: field("project"),
        task: field("task"),
        interviewer_ids: [field("first"), field("second")],
      },
    };
    const queue = (event.submitter as HTMLButtonElement)?.value === "queue";
    const fingerprint = JSON.stringify(payload);
    const revision = this.draftRevision;
    if (queue && fingerprint !== this.reviewed) {
      this.notice = "Review the updated email before submitting.";
      this.preview = null;
      return;
    }
    const session = loadStoredMemberSession();
    if (!session) {
      this.notice = "Sign in to propose an interview invitation.";
      return;
    }
    this.busy = true;
    this.notice = "";
    try {
      const response = await fetch(
        `${resolveAdminBotBaseUrl(loadSettings())}/onboarding/interview-invitation`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.sessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...payload, preview: !queue }),
        },
      );
      const result = await response.json();
      if (
        !this.isConnected ||
        revision !== this.draftRevision ||
        loadStoredMemberSession()?.sessionToken !== session.sessionToken
      ) {
        return;
      }
      if (!response.ok) {
        throw new Error(result.error?.message || "Could not prepare the invitation.");
      }
      if (queue) {
        this.notice = `Queued for admin approval (${result.id}). Nothing has been sent yet.`;
        this.preview = null;
        this.reviewed = "";
      } else {
        this.preview = result;
        this.reviewed = fingerprint;
      }
    } catch (error) {
      this.notice = error instanceof Error ? error.message : "Could not prepare the invitation.";
    } finally {
      this.busy = false;
    }
  }
  render() {
    const options = [
      ...new Map(
        [...this.members, ...this.choices].map((member) => [member.slack_user_id, member]),
      ).values(),
    ].filter(
      (member) =>
        member.slack_user_id && ["member", "admin"].includes(member.privilege_level || ""),
    );
    return html`<details
      @toggle=${(event: Event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) {
          void this.search();
        }
      }}
    >
      <summary>Invite an interviewee</summary>
      <form
        @submit=${(event: SubmitEvent) => this.submit(event)}
        @input=${() => {
          this.preview = null;
          this.reviewed = "";
          this.draftRevision++;
        }}
      >
        <p>
          Enter the candidate and task, then choose two interviewers. An admin approves the email
          and private Slack invitation in Pending Actions.
        </p>
        <div class="pair">
          <label
            >Candidate name *<input
              name="name"
              required
              maxlength="200"
              autocomplete="name" /></label
          ><label
            >Candidate email *<input
              name="email"
              type="email"
              required
              maxlength="254"
              autocomplete="email"
          /></label>
        </div>
        <label>Project *<input name="project" required maxlength="200" /></label
        ><label
          >Interview task *<textarea
            name="task"
            required
            maxlength="12000"
            placeholder="Describe the task, expected deliverables, and evaluation."
          ></textarea>
        </label>
        <label
          >Find interviewers<input
            id="interviewer-search"
            type="search"
            placeholder="Search lab members by name"
        /></label>
        <button type="button" @click=${() => this.search()}>Find interviewers</button>
        <div class="pair">
          ${["first", "second"].map(
            (key, index) =>
              html`<label
                >Interviewer ${index + 1} *<select
                  name=${key}
                  required
                  .value=${key === "first" ? this.first : this.second}
                  @change=${(event: Event) => {
                    const value = (event.target as HTMLSelectElement).value;
                    if (key === "first") {
                      this.first = value;
                    } else {
                      this.second = value;
                    }
                  }}
                >
                  <option value="">Choose a lab member</option>
                  ${options.map(
                    (member) =>
                      html`<option value=${member.slack_user_id!}>${member.name}</option>`,
                  )}
                </select></label
              >`,
          )}
        </div>
        <button type="submit" value="preview" ?disabled=${this.busy}>
          ${this.busy ? "Preparing…" : "Preview email"}
        </button>
        ${this.preview
          ? html`<section aria-label="Email preview">
                <strong>${this.preview.subject}</strong>
                <p>
                  To: ${this.preview.email || "candidate"}<br />CC:
                  ${(this.preview.cc || []).join(", ")}
                </p>
                <pre>${this.preview.body}</pre>
                <p>
                  The private Slack channel is created after approval for the candidate, the two
                  interviewers, and AdminBot.
                </p>
              </section>
              <button class="primary" type="submit" value="queue" ?disabled=${this.busy}>
                Submit for admin approval
              </button>`
          : nothing}
        ${this.notice ? html`<div role="status">${this.notice}</div>` : nothing}
      </form>
    </details>`;
  }
}

if (!customElements.get("adminbot-interview-invite")) {
  customElements.define("adminbot-interview-invite", InterviewInvite);
}
