// The admin's queue, as a spreadsheet.
//
// A dot-suffix sibling of logistics-requests.ts, which owns the member's own list and the detail
// card. The queue keeps deadlines and actions on one line; documents and context live in the
// detail card, opened from the member's name.
//
// Read-only about the member's own words: an admin cannot edit what somebody asked for. The two
// writes are returning the signed file and answering, and both belong to the lab.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { LogisticsRequest, LogisticsRequestStatus } from "../api/logistics.ts";
import {
  logisticsDeadlineText,
  selectLogisticsQueue,
  type LogisticsQueueOptions,
} from "../data/logistics-queue.ts";
import { isSettledRequest } from "../data/logistics-requests.ts";
import { logisticsStatusLabel } from "./logistics-status.ts";

export type AdminBotLogisticsQueueProps = {
  requests: LogisticsRequest[];
  options: LogisticsQueueOptions;
  onOptionsChange: (patch: Partial<LogisticsQueueOptions>) => void;
  loading: boolean;
  error: string | null;
  /** Outstanding only, or everything the lab has ever been sent. */
  showSettled: boolean;
  onShowSettledChange: (showSettled: boolean) => void;
  /** The request whose signed document is uploading, so its row can say so. */
  signingId: string | null;
  onSendSigned: (requestId: string, files: File[]) => void;
  signedNote: string;
  onSignedNoteChange: (note: string) => void;
  onOpenRequest: (requestId: string) => void;
  onSetStatus: (requestId: string, status: LogisticsRequestStatus) => void;
};

function formatInstant(instant: string | undefined): string {
  if (!instant) {
    return "";
  }
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime())
    ? instant
    : parsed.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/**
 * The upload that finishes a request.
 *
 * A file input rather than a drop zone: this is one file, picked once, in a table cell -- and the
 * label doubles as the button, so the whole control is one target. Sending starts on picking the
 * file, because a separate "send" button in a table row is a second thing to find and the file is
 * the whole of the decision.
 */
function renderSignCell(props: AdminBotLogisticsQueueProps, request: LogisticsRequest) {
  if (request.kind !== "document_signature") {
    return html`<span class="muted">—</span>`;
  }
  if (request.signed_sent_at) {
    return html`
      <span class="logistics-queue__sent" title=${formatInstant(request.signed_sent_at)}>
        ${t("logistics.queue.sentTo", { email: request.signed_sent_to ?? "" })}
      </span>
    `;
  }
  if (isSettledRequest(request)) {
    return html`<span class="muted">—</span>`;
  }
  const busy = props.signingId === request.id;
  return html`
    <label class="btn btn--sm logistics-queue__upload" ?data-busy=${busy}>
      ${busy ? t("logistics.queue.sending") : t("logistics.queue.upload")}
      <input
        class="sr-only"
        type="file"
        multiple
        ?disabled=${busy}
        data-testid="logistics-queue-upload"
        @change=${(event: Event) => {
          const input = event.currentTarget;
          if (!(input instanceof HTMLInputElement)) {
            return;
          }
          const picked = [...(input.files ?? [])];
          // Cleared straight away so the same file can be picked again after a failed send --
          // otherwise the input holds it and fires no second change event.
          input.value = "";
          if (picked.length) {
            props.onSendSigned(request.id, picked);
          }
        }}
      />
    </label>
  `;
}

function renderStatusCell(props: AdminBotLogisticsQueueProps, request: LogisticsRequest) {
  return html`
    <select
      class="logistics-queue__status logistics-status--${request.status}"
      aria-label=${t("logistics.queue.statusFor", { member: request.member_name })}
      .value=${request.status}
      ?disabled=${props.signingId === request.id}
      @change=${(event: Event) => {
        const select = event.currentTarget;
        if (select instanceof HTMLSelectElement) {
          props.onSetStatus(request.id, select.value as LogisticsRequestStatus);
        }
      }}
    >
      <!-- Withdrawn is absent on purpose: calling a request off belongs to the member who made it,
           and the service refuses it here whoever asks. A request already withdrawn still shows
           what it is. -->
      ${(["submitted", "in_progress", "completed", "declined"] as const).map(
        (status) =>
          html`<option value=${status}>${logisticsStatusLabel(request.kind, status)}</option>`,
      )}
      ${request.status === "withdrawn"
        ? html`<option value="withdrawn">
            ${logisticsStatusLabel(request.kind, "withdrawn")}
          </option>`
        : nothing}
    </select>
  `;
}

function renderRow(props: AdminBotLogisticsQueueProps, request: LogisticsRequest) {
  const deadline = logisticsDeadlineText(request);
  return html`
    <tr class="logistics-queue__row" data-status=${request.status}>
      <td class="logistics-queue__cell ab-num">${formatInstant(request.submitted_at)}</td>
      <td class="logistics-queue__cell">
        <button
          class="logistics-requests__open"
          type="button"
          @click=${() => props.onOpenRequest(request.id)}
        >
          ${request.member_name}
        </button>
      </td>
      <td class="logistics-queue__cell ab-num">
        ${deadline
          ? deadline
          : html`<span class="muted">${t("logistics.requests.noDeadline")}</span>`}
      </td>
      <td class="logistics-queue__cell">${renderStatusCell(props, request)}</td>
      <td class="logistics-queue__cell logistics-queue__cell--sign">
        ${renderSignCell(props, request)}
      </td>
    </tr>
  `;
}

const COLUMNS = [
  { key: "logistics.queue.submitted", sort: "submitted" },
  { key: "logistics.requests.user", sort: "user" },
  { key: "logistics.requests.earliestDeadline", sort: "deadline" },
  { key: "logistics.requests.statusColumn", sort: "status" },
  { key: "logistics.queue.signed", sort: null },
] as const;

