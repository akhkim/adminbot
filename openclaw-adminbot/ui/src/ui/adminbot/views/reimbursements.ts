import { html, nothing } from "lit";
import {
  ADMINBOT_FUNDER_LABELS,
  adminBotReimbursementFunders,
  type AdminBotReimbursementCheck,
  type AdminBotReimbursementFunder,
} from "../../../../../extensions/adminbot/src/contracts/reimbursement-rules.js";
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
  /** Which finance office is paying. Nothing is prepared until this is answered. */
  onFunderChange: (funder: AdminBotReimbursementFunder) => void;
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
          Fill out the highlighted section of the <strong>DCS Expense Form</strong>, and every
          section of the <strong>Trip Summary Form</strong>, as shown by the example above &mdash;
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
          with both completed forms and the receipts, and provide any other information she needs.
        </li>
      </ol>
    </section>
  `;
}

/**
 * Which finance office is paying, asked before anything else.
 *
 * First on the page and not defaulted, because R0.1 makes it a blocker in its own right and R0.2
 * says the two rulesets are not interchangeable -- they disagree on at least one requirement, so
 * picking the wrong one does not produce a nearly-right package, it produces the other office's
 * package. Locked once the conversation has started: switching funder mid-claim would re-check
 * the same evidence against a different ruleset without re-asking for what the new one needs.
 */
function renderFunderPicker(props: AdminBotReimbursementProps) {
  const chosen = props.state.funder;
  const started = props.state.messages.length > 0;
  return html`
    <section class="adminbot-reimbursement-funder" data-testid="reimbursement-funder">
      <div class="card-title">Where are you claiming from?</div>
      <div class="card-sub">
        The two institutes have different — and in places contradictory — requirements, so this
        decides which rules apply and which form is prepared.
      </div>
      <div class="adminbot-reimbursement-funder__options">
        ${adminBotReimbursementFunders.map(
          (funder) => html`
            <label
              class=${`adminbot-reimbursement-funder__option ${
                chosen === funder ? "adminbot-reimbursement-funder__option--on" : ""
              }`}
            >
              <input
                type="radio"
                name="reimbursement-funder"
                value=${funder}
                ?checked=${chosen === funder}
                ?disabled=${started}
                data-testid=${`reimbursement-funder-${funder}`}
                @change=${() => props.onFunderChange(funder)}
              />
              <span>
                <strong>${funder === "DCS" ? "UofT" : "MPI IS"}</strong>
                <small>${ADMINBOT_FUNDER_LABELS[funder]}</small>
              </span>
            </label>
          `,
        )}
      </div>
      ${started
        ? html`<p class="adminbot-reimbursement-funder__locked">
            Start over to change institute — the rules and the questions differ.
          </p>`
        : nothing}
    </section>
  `;
}

/**
 * The pre-submission report: what would come back, and what to supply.
 *
 * Rendered whenever a check exists, passing or failing. A check that only appeared on failure
 * would leave a claimant unable to tell "cleared" from "not run", and the cleared case is the one
 * carrying the warnings worth fixing first.
 */
function renderCheck(check: AdminBotReimbursementCheck | null) {
  if (!check?.funder) {
    return nothing;
  }
  const blocked = check.verdict !== "ready_to_submit";
  return html`
    <section
      class=${`adminbot-reimbursement-check ${
        blocked ? "adminbot-reimbursement-check--blocked" : "adminbot-reimbursement-check--ready"
      }`}
      data-testid="reimbursement-check"
    >
      <div class="card-title">
        ${blocked ? "Do not submit" : "Ready to submit"}
        <span class="adminbot-reimbursement-check__funder"
          >${check.funder === "DCS" ? "UofT DCS" : "MPI IS"}</span
        >
      </div>
      ${blocked
        ? html`<p class="adminbot-reimbursement-check__lead">
            No forms were generated. ${check.blockers.length} blocker(s) must be cleared first.
          </p>`
        : nothing}
      ${check.blockers.length
        ? html`<ul class="adminbot-reimbursement-check__list" data-testid="reimbursement-blockers">
            ${check.blockers.map(
              (finding) => html`
                <li>
                  <span class="adminbot-reimbursement-check__id">${finding.rule_id}</span>
                  <strong>${finding.title}</strong>
                  <span>${finding.detail}</span>
                  <small>${finding.remedy}</small>
                  ${finding.unrecoverable
                    ? html`<em class="adminbot-reimbursement-check__unrecoverable"
                        >Cannot be produced after the fact — decide whether to submit a weakened
                        claim or drop the line.</em
                      >`
                    : nothing}
                </li>
              `,
            )}
          </ul>`
        : nothing}
      ${check.warnings.length
        ? html`<ul
            class="adminbot-reimbursement-check__list adminbot-reimbursement-check__list--warn"
            data-testid="reimbursement-warnings"
          >
            ${check.warnings.map(
              (finding) => html`
                <li>
                  <span class="adminbot-reimbursement-check__id">${finding.rule_id}</span>
                  <strong>${finding.title}</strong>
                  <span>${finding.detail}</span>
                  <small>${finding.remedy}</small>
                </li>
              `,
            )}
          </ul>`
        : nothing}
      ${check.amounts_checked.length
        ? html`<p class="adminbot-reimbursement-check__amounts">
            Amounts checked:
            ${check.amounts_checked
              .map(
                (amount) =>
                  `${amount.label} — ${amount.reconciled ? "reconciled" : `not reconciled${amount.note ? ` (${amount.note})` : ""}`}`,
              )
              .join(" · ")}
          </p>`
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
    ${renderComplianceWarning()} ${renderFunderPicker(props)}
    ${renderCheck(props.state.check ?? null)}
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
