import { html, nothing } from "lit";

/** A filter that is set, drawn as a chip that clears it. */
export type FilterChip = {
  label: string;
  onClear: () => void;
};

/**
 * Filters on demand (ui/DESIGN.md rule 13).
 *
 * A list keeps its one search box in view; every other filter sits behind a "Filters" button that
 * opens a small panel. Once a filter is set it shows as a removable chip, so the reader can see
 * why the list is shorter than they expect without opening the panel again.
 */
export function renderFilterFold(params: {
  /** Prefix for test ids: `<testId>` on the fold, `<testId>-chips` on the chip row. */
  testId: string;
  /** The controls inside the panel: selects, checkbox groups. */
  controls: unknown;
  /** One per filter that is set to something other than its default. */
  chips: readonly FilterChip[];
}) {
  const { testId, controls, chips } = params;
  return html`
    <details class="ab-filters" data-testid=${testId}>
      <summary class="btn btn--sm ab-filters__toggle">
        Filters${chips.length ? html` <span class="ab-num">(${chips.length})</span>` : nothing}
      </summary>
      <div class="ab-filters__panel">${controls}</div>
    </details>
  `;
}

/** The set filters as removable chips. Renders nothing when none is set. */
export function renderFilterChips(testId: string, chips: readonly FilterChip[]) {
  if (chips.length === 0) {
    return nothing;
  }
  return html`
    <div class="ab-filters__chips" data-testid=${`${testId}-chips`}>
      ${chips.map(
        (chip) => html`<button
          type="button"
          class="chip ab-filters__chip"
          aria-label=${`Remove filter: ${chip.label}`}
          @click=${chip.onClear}
        >
          ${chip.label} <span aria-hidden="true">×</span>
        </button>`,
      )}
    </div>
  `;
}
