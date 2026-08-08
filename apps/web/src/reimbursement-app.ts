import type {
  ReimbursementConversationMessage,
  ReimbursementDraft,
  ReimbursementPacketArtifact,
  GovernedActionProjection,
} from "@adminbot/api-contracts";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import {
  encodeReceipt,
  ReimbursementApiClient,
  type ReimbursementClient,
} from "./reimbursement-api-client.js";

export class AdminBotReimbursementApp extends LitElement {
  static override properties = {
    draft: { state: true }, messages: { state: true }, missingFields: { state: true },
    receiptNames: { state: true }, selectedFiles: { state: true }, busy: { state: true },
    errorMessage: { state: true }, warnings: { state: true },
    proposedAction: { state: true },
  };

  static override styles = css`
    :host { display: block; color: var(--text); } * { box-sizing: border-box; }
    h1 { margin: 0; color: var(--text-strong); font: 500 clamp(2rem, 5vw, 3.5rem)/1.05 Georgia, serif; }
    h2 { margin: 0 0 .75rem; color: var(--text-strong); font-size: 1rem; }
    button, textarea, input, select { font: inherit; }
    .eyebrow { margin: 0 0 .55rem; color: var(--accent); font-size: .65rem; font-weight: 780; letter-spacing: .14em; text-transform: uppercase; }
    .lede { max-width: 54rem; color: var(--text-muted); line-height: 1.65; }
    .privacy { display: grid; grid-template-columns: auto 1fr; gap: .7rem; margin: 1.25rem 0; border: 1px solid var(--border); border-radius: .8rem; padding: .85rem 1rem; background: var(--surface-2); }
    .privacy strong { color: var(--text-strong); } .privacy p { margin: .2rem 0 0; color: var(--text-muted); font-size: .76rem; line-height: 1.5; }
    .layout { display: grid; grid-template-columns: minmax(18rem, .8fr) minmax(25rem, 1.2fr); gap: 1rem; align-items: start; }
    .panel { border: 1px solid var(--border); border-radius: .85rem; padding: 1rem; background: var(--surface-2); }
    .messages { display: grid; gap: .55rem; max-height: 26rem; overflow: auto; margin-bottom: .8rem; }
    .message { max-width: 92%; border-radius: .7rem; padding: .65rem .75rem; line-height: 1.45; font-size: .78rem; white-space: pre-wrap; }
    .message.user { justify-self: end; background: var(--accent-soft); } .message.assistant { background: var(--surface-3); }
    .empty { color: var(--text-muted); font-size: .78rem; line-height: 1.55; }
    textarea { width: 100%; min-height: 6.5rem; resize: vertical; border: 1px solid var(--border-strong); border-radius: .65rem; padding: .7rem; color: var(--text-strong); background: var(--surface-1); }
    .file { display: block; margin: .65rem 0; border: 1px dashed var(--border-strong); border-radius: .65rem; padding: .7rem; color: var(--text-muted); font-size: .72rem; }
    input[type=file] { width: 100%; margin-top: .4rem; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    button { border: 1px solid var(--border-strong); border-radius: .6rem; padding: .58rem .75rem; color: var(--text); background: var(--surface-3); cursor: pointer; }
    button.primary { border-color: var(--accent); color: var(--accent-ink); background: var(--accent); font-weight: 750; }
    button:disabled { opacity: .5; cursor: wait; }
    .badge { border-radius: 999px; padding: .22rem .5rem; color: var(--text-muted); background: var(--surface-3); font-size: .65rem; }
    .badge.ready { color: var(--accent); background: var(--accent-soft); }
    .status { margin: .8rem 0; border-left: .2rem solid var(--danger); padding: .65rem .8rem; color: var(--danger); background: var(--surface-1); }
    .details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; }
    .field { min-width: 0; border-bottom: 1px solid var(--border); padding: .35rem 0 .55rem; }
    .field span { display: block; color: var(--text-muted); font-size: .61rem; letter-spacing: .06em; text-transform: uppercase; }
    .field strong { display: block; overflow-wrap: anywhere; margin-top: .2rem; color: var(--text-strong); font-size: .78rem; }
    .missing { color: var(--warning) !important; font-weight: 500; }
    .table-wrap { overflow-x: auto; margin: 1rem 0; } table { width: 100%; border-collapse: collapse; font-size: .72rem; }
    th, td { border-bottom: 1px solid var(--border); padding: .55rem .45rem; text-align: left; white-space: nowrap; }
    th { color: var(--text-muted); font-size: .61rem; letter-spacing: .05em; text-transform: uppercase; }
    .warning { margin: .6rem 0; color: var(--warning); font-size: .72rem; }
    .submission { margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 1rem; }
    .submission label { display: grid; gap: .3rem; margin: .65rem 0; color: var(--text-muted); font-size: .7rem; }
    .submission input[type=text] { border: 1px solid var(--border-strong); border-radius: .55rem; padding: .55rem; color: var(--text-strong); background: var(--surface-1); }
    .success { border-left: .2rem solid var(--accent); padding: .65rem .8rem; color: var(--text-strong); background: var(--accent-soft); font-size: .74rem; }
    .receipts { margin: .5rem 0; color: var(--text-muted); font-size: .68rem; }
    @media (max-width: 880px) { .layout { grid-template-columns: 1fr; } }
    @media (max-width: 520px) { .details { grid-template-columns: 1fr; } }
  `;

