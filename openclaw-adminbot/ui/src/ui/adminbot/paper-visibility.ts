// Browser-local paper visibility. This never modifies a shared paper or a coauthor's view.
import { LitElement, html } from "lit";
import { property, state } from "lit/decorators.js";
import { readHiddenPapers, writeHiddenPapers } from "./hidden-papers.ts";

// Checkboxes drawn at once. Past this the search narrows the list; "Select matching" still takes
// every match, drawn or not.
const PICKER_ROWS = 50;

export class PaperVisibility extends LitElement {
  @property({ attribute: false }) papers: { id: string; title: string }[] = [];
  @property({ attribute: false }) memberId: string | null = null;
  @state() private query = "";
  @state() private selected = new Set<string>();
  // The panel's contents are drawn only while it is open: a closed <details> still holds its
  // children, and fifteen hundred unseen checkboxes made every visit to My Work slow.
  @state() private open = false;
  override createRenderRoot() {
    return this;
  }
  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("memberId")) {
      this.selected = new Set();
      this.query = "";
    }
  }
  override render() {
    const matching = this.papers.filter((paper) =>
      paper.title.toLowerCase().includes(this.query.toLowerCase().trim()),
    );
    const selected = this.papers.filter((paper) => this.selected.has(paper.id));
    return html`<details
      class="paper-visibility"
      @toggle=${(event: Event) => {
        this.open = (event.currentTarget as HTMLDetailsElement).open;
      }}
    >
      <summary class="btn btn--sm">Hide papers…</summary>
      ${this.open ? this.renderPanel(matching, selected) : ""}
    </details>`;
  }

  private renderPanel(
    matching: { id: string; title: string }[],
    selected: { id: string; title: string }[],
  ) {
    return html`<div class="paper-visibility__panel">
      <p>
        Hide papers from your view in this browser. Coauthors still see them; you can restore them
        below.
      </p>
      <label
        >Find papers<input
          class="input"
          type="search"
          .value=${this.query}
          @input=${(event: Event) => {
            this.query = (event.target as HTMLInputElement).value;
          }}
      /></label>
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${!matching.length}
        @click=${() => {
          this.selected = new Set([...this.selected, ...matching.map((paper) => paper.id)]);
        }}
      >
        Select matching papers (${matching.length})
      </button>
      <button
        class="btn btn--sm"
        type="button"
        @click=${() => {
          this.selected = new Set();
        }}
      >
        Clear selection
      </button>
      <div class="paper-visibility__list">
        ${matching.slice(0, PICKER_ROWS).map(
          (paper) => html`<label
            ><input
              type="checkbox"
              .checked=${this.selected.has(paper.id)}
              @change=${(event: Event) => {
                const next = new Set(this.selected);
                (event.target as HTMLInputElement).checked
                  ? next.add(paper.id)
                  : next.delete(paper.id);
                this.selected = next;
              }}
            />${paper.title}</label
          >`,
        )}
        ${!matching.length ? html`<p>No matching papers.</p>` : ""}
        ${matching.length > PICKER_ROWS
          ? html`<p>${matching.length - PICKER_ROWS} more. Type above to narrow the list.</p>`
          : ""}
      </div>
      <button
        type="button"
        class="btn primary"
        ?disabled=${!selected.length}
        @click=${() => {
          writeHiddenPapers(
            this.memberId,
            new Set([...readHiddenPapers(this.memberId), ...selected.map((paper) => paper.id)]),
          );
          this.selected = new Set();
          this.dispatchEvent(new CustomEvent("visibility-changed", { bubbles: true }));
        }}
      >
        Hide selected (${selected.length})
      </button>
    </div>`;
  }
}

if (!customElements.get("adminbot-paper-visibility")) {
  customElements.define("adminbot-paper-visibility", PaperVisibility);
}
