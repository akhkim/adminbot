// What an admin sees under "View Current Requests": every saved request as a list, and any one of
// them opened in full.
//
// Read-only by design. An admin reads a member's request here; changing it is the member's own
// form, and acting on it is a typed action behind the approval gate. Nothing on this surface
// writes anything.
//
// The list is only as wide as its source. See data/logistics-requests.ts: until a submitted
// request reaches the service, the only ones readable are those saved in this browser, which the
// scope note on screen says out loud rather than letting the heading imply the lab.
import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { RecommendationSchool } from "../data/logistics-draft.ts";
import type { LogisticsRequest, LogisticsRequestFile } from "../data/logistics-requests.ts";
import { SCHOOL_FIELDS, TEMPLATE_FOLDER_URL } from "./logistics-fields.ts";

export type AdminBotLogisticsRequestsProps = {
  requests: LogisticsRequest[];
  loading: boolean;
  // Which request is open, by id. Null is the list.
  openRequestId: string | null;
  onOpenRequest: (requestId: string | null) => void;
};

const TYPE_LABEL_KEY: Record<LogisticsRequest["type"], string> = {
  documentSignature: "logistics.templates.documentSignature",
  recommendationLetters: "logistics.templates.recommendationLetters",
};

/**
 * A stored `yyyy-mm-dd` as the reader's own date.
 *
 * Built field by field rather than by parsing the string: `new Date("2026-12-01")` is UTC midnight,
 * which prints as the 30th for every reader west of Greenwich.
 */
function formatDeadline(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatSavedAt(savedAt: number): string {
  return savedAt
    ? new Date(savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : t("logistics.requests.savedUnknown");
}

function renderDeadlineCell(request: LogisticsRequest) {
  return request.deadline
    ? html`<span class="ab-num">${formatDeadline(request.deadline)}</span>`
    : html`<span class="muted">${t("logistics.requests.noDeadline")}</span>`;
}

function renderRequestRow(props: AdminBotLogisticsRequestsProps, request: LogisticsRequest) {
  const open = () => props.onOpenRequest(request.id);
  return html`
    <!-- The row is the target for a pointer and the button inside it for everything else, so a
         click on the name opens the request twice. Opening is idempotent, which is cheaper than
         teaching the row to know where the click came from. -->
    <tr class="logistics-requests__row" @click=${open}>
      <td class="logistics-requests__cell">
        <button class="logistics-requests__open" type="button" @click=${open}>
          ${request.member}
        </button>
      </td>
      <td class="logistics-requests__cell">${t(TYPE_LABEL_KEY[request.type])}</td>
      <td class="logistics-requests__cell">${renderDeadlineCell(request)}</td>
    </tr>
  `;
}

function renderRequestsList(props: AdminBotLogisticsRequestsProps) {
  return html`
    <div
      class="card adminbot-card adminbot-card--wide logistics-requests"
      data-testid="logistics-requests"
    >
      <div class="card-title">${t("logistics.requests.title")}</div>
      <div class="card-sub">${t("logistics.requests.sub")}</div>
      <!-- Says what the list can and cannot see. Without it the heading promises the lab and
           delivers one laptop. -->
      <p class="logistics-requests__scope">${t("logistics.requests.scope")}</p>

      ${props.loading
        ? html`<p class="logistics-requests__empty">${t("logistics.requests.loading")}</p>`
        : props.requests.length
          ? html`
              <div class="logistics-requests__scroll">
                <table class="logistics-requests__table">
                  <thead>
                    <tr>
                      <th scope="col" class="logistics-requests__head">
                        ${t("logistics.requests.user")}
                      </th>
                      <th scope="col" class="logistics-requests__head">
                        ${t("logistics.requests.type")}
                      </th>
                      <th scope="col" class="logistics-requests__head">
                        ${t("logistics.requests.deadline")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    ${props.requests.map((request) => renderRequestRow(props, request))}
                  </tbody>
                </table>
              </div>
            `
          : html`<p class="logistics-requests__empty">${t("logistics.requests.empty")}</p>`}
    </div>
  `;
}

function renderFileList(files: LogisticsRequestFile[]) {
  return files.length
    ? html`
        <ul class="logistics-detail__files">
          ${files.map(
            (file) => html`
              <li>
                <span class="logistics-detail__file-icon" aria-hidden="true"
                  >${icons.fileText}</span
                >
                ${file.name}
              </li>
            `,
          )}
        </ul>
      `
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

function renderLinkValue(url: string) {
  return url
    ? html`<a class="logistics-detail__link" href=${url} target="_blank" rel="noreferrer noopener"
        >${url}</a
      >`
    : html`<p class="logistics-detail__value muted">${t("logistics.requests.none")}</p>`;
}

// The same columns the member filled in, in the same order, as text. Read-only: an admin reading a
// request must not be able to edit it from here.
function renderSchoolsTable(schools: RecommendationSchool[]) {
  return schools.length
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
                          ${school[field.key] || html`<span class="muted">—</span>`}
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

function renderDetailBody(request: LogisticsRequest) {
  if (request.type === "documentSignature") {
    return html`
      ${renderDetailField(t("logistics.requests.documents"), renderFileList(request.documents))}
      ${renderDetailField(
        t("logistics.supporting.description"),
        request.description
          ? html`<p class="logistics-detail__value">${request.description}</p>`
          : html`<p class="logistics-detail__value muted">${t("logistics.requests.none")}</p>`,
      )}
      ${renderDetailField(
        t("logistics.supporting.attachments"),
        renderFileList(request.attachments),
      )}
    `;
  }
  return html`
    ${renderDetailField(t("logistics.schools.title"), renderSchoolsTable(request.schools))}
    ${renderDetailField(t("logistics.cvOverleaf.title"), renderLinkValue(request.cvOverleafUrl))}
    ${renderDetailField(
      t("logistics.driveFolder.title"),
      html`
        ${renderLinkValue(request.driveFolderUrl)}
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

function renderRequestDetail(props: AdminBotLogisticsRequestsProps, request: LogisticsRequest) {
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
      <h3 class="card-title">${request.member}</h3>
      <p class="card-sub">
        ${t("logistics.requests.detailSub", {
          type: t(TYPE_LABEL_KEY[request.type]),
          saved: formatSavedAt(request.savedAt),
        })}
        ·
        ${request.deadline
          ? t("logistics.requests.detailDeadline", { date: formatDeadline(request.deadline) })
          : t("logistics.requests.noDeadline")}
      </p>
      ${renderDetailBody(request)}
    </div>
  `;
}

export function renderAdminBotLogisticsRequests(props: AdminBotLogisticsRequestsProps) {
  // An id that no longer matches anything -- the request was cleared in another tab, say -- falls
  // back to the list rather than an empty card.
  const open = props.requests.find((request) => request.id === props.openRequestId) ?? null;
  return open ? renderRequestDetail(props, open) : renderRequestsList(props);
}