  client: ReimbursementClient = new ReimbursementApiClient(
    import.meta.env.VITE_ADMINBOT_API_ORIGIN || window.location.origin,
  );
  declare private draft: ReimbursementDraft;
  declare private messages: ReimbursementConversationMessage[];
  declare private missingFields: string[];
  declare private receiptNames: string[];
  declare private selectedFiles: File[];
  declare private busy: boolean;
  declare private errorMessage: string;
  declare private warnings: string[];
  declare private proposedAction: GovernedActionProjection | undefined;

  constructor() {
    super();
    this.draft = { expenses: [] }; this.messages = []; this.missingFields = [];
    this.receiptNames = []; this.selectedFiles = []; this.busy = false;
    this.errorMessage = ""; this.warnings = [];
    this.proposedAction = undefined;
  }

  override render(): TemplateResult {
    const ready = this.missingFields.length === 0 && this.draft.expenses.length > 0;
    return html`
      <header><p class="eyebrow">Public utility · local processing</p><h1>Reimbursement assistant</h1>
        <p class="lede">Turn receipts and trip details into the institution’s expense and trip-summary forms. You review every extracted fact before downloading anything.</p></header>
      <aside class="privacy"><span aria-hidden="true">LOCAL</span><div><strong>Private by construction</strong><p>Receipt bytes are sent only to the loopback AdminBot service, processed by its local model, and discarded after each request. They are not stored in the AdminBot database. Generating forms does not submit a claim.</p></div></aside>
      ${this.errorMessage ? html`<p class="status" role="alert">${this.errorMessage}</p>` : nothing}
      <div class="layout"><section class="panel"><h2>Conversation</h2>${this.renderMessages()}
        <form @submit=${this.sendMessage}><textarea name="message" maxlength="8000" required placeholder="Describe the trip, paste missing details, or explain the attached receipts."></textarea>
          <label class="file">Receipts · PDF, PNG, or JPEG · 12 MB each<input type="file" multiple accept="application/pdf,image/png,image/jpeg" @change=${this.chooseFiles}></label>
          ${this.selectedFiles.length ? html`<p class="receipts">Ready to upload: ${this.selectedFiles.map(({ name }) => name).join(", ")}</p>` : nothing}
          <div class="actions"><button class="primary" type="submit" ?disabled=${this.busy}>${this.busy ? "Processing locally…" : "Send"}</button><button type="button" ?disabled=${this.busy} @click=${this.reset}>Start over</button></div>
        </form></section>
        <section class="panel"><div class="actions"><h2>Packet preview</h2><span class=${`badge ${ready ? "ready" : ""}`}>${ready ? "Ready to generate" : "Needs information"}</span></div>
          ${this.renderDetails()}${this.renderExpenses()}
          ${this.missingFields.length ? html`<p class="warning">Still needed: ${this.missingFields.map(friendly).join(", ")}.</p>` : nothing}
          ${this.warnings.map((warning) => html`<p class="warning">${warning}</p>`)}
          ${this.receiptNames.length ? html`<p class="receipts">Processed this session: ${this.receiptNames.join(", ")}</p>` : nothing}
          <button class="primary" ?disabled=${!ready || this.busy} @click=${this.generatePacket}>Generate both forms</button>
          <section class="submission"><h2>Governed submission</h2>
            <p class="empty">Signed-in members can propose this exact reviewed claim. It is hash-bound, requires an eligible approver, and is never sent directly from this page.</p>
            ${this.proposedAction === undefined ? html`<form @submit=${this.proposeSubmission}>
              <label>Approved destination identifier<input name="destination" type="text" value="finance_office" maxlength="240" required></label>
              <label><span><input name="attested" type="checkbox" required> I attest that the reviewed claim and expense rows are accurate.</span></label>
              <button class="primary" type="submit" ?disabled=${!ready || this.busy}>Propose authenticated submission</button>
            </form>` : html`<p class="success" role="status">Proposal ${this.proposedAction.id} is ${this.proposedAction.state.replaceAll("_", " ")}. Payload hash: ${this.proposedAction.payloadHash}</p>`}
          </section>
        </section></div>`;
  }

