// A compact, self-contained 1-5 star rating widget for collecting experience feedback on a single
// AdminBot function. It floats in the bottom-right corner of the tab as a small pill; clicking it
// opens a roomy panel with the stars and an optional comment. The vote persists per-feature in
// localStorage so a member's choice survives reloads and tab switches, and re-rating updates
// (never duplicates) their entry.
//
// The "i" button links to the source file for the function being rated, so a member who wants the
// function improved can open it on GitHub and file their own PR.
//
// Frontend-only for now: the vote is not yet sent anywhere. Every submission dispatches a
// `feedback` CustomEvent with `{ featureId, rating, comment, githubFile }` so the write path can be
// attached later without touching this component.
import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { I18nController, t } from "../../i18n/index.ts";

type StoredFeedback = {
  rating: number;
  comment: string;
  // Set only once the member clicks Send. Distinct from merely having a rating stored, so reopening
  // a previously rated tab does not hide the send button before an actual submission.
  submitted?: boolean;
  // Set once the member clicks Send: the whole widget is dismissed (and stays gone) for this feature.
  dismissed?: boolean;
};

const STORAGE_PREFIX = "openclaw:feedback:v2:";
const COMMENT_MAX = 280;
const STAR_COUNT = 5;

function storageKey(featureId: string): string {
  return `${STORAGE_PREFIX}${featureId}`;
}

function loadFeedback(featureId: string): StoredFeedback | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(storageKey(featureId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredFeedback>;
    const rating = Number(parsed?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > STAR_COUNT) {
      return null;
    }
    return {
      rating,
      comment: typeof parsed.comment === "string" ? parsed.comment : "",
      submitted: parsed?.submitted === true,
      dismissed: parsed?.dismissed === true,
    };
  } catch {
    return null;
  }
}

function saveFeedback(featureId: string, vote: StoredFeedback): void {
  try {
    getSafeLocalStorage()?.setItem(storageKey(featureId), JSON.stringify(vote));
  } catch {
    // Storage may be unavailable (private mode, disabled); the widget still works for the session.
  }
}

const starIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path
    d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
    fill="currentColor"
    stroke="currentColor"
    stroke-width="1"
    stroke-linejoin="round"
  />
</svg>`;

const closeIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
  <path d="m6 6 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
</svg>`;

export class AdminbotFeedbackWidget extends LitElement {
  readonly i18nController = new I18nController(this);

  // The stable surface id this widget rates, e.g. "my-work" or "reimbursements".
  @property({ attribute: "feature-id" }) featureId = "";

  // Full GitHub URL of the source file for the rated function. Renders the "i" button; omitted
  // and the button is hidden.
  @property({ attribute: "github-file" }) githubFile = "";

  // Optional title shown in the open panel. Defaults to the localized prompt.
  @property() label = "";

  // True while the rating panel is open. Collapsed by default: a fresh mount after a tab switch
  // shows the pill again, and the persisted vote comes back when the panel reopens.
  private open = false;

  // 1-5, or null before the member rates.
  private rating: number | null = null;
  // 1-5 while the pointer is over the stars, 0 otherwise. Drives the hover preview that lights up
  // every star up to the one hovered, without committing a rating.
  private hoverRating = 0;
  private commentDraft = "";
  private submitted = false;
  // Once true (set on Send) the widget renders nothing for this feature; the vote is already saved.
  private dismissed = false;

  override connectedCallback() {
    super.connectedCallback();
    if (this.featureId) {
      this.restore();
    }
  }

