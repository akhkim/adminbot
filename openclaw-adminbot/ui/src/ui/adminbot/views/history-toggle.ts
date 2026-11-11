// The one "History" fold a surface keeps its resolved and out-of-date entries behind.
//
// The rule it serves: old information leaves the default view, but nothing is deleted to make
// that happen. A surface that drops a done or stale entry from its list puts it here instead,
// closed by default, so the list shows what still needs somebody while the record stays one
// press away. Closed is a native <details>, so it needs no state of its own and survives a
// re-render without a flag to keep.
import { html, nothing, type TemplateResult } from "lit";

export function historyToggle(params: {
  /** data-testid of the fold, so each surface's history is found on its own. */
  testId: string;
  /** The summary line, with the count already in it ("History (3)"). */
  label: string;
  /** One rendered entry per resolved item. Nothing is drawn when there are none. */
  items: readonly TemplateResult[];
  /** The surface's own fold class ("professor__done", "adminbot-fold"). */
  className?: string;
  /** The list's class, so the entries keep the surface's row layout. */
  listClassName?: string;
}): TemplateResult | typeof nothing {
  if (!params.items.length) {
    return nothing;
  }
  return html`<details
    class=${`${params.className ?? "adminbot-fold"} adminbot-history`}
    data-testid=${params.testId}
  >
    <summary>${params.label}</summary>
    <ul class=${params.listClassName ?? "adminbot-history__list"}>
      ${params.items.map((item) => html`<li>${item}</li>`)}
    </ul>
  </details>`;
}
