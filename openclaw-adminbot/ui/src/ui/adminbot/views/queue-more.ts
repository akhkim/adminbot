import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { ADMIN_QUEUE_PAGE_SIZE, type AdminQueuePage } from "../controllers/admin-queues.ts";

/**
 * The "Show N more" button under a paged admin queue, in the Meetings list's style.
 *
 * Drawn only while the service says another page exists, so an older service that sends the
 * whole queue (and no `next_offset`) shows exactly the list it always did.
 */
export function renderQueueMore(
  page: AdminQueuePage | undefined,
  loaded: number,
  onMore: (() => void) | undefined,
) {
  if (page?.next === undefined || !onMore) {
    return nothing;
  }
  const remaining = Math.max(1, Math.min(ADMIN_QUEUE_PAGE_SIZE, page.total - loaded));
  return html`<button
    class="btn meetings__more"
    type="button"
    data-testid="queue-show-more"
    ?disabled=${Boolean(page.loading)}
    aria-busy=${page.loading ? "true" : "false"}
    @click=${onMore}
  >
    ${page.loading ? t("common.loading") : t("professor.showMore", { count: String(remaining) })}
  </button>`;
}
