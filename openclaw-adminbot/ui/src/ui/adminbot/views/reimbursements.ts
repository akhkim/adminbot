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
  /** Mail the generated package to that office, reply-to the claimant. */
  onSubmit: () => void;
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

const DRAFT_FIELDS: { key: string; label: string; wide?: boolean }[] = [
  { key: "claimant_name", label: "Claimant" },
  { key: "claimant_email", label: "Email" },
  { key: "claimant_title", label: "Title" },
  { key: "trip_title", label: "Trip" },
  { key: "trip_dates", label: "Dates" },
  { key: "trip_location", label: "Location" },
  { key: "purpose", label: "Purpose", wide: true },
];

function filled(draft: Record<string, unknown>, key: string): boolean {
  const value = draft[key];
  return typeof value === "string" && value.trim() !== "";
}

function draftExpenses(state: AdminBotReimbursementState): Record<string, unknown>[] {
  return Array.isArray(state.draft.expenses)
    ? state.draft.expenses.filter(
        (value): value is Record<string, unknown> => Boolean(value) && typeof value === "object",
      )
    : [];
}

/**
 * Whether there is anything to preview. Before the assistant has read a receipt the preview would
 * be seven "Not provided" rows and an empty table -- a form-shaped placeholder that says nothing --
 * so it waits until the first detail arrives.
 */
function hasDraftData(state: AdminBotReimbursementState): boolean {
  return (
    DRAFT_FIELDS.some(({ key }) => filled(state.draft, key)) ||
    draftExpenses(state).length > 0 ||
    state.receiptNames.length > 0 ||
    state.missingFields.length > 0 ||
    state.artifacts.length > 0 ||
    Boolean(state.check)
  );
}

