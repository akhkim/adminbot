// Who changed what on one thing -- a member's record, or a paper.
//
// The service has kept an append-only row per changed field since the activity log went in, and
// nothing read it. This is the reader, and it is deliberately *per object*: the question people
// actually ask is "who has been in my profile" or "who moved this paper's checklist", and a
// lab-wide feed answers it only by making you scroll past everybody else's work. The same rows,
// asked for by subject.
//
// Rendered as a disclosure, shut. It is history: worth having, not worth the space it would take
// from the record it sits under every time somebody opens the page.
import { html, nothing } from "lit";
import { adminBotPaperSlotRegistry } from "../../../../../extensions/adminbot/src/contracts/paper-slots.js";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../format.ts";
import type { RecentUpdateRow } from "../auth/session.ts";
import { PROFILE_FIELDS } from "../member-fields.ts";

export type RecentEditsProps = {
  updates: RecentUpdateRow[];
  loading: boolean;
  error: string | null;
  /** Called when the disclosure is opened, so a closed panel costs no request. */
  onOpen: () => void;
  /**
   * What the panel is about, which decides what each row may leave unsaid.
   *
   * On a profile every row is about that member, so repeating "on Ada's record" forty times says
   * nothing; on a paper every row is about that paper, so the title is already above the list.
   */
  subject: "member" | "paper";
};

/**
 * A field this build has no name for, spelled the way a person would say it.
 *
 * Not every column on the roster is a question the profile form asks: `member_type`,
 * `privilege_level` and the rest are the lab's own bookkeeping and have no entry in
 * PROFILE_FIELDS. Printing the key raw put `member_type` in a feed of ordinary English, and
 * dropping the row would make the feed quietly understate how much has been going on.
 */
function humanizeKey(key: string): string {
  const words = key.replaceAll("_", " ").trim();
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : key;
}

/**
 * What a reader calls the thing that changed.
 *
 * The service sends the key, not the label: the profile field list lives here and the slot
 * registry lives in contracts, so naming a field is the reader's job.
 */
export function fieldLabel(row: RecentUpdateRow): string {
  if (row.subject === "paper") {
    return t("recentEdits.paperRecord");
  }
  if (!row.field_key) {
    return row.slot_id;
  }
  if (row.subject === "paper_slot") {
    const slot = adminBotPaperSlotRegistry[row.field_key as keyof typeof adminBotPaperSlotRegistry];
    return slot?.label ?? humanizeKey(row.field_key);
  }
  const field = PROFILE_FIELDS.find((candidate) => candidate.key === row.field_key);
  return field ? t(field.labelKey) : humanizeKey(row.field_key);
}

/** Who did it, as a name when the roster still knows the id. */
function actorName(row: RecentUpdateRow): string {
  return row.actor_name ?? row.actor_member_id;
}

function renderRow(row: RecentUpdateRow, subject: RecentEditsProps["subject"]) {
  return html`
    <li class="recent-edits__row" data-source=${row.source} data-testid="recent-edits-row">
      <div class="recent-edits__line">
        <span class="recent-edits__actor">${actorName(row)}</span>
        <span class="recent-edits__field">${fieldLabel(row)}</span>
        ${row.paper_title && subject !== "paper"
          ? html`<span class="recent-edits__paper">${row.paper_title}</span>`
          : nothing}
      </div>
      <div class="recent-edits__meta">
        <!-- The source is the half that cannot be read off the names: an admin correcting somebody
             else's record and that member filling it in themselves are the same two names in the
             same order. -->
        <span class="chip recent-edits__source">${t(`recentEdits.source.${row.source}`)}</span>
        <span class="recent-edits__when">${formatRelativeTimestamp(Date.parse(row.at))}</span>
      </div>
    </li>
  `;
}

/**
 * The panel's contents, without the disclosure around them.
 *
 * Split out because an admin reads this history from somewhere else: on a profile it belongs in a
 * shut `<details>` under the record, but in the roster it is the whole point of the popover it
 * opens in, and a disclosure inside a popover is a second click for nothing.
 */
export function renderRecentEditsBody(props: Omit<RecentEditsProps, "onOpen">) {
  return html`
    ${props.error
      ? html`<div class="callout danger" data-testid="recent-edits-error">${props.error}</div>`
      : nothing}
    ${props.updates.length
      ? html`<ol class="recent-edits__list" data-testid="recent-edits-list">
          ${props.updates.map((row) => renderRow(row, props.subject))}
        </ol>`
      : props.loading || props.error
        ? nothing
        : html`<p class="recent-edits__empty" data-testid="recent-edits-empty">
            ${t("recentEdits.empty")}
          </p>`}
  `;
}

export function renderRecentEdits(props: RecentEditsProps) {
  return html`
    <details
      class="recent-edits"
      data-testid="recent-edits"
      @toggle=${(event: Event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) {
          props.onOpen();
        }
      }}
    >
      <summary class="recent-edits__summary">
        ${t("recentEdits.title")}
        ${props.loading
          ? html`<span class="recent-edits__loading">${t("recentEdits.loading")}</span>`
          : nothing}
      </summary>
      ${renderRecentEditsBody(props)}
    </details>
  `;
}
