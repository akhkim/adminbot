// The multi-answer control (today: Role), shared by the admin roster editor and the member's own
// profile page so both surfaces ask the question the same way.
//
// It is a dropdown that opens a checkbox menu rather than a bare column of checkboxes. The
// checkboxes themselves are the reason: a `<select multiple>` needs ctrl-click to pick a second
// answer, which nobody recording "PhD Student" and "Lab Manager" would guess at. But eleven boxes
// spread down the page read as eleven separate questions and crowd out the fields either side of
// them, so the boxes live behind a summary line that names what is currently held.
//
// A plain `<details>`, and the menu stays in flow rather than floating: both of the forms that use
// this sit inside a scrolling card, and an absolutely positioned menu opened near the bottom of
// one would be clipped by that card's own overflow.
//
// Every checkbox keeps the field key as its `name`, so the forms read the answers back with
// `FormData.getAll(key)` exactly as they did when the boxes were bare.
import { html, type TemplateResult } from "lit";

export type MultiSelectOption = {
  value: string;
  /** Options the vocabulary no longer offers but the record still holds -- kept, and marked. */
  legacy?: boolean;
};

export type MultiSelectFieldConfig = {
  name: string;
  /** Accessible name for the group, and what the closed summary is describing. */
  label: string;
  /** Shown on the summary line when nothing is selected. */
  placeholder: string;
  options: readonly MultiSelectOption[];
  /** Lowercased set of the values currently held by the record. */
  selected: ReadonlySet<string>;
  /** Surface-specific classes, so each page keeps the look it already had. */
  rootClass: string;
  optionClass: string;
  legacyOptionClass?: string;
  testId?: string;
};

/**
 * The closed summary: the selected answers in the order the menu offers them, or the placeholder.
 *
 * Names rather than a count, because "PhD Student, Lab Manager" is the answer somebody came to
 * check and "2 selected" makes them open the menu to find out.
 */
export function multiSelectSummaryText(
  options: readonly MultiSelectOption[],
  selected: ReadonlySet<string>,
  placeholder: string,
): string {
  const held = options.filter((option) => selected.has(option.value.toLowerCase()));
  return held.length === 0 ? placeholder : held.map((option) => option.value).join(", ");
}

/**
 * Keep the closed summary honest while the menu is open.
 *
 * The forms around this control re-render on their own schedule (the roster editor autosaves; the
 * profile form does not redraw until it is saved), so the summary is refreshed from the DOM on
 * every change rather than waiting for a render that may not come.
 */
export function syncMultiSelectSummary(event: Event): void {
  const root = (event.currentTarget as HTMLElement | null)?.closest?.<HTMLElement>(
    "[data-multi-select]",
  );
  if (!root) {
    return;
  }
  const value = root.querySelector<HTMLElement>("[data-multi-select-value]");
  if (!value) {
    return;
  }
  const checked = [...root.querySelectorAll<HTMLInputElement>("input[type='checkbox']")]
    .filter((input) => input.checked)
    .map((input) => input.value);
  const placeholder = root.dataset.multiSelectPlaceholder ?? "";
  value.textContent = checked.length === 0 ? placeholder : checked.join(", ");
}

export function renderMultiSelectField(config: MultiSelectFieldConfig): TemplateResult {
  const summary = multiSelectSummaryText(config.options, config.selected, config.placeholder);
  return html`
    <details
      class=${`adminbot-multiselect ${config.rootClass}`}
      data-multi-select
      data-multi-select-placeholder=${config.placeholder}
      data-testid=${config.testId ?? config.name}
      @change=${syncMultiSelectSummary}
    >
      <summary class="adminbot-multiselect__summary" aria-label=${config.label}>
        <span class="adminbot-multiselect__value" data-multi-select-value>${summary}</span>
        <span class="adminbot-multiselect__caret" aria-hidden="true"></span>
      </summary>
      <div class="adminbot-multiselect__menu" role="group" aria-label=${config.label}>
        ${config.options.map(
          (option) => html`
            <label
              class=${option.legacy && config.legacyOptionClass
                ? `${config.optionClass} ${config.legacyOptionClass}`
                : config.optionClass}
            >
              <input
                type="checkbox"
                name=${config.name}
                value=${option.value}
                .checked=${config.selected.has(option.value.toLowerCase())}
              />
              <span>${option.value}</span>
            </label>
          `,
        )}
      </div>
    </details>
  `;
}

/**
 * The vocabulary the menu offers, followed by anything the record holds that it does not cover.
 *
 * An imported answer with no box of its own ("PhD Mentee / MSc") would vanish the first time the
 * form was saved, so it gets a box, checked, and is written back untouched unless the person
 * editing clears it themselves.
 */
export function multiSelectOptionsFor(
  vocabulary: readonly string[],
  held: readonly string[],
): MultiSelectOption[] {
  const extra = held.filter(
    (entry) => !vocabulary.some((option) => option.toLowerCase() === entry.toLowerCase()),
  );
  return [
    ...vocabulary.map((value) => ({ value })),
    ...extra.map((value) => ({ value, legacy: true })),
  ];
}