  // The element is reused across tab navigation (same template position), so a changed feature id
  // must reload its vote instead of showing the previous feature's, and the open panel must collapse
  // back to the pill so navigating to a new tab never leaves the previous tab's widget expanded.
  override attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    super.attributeChangedCallback(name, oldValue, newValue);
    if (name === "feature-id" && oldValue !== newValue) {
      this.open = false;
      this.hoverRating = 0;
      this.restore();
    }
  }

  private restore() {
    const stored = loadFeedback(this.featureId);
    this.rating = stored?.rating ?? null;
    this.submitted = stored?.submitted ?? false;
    this.dismissed = stored?.dismissed ?? false;
    this.commentDraft = stored?.comment ?? "";
  }

  private openPanel() {
    this.open = true;
    this.requestUpdate();
  }

  private closePanel() {
    this.open = false;
    this.hoverRating = 0;
    this.requestUpdate();
  }

  private rate(value: number) {
    this.rating = value;
    this.hoverRating = 0;
    this.persistAndEmit();
    this.requestUpdate();
  }

  private hover(value: number) {
    this.hoverRating = value;
    this.requestUpdate();
  }

  private clearHover() {
    this.hoverRating = 0;
    this.requestUpdate();
  }

  private confirmComment() {
    this.commentDraft = this.commentDraft.trim();
    this.submitted = true;
    this.dismissed = true;
    this.persistAndEmit();
    this.requestUpdate();
  }

  private submit() {
    if (this.rating === null) {
      return;
    }
    this.confirmComment();
  }

  private persistAndEmit() {
    if (this.rating === null) {
      return;
    }
    const comment = this.submitted ? this.commentDraft : "";
    saveFeedback(this.featureId, {
      rating: this.rating,
      comment,
      submitted: this.submitted,
      dismissed: this.dismissed,
    });
    this.dispatchEvent(
      new CustomEvent("feedback", {
        bubbles: true,
        composed: true,
        detail: {
          featureId: this.featureId,
          rating: this.rating,
          comment,
          githubFile: this.githubFile,
        },
      }),
    );
  }

  static override styles = css`
    :host {
      position: fixed;
      right: var(--space-4, 16px);
      bottom: var(--space-4, 16px);
      z-index: 30;
      display: block;
      color: var(--text);
      font-family: inherit;
    }

    /* Collapsed pill: the whole thing is a single clickable affordance that opens the panel. */
    .fb__open {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      padding: 10px 18px;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      background: color-mix(in srgb, var(--bg) 82%, var(--accent) 12%);
      color: var(--text-strong);
      font-size: var(--control-ui-text-sm);
      font-weight: 600;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
      transition:
        border-color 120ms ease,
        transform 120ms ease,
        box-shadow 120ms ease;
    }

    .fb__open:hover {
      border-color: var(--accent);
      transform: translateY(-1px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    .fb__open-icon {
      display: inline-flex;
      color: #fbbf24;
    }

    .fb__open-icon svg {
      width: 18px;
      height: 18px;
    }

    .fb__open-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--ok, var(--accent));
    }

    /* Open panel: roomy, one clear job at a time. */
    .fb {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      width: min(400px, calc(100vw - var(--space-8)));
      box-sizing: border-box;
      padding: var(--space-5);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      background: var(--bg);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    }

    .fb__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }

    .fb__head-actions {
      display: flex;
      align-items: center;
      gap: var(--space-4);
    }

    .fb__title {
      margin: 0;
      font-size: var(--control-ui-text-md);
      font-weight: 600;
      color: var(--text-strong);
    }

    .fb__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      flex: none;
      padding: 0;
      border: 1px solid var(--border-strong);
      border-radius: 50%;
      background: transparent;
      color: var(--muted-strong);
      cursor: pointer;
      transition:
        border-color 120ms ease,
        color 120ms ease;
    }

    .fb__close:hover {
      border-color: var(--accent);
      color: var(--text-strong);
    }

    .fb__close svg {
      width: 14px;
      height: 14px;
    }

    .fb__row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .fb__stars {
      display: inline-flex;
      gap: 4px;
    }

    .fb__star {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px;
      border: none;
      background: transparent;
      color: var(--muted-strong);
      cursor: pointer;
      transition: color 120ms ease;
    }

    .fb__star svg {
      width: 22px;
      height: 22px;
    }

    .fb__star:hover,
    .fb__star--on {
      color: #fbbf24;
    }

    .fb__info {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      flex: none;
      border: 1px solid var(--border-strong);
      border-radius: 50%;
      background: transparent;
      color: var(--muted-strong);
      font-size: 14px;
      font-style: italic;
      font-weight: 700;
      line-height: 1;
      text-decoration: none;
      cursor: pointer;
      transition:
        border-color 120ms ease,
        color 120ms ease;
    }

    .fb__info:hover {
      border-color: var(--accent);
      color: var(--text-strong);
    }

    .fb__form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: var(--space-2);
    }

    .fb__input {
      grid-column: 1 / -1;
      grid-row: 1;
      width: 100%;
      min-width: 0;
      min-height: 96px;
      box-sizing: border-box;
      resize: vertical;
      padding: var(--space-3);
      border: 1px solid var(--input);
      border-radius: var(--radius-sm);
      background: var(--bg);
      color: var(--text);
      font-family: inherit;
      font-size: var(--control-ui-text-sm);
      line-height: 1.5;
      outline: none;
    }

    .fb__input:focus-visible {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--focus);
    }

    .fb__send {
      grid-column: 2;
      grid-row: 2;
      justify-self: end;
      align-self: center;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 5rem;
      min-height: 1.8rem;
      padding: 0 14px;
      background: #c5c5c5;
      border: 1px solid #e4e4e7;
      border-radius: var(--radius-lg);
      color: #06080d;
      font-family: inherit;
      font-size: var(--control-ui-text-md);
      font-weight: 500;
      letter-spacing: var(--tracking-tight);
      line-height: 1;
      cursor: pointer;
      transition:
        background 120ms ease,
        border-color 120ms ease,
        color 120ms ease;
    }

    .fb__send:hover:not(:disabled) {
      background: #f4f4f5;
      border-color: #d4d4d8;
    }

    .fb__send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .fb__count {
      grid-column: 1;
      grid-row: 2;
      justify-self: start;
      align-self: center;
      color: var(--muted);
      font-size: var(--control-ui-text-xs);
    }
  `;

  override render() {
    if (this.dismissed) {
      return nothing;
    }

    if (!this.open) {
      return html`
        <button
          type="button"
          class="fb__open"
          aria-expanded="false"
          aria-label=${this.label || t("feedback.openLabel")}
          @click=${this.openPanel}
        >
          <span class="fb__open-icon">${starIcon}</span>
          <span>${this.label || t("feedback.openLabel")}</span>
          ${this.rating !== null ? html`<span class="fb__open-dot" aria-hidden="true"></span>` : ""}
        </button>
      `;
    }

    const title = this.label || t("feedback.prompt");
    // The comment box and submit button stay visible whether or not a star is picked yet, so the
    // member never lands on a panel that looks empty. The submit button unlocks once a rating is
    // chosen; re-submitting updates the saved entry.
    const lit = this.hoverRating > 0 ? this.hoverRating : (this.rating ?? 0);
    const stars = Array.from({ length: STAR_COUNT }, (_, index) => index + 1);
    return html`
      <div class="fb" role="group" aria-label=${this.featureId}>
        <div class="fb__head">
          <h3 class="fb__title">${title}</h3>
          <div class="fb__head-actions">
            ${this.githubFile
              ? html`
                  <a
                    class="fb__info"
                    href=${this.githubFile}
                    target="_blank"
                    rel="noopener noreferrer"
                    title=${t("feedback.infoTitle")}
                    aria-label=${t("feedback.infoTitle")}
                  >
                    i
                  </a>
                `
              : ""}
            <button
              type="button"
              class="fb__close"
              title=${t("feedback.close")}
              aria-label=${t("feedback.close")}
              @click=${this.closePanel}
            >
              ${closeIcon}
            </button>
          </div>
        </div>
        <div class="fb__row">
          <span class="fb__stars" @mouseleave=${this.clearHover}>
            ${stars.map(
              (value) => html`
                <button
                  type="button"
                  class="fb__star ${value <= lit ? "fb__star--on" : ""}"
                  title=${t("feedback.starTitle", { rating: String(value) })}
                  aria-label=${t("feedback.starTitle", { rating: String(value) })}
                  aria-pressed=${String(this.rating === value)}
                  @mouseenter=${() => this.hover(value)}
                  @click=${() => this.rate(value)}
                >
                  ${starIcon}
                </button>
              `,
            )}
          </span>
        </div>
        <div class="fb__form">
          <textarea
            class="fb__input"
            placeholder=${t("feedback.commentPlaceholder")}
            maxlength=${COMMENT_MAX}
            rows="3"
            .value=${this.commentDraft}
            @input=${(event: Event) => {
              this.commentDraft = (event.target as HTMLTextAreaElement).value;
            }}
          ></textarea>
          <!-- Send dismisses the whole widget (see confirmComment): the vote is saved and render()
               returns nothing. The button itself is plain; dismissal happens on submit. -->
          <button
            type="button"
            class="fb__send"
            ?disabled=${this.rating === null}
            @click=${this.submit}
          >
            ${t("feedback.send")}
          </button>
          <span class="fb__count">
            ${t("feedback.countRemaining", { remaining: String(COMMENT_MAX - this.commentDraft.length) })}
          </span>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("adminbot-feedback-widget")) {
  customElements.define("adminbot-feedback-widget", AdminbotFeedbackWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    "adminbot-feedback-widget": AdminbotFeedbackWidget;
  }
}