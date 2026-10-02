// One-at-a-time card deck for a branch's checklist fields.
//
// A three-up grid buried each field under the others; a deck gives the active field the whole
// branch width and pages through the rest with arrows. Light DOM on purpose: the slotted cards
// are styled by the global stylesheet, not a shadow root.

import { html, LitElement, nothing } from "lit";
import type { TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../../icons.ts";

export class AdminBotPaperSlotDeck extends LitElement {
  /** Rendered slot cards, in deck order. */
  @property() items: TemplateResult[] = [];

  @state() private index = 0;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private go(delta: number): void {
    const count = this.items.length;
    if (!count) {
      return;
    }
    // Wrap around: next past the last card lands on the first, and vice versa.
    this.index = (this.index + delta + count) % count;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    // Filters can shrink the deck; never let the index point past the last card.
    if (changed.has("items") && this.index > this.items.length - 1) {
      this.index = Math.max(0, this.items.length - 1);
    }
  }

  protected override render(): unknown {
    if (this.items.length === 0) {
      return nothing;
    }
    const many = this.items.length > 1;
    return html`
      <div class="paper-slot-deck">
        ${many
          ? html`
              <div class="paper-slot-deck__bar">
                <span class="paper-slot-deck__count" aria-live="polite">
                  ${this.index + 1} / ${this.items.length}
                </span>
                <button
                  type="button"
                  class="paper-slot-deck__arrow paper-slot-deck__arrow--prev"
                  aria-label="Previous field"
                  @click=${() => this.go(-1)}
                >
                  ${icons.chevronRight}
                </button>
                <button
                  type="button"
                  class="paper-slot-deck__arrow"
                  aria-label="Next field"
                  @click=${() => this.go(1)}
                >
                  ${icons.chevronRight}
                </button>
              </div>
            `
          : nothing}
        <div class="paper-slot-deck__track">
          ${this.items.map(
            (item, i) =>
              html`<div class="paper-slot-deck__item" ?hidden=${i !== this.index}>${item}</div>`,
          )}
        </div>
      </div>
    `;
  }
}

// Registered by hand and guarded, like every other element in this tree, rather than through
// lit's `@customElement`. The decorator defines unconditionally, so the second evaluation of this
// module throws `NotSupportedError: This name has already been registered` -- which under the
// jsdom test lane, where many specs share one process and the graph can be instantiated more than
// once, killed whichever *other* spec happened to import it first. That made the failure look like
// it belonged to paper-slots, paper-card-dialog or the dashboard depending on file order, which is
// three suites failing for a reason none of them owned.
if (!customElements.get("adminbot-paper-slot-deck")) {
  customElements.define("adminbot-paper-slot-deck", AdminBotPaperSlotDeck);
}

declare global {
  interface HTMLElementTagNameMap {
    "adminbot-paper-slot-deck": AdminBotPaperSlotDeck;
  }
}
