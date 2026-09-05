// Who changed what, lately.
//
// The service has kept an append-only row per changed field since the activity log went in -- who
// typed it, whose record it was, which field, when -- and until now nothing read it. The two reads
// beside it answer "what has this person touched" and "who has touched this field"; neither
// answers the question an admin actually opens the tab to ask.
//
// Deliberately a feed and not a table with filters. The question is "what has been going on", it
// is answered by scanning, and every filter offered here is one the Profile Completeness table
// already answers better for the questions that need filtering.
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
  onReload: () => void;
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

/**
 * Whose record it was, when that is somebody else.
 *
 * Absent means a self-edit, which is why the line reads "Ada changed her Location" as one name
 * rather than repeating it on both sides.
 */
function subjectName(row: RecentUpdateRow): string | undefined {
  if (!row.subject_member_id) {
    return undefined;
  }
  return row.subject_member_name ?? row.subject_member_id;
}

function renderRow(row: RecentUpdateRow) {
  const whose = subjectName(row);
  return html`
    <li class="recent-edits__row" data-source=${row.source} data-testid="recent-edits-row">
      <div class="recent-edits__line">
        <span class="recent-edits__actor">${actorName(row)}</span>
        <span class="recent-edits__field">${fieldLabel(row)}</span>
        ${whose
          ? html`<span class="recent-edits__subject"
              >${t("recentEdits.onRecordOf", { member: whose })}</span
            >`
          : nothing}
        ${row.paper_title
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

export function renderRecentEdits(props: RecentEditsProps) {
  return html`
    <section class="card adminbot-card adminbot-card--wide recent-edits">
      <div class="recent-edits__head">
        <div>
          <div class="card-title">${t("recentEdits.title")}</div>
          <div class="card-sub">${t("recentEdits.sub")}</div>
        </div>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${props.loading}
          data-testid="recent-edits-reload"
          @click=${() => props.onReload()}
        >
          ${props.loading ? t("recentEdits.loading") : t("recentEdits.reload")}
        </button>
      </div>
      ${props.error
        ? html`<div class="callout danger" data-testid="recent-edits-error">${props.error}</div>`
        : nothing}
      ${props.updates.length
        ? html`<ol class="recent-edits__list" data-testid="recent-edits-list">
            ${props.updates.map((row) => renderRow(row))}
          </ol>`
        : props.loading || props.error
          ? nothing
          : html`<p class="recent-edits__empty" data-testid="recent-edits-empty">
              ${t("recentEdits.empty")}
            </p>`}
    </section>
  `;
}