function renderFilters(props: AdminBotLogisticsQueueProps) {
  return html`<div class="logistics-queue__filters">
    <label class="adminbot-form adminbot-form__field">
      <span>${t("common.search")}</span>
      <input
        type="search"
        .value=${props.options.search}
        placeholder=${t("logistics.queue.searchPlaceholder")}
        @input=${(event: Event) =>
          props.onOptionsChange({ search: (event.currentTarget as HTMLInputElement).value })}
      />
    </label>
    <label class="adminbot-form adminbot-form__field">
      <span>${t("logistics.requests.type")}</span>
      <select
        aria-label=${t("logistics.requests.type")}
        .value=${props.options.kind}
        @change=${(event: Event) =>
          props.onOptionsChange({
            kind: (event.currentTarget as HTMLSelectElement).value as LogisticsQueueOptions["kind"],
          })}
      >
        <option value="all">${t("logistics.queue.allTypes")}</option>
        <option value="document_signature">${t("logistics.templates.documentSignature")}</option>
        <option value="recommendation_letters">
          ${t("logistics.templates.recommendationLetters")}
        </option>
        <option value="book_meeting">${t("logistics.templates.bookMeeting")}</option>
      </select>
    </label>
    <label class="adminbot-form adminbot-form__field">
      <span>${t("logistics.requests.statusColumn")}</span>
      <select
        aria-label=${t("logistics.requests.statusColumn")}
        .value=${props.options.status}
        @change=${(event: Event) =>
          props.onOptionsChange({
            status: (event.currentTarget as HTMLSelectElement)
              .value as LogisticsQueueOptions["status"],
          })}
      >
        <option value="all">${t("logistics.queue.allStatuses")}</option>
        <option value="submitted">${t("logistics.queue.awaitingAction")}</option>
        <option value="in_progress">${t("logistics.requests.status.inProgress")}</option>
        <option value="completed">${t("logistics.requests.status.completed")}</option>
        <option value="declined">${t("logistics.requests.status.declined")}</option>
        <option value="withdrawn">${t("logistics.requests.status.withdrawn")}</option>
      </select>
    </label>
  </div>`;
}

export function renderAdminBotLogisticsQueue(props: AdminBotLogisticsQueueProps) {
  const rows = selectLogisticsQueue(props.requests, props.options, props.showSettled);
  const filtered =
    Boolean(props.options.search.trim()) ||
    props.options.kind !== "all" ||
    props.options.status !== "all";
  return html`
    <div
      class="card adminbot-card adminbot-card--wide logistics-queue"
      data-testid="logistics-queue"
    >
      <div class="logistics-queue__heading">
        <div>
          <div class="card-title">${t("logistics.queue.title")}</div>
          <div class="card-sub">${t("logistics.queue.instructions")}</div>
        </div>
        <label class="logistics-queue__toggle">
          <input
            type="checkbox"
            .checked=${props.showSettled}
            @change=${(event: Event) => {
              const box = event.currentTarget;
              if (box instanceof HTMLInputElement) {
                props.onShowSettledChange(box.checked);
              }
            }}
          />
          ${t("logistics.queue.showSettled")}
        </label>
      </div>

      ${renderFilters(props)}
      <label class="adminbot-form adminbot-form__field logistics-queue__note">
        <span>${t("logistics.queue.note")}</span>
        <input
          type="text"
          placeholder=${t("logistics.queue.notePlaceholder")}
          .value=${props.signedNote}
          @input=${(event: Event) => {
            const field = event.currentTarget;
            if (field instanceof HTMLInputElement) {
              props.onSignedNoteChange(field.value);
            }
          }}
        />
      </label>

      ${props.error
        ? html`<p class="logistics-requests__error" role="alert">${props.error}</p>`
        : nothing}
      ${props.loading
        ? html`<p class="logistics-requests__empty">${t("logistics.requests.loading")}</p>`
        : rows.length
          ? html`
              <div class="logistics-queue__scroll">
                <table class="logistics-queue__table">
                  <thead>
                    <tr>
                      ${COLUMNS.map(
                        ({ key, sort }) => html` <th
                          scope="col"
                          class="logistics-queue__head"
                          aria-sort=${sort && props.options.sortBy === sort
                            ? props.options.sortDirection === "asc"
                              ? "ascending"
                              : "descending"
                            : sort
                              ? "none"
                              : nothing}
                        >
                          ${sort
                            ? html`<button
                                type="button"
                                class="logistics-queue__sort"
                                aria-label=${t(key)}
                                @click=${() =>
                                  props.onOptionsChange({
                                    sortBy: sort,
                                    sortDirection:
                                      props.options.sortBy === sort &&
                                      props.options.sortDirection === "asc"
                                        ? "desc"
                                        : "asc",
                                  })}
                              >
                                ${t(key)}<span aria-hidden="true"
                                  >${props.options.sortBy === sort
                                    ? props.options.sortDirection === "asc"
                                      ? " ↑"
                                      : " ↓"
                                    : " ↕"}</span
                                >
                              </button>`
                            : t(key)}
                        </th>`,
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    ${rows.map((request) => renderRow(props, request))}
                  </tbody>
                </table>
              </div>
            `
          : html`<p class="logistics-requests__empty">
              ${filtered
                ? t("logistics.queue.noMatches")
                : props.showSettled
                  ? t("logistics.requests.empty")
                  : t("logistics.queue.nothingOutstanding")}
            </p>`}
    </div>
  `;
}