  private renderMessages(): TemplateResult {
    return html`<div class="messages" aria-live="polite">${this.messages.length
      ? this.messages.map(({ role, content }) => html`<div class=${`message ${role}`}>${content}</div>`)
      : html`<p class="empty">Attach receipts and describe the claim. The assistant will extract only supported facts and ask for anything it cannot establish.</p>`}</div>`;
  }

  private renderDetails(): TemplateResult {
    const fields: ReadonlyArray<readonly [string, string | undefined]> = [
      ["Claimant", this.draft.claimantName], ["Email", this.draft.claimantEmail],
      ["Address", this.draft.claimantAddress], ["Title", this.draft.claimantTitle],
      ["Trip", this.draft.tripTitle], ["Dates", this.draft.tripDates],
      ["Location", this.draft.tripLocation], ["Purpose", this.draft.purpose],
      ["Currency", this.draft.currency === "OTHER" ? this.draft.otherCurrency : this.draft.currency],
    ];
    return html`<div class="details">${fields.map(([label, value]) => html`<div class="field"><span>${label}</span><strong class=${value ? "" : "missing"}>${value || "Not provided"}</strong></div>`)}</div>`;
  }

  private renderExpenses(): TemplateResult {
    if (this.draft.expenses.length === 0) return html`<p class="empty">No expense rows extracted yet.</p>`;
    return html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th>Source</th><th>Confidence</th></tr></thead><tbody>${this.draft.expenses.map((expense) => html`<tr><td>${expense.date ?? "—"}</td><td>${expense.description ?? "—"}</td><td>${expense.category ?? "—"}</td><td>${expense.amount === undefined ? "—" : `${expense.currency ?? ""} ${expense.amount.toFixed(2)}`}</td><td>${expense.sourceReceipt ?? expense.receiptNumber ?? "—"}</td><td>${expense.extractedConfidence === undefined ? "—" : `${Math.round(expense.extractedConfidence * 100)}%`}</td></tr>`)}</tbody></table></div>`;
  }

  private readonly chooseFiles = (event: Event): void => {
    this.selectedFiles = [...((event.target as HTMLInputElement).files ?? [])].slice(0, 12);
  };

  private readonly sendMessage = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault(); this.busy = true; this.errorMessage = ""; this.warnings = [];
    const form = event.currentTarget as HTMLFormElement;
    const message = String(new FormData(form).get("message") ?? "").trim();
    try {
      const receipts = await Promise.all(this.selectedFiles.map(encodeReceipt));
      const result = await this.client.converse({ message, messages: this.messages, draft: this.draft, ...(receipts.length ? { receipts } : {}) });
      const nextMessages: ReimbursementConversationMessage[] = [
        ...this.messages,
        { role: "user", content: message },
        { role: "assistant", content: result.assistantMessage },
      ];
      this.messages = nextMessages.slice(-20);
      this.draft = result.draft; this.missingFields = [...result.missingFields];
      this.receiptNames = [...new Set([...this.receiptNames, ...result.receiptNames])];
      this.selectedFiles = []; form.reset();
    } catch (error) { this.errorMessage = userError(error); } finally { this.busy = false; }
  };

  private readonly generatePacket = async (): Promise<void> => {
    this.busy = true; this.errorMessage = "";
    try {
      const packet = await this.client.generate({ packId: "waterloo_travel_v1", draft: this.draft });
      this.warnings = [...packet.warnings]; packet.artifacts.forEach(downloadArtifact);
    } catch (error) { this.errorMessage = userError(error); } finally { this.busy = false; }
  };

  private readonly proposeSubmission = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault(); this.busy = true; this.errorMessage = "";
    const data = new FormData(event.currentTarget as HTMLFormElement);
    try {
      this.proposedAction = await this.client.proposeSubmission({
        clientRequestId: crypto.randomUUID(), packId: "waterloo_travel_v1", draft: this.draft,
        destination: String(data.get("destination") ?? "").trim(), attestedAccurate: data.get("attested") === "on",
      });
    } catch (error) { this.errorMessage = userError(error); } finally { this.busy = false; }
  };

  private readonly reset = (): void => {
    this.draft = { expenses: [] }; this.messages = []; this.missingFields = [];
    this.receiptNames = []; this.selectedFiles = []; this.errorMessage = ""; this.warnings = [];
    this.proposedAction = undefined;
  };
}

function downloadArtifact(artifact: ReimbursementPacketArtifact): void {
  const binary = atob(artifact.dataBase64); const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: artifact.mediaType }));
  const link = document.createElement("a"); link.href = url; link.download = artifact.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function friendly(value: string): string { return value.replaceAll("_", " "); }
function userError(error: unknown): string { return error instanceof Error ? error.message : "Reimbursement request failed."; }
