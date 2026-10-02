// Control UI view for the Mailing List tab: the lab's publications in a date range, mailed out.
//
// Sits beside the Grant Report on Lab Overview and answers a narrower version of the same
// question. The grant report is the lab's standing written for a funder to read; this is one list
// of papers for one range, sent to one address -- the thing somebody asks for when a newsletter,
// a department page or an annual report needs "what came out this year".
//
// Two ways to compose, chosen with one select. By date range is the default and answers "what came
// out this year". By venue answers the question the range cannot -- "the papers we got into ICLR
// 2027" -- and it selects on the recorded acceptance, not on where a paper is aimed, so the dates
// stop mattering and the picker says how many of each a venue has before anything is previewed.
//
// The screen is arranged around one risk: sending a short list and believing it is the whole
// truth. The lab's records carry almost no acceptance data, so the digest is dated from arXiv ids
// and a paper without one has no date at all. The preview therefore shows what is *excluded* as
// prominently as what is included, and the send is deliberately a second, separate click on a
// preview that is already on screen.
import { html, nothing, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import type { PublicationDigestPreview, PublicationDigestVenue } from "../auth/session.ts";

export type MailingListProps = {
  preview: PublicationDigestPreview | null;
  loading: boolean;
  sending: boolean;
  error: string | null;
  notice: string | null;
  from: string;
  to: string;
  email: string;
  /** The chosen venue's key, or "" for the date range. */
  venue: string;
  venues: PublicationDigestVenue[];
  onRangeChange: (range: { from: string; to: string }) => void;
  onVenueChange: (venue: string) => void;
  onEmailChange: (email: string) => void;
  onPreview: () => void;
  onSend: () => void;
};

class AdminbotMailingListView extends LitElement {
  @property({ attribute: false }) props!: MailingListProps;
  // Kept off the props so a keystroke in the recipient box does not re-request the preview; the
  // host owns the committed values and this owns what is being typed.
  @state() private draftEmail: string | null = null;

  override createRenderRoot() {
    return this;
  }

  private get email(): string {
    return this.draftEmail ?? this.props.email;
  }

  override render() {
    const { props } = this;
    const preview = props.preview;
    // The send is refused rather than disabled-with-no-reason: an address and a preview are both
    // required, and which one is missing is the thing worth saying.
    const sendable = Boolean(preview && this.email.includes("@") && !props.sending);
    return html`
      <section class="adminbot-panel">
        <div class="card-title">${t("mailingList.title")}</div>
        <p class="muted">${t("mailingList.sub")}</p>
        <!-- adminbot-form is what carries this tab's controls into the app's own input styling
             (height, border, focus ring, placeholder colour), and adminbot-form__field is what
             puts a label above its box. Written as bare labels around bare inputs, this row drew
             browser defaults beside the Announcements composer it sits two tabs away from. -->
        <div class="adminbot-form adminbot-mailing-list__controls">
          <label class="adminbot-form__field">
            <span>${t("mailingList.compose")}</span>
            <select
              .value=${props.venue}
              @change=${(event: Event) =>
                props.onVenueChange((event.target as HTMLSelectElement).value)}
              data-testid="mailing-list-venue"
            >
              <option value="">${t("mailingList.composeByRange")}</option>
              ${props.venues.map(
                (venue) => html`
                  <option value=${venue.key} ?selected=${venue.key === props.venue}>
                    ${t("mailingList.composeByVenue", {
                      venue: venue.label,
                      accepted: String(venue.accepted),
                      pending: String(venue.pending),
                    })}
                  </option>
                `,
              )}
            </select>
          </label>
          <label class="adminbot-form__field">
            <span>${t("mailingList.from")}</span>
            <input
              type="date"
              ?disabled=${Boolean(props.venue)}
              .value=${props.from}
              @change=${(event: Event) =>
                props.onRangeChange({
                  from: (event.target as HTMLInputElement).value,
                  to: props.to,
                })}
            />
          </label>
          <label class="adminbot-form__field">
            <span>${t("mailingList.to")}</span>
            <input
              type="date"
              ?disabled=${Boolean(props.venue)}
              .value=${props.to}
              @change=${(event: Event) =>
                props.onRangeChange({
                  from: props.from,
                  to: (event.target as HTMLInputElement).value,
                })}
            />
          </label>
          <label class="adminbot-form__field adminbot-mailing-list__email">
            <span>${t("mailingList.recipient")}</span>
            <input
              type="email"
              placeholder="someone@example.org"
              .value=${this.email}
              @input=${(event: Event) => {
                this.draftEmail = (event.target as HTMLInputElement).value;
                this.props.onEmailChange(this.draftEmail);
              }}
            />
          </label>
          <div class="adminbot-form__actions adminbot-mailing-list__preview-action">
            <button
              class="btn"
              type="button"
              ?disabled=${props.loading}
              @click=${() => props.onPreview()}
              data-testid="mailing-list-preview"
            >
              ${props.loading ? t("mailingList.previewing") : t("mailingList.preview")}
            </button>
          </div>
        </div>
        ${props.error
          ? html`<div class="adminbot-error" data-testid="mailing-list-error">${props.error}</div>`
          : nothing}
        ${props.notice
          ? html`<div class="adminbot-notice" data-testid="mailing-list-notice">
              ${props.notice}
            </div>`
          : nothing}
        ${preview ? this.renderPreview(preview, sendable) : this.renderEmpty()}
      </section>
    `;
  }

  private renderEmpty() {
    return html`<div class="adminbot-empty">${t("mailingList.empty")}</div>`;
  }

  private renderPreview(preview: PublicationDigestPreview, sendable: boolean) {
    // In venue mode the excluded list is the papers aimed at the venue with no decision recorded;
    // by date it is the papers nothing can date. Different reasons, one place on screen.
    const undated = preview.excluded.filter((entry) => entry.reason === "no_date");
    const notAccepted = preview.excluded.filter((entry) => entry.reason === "not_accepted");
    const venue = preview.venue;
    return html`
      <div class="adminbot-mailing-list__summary" data-testid="mailing-list-summary">
        ${venue
          ? t("mailingList.venueSummary", {
              count: String(preview.publications.length),
              venue,
            })
          : t("mailingList.summary", {
              count: String(preview.publications.length),
              from: preview.from,
              to: preview.to,
            })}
      </div>
      ${preview.publications.length === 0
        ? html`<div class="adminbot-empty adminbot-empty--compact">
            ${venue ? t("mailingList.noneAccepted", { venue }) : t("mailingList.noneInRange")}
          </div>`
        : html`<ol class="adminbot-mailing-list__papers">
            ${preview.publications.map(
              (entry) => html`
                <li>
                  <strong>${entry.title}</strong>
                  <small>${entry.authors.join(", ") || t("mailingList.noAuthors")}</small>
                  <small class="muted">
                    ${entry.date
                      ? entry.date.iso.slice(0, entry.date.precision === "year" ? 4 : 7)
                      : t("mailingList.noDate")}
                    ${entry.venue ? `— ${entry.venue}` : ""}
                    <!-- Where the date came from, because a year off accepted_year and a month off
                         an arXiv id are different strengths of claim. -->
                    ${entry.date
                      ? html`<span class="adminbot-tag"
                          >${t(`mailingList.source.${entry.date.source}`)}</span
                        >`
                      : nothing}
                  </small>
                </li>
              `,
            )}
          </ol>`}
      ${venue && notAccepted.length > 0
        ? html`
            <details class="adminbot-mailing-list__undated" data-testid="mailing-list-pending">
              <summary>
                ${t("mailingList.pending", { count: String(notAccepted.length), venue })}
              </summary>
              <p class="muted">${t("mailingList.pendingWhy", { venue })}</p>
              <ul>
                ${notAccepted.map((entry) => html`<li>${entry.title}</li>`)}
              </ul>
            </details>
          `
        : nothing}
      ${!venue && undated.length > 0
        ? html`
            <details class="adminbot-mailing-list__undated" data-testid="mailing-list-undated">
              <summary>${t("mailingList.undated", { count: String(undated.length) })}</summary>
              <p class="muted">${t("mailingList.undatedWhy")}</p>
              <ul>
                ${undated.map((entry) => html`<li>${entry.title}</li>`)}
              </ul>
            </details>
          `
        : nothing}
      <details class="adminbot-mailing-list__body">
        <summary>${t("mailingList.showEmail")}</summary>
        <pre>${preview.body}</pre>
      </details>
      <div class="adminbot-mailing-list__send">
        <button
          class="btn btn--primary"
          type="button"
          ?disabled=${!sendable}
          @click=${() => this.props.onSend()}
          data-testid="mailing-list-send"
        >
          ${this.props.sending
            ? t("mailingList.sending")
            : t("mailingList.send", { email: this.email || "—" })}
        </button>
      </div>
    `;
  }
}

if (!customElements.get("adminbot-mailing-list-view")) {
  customElements.define("adminbot-mailing-list-view", AdminbotMailingListView);
}

export function renderMailingList(props: MailingListProps) {
  return html`<adminbot-mailing-list-view .props=${props}></adminbot-mailing-list-view>`;
}
