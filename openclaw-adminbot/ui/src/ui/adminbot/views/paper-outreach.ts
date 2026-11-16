import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { t } from "../../../i18n/index.ts";
import type {
  AcceptanceSheetSync,
  PaperAcceptanceRow,
  PaperOutreach,
  PaperOutreachDraft,
} from "../api/paper-admin.ts";
// The research-outreach section of the Mailing List tab.
//
// The digest above it is one list for one address. This is the same acceptances told many ways:
// each institute newsletter, the department record, the social-media managers, each with its own
// wording and its own rule about which papers it wants. One row per outlet, folded, grouped by the
// moment it is due (on acceptance, at camera-ready, right before the conference).
//
// Two things a draft can be, and the row says which. A draft that is complete and has recipients
// on the service can be sent from here. A draft that still needs a sentence only a person can
// write -- a summary, a pitch -- can only be copied, so nothing with a placeholder in it is ever
// mailed. Recipients are shown, never typed: they come from the service's configuration.
//
// Some outlets want a sentence about each paper. Those sentences are typed once, in the list above
// the outlets, saved on the paper, and reused by every draft that asks for one -- so finishing a
// draft is filling in a box here, not editing the same placeholder in three copied emails.
//
// Under the outlets sits the acceptance tab of the lab's spreadsheet. People keep that tab, so the
// write is two presses: compare first, and add only the rows the comparison named.

export type PaperOutreachProps = {
  data: PaperOutreach | null;
  loading: boolean;
  busy: string | null;
  error: string | null;
  notice: string | null;
  sent: string[];
  sheet: AcceptanceSheetSync | null;
  onSend: (outlet: string) => void;
  onSaveSummary: (paperId: string, summary: string) => void;
  onCheckSheet: () => void;
  onAddToSheet: () => void;
};

const STAGES: ReadonlyArray<PaperOutreachDraft["stage"]> = [
  "acceptance",
  "camera_ready",
  "pre_conference",
];

function copy(text: string): void {
  void globalThis.navigator?.clipboard?.writeText?.(text);
}

/** Tab-separated, header first: what a spreadsheet accepts as a paste. */
export function acceptanceRowsAsTsv(rows: readonly PaperAcceptanceRow[]): string {
  const clean = (cell: string) => cell.replaceAll(/[\t\n\r]+/gu, " ");
  return [
    ["year", "paper title", "conference", "authors", "paper_link"],
    ...rows.map((row) => [row.year, row.title, row.conference, row.authors, row.paper_link]),
  ]
    .map((cells) => cells.map(clean).join("\t"))
    .join("\n");
}

function draftState(draft: PaperOutreachDraft, sent: boolean): string {
  if (sent) {
    return t("mailingList.outreach.state.sent");
  }
  if (draft.paper_ids.length === 0) {
    return t("mailingList.outreach.state.none");
  }
  if (draft.channel === "form") {
    return t("mailingList.outreach.state.form");
  }
  if (draft.needs_edit) {
    return t("mailingList.outreach.state.needsEdit");
  }
  return draft.sendable
    ? t("mailingList.outreach.state.ready")
    : t("mailingList.outreach.state.copyOnly");
}

function renderDraft(draft: PaperOutreachDraft, props: PaperOutreachProps): TemplateResult {
  const sent = props.sent.includes(draft.key);
  const sending = props.busy === draft.key;
  return html`
    <details class="adminbot-outreach__outlet" data-testid="outreach-outlet-${draft.key}">
      <summary>
        <span class="adminbot-outreach__name">${draft.institute} — ${draft.label}</span>
        <small class="muted">
          ${draft.paper_ids.length === 1
            ? t("mailingList.outreach.onePaper")
            : t("mailingList.outreach.papers", { count: String(draft.paper_ids.length) })}
          · ${draftState(draft, sent)}
        </small>
      </summary>
      <p class="muted">${draft.cadence}</p>
      ${draft.channel === "email"
        ? html`<p class="adminbot-outreach__recipients">
            ${draft.to.length > 0
              ? t("mailingList.outreach.to", { recipients: draft.to.join(", ") })
              : t("mailingList.outreach.noRecipients")}
            ${draft.cc.length > 0
              ? html`<span class="muted"
                  >${t("mailingList.outreach.cc", { recipients: draft.cc.join(", ") })}</span
                >`
              : nothing}
          </p>`
        : nothing}
      ${draft.notes.length > 0
        ? html`<ul class="adminbot-outreach__notes">
            ${draft.notes.map((note) => html`<li>${note}</li>`)}
          </ul>`
        : nothing}
      ${draft.paper_ids.length > 0
        ? html`
            <div class="adminbot-mailing-list__body">
              <strong>${draft.subject}</strong>
              <pre>${draft.body}</pre>
            </div>
            <div class="adminbot-outreach__actions">
              <button
                class="btn btn--sm"
                type="button"
                @click=${() => copy(`${draft.subject}\n\n${draft.body}`)}
                data-testid="outreach-copy-${draft.key}"
              >
                ${t("mailingList.outreach.copy")}
              </button>
              ${draft.form_url
                ? html`<a
                    class="btn btn--sm"
                    href=${draft.form_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    >${t("mailingList.outreach.openForm")}</a
                  >`
                : nothing}
              ${draft.sendable
                ? html`<button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${props.busy !== null}
                    @click=${() => props.onSend(draft.key)}
                    data-testid="outreach-send-${draft.key}"
                  >
                    ${sending
                      ? t("mailingList.sending")
                      : sent
                        ? t("mailingList.outreach.sendAgain")
                        : t("mailingList.outreach.send")}
                  </button>`
                : nothing}
            </div>
          `
        : nothing}
    </details>
  `;
}

