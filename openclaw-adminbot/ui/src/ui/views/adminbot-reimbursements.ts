import { html, nothing } from "lit";
import type {
  AdminBotReimbursementArtifact,
  AdminBotReimbursementState,
} from "../controllers/adminbot.ts";

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
    <div class="adminbot-reimbursement-workspace">
      <section class="adminbot-reimbursement-chat" aria-label="Reimbursement assistant">
        <div class="adminbot-reimbursement-chat__heading">
          <div>
            <div class="card-title">Reimbursement assistant</div>
            <div class="card-sub">Receipt and personal data stays on the local AdminBot model.</div>
          </div>
          <button
            class="btn btn--sm"
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
