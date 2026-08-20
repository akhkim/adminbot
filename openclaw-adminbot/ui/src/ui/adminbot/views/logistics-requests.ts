// Saved logistics requests: the list, and any one of them opened in full.
//
// Two audiences, one surface. A member reads their own requests here -- what they asked for, where
// it stands, and the way to take one back. An admin reads the lab's queue, most urgent first, and
// answers each one. Which of the two you get is decided by the service, which scopes the list to
// the caller; this view only knows whether to draw the admin's controls, and the buttons it hides
// are hidden as an affordance, never as the security boundary (see access.ts).
//
// Read-only about content: an admin reading a request cannot edit what the member wrote. Correcting
// a request is the member's own form, and answering one is the status control at the bottom.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type {
  LogisticsAttachment,
  LogisticsFact,
  LogisticsMeeting,
  LogisticsRequest,
  LogisticsRequestStatus,
  LogisticsSchool,
} from "../auth/session.ts";
import { attachmentDataUrl, formatFileSize } from "../data/logistics-requests.ts";
import { SCHOOL_FIELDS, TEMPLATE_FOLDER_URL, type SchoolField } from "./logistics-fields.ts";

export type AdminBotLogisticsRequestsProps = {
  requests: LogisticsRequest[];
  loading: boolean;
  error: string | null;
  /** The request opened in full, with its file bytes. Null is the list. */
  open: LogisticsRequest | null;
  openLoading: boolean;
  onOpenRequest: (requestId: string | null) => void;
  /** Draws the answer controls. The service re-checks; this only decides what is on screen. */
  viewerIsAdmin: boolean;
  /** Whose requests these are, so a member's own list can drop the column that only says "you". */
  viewerMemberId: string | null;
  onWithdraw: (requestId: string) => void;
  /** Loads the request back into its form so the member can correct what they sent. */
  onEdit: (requestId: string) => void;
  onSetStatus: (requestId: string, status: LogisticsRequestStatus, note: string) => void;
  /** The note an admin is typing on the open request, held on app state so a re-render cannot eat it. */
  statusNote: string;
  onStatusNoteChange: (note: string) => void;
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

// The three answers an admin gives. Withdrawn is deliberately absent: it belongs to the requester,
// and the service refuses it here however privileged the caller is.
const ANSWERS: LogisticsRequestStatus[] = ["in_progress", "completed", "declined"];

/**
 * An RFC3339 instant as the reader's own date and time.
 *
 * The service resolved the member's date, time and zone into an absolute instant on the way in, so
 * this is a plain local render of a real moment -- no re-interpretation of a wall-clock string, and
 * no chance of the "2026-12-01 prints as Nov 30 west of Greenwich" bug the old date path had.
 */
function formatInstant(instant: string): string {
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime())
    ? instant
    : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatDay(instant: string): string {
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime())
    ? instant
    : parsed.toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function renderStatusPill(status: LogisticsRequestStatus) {
  return html`
    <span class="logistics-status logistics-status--${status}">${t(STATUS_LABEL_KEY[status])}</span>
  `;
}

function renderDeadlineCell(request: LogisticsRequest) {
  return request.deadline_at
    ? html`<span class="ab-num">${formatDay(request.deadline_at)}</span>`
    : html`<span class="muted">${t("logistics.requests.noDeadline")}</span>`;
}

function renderRequestRow(props: AdminBotLogisticsRequestsProps, request: LogisticsRequest) {
  const open = () => props.onOpenRequest(request.id);
  return html`
    <!-- The row is the target for a pointer and the button inside it for everything else, so a
         click on the name opens the request twice. Opening is idempotent, which is cheaper than
         teaching the row to know where the click came from. -->
    <tr class="logistics-requests__row" @click=${open}>
      ${props.viewerIsAdmin
        ? html`
            <td class="logistics-requests__cell">
              <button class="logistics-requests__open" type="button" @click=${open}>
                ${request.member_name}
              </button>
            </td>
          `
        : nothing}
      <td class="logistics-requests__cell">
        ${props.viewerIsAdmin
          ? t(KIND_LABEL_KEY[request.kind])
          : html`
              <button class="logistics-requests__open" type="button" @click=${open}>
                ${t(KIND_LABEL_KEY[request.kind])}
              </button>
            `}
      </td>
      <td class="logistics-requests__cell">${renderDeadlineCell(request)}</td>
      <td class="logistics-requests__cell">${renderStatusPill(request.status)}</td>
    </tr>
  `;
}

function renderRequestsList(props: AdminBotLogisticsRequestsProps) {
  const heading = props.viewerIsAdmin
    ? t("logistics.requests.title")
    : t("logistics.requests.mineTitle");
  return html`
    <div
      class="card adminbot-card adminbot-card--wide logistics-requests"
      data-testid="logistics-requests"
    >
      <div class="card-title">${heading}</div>
      <div class="card-sub">
        ${props.viewerIsAdmin ? t("logistics.requests.sub") : t("logistics.requests.mineSub")}
      </div>

      ${props.error
        ? html`<p class="logistics-requests__error" role="alert">${props.error}</p>`
        : nothing}
      ${props.loading
        ? html`<p class="logistics-requests__empty">${t("logistics.requests.loading")}</p>`
        : props.requests.length
          ? html`
              <div class="logistics-requests__scroll">
                <table class="logistics-requests__table">
                  <thead>
                    <tr>
                      ${props.viewerIsAdmin
                        ? html`
                            <th scope="col" class="logistics-requests__head">
                              ${t("logistics.requests.user")}
                            </th>
                          `
                        : nothing}
                      <th scope="col" class="logistics-requests__head">
                        ${t("logistics.requests.type")}
                      </th>
                      <th scope="col" class="logistics-requests__head">
                        ${t("logistics.requests.deadline")}
                      </th>
                      <th scope="col" class="logistics-requests__head">
                        ${t("logistics.requests.statusColumn")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    ${props.requests.map((request) => renderRequestRow(props, request))}
                  </tbody>
                </table>
              </div>
            `
          : html`<p class="logistics-requests__empty">
              ${props.viewerIsAdmin
                ? t("logistics.requests.empty")
                : t("logistics.requests.mineEmpty")}
            </p>`}
    </div>
  `;
}

/**
 * The files on a request, each one downloadable.
 *
 * A download link rather than a preview: the point of a signature request is that somebody opens
 * the document in the thing they sign it with. The bytes arrive with the request itself, so the
 * link is a data: URL and needs no second round trip -- and a request read from the list, which
 * carries no bytes, still lists the names.
 */
/**
 * One file on a request.
 *
 * A name alone once the request is settled: the service drops the bytes then, and what is left is
 * the record of which document it was. Before that, the name is the download.
 */
function renderFile(file: LogisticsAttachment) {
  return html`
    <li>
      <span class="logistics-detail__file-icon" aria-hidden="true">${icons.fileText}</span>
      ${file.data_base64
        ? html`<a
            class="logistics-detail__link"
            href=${attachmentDataUrl(file)}
            download=${file.name}
            >${file.name}</a
          >`
        : html`<span>${file.name}</span>`}
      ${file.size > 0
        ? html`<span class="logistics-detail__file-size ab-num">${formatFileSize(file.size)}</span>`
        : nothing}
    </li>
  `;
}

function renderFileList(files: LogisticsAttachment[] | undefined) {
  return files?.length
    ? html`<ul class="logistics-detail__files">
        ${files.map((file) => renderFile(file))}
      </ul>`
    : html`<p class="logistics-detail__value muted">${t("logistics.requests.none")}</p>`;
}

function renderDetailField(label: string, body: unknown) {
  return html`
    <div class="logistics-detail__field">
      <span class="logistics-detail__label">${label}</span>
      ${body}
    </div>
  `;
}

function renderTextValue(value: string | undefined) {
  return value
    ? html`<p class="logistics-detail__value">${value}</p>`
    : html`<p class="logistics-detail__value muted">${t("logistics.requests.none")}</p>`;
}

function renderLinkValue(url: string | undefined) {
  return url
    ? html`<a class="logistics-detail__link" href=${url} target="_blank" rel="noreferrer noopener"
        >${url}</a
      >`
    : html`<p class="logistics-detail__value muted">${t("logistics.requests.none")}</p>`;
}

// The columns the member filled in, in the same order the form asked for them, as text. The one
// list of columns is shared with the form so the two can never drift.
function schoolCellValue(school: LogisticsSchool, field: SchoolField): string {
  const wire: Record<SchoolField["key"], keyof LogisticsSchool> = {
    school: "school",
    applicationDeadline: "application_deadline",
    applicationDeadlineTime: "application_deadline_time",
    letterDeadline: "letter_deadline",
    letterDeadlineTime: "letter_deadline_time",
    deadlineTimezone: "deadline_timezone",
    applicationStatus: "application_status",
    letterStatus: "letter_status",
    program: "program",
    programLink: "program_link",
    notes: "notes",
  };
  return school[wire[field.key]] ?? "";
}

function renderSchoolsTable(schools: LogisticsSchool[] | undefined) {
  return schools?.length
    ? html`
        <div class="logistics-schools__scroll">
          <table class="logistics-schools__table">
            <thead>
              <tr>
                ${SCHOOL_FIELDS.map(
                  (field) => html`
                    <th scope="col" class="logistics-schools__head">${t(field.labelKey)}</th>
                  `,
                )}
              </tr>
            </thead>
            <tbody>
              ${schools.map(
                (school) => html`
                  <tr class="logistics-schools__row">
                    ${SCHOOL_FIELDS.map(
                      (field) => html`
                        <td class="logistics-schools__cell logistics-detail__cell">
                          ${schoolCellValue(school, field) || html`<span class="muted">—</span>`}
                        </td>
                      `,
                    )}
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
      `
    : html`<p class="logistics-detail__value muted">${t("logistics.requests.noSchools")}</p>`;
}

/**
 * What the member said they did, which is the half of a letter request only they can supply.
 *
 * Shown in full rather than summarized: the writer is reading this to write a paragraph about the
 * person, and a truncated contribution is the exact thing that made them fall back on memory.
 */
function renderFactsTable(facts: LogisticsFact[] | undefined) {
  return facts?.length
    ? html`
        <div class="logistics-schools__scroll">
          <table class="logistics-schools__table">
            <thead>
              <tr>
                <th scope="col" class="logistics-schools__head">${t("logistics.facts.project")}</th>
                <th scope="col" class="logistics-schools__head">
                  ${t("logistics.facts.contribution")}
                </th>
              </tr>
            </thead>
            <tbody>
              ${facts.map(
                (fact) => html`
                  <tr class="logistics-schools__row">
                    <td class="logistics-schools__cell logistics-detail__cell">
                      ${fact.project || html`<span class="muted">—</span>`}
                    </td>
                    <td class="logistics-schools__cell logistics-detail__cell">
                      ${fact.contribution || html`<span class="muted">—</span>`}
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
      `
    : html`<p class="logistics-detail__value muted">${t("logistics.facts.empty")}</p>`;
}

function renderMeetingsTable(meetings: LogisticsMeeting[] | undefined) {
  return meetings?.length
    ? html`
        <div class="logistics-schools__scroll">
          <table class="logistics-schools__table">
            <thead>
              <tr>
                ${[
                  t("logistics.meeting.submitted"),
                  t("logistics.meeting.purpose"),
                  t("logistics.meeting.preferredTime"),
                  t("logistics.meeting.timezone"),
                  t("logistics.meeting.length"),
                ].map(
                  (heading) => html`
                    <th scope="col" class="logistics-schools__head">${heading}</th>
                  `,
                )}
              </tr>
            </thead>
            <tbody>
              ${meetings.map(
                (meeting) => html`
                  <tr class="logistics-schools__row">
                    <td class="logistics-schools__cell logistics-detail__cell">
                      ${meeting.submitted_at
                        ? formatInstant(meeting.submitted_at)
                        : html`<span class="muted">—</span>`}
                    </td>
                    <td class="logistics-schools__cell logistics-detail__cell">
                      ${meeting.purpose || html`<span class="muted">—</span>`}
                    </td>
                    <td class="logistics-schools__cell logistics-detail__cell">
                      ${meeting.preferred_time || html`<span class="muted">—</span>`}
                    </td>
                    <td class="logistics-schools__cell logistics-detail__cell">
                      ${meeting.timezone || html`<span class="muted">—</span>`}
                    </td>
                    <td class="logistics-schools__cell logistics-detail__cell ab-num">
                      ${meeting.length_minutes
                        ? t("logistics.meeting.minutes", {
                            count: String(meeting.length_minutes),
                          })
                        : html`<span class="muted">—</span>`}
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
      `
    : html`<p class="logistics-detail__value muted">${t("logistics.meeting.empty")}</p>`;
}

function renderDetailBody(request: LogisticsRequest) {
  if (request.kind === "document_signature") {
    return html`
      ${renderDetailField(t("logistics.requests.documents"), renderFileList(request.documents))}
      ${renderDetailField(
        t("logistics.supporting.description"),
        renderTextValue(request.description),
      )}
      ${renderDetailField(
        t("logistics.supporting.attachments"),
        renderFileList(request.attachments),
      )}
    `;
  }
  if (request.kind === "book_meeting") {
    return renderDetailField(t("logistics.meeting.title"), renderMeetingsTable(request.meetings));
  }
  return html`
    ${renderDetailField(t("logistics.schools.title"), renderSchoolsTable(request.schools))}
    ${renderDetailField(t("logistics.facts.title"), renderFactsTable(request.facts))}
    ${renderDetailField(t("logistics.cvOverleaf.title"), renderLinkValue(request.cv_overleaf_url))}
    ${renderDetailField(
      t("logistics.driveFolder.title"),
      html`
        ${renderLinkValue(request.drive_folder_url)}
        <!-- The lab's own folder, for an admin checking which templates the member started from. -->
        <a
          class="logistics-link__folder"
          href=${TEMPLATE_FOLDER_URL}
          target="_blank"
          rel="noreferrer noopener"
          >${t("logistics.driveFolder.templates")}
          <span aria-hidden="true">${icons.externalLink}</span>
        </a>
      `,
    )}
  `;
}

/**
 * The lab's answer, and the note that goes with it.
 *
 * The note is one box shared by the three buttons rather than one per answer: an admin types the
 * reason and then picks what it is a reason for, and three boxes would be two of them left empty.
 */
function renderAnswerControls(props: AdminBotLogisticsRequestsProps, request: LogisticsRequest) {
  return html`
    <section class="logistics-detail__answer" data-testid="logistics-answer">
      <h4 class="logistics-detail__label">${t("logistics.requests.answerTitle")}</h4>
      <p class="card-sub">${t("logistics.requests.answerSub")}</p>
      <label class="adminbot-form__field">
        <span>${t("logistics.requests.note")}</span>
        <textarea
          class="logistics-detail__note"
          rows="2"
          placeholder=${t("logistics.requests.notePlaceholder")}
          .value=${props.statusNote}
          @input=${(event: Event) => {
            const field = event.currentTarget;
            if (field instanceof HTMLTextAreaElement) {
              props.onStatusNoteChange(field.value);
            }
          }}
        ></textarea>
      </label>
      <div class="logistics-detail__answer-actions">
        ${ANSWERS.map(
          (status) => html`
            <button
              class="btn btn--sm ${request.status === status ? "active" : ""}"
              type="button"
              ?disabled=${props.openLoading || request.status === status}
              @click=${() => props.onSetStatus(request.id, status, props.statusNote)}
            >
              ${t(STATUS_LABEL_KEY[status])}
            </button>
          `,
        )}
      </div>
    </section>
  `;
}

function renderRequestDetail(props: AdminBotLogisticsRequestsProps, request: LogisticsRequest) {
  const isMine = request.member_id === props.viewerMemberId;
  // Withdrawing is calling the ask off, so it is offered only while there is still something to
  // call off. The service refuses the rest, which is what makes this safe to decide on screen.
  const canWithdraw = isMine && request.status !== "completed" && request.status !== "withdrawn";
  // Correcting is only offered while nobody has started on it: past that, an edit would move the
  // ground under an admin mid-way through, and the service refuses it anyway.
  const canEdit = isMine && request.status === "submitted";
  return html`
    <div
      class="card adminbot-card adminbot-card--wide logistics-detail"
      data-testid="logistics-request-detail"
    >
      <div class="logistics-detail__back">
        <button class="btn btn--sm" type="button" @click=${() => props.onOpenRequest(null)}>
          <span aria-hidden="true">${icons.arrowLeft}</span>
          ${t("logistics.requests.back")}
        </button>
      </div>
      <div class="logistics-detail__heading">
        <h3 class="card-title">${request.member_name}</h3>
        ${renderStatusPill(request.status)}
      </div>
      <p class="card-sub">
        ${t("logistics.requests.detailSub", {
          type: t(KIND_LABEL_KEY[request.kind]),
          saved: formatInstant(request.submitted_at),
        })}
        ·
        ${request.deadline_at
          ? t("logistics.requests.detailDeadline", {
              date: formatInstant(request.deadline_at),
            })
          : t("logistics.requests.noDeadline")}
      </p>
      ${request.resolution_note
        ? html`
            <p class="logistics-detail__resolution" data-testid="logistics-resolution">
              ${t("logistics.requests.resolution", { note: request.resolution_note })}
            </p>
          `
        : nothing}
      ${props.error
        ? html`<p class="logistics-requests__error" role="alert">${props.error}</p>`
        : nothing}
      ${renderDetailBody(request)}
      ${canWithdraw || canEdit
        ? html`
            <div class="logistics-detail__actions">
              ${canEdit
                ? html`
                    <button
                      class="btn btn--sm"
                      type="button"
                      data-testid="logistics-edit"
                      ?disabled=${props.openLoading}
                      @click=${() => props.onEdit(request.id)}
                    >
                      ${t("logistics.requests.edit")}
                    </button>
                  `
                : nothing}
              ${canWithdraw
                ? html`
                    <button
                      class="btn btn--sm"
                      type="button"
                      ?disabled=${props.openLoading}
                      @click=${() => props.onWithdraw(request.id)}
                    >
                      ${t("logistics.requests.withdraw")}
                    </button>
                  `
                : nothing}
            </div>
          `
        : nothing}
      ${props.viewerIsAdmin ? renderAnswerControls(props, request) : nothing}
    </div>
  `;
}

export function renderAdminBotLogisticsRequests(props: AdminBotLogisticsRequestsProps) {
  // Opening a request is a second read -- the list carries no file bytes -- so there is a moment
  // with a request asked for and nothing yet to draw. Showing the list again for that moment would
  // read as the click having missed.
  if (props.open === null && props.openLoading) {
    return html`
      <div class="card adminbot-card adminbot-card--wide logistics-requests">
        <p class="logistics-requests__empty">${t("logistics.requests.loading")}</p>
      </div>
    `;
  }
  return props.open ? renderRequestDetail(props, props.open) : renderRequestsList(props);
}