function renderSummaries(data: PaperOutreach, props: PaperOutreachProps): TemplateResult {
  const missing = data.papers.filter((paper) => !paper.summary).length;
  return html`
    <h3 class="adminbot-outreach__heading">${t("mailingList.outreach.summaries.title")}</h3>
    <p class="muted" data-testid="outreach-summaries-state">
      ${missing === 0
        ? t("mailingList.outreach.summaries.done")
        : t("mailingList.outreach.summaries.sub", { count: String(missing) })}
    </p>
    <ul class="adminbot-form adminbot-outreach__summaries">
      ${data.papers.map(
        (paper) => html`
          <li>
            <label class="adminbot-form__field">
              <span>${paper.title}</span>
              <input
                type="text"
                maxlength="400"
                placeholder=${t("mailingList.outreach.summaries.placeholder")}
                .value=${live(paper.summary)}
                @change=${(event: Event) =>
                  props.onSaveSummary(paper.id, (event.target as HTMLInputElement).value)}
                data-testid="outreach-summary-${paper.id}"
              />
            </label>
          </li>
        `,
      )}
    </ul>
  `;
}

function renderSheet(props: PaperOutreachProps, data: PaperOutreach): TemplateResult {
  const rows = data.acceptance_rows;
  const check = props.sheet;
  const working = props.busy === "sheet";
  return html`
    <h3 class="adminbot-outreach__heading">${t("mailingList.outreach.sheet.title")}</h3>
    <p class="muted">
      ${data.acceptance_sheet_configured
        ? t("mailingList.outreach.sheet.sub")
        : t("mailingList.outreach.sheet.unconfigured")}
    </p>
    <details class="adminbot-outreach__outlet" data-testid="outreach-sheet-rows">
      <summary>${t("mailingList.outreach.sheet.rows", { count: String(rows.length) })}</summary>
      <ul class="adminbot-outreach__notes">
        ${rows.map((row) => html`<li>${row.year} · ${row.conference} · ${row.title}</li>`)}
      </ul>
    </details>
    ${check
      ? html`<p data-testid="outreach-sheet-result">
          ${check.missing.length === 0
            ? t("mailingList.outreach.sheet.upToDate", { count: String(check.total) })
            : t("mailingList.outreach.sheet.missing", {
                count: String(check.missing.length),
                titles: check.missing.map((row) => row.title).join("; "),
              })}
        </p>`
      : nothing}
    <div class="adminbot-outreach__actions">
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${rows.length === 0}
        @click=${() => copy(acceptanceRowsAsTsv(rows))}
      >
        ${t("mailingList.outreach.sheet.copy")}
      </button>
      ${data.acceptance_sheet_configured
        ? check && check.missing.length > 0
          ? html`<button
              class="btn btn--sm"
              type="button"
              ?disabled=${props.busy !== null}
              @click=${() => props.onAddToSheet()}
              data-testid="outreach-sheet-add"
            >
              ${working
                ? t("mailingList.outreach.sheet.working")
                : t("mailingList.outreach.sheet.add", { count: String(check.missing.length) })}
            </button>`
          : html`<button
              class="btn btn--sm"
              type="button"
              ?disabled=${props.busy !== null || rows.length === 0}
              @click=${() => props.onCheckSheet()}
              data-testid="outreach-sheet-check"
            >
              ${working
                ? t("mailingList.outreach.sheet.working")
                : t("mailingList.outreach.sheet.check")}
            </button>`
        : nothing}
    </div>
  `;
}

export function renderPaperOutreach(props: PaperOutreachProps): TemplateResult | typeof nothing {
  const { data } = props;
  if (!data && !props.loading && !props.error) {
    return nothing;
  }
  return html`
    <section class="adminbot-panel adminbot-outreach" data-testid="outreach">
      <div class="card-title">${t("mailingList.outreach.title")}</div>
      <p class="muted">
        ${data?.venue
          ? t("mailingList.outreach.sub", {
              venue: data.venue,
              count: String(data.paper_count),
            })
          : t("mailingList.outreach.chooseVenue")}
      </p>
      ${props.loading ? html`<p class="muted">${t("mailingList.previewing")}</p>` : nothing}
      ${props.error
        ? html`<div class="adminbot-error" data-testid="outreach-error">${props.error}</div>`
        : nothing}
      ${props.notice
        ? html`<div class="adminbot-notice" data-testid="outreach-notice">${props.notice}</div>`
        : nothing}
      ${data?.config_error
        ? html`<div class="adminbot-error" data-testid="outreach-config-error">
            ${t("mailingList.outreach.configError", { reason: data.config_error })}
          </div>`
        : nothing}
      ${data?.venue && data.papers.length > 0 ? renderSummaries(data, props) : nothing}
      ${data?.venue
        ? STAGES.map((stage) => {
            const drafts = data.drafts.filter((draft) => draft.stage === stage);
            return drafts.length === 0
              ? nothing
              : html`
                  <h3 class="adminbot-outreach__heading">
                    ${t(`mailingList.outreach.stage.${stage}`)}
                  </h3>
                  ${drafts.map((draft) => renderDraft(draft, props))}
                `;
          })
        : nothing}
      ${data ? renderSheet(props, data) : nothing}
    </section>
  `;
}