function renderDraft(props: AdminBotReimbursementProps) {
  const state = props.state;
  const onGenerate = props.onGenerate;
  const expenses = draftExpenses(state);
  const fields = DRAFT_FIELDS.filter(({ key }) => filled(state.draft, key));
  return html`
    <section class="adminbot-reimbursement-summary" aria-label="Reimbursement draft">
      <div class="adminbot-reimbursement-summary__header">
        <div class="card-title">Form preview</div>
        <span class="pill ${state.ready ? "adminbot-ready" : ""}">
          ${state.ready
            ? "Ready to generate"
            : state.missingFields.length
              ? `${state.missingFields.length} details needed`
              : state.check
                ? "Review required"
                : "Awaiting trip details"}
        </span>
      </div>
      ${fields.length
        ? html`<dl class="adminbot-reimbursement-fields">
            ${fields.map(
              ({ key, label, wide }) =>
                html`<div class=${wide ? "adminbot-reimbursement-fields__wide" : ""}>
                  <dt>${label}</dt>
                  <dd>${field(state.draft, key)}</dd>
                </div>`,
            )}
          </dl>`
        : nothing}
      ${state.receiptNames.length
        ? html`<div class="adminbot-receipt-list">
            ${state.receiptNames.map((name) => html`<span>${name}</span>`)}
          </div>`
        : nothing}
      ${expenses.length
        ? html`<div class="adminbot-expense-table-wrap">
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
                ${expenses.map(
                  (expense) => html`<tr>
                    <td>${field(expense, "date")}</td>
                    <td>${field(expense, "description")}</td>
                    <td>${field(expense, "category")}</td>
                    <td>${String(expense.amount ?? "")} ${field(expense, "currency")}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : nothing}
      <div class="adminbot-form__actions">
        <button
          class="btn btn--sm primary"
          type="button"
          ?disabled=${!state.ready || state.busy}
          @click=${onGenerate}
        >
          ${state.busy
            ? "Working..."
            : state.funder === "MPI-IS"
              ? "Generate MPI form and signable copy"
              : "Generate both forms"}
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
      ${renderSubmit(props)}
    </section>
  `;
}

/**
 * The assistant drafts both forms from an LLM reading of the receipts, so the numbers and the
 * business-purpose wording are a starting point, not an audit-ready filing. This block states what
 * the claimant still owes Finance before sending anything, and it renders above the workspace on
 * every path into this tab (signed-in, guest, and public shell).
 */
function renderComplianceWarning(funder: AdminBotReimbursementFunder | undefined) {
  // Nothing before an institute is chosen: the picker is the only thing on the page then.
  if (!funder) {
    return nothing;
  }
  // The one line every claimant must read stays visible as the fold's summary; the office's own
  // list sits behind it, one click away, instead of a tinted block above the assistant.
  return html`
    <details class="adminbot-fold adminbot-reimbursement-warning" role="note">
      <summary>Forms are drafts: check every line against your receipts</summary>
      ${funder !== "DCS"
        ? html`<p class="adminbot-reimbursement-warning__lede">
            The assistant prepares the MPI IS travel reimbursement form and a signable copy. Check
            every amount, date and description, and review the MPI IS pre-submission report before
            sending the package to the MPI IS secretariat.
          </p>`
        : html`<p class="adminbot-reimbursement-warning__lede">
              The assistant can misread an amount, a date or a category. These steps are yours:
            </p>
            <ol class="adminbot-reimbursement-warning__list">
              <li>
                Fill the highlighted section of the <strong>DCS Expense Form</strong> and every
                section of the <strong>Trip Summary Form</strong>, itemized by category, with a
                clear business purpose and the amount for each expense.
              </li>
              <li>Give pick-up and drop-off locations for taxi, rideshare and transit trips.</li>
              <li>
                For hospitality, list every attendee's full name. The most senior person present
                pays &mdash; if Zhijing is at a group lunch, Zhijing pays.
              </li>
              <li>
                If personal travel is combined with business travel, include airfare comparisons
                from when you booked, priced for the business leg only. Ask Gizelda for compliant
                documentation.
                <strong
                  >Without audit-compliant documentation the expenses may not be reimbursed.</strong
                >
              </li>
              <li>
                Email
                <a href="mailto:gizelda.pereira@utoronto.ca">gizelda.pereira@utoronto.ca</a>
                both completed forms and the receipts.
              </li>
            </ol>`}
    </details>
  `;
}

/**
 * Send the package to the funder's office.
 *
 * Only once forms exist, which means only once every blocker cleared -- generation refuses
 * otherwise, so there is no state in which this button appears over an unchecked claim.
 *
 * Says where it is going and who it will come back to before it is pressed. This mails an external
 * finance office under the lab's name, and a send button that does not name its recipient is one
 * people press without knowing what they just did.
 */
function renderSubmit(props: AdminBotReimbursementProps) {
  const state = props.state;
  if (!state.artifacts.length || !state.funder) {
    return nothing;
  }
  if (state.submission) {
    return html`<p class="adminbot-reimbursement-sent" data-testid="reimbursement-sent">
      Sent to ${state.submission.to}. Replies go to ${state.submission.reply_to}.
    </p>`;
  }
  const office = state.funder === "MPI-IS" ? "the MPI IS secretariat" : "the DCS finance office";
  return html`
    <div class="adminbot-reimbursement-submit">
      <button
        class="btn btn--sm primary"
        type="button"
        ?disabled=${state.busy}
        data-testid="reimbursement-submit"
        @click=${props.onSubmit}
      >
        ${state.busy ? "Sending…" : `Email ${office}`}
      </button>
      <small class="muted">Sent from AdminBot with the forms attached; replies come to you.</small>
    </div>
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
            "Upload your receipt PDFs and describe the trip. I’ll extract the expenses and ask for anything your institute's forms still require.",
        },
      ];
  if (!props.state.funder) {
    return renderFunderPicker(props);
  }
  const preview = hasDraftData(props.state);
  return html`
    ${renderFunderPicker(props)} ${renderComplianceWarning(props.state.funder)}
    ${renderCheck(props.state.check ?? null)}
    <div
      class="adminbot-reimbursement-workspace ${preview
        ? ""
        : "adminbot-reimbursement-workspace--single"}"
    >
      <section class="adminbot-reimbursement-chat" aria-label="Reimbursement assistant">
        <div class="adminbot-reimbursement-chat__heading">
          <div class="card-title">Reimbursement assistant</div>
          ${props.state.messages.length
            ? html`<button
                class="btn btn--sm adminbot-reimbursement-chat__reset"
                type="button"
                ?disabled=${props.state.busy}
                @click=${props.onReset}
              >
                Start over
              </button>`
            : nothing}
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
            <small>Up to 12 PDFs or photos, 12 MB each.</small>
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
      ${preview ? renderDraft(props) : nothing}
    </div>
  `;
}
