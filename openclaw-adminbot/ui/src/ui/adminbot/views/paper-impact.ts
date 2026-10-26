// The impact statement on a paper card, and the PI's half of it in the review dialog.
//
// One status function, shared with the service, decides whether the statement is owed -- so the
// card can never call a statement optional that the approval step then refuses. The classifier's
// reasons are shown next to its answer because a label nobody can check is a label nobody trusts,
// and an uncertain answer is shown as an open question rather than rounded either way.
import { html, nothing } from "lit";
import {
  PAPER_IMPACT_SLOT,
  paperImpactFieldLabels,
  paperImpactFields,
  paperImpactRequiredFields,
  paperImpactStatus,
  parsePaperImpactStatement,
  type PaperImpactStatus,
  type PaperSafetyInput,
} from "../../../../../extensions/adminbot/src/contracts/paper-impact.js";
import type { PaperSlotsProps } from "./paper-slots.ts";

const STATE_LABELS: Record<PaperImpactStatus["state"], string> = {
  not_required: "Optional",
  unresolved: "Optional — classification unresolved",
  missing: "Required — missing",
  draft: "Required — draft",
  awaiting_review: "Awaiting PI review",
  reviewed: "Reviewed",
};

const SEPARATE =
  "Reviewing a statement does not approve publication or compute; those stay separate decisions.";

export function readPaperImpact(
  paper: PaperSafetyInput,
  slots: PaperSlotsProps["slots"],
): PaperImpactStatus {
  const row = slots.find((entry) => entry.slot === PAPER_IMPACT_SLOT);
  return paperImpactStatus(paper, parsePaperImpactStatement(row?.value_text));
}

/** Why the paper does or does not owe a statement, in the reader's terms. */
function renderVerdict(status: PaperImpactStatus) {
  const reasons = status.reasons.length > 0 ? ` (${status.reasons.join(", ")})` : "";
  if (status.source === "override" && status.override) {
    return html`<p class="muted" data-testid="paper-impact-verdict">
      Marked ${status.verdict === "related" ? "AI-safety related" : "not AI-safety related"} by
      ${status.override.by}${reasons}.
    </p>`;
  }
  const text =
    status.verdict === "related"
      ? `Looks AI-safety related${reasons}, so this statement is required before publication approval.`
      : status.verdict === "uncertain"
        ? `Possibly AI-safety related${reasons}. Optional until the PI or an admin decides.`
        : "Does not look AI-safety related, so this statement is optional.";
  return html`<p class="muted" data-testid="paper-impact-verdict">
    ${text} Matched on the paper's title, alias, venue, notes and author roles only.
  </p>`;
}

