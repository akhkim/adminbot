import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { adminBotFeedbackCommentMax } from "../../../../../extensions/adminbot/src/contracts/feedback.ts";
import { submitFeedback } from "../api/workspace.ts";
import { loadStoredMemberSession } from "../auth/session.ts";

const setupGuide =
  "https://github.com/akhkim/adminbot/blob/adminbot-cli-pilot-v2/openclaw-adminbot/extensions/adminbot/cli/README.md";

export class CliPilotNotice extends LitElement {
  @property({ attribute: false }) baseUrl = "";
  @state() private saving = false;
  @state() private status = "";

  private async sendFeedback(event: SubmitEvent) {
    event.preventDefault();
    if (this.saving) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const session = loadStoredMemberSession();
    if (!session) {
      this.status = "Sign in again to submit feedback.";
      return;
    }
    this.saving = true;
    this.status = "";
    try {
      const result = await submitFeedback(
        {
          featureId: "adminbot-cli",
          rating: Number(data.get("rating")),
          comment: String(data.get("comment") ?? "").trim(),
        },
        session.sessionToken,
        this.baseUrl,
      );
      this.status = result.ok
        ? "Your CLI feedback was saved."
        : "Could not save your feedback. Try again.";
    } catch {
      this.status = "Could not save your feedback. Try again.";
    } finally {
      this.saving = false;
    }
  }

  static styles = css`
    :host {
      display: block;
    }
    section {
      border-inline-start: 3px solid var(--accent);
      padding: 4px 0 4px 16px;
    }
    h3,
    p {
      margin: 0 0 8px;
    }
    h3 {
      font-size: 1rem;
    }
    a,
    summary {
      color: var(--accent);
    }
    summary {
      cursor: pointer;
      width: fit-content;
    }
    details {
      margin-top: 10px;
    }
    form {
      display: grid;
      gap: 10px;
      justify-items: start;
      padding-top: 10px;
    }
    label {
      display: grid;
      gap: 4px;
      max-width: 100%;
    }
    select,
    textarea,
    button {
      font: inherit;
      color: inherit;
      background: var(--bg);
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      padding: 6px 10px;
    }
    textarea {
      box-sizing: border-box;
      width: min(26rem, 100%);
    }
    button {
      cursor: pointer;
    }
  `;

  override render() {
    return html`<section aria-labelledby="cli-pilot-heading">
      <h3 id="cli-pilot-heading">You can now use the AdminBot CLI.</h3>
      <p>
        Set it up to update your projects, post weekly notes and manage requests with your existing
        permissions.
      </p>
      <a href=${setupGuide} target="_blank" rel="noopener noreferrer">Setup guide</a>
      <details>
        <summary>CLI feedback</summary>
        <form @submit=${this.sendFeedback}>
          <label
            >Rating (1–5)
            <select name="rating" required>
              <option value="">Choose a rating</option>
              ${[1, 2, 3, 4, 5].map((n) => html`<option value=${n}>${n}</option>`)}
            </select>
          </label>
          <label
            >Comment (optional)<textarea
              name="comment"
              rows="3"
              maxlength=${adminBotFeedbackCommentMax}
            ></textarea>
          </label>
          <button type="submit" ?disabled=${this.saving}>
            ${this.saving ? "Saving…" : "Send feedback"}
          </button>
          <span role="status">${this.status || nothing}</span>
        </form>
      </details>
    </section>`;
  }
}

if (!customElements.get("adminbot-cli-pilot"))
  customElements.define("adminbot-cli-pilot", CliPilotNotice);
