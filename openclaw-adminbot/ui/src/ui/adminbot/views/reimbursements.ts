import { html, nothing } from "lit";
import type {
  AdminBotReimbursementArtifact,
  AdminBotReimbursementState,
} from "../controllers/admin.ts";

export type AdminBotReimbursementProps = {
  // Whether this view's transport can carry a submission right now: the gateway connection for the
  // signed-in path, and always true for the guest path, which posts straight to AdminBot over HTTP.
  canSubmit: boolean;
  state: AdminBotReimbursementState;
  onMessage: (message: string, receipts: File[]) => void;
  onGenerate: () => void;
  onReset: () => void;
};

function submitMessage(event: Event, props: AdminBotReimbursementProps): void {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const data = new FormData(form);
  const message = String(data.get("message") ?? "").trim();
  const input = form.elements.namedItem("receipts");
  const receipts = input instanceof HTMLInputElement ? [...(input.files ?? [])] : [];
  if (!message) return;
  props.onMessage(message, receipts);
  form.reset();
}

function downloadArtifact(artifact: AdminBotReimbursementArtifact): void {
  const binary = atob(artifact.data_base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: artifact.media_type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function field(draft: Record<string, unknown>, key: string): string {
  const value = draft[key];
  return typeof value === "string" && value.trim() ? value : "Not provided";
}

function renderDraft(state: AdminBotReimbursementState, onGenerate: () => void) {
  const expenses = Array.isArray(state.draft.expenses)
    ? state.draft.expenses.filter(
        (value): value is Record<string, unknown> => Boolean(value) && typeof value === "object",
      )
    : [];
  return html`
    <section class="adminbot-reimbursement-summary" aria-label="Reimbursement draft">
      <div class="adminbot-reimbursement-summary__header">
        <div>
          <div class="card-title">Form preview</div>
          <div class="card-sub">Details the assistant will place into both canonical forms.</div>
        </div>
        <span class="pill ${state.ready ? "adminbot-ready" : ""}">
          ${state.ready ? "Ready to generate" : `${state.missingFields.length} details needed`}
        </span>
      </div>
      <dl class="adminbot-reimbursement-fields">
        <div>
          <dt>Claimant</dt>
          <dd>${field(state.draft, "claimant_name")}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>${field(state.draft, "claimant_email")}</dd>
        </div>
        <div>
          <dt>Title</dt>
          <dd>${field(state.draft, "claimant_title")}</dd>
        </div>
        <div>
          <dt>Trip</dt>
          <dd>${field(state.draft, "trip_title")}</dd>
        </div>
        <div>
          <dt>Dates</dt>
          <dd>${field(state.draft, "trip_dates")}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>${field(state.draft, "trip_location")}</dd>
        </div>
        <div class="adminbot-reimbursement-fields__wide">
          <dt>Purpose</dt>
          <dd>${field(state.draft, "purpose")}</dd>
        </div>
      </dl>
      ${state.receiptNames.length
        ? html`<div class="adminbot-receipt-list">
            ${state.receiptNames.map((name) => html`<span>${name}</span>`)}
          </div>`
        : html`<div class="muted">No receipt PDFs analyzed yet.</div>`}
      <div class="adminbot-expense-table-wrap">
        <table class="adminbot-expense-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Category</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            ${expenses.length
              ? expenses.map(
                  (expense) => html`<tr>
                    <td>${field(expense, "date")}</td>
                    <td>${field(expense, "description")}</td>
                    <td>${field(expense, "category")}</td>
                    <td>${String(expense.amount ?? "")} ${field(expense, "currency")}</td>
                  </tr>`,
                )
              : html`<tr>
                  <td colspan="4" class="muted">Receipt expenses will appear here.</td>
                </tr>`}
          </tbody>
        </table>
      </div>
      <div class="adminbot-form__actions">
        <button
          class="btn btn--sm primary"
          type="button"
          ?disabled=${!state.ready || state.busy}
          @click=${onGenerate}
        >
          ${state.busy ? "Working..." : "Generate both forms"}
        </button>
      </div>
      ${state.artifacts.length
        ? html`<div class="adminbot-reimbursement-downloads">
            ${state.artifacts.map(
              (artifact) => html`<button
                class="btn btn--sm"
                type="button"
                @click=${() => downloadArtifact(artifact)}
              >
                Download ${artifact.filename}
              </button>`,
            )}
          </div>`
        : nothing}
    </section>
  `;
}

/**
 * The assistant drafts both forms from an LLM reading of the receipts, so the numbers and the
 * business-purpose wording are a starting point, not an audit-ready filing. This block states what
 * the claimant still owes Finance before sending anything, and it renders above the workspace on
 * every path into this tab (signed-in, guest, and public shell).
 */
function renderComplianceWarning() {
  return html`
    <section class="callout warning adminbot-reimbursement-warning" role="note">
      <div class="adminbot-reimbursement-warning__title">
        Read this before trusting the generated forms
      </div>
      <p class="adminbot-reimbursement-warning__lede">
        Both forms are drafted for you by the LLM assistant in the box on this page: it reads your
        receipts and fills the forms in. It can misread an amount, a date, or a category, and it
        cannot know anything the receipts do not say &mdash; so treat what it produces as a first
        draft, and check every line against the receipts yourself. The steps below are on you, not
        on the assistant.
      </p>
      <ol class="adminbot-reimbursement-warning__list">
        <li>
          Make a copy of <strong>DCS Expense Form.xlsx</strong> and the
          <strong>Trip Summary Form</strong>. Fill out the highlighted section of the DCS Expense
          Form, and every section of the Trip Summary Form, as shown by the example above &mdash;
          with itemized expenses in each category, including the description / clear business
          purpose of the expense <strong>and</strong> the amount claimed for each one.
        </li>
        <li>
          Include descriptions of pick-up and drop-off locations for Taxi / Rideshare / Public
          Transport trips.
        </li>
        <li>
          Include names of all attendees (first and last) if claiming a hospitality expense (a meal
          paid for the research group). The most senior person at the meal must be the one paying
          &mdash; e.g. if Zhijing is present at a research group lunch meeting, Zhijing pays for the
          meal.
        </li>
        <li>
          If you combine personal travel with business travel, you need to provide airfare
          comparisons from the same time you booked your flight, showing the pricing of the business
          leg of your trip only. In general, connect with Gizelda to get compliant supporting
          documentation.
          <strong
            >Without audit-compliant documentation, there is a risk of being unable to reimburse the
            expenses.</strong
          >
        </li>
        <li>
          Email
          <a href="mailto:gizelda.pereira@utoronto.ca">gizelda.pereira@utoronto.ca</a>
          with the two files above and the receipts, and provide any other information she needs.
        </li>
      </ol>
    </section>
  `;
}

export function renderAdminBotReimbursements(props: AdminBotReimbursementProps) {
  const messages = props.state.messages.length
    ? props.state.messages
    : [
        {
          role: "assistant" as const,
          content:
            "Upload your receipt PDFs and describe the trip. I’ll extract the expenses and ask for anything the two forms still require.",
        },
      ];
  return html`
    ${renderComplianceWarning()}
    <div class="adminbot-reimbursement-workspace">
      <section class="adminbot-reimbursement-chat" aria-label="Reimbursement assistant">
        <div class="adminbot-reimbursement-chat__heading">
          <div>
            <div class="card-title">Reimbursement assistant</div>
            <div class="card-sub">Receipt and personal data stays on the local AdminBot model.</div>
          </div>
          <button
            class="btn btn--sm adminbot-reimbursement-chat__reset"
            type="button"
            ?disabled=${props.state.busy}
            @click=${props.onReset}
          >
            Start over
          </button>
        </div>
        <div class="adminbot-reimbursement-messages" role="log" aria-live="polite">
          ${messages.map(
            (message) => html` <div
              class="adminbot-reimbursement-message adminbot-reimbursement-message--${message.role}"
            >
              <span>${message.role === "assistant" ? "AdminBot" : "You"}</span>
              <p>${message.content}</p>
            </div>`,
          )}
        </div>
        ${props.state.error
          ? html`<div class="callout danger">${props.state.error}</div>`
          : nothing}
        <form
          class="adminbot-reimbursement-composer"
          @submit=${(event: Event) => submitMessage(event, props)}
        >
          <label class="adminbot-receipt-drop">
            <span>Receipts</span>
            <input
              name="receipts"
              type="file"
              accept="application/pdf,.pdf,image/png,.png,image/jpeg,.jpg,.jpeg"
              multiple
            />
            <small>Up to 12 PDFs or photos, 12 MB each. Add files with your first message.</small>
          </label>
          <label class="adminbot-form__field">
            <span>Trip details or answer</span>
            <textarea
              name="message"
              rows="4"
              required
              placeholder="Example: I traveled to Montreal for the lab workshop from July 8–10..."
              ?disabled=${props.state.busy}
            ></textarea>
          </label>
          <button
            class="btn btn--sm primary"
            type="submit"
            ?disabled=${props.state.busy || !props.canSubmit}
          >
            ${props.state.busy ? "Analyzing..." : "Send to assistant"}
          </button>
        </form>
      </section>
      ${renderDraft(props.state, props.onGenerate)}
    </div>
  `;
}