/** The author's form. Saves partial drafts; the service says what is still needed. */
export function renderPaperImpact(
  props: Pick<PaperSlotsProps, "slots" | "loading" | "onSaveSlot"> & { paper: PaperSafetyInput },
) {
  const status = readPaperImpact(props.paper, props.slots);
  const statement = status.statement;
  return html`<section class="card" data-testid="paper-impact">
    <details ?open=${status.required && status.state !== "reviewed"}>
      <summary>
        Impact statement
        <span class="pill" data-testid="paper-impact-state">${STATE_LABELS[status.state]}</span>
      </summary>
      ${renderVerdict(status)}
      ${statement?.reviewed
        ? html`<p role="status">Reviewed by the PI.</p>`
        : status.state === "awaiting_review"
          ? html`<p role="status">Waiting for the PI's review.</p>`
          : status.state === "draft"
            ? html`<p role="status" data-testid="paper-impact-missing">
                Still needed:
                ${status.missing.map((field) => paperImpactFieldLabels[field]).join(" ")}
              </p>`
            : nothing}
      ${statement?.review_note
        ? html`<p style="white-space: pre-wrap">${statement.review_note}</p>`
        : nothing}
      <form
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget as HTMLFormElement);
          const value = Object.fromEntries(
            paperImpactFields.map((field) => [field, String(data.get(field) ?? "").trim()]),
          );
          // Only the prompts go up. The review and any correction are carried over by the service,
          // so saving here can never undo them.
          props.onSaveSlot(PAPER_IMPACT_SLOT, { value_text: JSON.stringify(value) });
        }}
      >
        ${paperImpactFields.map(
          (field) =>
            html`<label
              >${paperImpactFieldLabels[field]}${paperImpactRequiredFields.includes(field)
                ? ""
                : " (optional)"}<textarea
                class="input"
                name=${field}
                maxlength="4000"
                .value=${statement?.[field] ?? ""}
                ?disabled=${props.loading}
              ></textarea>
            </label>`,
        )}
        <p class="muted">
          Write as much as the argument needs — about half a page is a guide, not a minimum. Drafts
          save. ${SEPARATE}
        </p>
        <button class="btn btn--primary" type="submit" ?disabled=${props.loading}>
          ${props.loading ? "Saving…" : "Save statement"}
        </button>
      </form>
    </details>
  </section>`;
}

/** The PI's card: read, mark reviewed with a note, or correct the classification. */
export function renderPaperImpactReview(params: {
  status: PaperImpactStatus;
  busy: boolean;
  onSave: (valueText: string) => void;
}) {
  const { status, busy } = params;
  if (status.state === "not_required" && !status.statement && !status.override) {
    return nothing;
  }
  const statement = status.statement ?? {};
  // Only the prompts and the one change being made: the stored review stamps are the service's to
  // carry, and resending them would re-stamp a review nobody just gave.
  const text = Object.fromEntries(
    paperImpactFields.map((field) => [field, statement[field] ?? ""]),
  );
  const correct = (verdict: "related" | "unrelated" | null) =>
    params.onSave(JSON.stringify({ ...text, safety: verdict ? { verdict } : null }));
  return html`<section class="card" data-testid="paper-impact-review">
    <h4>
      Impact statement
      ${status.state === "awaiting_review"
        ? html`<span class="pill">High priority</span>`
        : html`<span class="pill">${STATE_LABELS[status.state]}</span>`}
    </h4>
    ${renderVerdict(status)}
    ${paperImpactFields.map((field) =>
      statement[field]
        ? html`<p>
            <strong>${paperImpactFieldLabels[field]}</strong><br /><span
              style="white-space: pre-wrap"
              >${statement[field]}</span
            >
          </p>`
        : nothing,
    )}
    ${status.state === "awaiting_review"
      ? html`<form
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const note = new FormData(event.currentTarget as HTMLFormElement).get("note");
            params.onSave(
              JSON.stringify({
                ...text,
                reviewed: true,
                review_note: typeof note === "string" ? note : "",
              }),
            );
          }}
        >
          <label
            >Note to the authors (optional)<textarea
              class="input"
              name="note"
              maxlength="4000"
              ?disabled=${busy}
            ></textarea>
          </label>
          <p class="muted">${SEPARATE}</p>
          <button class="btn btn--primary" type="submit" ?disabled=${busy}>
            ${busy ? "Saving…" : "Mark impact statement reviewed"}
          </button>
        </form>`
      : status.state === "reviewed"
        ? html`<p role="status">Reviewed</p>
            ${statement.review_note
              ? html`<p style="white-space: pre-wrap">${statement.review_note}</p>`
              : nothing}`
        : nothing}
    <p>
      ${status.verdict === "related"
        ? html`<button
            class="btn btn--sm"
            type="button"
            ?disabled=${busy}
            @click=${() => correct("unrelated")}
          >
            Not AI-safety related
          </button>`
        : html`<button
            class="btn btn--sm"
            type="button"
            ?disabled=${busy}
            @click=${() => correct("related")}
          >
            Mark AI-safety related
          </button>`}
      ${status.override
        ? html`<button
            class="btn btn--sm"
            type="button"
            ?disabled=${busy}
            @click=${() => correct(null)}
          >
            Use the automatic classification
          </button>`
        : nothing}
    </p>
  </section>`;
}
