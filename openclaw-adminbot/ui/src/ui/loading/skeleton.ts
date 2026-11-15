// The placeholder a page draws while its first content is on the way: a few quiet lines in the
// shape of what is coming, instead of the word "Loading".
//
// The delay lives in CSS (styles/loading.css): the block is laid out at once but stays invisible
// for the first moment, so a load that finishes quickly never flashes a placeholder at all. That
// needs no timer and no state, which is why any render function can call this.
import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";

export type SkeletonShape = "rows" | "lines";

export type SkeletonOptions = {
  /** `rows` for a list or table (the default), `lines` for a block of text or a form. */
  shape?: SkeletonShape;
  /** How many rows or lines to hint at. Clamped to 1..12. */
  count?: number;
  /** What a screen reader announces; defaults to the shared "Loading…". */
  label?: string;
  testId?: string;
};

// Uneven widths read as text; identical bars read as a broken page.
const LINE_WIDTHS = ["72%", "54%", "88%", "63%", "46%", "80%"] as const;

export function skeletonCount(count: number | undefined, fallback: number): number {
  if (count === undefined || !Number.isFinite(count)) {
    return fallback;
  }
  return Math.min(12, Math.max(1, Math.round(count)));
}

export function renderSkeleton(options: SkeletonOptions = {}): TemplateResult {
  const shape = options.shape ?? "rows";
  const count = skeletonCount(options.count, shape === "rows" ? 5 : 4);
  const items = Array.from({ length: count }, (_, index) => index);
  return html`
    <div
      class="skeleton skeleton--${shape}"
      role="status"
      aria-busy="true"
      aria-label=${options.label ?? t("common.loading")}
      data-testid=${options.testId ?? "skeleton"}
    >
      ${items.map((index) =>
        shape === "rows"
          ? html`<div class="skeleton__row" aria-hidden="true">
              <span
                class="skeleton__line skeleton__line--lead"
                style="width: ${LINE_WIDTHS[(index + 2) % LINE_WIDTHS.length]}"
              ></span>
              <span
                class="skeleton__line"
                style="width: ${LINE_WIDTHS[index % LINE_WIDTHS.length]}"
              ></span>
            </div>`
          : html`<span
              class="skeleton__line"
              aria-hidden="true"
              style="width: ${LINE_WIDTHS[index % LINE_WIDTHS.length]}"
            ></span>`,
      )}
    </div>
  `;
}
