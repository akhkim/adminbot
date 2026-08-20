// The admin's queue, as a spreadsheet.
//
// A dot-suffix sibling of logistics-requests.ts, which owns the member's own list and the detail
// card. This is the other audience: somebody working through everyone's requests, who wants every
// row's facts and both of its actions on one line rather than four clicks deep. Everything an admin
// does to a signature request is here -- read the context, download what needs signing, upload what
// they signed -- because opening a card to do each of them is what made the old queue a list nobody
// worked from.
//
// Read-only about the member's own words: an admin cannot edit what somebody asked for. The two
// writes are returning the signed file and answering, and both belong to the lab.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { LogisticsRequest, LogisticsRequestStatus } from "../auth/session.ts";
import { formatFileSize, isSettledRequest } from "../data/logistics-requests.ts";

export type AdminBotLogisticsQueueProps = {
  requests: LogisticsRequest[];
  loading: boolean;
  error: string | null;
  /** Outstanding only, or everything the lab has ever been sent. */
  showSettled: boolean;
  onShowSettledChange: (showSettled: boolean) => void;
  /** The request whose signed document is uploading, so its row can say so. */
  signingId: string | null;
  /** "<requestId>:<fileName>" while that document is being fetched. */
  downloadingId: string | null;
  onDownload: (requestId: string, fileName: string) => void;
  onSendSigned: (requestId: string, files: File[]) => void;
  signedNote: string;
  onSignedNoteChange: (note: string) => void;
  onOpenRequest: (requestId: string) => void;
  onSetStatus: (requestId: string, status: LogisticsRequestStatus) => void;
};

const KIND_LABEL_KEY: Record<LogisticsRequest["kind"], string> = {
  document_signature: "logistics.templates.documentSignature",
  recommendation_letters: "logistics.templates.recommendationLetters",
  book_meeting: "logistics.templates.bookMeeting",
};

const STATUS_LABEL_KEY: Record<LogisticsRequestStatus, string> = {
  submitted: "logistics.requests.status.submitted",
  in_progress: "logistics.requests.status.inProgress",
  completed: "logistics.requests.status.completed",
  declined: "logistics.requests.status.declined",
  withdrawn: "logistics.requests.status.withdrawn",
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

function formatDay(instant: string): string {
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime())
    ? instant
    : parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The documents on a row, each one a download.
 *
 * A button rather than a link, because the queue deliberately holds no file bytes: the list read
 * carries names and sizes so that drawing a queue of twenty requests is not twenty PDFs down the
 * wire. Pressing one fetches that request and hands the file to the browser. A settled request has
 * had its bytes dropped by the service, so its documents are named but no longer offered.
 */
function renderDocumentCell(props: AdminBotLogisticsQueueProps, request: LogisticsRequest) {
  const files = request.documents ?? [];
  if (!files.length) {
    return html`<span class="muted">—</span>`;
  }
  const settled = isSettledRequest(request);
  return html`
    <ul class="logistics-queue__files">
      ${files.map((file) => {
        const busy = props.downloadingId === `${request.id}:${file.name}`;
        return html`
          <li>
            ${settled
              ? html`<span class="logistics-queue__file muted" title=${t("logistics.queue.cleared")}
                  >${file.name}</span
                >`
              : html`<button
                  class="logistics-queue__file"
                  type="button"
                  ?disabled=${busy}
                  data-testid="logistics-queue-download"
                  title=${t("logistics.queue.download", { name: file.name })}
                  @click=${() => props.onDownload(request.id, file.name)}
                >
                  <span aria-hidden="true">${icons.download}</span>${file.name}
                </button>`}
            ${file.size > 0
              ? html`<span class="logistics-queue__size ab-num">${formatFileSize(file.size)}</span>`
              : nothing}
          </li>
        `;
      })}
    </ul>
  `;
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
        (status) => html`<option value=${status}>${t(STATUS_LABEL_KEY[status])}</option>`,
      )}
      ${request.status === "withdrawn"
        ? html`<option value="withdrawn">${t(STATUS_LABEL_KEY.withdrawn)}</option>`
        : nothing}
    </select>
  `;
}

function renderRow(props: AdminBotLogisticsQueueProps, request: LogisticsRequest) {
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
      <td class="logistics-queue__cell">${t(KIND_LABEL_KEY[request.kind])}</td>
      <td class="logistics-queue__cell logistics-queue__cell--documents">
        ${renderDocumentCell(props, request)}
      </td>
      <td class="logistics-queue__cell logistics-queue__cell--context">
        ${request.description || html`<span class="muted">—</span>`}
      </td>
      <td class="logistics-queue__cell ab-num">
        ${request.deadline_at
          ? formatDay(request.deadline_at)
          : html`<span class="muted">${t("logistics.requests.noDeadline")}</span>`}
      </td>
      <td class="logistics-queue__cell">${renderStatusCell(props, request)}</td>
      <td class="logistics-queue__cell logistics-queue__cell--sign">
        ${renderSignCell(props, request)}
      </td>
    </tr>
  `;
}

const COLUMN_KEYS = [
  "logistics.queue.submitted",
  "logistics.requests.user",
  "logistics.requests.type",
  "logistics.requests.documents",
  "logistics.queue.context",
  "logistics.requests.deadline",
  "logistics.requests.statusColumn",
  "logistics.queue.signed",
];

export function renderAdminBotLogisticsQueue(props: AdminBotLogisticsQueueProps) {
  const rows = props.showSettled
    ? props.requests
    : props.requests.filter((request) => !isSettledRequest(request));
  return html`
    <div
      class="card adminbot-card adminbot-card--wide logistics-queue"
      data-testid="logistics-queue"
    >
      <div class="logistics-queue__heading">
        <div>
          <div class="card-title">${t("logistics.queue.title")}</div>
          <div class="card-sub">${t("logistics.queue.sub")}</div>
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

      <label class="adminbot-form__field logistics-queue__note">
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
                      ${COLUMN_KEYS.map(
                        (key) => html`
                          <th scope="col" class="logistics-queue__head">${t(key)}</th>
                        `,
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
              ${props.showSettled
                ? t("logistics.requests.empty")
                : t("logistics.queue.nothingOutstanding")}
            </p>`}
    </div>
  `;
}
