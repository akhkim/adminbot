// The member-type filter shared by both Lab Overview tabs.
//
// Profile Completeness and Active Papers answer different questions about the same roster, and an
// administrator narrowing one to "alumni and major coauthors" means the same thing on the other.
// One module so the two cannot drift into filtering the same word differently -- the same reason
// the mandatory-field list lives in the contracts module rather than once per surface.

import { html, nothing } from "lit";

/**
 * The types the filter offers, and how they are spelled on the roster.
 *
 * A deliberate subset of what `member_type` actually contains: these four are the groups the lab
 * reviews as groups. The column is free text and carries other values ("acquaintance",
 * "interviewee", "coauthor-minor", "external-prof"), which stay reachable through the search box
 * rather than adding six more checkboxes to a filter nobody would read.
 *
 * `value` is matched against the roster's own spelling, lowercased. It is not the same vocabulary
 * as `adminBotExternalCollaboratorSubgroups` -- that is the access matrix's axis and uses
 * underscores; this column is hand-maintained and uses hyphens.
 */
export const ADMINBOT_MEMBER_TYPE_FILTERS = [
  { value: "full", label: "Full member" },
  { value: "own-pace-advisee", label: "Own-pace advisee" },
  { value: "coauthor-major", label: "Coauthor (major)" },
  { value: "alumni", label: "Alumni" },
] as const;

export type AdminBotMemberTypeFilterValue = (typeof ADMINBOT_MEMBER_TYPE_FILTERS)[number]["value"];

/**
 * One member's types as a set.
 *
 * The column holds a comma-separated list, because people are genuinely more than one thing --
 * "alumni, coauthor-major" is somebody who left and still writes with the lab. Splitting rather
 * than substring-matching is what keeps "coauthor-major" from also matching "coauthor-minor"
 * on a row that carries both.
 */
export function memberTypeTokens(memberType: string | undefined): Set<string> {
  return new Set(
    (memberType ?? "")
      .split(",")
      .map((entry) => entry.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
}

/**
 * Whether a row survives the filter.
 *
 * An empty selection shows everyone. That is the important case: the filter is off by default, and
 * a filter whose "nothing ticked" state hid the whole table would read as a broken page rather
 * than as an unset control.
 *
 * Ticking more than one is a union -- "alumni or major coauthor" -- because these are labels a
 * person holds, not a hierarchy to intersect.
 */
export function matchesMemberTypeFilter(
  memberType: string | undefined,
  selected: readonly string[],
): boolean {
  if (selected.length === 0) {
    return true;
  }
  const tokens = memberTypeTokens(memberType);
  return selected.some((value) => tokens.has(value));
}

/**
 * The checkbox group, drawn the same way on both tabs.
 *
 * Checkboxes rather than a multi-select: four options is small enough to show at once, and a
 * `<select multiple>` hides the current state behind a scroll box and needs a modifier key to add
 * a second value -- which is how a filter ends up silently narrower than the reader thinks.
 */
export function renderMemberTypeFilter(params: {
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Distinguishes the two tabs' copies in the DOM, so a test can name the one it means. */
  testIdPrefix: string;
  label: string;
}) {
  const { selected, onChange, testIdPrefix, label } = params;
  const toggle = (value: string) =>
    onChange(
      selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value],
    );
  // `chip-row` and `chip` are the app's own control vocabulary, and the two class names this
  // group used to carry had no rules behind them anywhere in the stylesheet -- so the filter drew
  // as a raw <fieldset>, browser border and all, beside toolbars that had been restyled around it.
  // The checkbox stays inside the chip: it is what makes the state readable without colour, and
  // `.chip input` is already spaced for it.
  return html`
    <fieldset
      class="chip-row profile-overview__type-filter"
      data-testid=${`${testIdPrefix}-type-filter`}
    >
      <legend class="sr-only">${label}</legend>
      ${ADMINBOT_MEMBER_TYPE_FILTERS.map(
        (option) => html`
          <label class="chip profile-overview__type-option">
            <input
              type="checkbox"
              data-testid=${`${testIdPrefix}-type-${option.value}`}
              .checked=${selected.includes(option.value)}
              @change=${() => toggle(option.value)}
            />
            <span>${option.label}</span>
          </label>
        `,
      )}
      ${selected.length
        ? html`<button
            type="button"
            class="btn btn--sm"
            data-testid=${`${testIdPrefix}-type-clear`}
            @click=${() => onChange([])}
          >
            Clear
          </button>`
        : nothing}
    </fieldset>
  `;
}
