// Templates that start a logistics request -- the routine asks a member makes of the lab, each of
// which always takes the same shape (a signature, a letter, a meeting slot).
//
// The three buttons name the request types and pick which container is on screen. Each one grows
// into a form that proposes a typed action from contracts/actions.ts, so none of them may reach a
// connector directly -- propose -> approve -> execute is the only path out of here.
//
// Each form has two ways out. Save keeps a draft on the member's own device so a half-filled
// request survives a reload; Submit sends it to the service (POST /logistics/requests), which
// stores it, stamps it with the session's member and puts it in the queue an admin works through
// on the other tab. Storing a request has no external effect, which is why it needs no approval
// gate -- the day AdminBot sends the letter or books the room, that send is the typed action.
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { AccessRole } from "../access.ts";
import {
  createFactRow,
  createMeetingRow,
  createSchoolRow,
  type LetterFact,
  type MeetingRequestRow,
  type RecommendationSchool,
} from "../data/logistics-draft.ts";
import { formatFileSize } from "../data/logistics-requests.ts";
import {
  APPLICATION_STATUS_LIST_ID,
  APPLICATION_STATUS_SUGGESTIONS,
  LETTER_STATUS_LIST_ID,
  LETTER_STATUS_SUGGESTIONS,
  SCHOOL_FIELDS,
  TEMPLATE_FOLDER_URL,
  TIMEZONE_LIST_ID,
  timezoneSuggestions,
  type SchoolField,
} from "./logistics-fields.ts";
import {
  renderAdminBotLogisticsQueue,
  type AdminBotLogisticsQueueProps,
} from "./logistics-requests.queue.ts";
import {
  renderAdminBotLogisticsRequests,
  type AdminBotLogisticsRequestsProps,
} from "./logistics-requests.ts";

/** What `describeSubmitBlock` found, as the view needs it: a reason and, for a file, which one. */
export type SubmitBlock = {
  reason: "empty" | "no-name" | "no-purpose" | "file-too-big" | "request-too-big" | "signed-out";
  file?: string;
};

export type LogisticsTemplate = "documentSignature" | "recommendationLetters" | "bookMeeting";

// Making a request is what this tab is; reading everyone's is an admin's job on top of it.
export type LogisticsMode = "make" | "view";

// Saving is local-only (IndexedDB on the member's device) and per request type, so each container
// reports its own outcome rather than sharing one "Saved at" that would follow the member from
// form to form and describe the wrong draft.
//
// Submitting is shared, because only one form is ever on screen and a member can only be sending
// one request at a time. Its outcome is not: `submitBlocked` is per-form, since what makes a
// signature request unsendable is not what makes a letters request unsendable.
type RequestSaveProps = {
  saving: boolean;
  savedAt: number | null;
  saveError: string | null;
  onSave: () => void;
  onSubmit: () => void;
  /** Why Submit would refuse right now, or null when it would go through. */
  submitBlocked: SubmitBlock | null;
  /** Shared across the three forms: only one of them is ever on screen. */
  submitting: boolean;
  submitError: string | null;
  /** Set once a request landed, so the form can say so instead of looking like nothing happened. */
  submitted: boolean;
  /** Clears everything typed into this form, draft included. */
  onDiscard: () => void;
  hasContent: boolean;
  /** Set while this form holds a request that was already sent and is being corrected. */
  editing: boolean;
  onCancelEdit: () => void;
};

export type AdminBotLogisticsProps = {
  // Visibility only. The admin section below is hidden for anyone else, and the request list it
  // opens holds nothing the service has not already decided this viewer may read -- see access.ts:
  // a hidden section is an affordance, the server is what says no.
  role: AccessRole;
  mode: LogisticsMode;
  onModeChange: (mode: LogisticsMode) => void;
  requests: AdminBotLogisticsRequestsProps;
  /**
   * The admin's spreadsheet of everyone's requests. Drawn instead of the member list when an admin
   * is in view mode, and never for anyone else -- the service scopes the data either way, so this
   * only decides which shape it is read in.
   */
  queue: AdminBotLogisticsQueueProps;
  template: LogisticsTemplate;
  onTemplateChange: (template: LogisticsTemplate) => void;
  signature: RequestSaveProps & {
    files: File[];
    onFilesChange: (files: File[]) => void;
    description: string;
    onDescriptionChange: (description: string) => void;
    attachments: File[];
    onAttachmentsChange: (files: File[]) => void;
  };
  meeting: RequestSaveProps & {
    rows: MeetingRequestRow[];
    onRowsChange: (rows: MeetingRequestRow[]) => void;
  };
  letters: RequestSaveProps & {
    schools: RecommendationSchool[];
    onSchoolsChange: (schools: RecommendationSchool[]) => void;
    // The per-project record of what the member actually did, which the Drive template cannot
    // supply and the writer would otherwise reconstruct from memory.
    facts: LetterFact[];
    onFactsChange: (facts: LetterFact[]) => void;
    // Routes to My Projects, where the weekly updates the letter draws on already live. Passed in
    // rather than reached for, because this view knows nothing about how navigation works.
    onOpenMyProjects: () => void;
    cvOverleafUrl: string;
    onCvOverleafUrlChange: (url: string) => void;
    driveFolderUrl: string;
    onDriveFolderUrlChange: (url: string) => void;
  };
};

type SignatureProps = AdminBotLogisticsProps["signature"];
type LettersProps = AdminBotLogisticsProps["letters"];
type MeetingProps = AdminBotLogisticsProps["meeting"];

// The documents to be signed are the point of the request, so this list is narrow on purpose.
// Supporting attachments deliberately carry no accept list -- context arrives as anything.
const SIGNATURE_ACCEPT =
  "application/pdf,.pdf,.doc,.docx,application/msword," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "image/png,.png,image/jpeg,.jpg,.jpeg";

// A drop and a picker both hand back a fresh FileList, so the same two files arrive as different
// File objects each time. Identity is name+size+lastModified -- enough to stop an accidental
// double-drop showing the document twice, without reading the bytes.
function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function mergeFiles(existing: readonly File[], incoming: readonly File[]): File[] {
  const seen = new Set(existing.map(fileKey));
  const added = incoming.filter((file) => {
    const key = fileKey(file);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return added.length ? [...existing, ...added] : [...existing];
}

// The drag highlight is a class toggled straight on the element rather than app state: dragover
// fires continuously while the pointer moves, and routing that through a re-render would rebuild
// the file list on every frame of the drag.
function setDragging(event: DragEvent, dragging: boolean): void {
  const zone = event.currentTarget;
  if (zone instanceof HTMLElement) {
    zone.classList.toggle("is-dragging", dragging);
  }
}

// One uploader, used by both the documents to be signed and the supporting attachments. The two
// differ only in their copy and what they accept, so they share the drop, merge and remove
// behaviour rather than growing a second copy of it that can drift.
type FileDropProps = {
  testId: string;
  inputName: string;
  files: File[];
  onFilesChange: (files: File[]) => void;
  dropTitle: string;
  dropHint: string;
  removeLabel: (name: string) => string;
  clearLabel: string;
  // Omitted means every file type is allowed.
  accept?: string;
};

function renderFileRow(props: FileDropProps, file: File) {
  return html`
    <li class="logistics-upload__file">
      <span class="logistics-upload__file-icon" aria-hidden="true">${icons.fileText}</span>
      <span class="logistics-upload__file-name">${file.name}</span>
      <span class="logistics-upload__file-size ab-num">${formatFileSize(file.size)}</span>
      <button
        class="btn btn--icon btn--xs"
        type="button"
        aria-label=${props.removeLabel(file.name)}
        @click=${() =>
          props.onFilesChange(
            props.files.filter((candidate) => fileKey(candidate) !== fileKey(file)),
          )}
      >
        ${icons.x}
      </button>
    </li>
  `;
}

function renderFileDrop(props: FileDropProps) {
  const files = props.files;
  return html`
    <!-- A label rather than a div: clicking anywhere in the zone opens the picker through the
         browser's own label-to-input association, so that path needs no script and keeps working
         for keyboard users, who reach the input directly. -->
    <label
      class="logistics-upload__drop"
      data-testid=${props.testId}
      @dragenter=${(event: DragEvent) => {
        event.preventDefault();
        setDragging(event, true);
      }}
      @dragover=${(event: DragEvent) => {
        // Without preventDefault on dragover the browser treats the element as a non-target and
        // navigates to the dropped file instead of firing our handler.
        event.preventDefault();
        setDragging(event, true);
      }}
      @dragleave=${(event: DragEvent) => setDragging(event, false)}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        setDragging(event, false);
        const dropped = [...(event.dataTransfer?.files ?? [])];
        if (dropped.length) {
          props.onFilesChange(mergeFiles(files, dropped));
        }
      }}
    >
      <span class="logistics-upload__drop-icon" aria-hidden="true">${icons.paperclip}</span>
      <span class="logistics-upload__drop-title">${props.dropTitle}</span>
      <small class="logistics-upload__drop-hint">${props.dropHint}</small>
      <input
        class="sr-only"
        name=${props.inputName}
        type="file"
        accept=${props.accept ?? nothing}
        multiple
        @change=${(event: Event) => {
          const input = event.currentTarget;
          if (!(input instanceof HTMLInputElement)) {
            return;
          }
          const picked = [...(input.files ?? [])];
          if (picked.length) {
            props.onFilesChange(mergeFiles(files, picked));
          }
          // Clearing lets the same file be re-picked after it was removed from the list --
          // otherwise the input holds it and fires no change event the second time.
          input.value = "";
        }}
      />
    </label>

    ${files.length
      ? html`
          <ul class="logistics-upload__files">
            ${files.map((file) => renderFileRow(props, file))}
          </ul>
          <div class="adminbot-form__actions">
            <button class="btn btn--sm" type="button" @click=${() => props.onFilesChange([])}>
              ${props.clearLabel}
            </button>
          </div>
        `
      : nothing}
  `;
}

function renderSignatureSection(props: SignatureProps) {
  return html`
    <section class="logistics-request__section">
      <h3 class="card-title">${t("logistics.signature.title")}</h3>
      <p class="card-sub">${t("logistics.signature.sub")}</p>
      ${renderFileDrop({
        testId: "logistics-signature-drop",
        inputName: "signature-documents",
        files: props.files,
        onFilesChange: props.onFilesChange,
        dropTitle: t("logistics.signature.dropTitle"),
        dropHint: t("logistics.signature.dropHint"),
        removeLabel: (name) => t("logistics.signature.remove", { name }),
        clearLabel: t("logistics.signature.clear"),
        accept: SIGNATURE_ACCEPT,
      })}
    </section>
  `;
}

function renderSupportingSection(props: SignatureProps) {
  return html`
    <section
      class="logistics-request__section logistics-supporting"
      data-testid="logistics-supporting"
    >
      <h3 class="card-title">${t("logistics.supporting.title")}</h3>
      <p class="card-sub">${t("logistics.supporting.sub")}</p>

      <label class="adminbot-form__field logistics-supporting__field">
        <span>${t("logistics.supporting.description")}</span>
        <textarea
          class="logistics-supporting__description"
          name="supporting-description"
          rows="4"
          placeholder=${t("logistics.supporting.descriptionPlaceholder")}
          .value=${props.description}
          @input=${(event: Event) => {
            const field = event.currentTarget;
            if (field instanceof HTMLTextAreaElement) {
              props.onDescriptionChange(field.value);
            }
          }}
        ></textarea>
      </label>

      <!-- The zone below is itself a <label>, and labels cannot nest, so this heading names the
           group instead of wrapping it. The input still gets its own name from the zone's text. -->
      <div
        class="logistics-supporting__field"
        role="group"
        aria-labelledby="logistics-attachments-label"
      >
        <span class="logistics-supporting__label" id="logistics-attachments-label">
          ${t("logistics.supporting.attachments")}
        </span>
        ${renderFileDrop({
          testId: "logistics-attachments-drop",
          inputName: "supporting-attachments",
          files: props.attachments,
          onFilesChange: props.onAttachmentsChange,
          dropTitle: t("logistics.supporting.dropTitle"),
          dropHint: t("logistics.supporting.dropHint"),
          removeLabel: (name) => t("logistics.supporting.remove", { name }),
          clearLabel: t("logistics.supporting.clear"),
        })}
      </div>
    </section>
  `;
}

/**
 * Why Submit is refusing, in the member's words.
 *
 * Said out loud rather than left to a disabled button: a button that does nothing and explains
 * nothing is the reason people file a request twice and then email instead.
 */
function submitBlockText(block: SubmitBlock): string {
  if (block.reason === "file-too-big") {
    return t("logistics.request.blocked.fileTooBig", {
      name: block.file ?? "",
    });
  }
  if (block.reason === "request-too-big") {
    return t("logistics.request.blocked.requestTooBig");
  }
  if (block.reason === "no-name") {
    return t("logistics.request.blocked.noName");
  }
  if (block.reason === "no-purpose") {
    return t("logistics.request.blocked.noPurpose");
  }
  if (block.reason === "signed-out") {
    return t("logistics.request.blocked.signedOut");
  }
  return t("logistics.request.blocked.empty");
}

function renderRequestActions(props: RequestSaveProps) {
  const saved = props.savedAt
    ? new Date(props.savedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  // A failed submit outranks everything else in this line, then a landed one, then the local draft:
  // the member is looking here for the answer to the button they just pressed.
  const status = props.submitError
    ? html`<span class="logistics-request__status--error">${props.submitError}</span>`
    : props.submitted
      ? html`<span class="logistics-request__status--ok" data-testid="logistics-submitted"
          >${t("logistics.request.submitted")}</span
        >`
      : props.saveError
        ? html`<span class="logistics-request__status--error">${props.saveError}</span>`
        : saved
          ? t("logistics.request.savedAt", { time: saved })
          : nothing;
  return html`
    ${props.editing
      ? html`
          <!-- Said out loud because the form looks exactly like a new request otherwise, and a
               member who thinks they are filing a second one will file a second one. -->
          <p class="logistics-request__editing" data-testid="logistics-editing" role="status">
            ${t("logistics.request.editing")}
            <button class="logistics-facts__link" type="button" @click=${props.onCancelEdit}>
              ${t("logistics.request.cancelEdit")}
            </button>
          </p>
        `
      : nothing}
    <div class="logistics-request__actions">
      <!-- Status sits with the buttons rather than above them: it is the answer to pressing one of
           them, and a member who just did is looking here. -->
      <span class="logistics-request__status" role="status">${status}</span>
      ${props.submitBlocked && !props.submitted
        ? html`
            <span class="logistics-request__blocked" data-testid="logistics-blocked"
              >${submitBlockText(props.submitBlocked)}</span
            >
          `
        : nothing}
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${!props.hasContent || props.saving || props.submitting}
        @click=${props.onDiscard}
      >
        ${t("logistics.request.discard")}
      </button>
      <button
        class="btn"
        type="button"
        ?disabled=${props.saving || props.submitting}
        @click=${props.onSave}
      >
        ${props.saving ? t("logistics.request.saving") : t("logistics.request.save")}
      </button>
      <!-- Left pressable while blocked on purpose: pressing it is how a member finds out what is
           missing, and the reason is written next to it either way. Only an in-flight submit
           disables it, so the same request cannot be filed twice by a double click. -->
      <button
        class="btn primary"
        type="button"
        data-testid="logistics-submit"
        ?disabled=${props.submitting}
        @click=${props.onSubmit}
      >
        ${props.submitting
          ? t("logistics.request.submitting")
          : props.editing
            ? t("logistics.request.resend")
            : t("logistics.request.submit")}
      </button>
    </div>
  `;
}

function renderStatusOptions(id: string, suggestions: readonly string[]) {
  return html`
    <datalist id=${id}>
      ${suggestions.map((suggestion) => html`<option value=${suggestion}></option>`)}
    </datalist>
  `;
}

function renderSchoolHead(field: SchoolField) {
  return html`
    <th scope="col" class="logistics-schools__head logistics-schools__head--${field.key}">
      <span class="logistics-schools__head-name">${t(field.labelKey)}</span>
      ${field.hintKey
        ? html`<small class="logistics-schools__head-hint">${t(field.hintKey)}</small>`
        : nothing}
    </th>
  `;
}

function renderSchoolCell(
  props: LettersProps,
  row: RecommendationSchool,
  index: number,
  field: SchoolField,
) {
  // The row is found again by id rather than by index: a removal elsewhere in the table can
  // renumber the rows between this handler being made and being called.
  const update = (value: string) =>
    props.onSchoolsChange(
      props.schools.map((candidate) =>
        candidate.id === row.id ? { ...candidate, [field.key]: value } : candidate,
      ),
    );
  const onInput = (event: Event) => {
    const control = event.currentTarget;
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      update(control.value);
    }
  };
  // Every control is inside a cell, and a <th> in a data row would only name it for the row it is
  // in, not for the column. The label a screen reader needs is both -- column and row number.
  const label = t("logistics.schools.cell", {
    column: t(field.labelKey),
    row: String(index + 1),
  });
  const placeholder = field.placeholderKey ? t(field.placeholderKey) : nothing;
  return html`
    <td class="logistics-schools__cell logistics-schools__cell--${field.key}">
      ${field.control === "notes"
        ? html`
            <textarea
              class="logistics-schools__input logistics-schools__notes"
              rows="2"
              aria-label=${label}
              placeholder=${placeholder}
              .value=${row[field.key]}
              @input=${onInput}
            ></textarea>
          `
        : html`
            <input
              class="logistics-schools__input"
              type=${field.control === "date"
                ? "date"
                : field.control === "time"
                  ? "time"
                  : field.control === "url"
                    ? "url"
                    : "text"}
              list=${field.listId ?? nothing}
              aria-label=${label}
              placeholder=${placeholder}
              .value=${row[field.key]}
              @input=${onInput}
            />
          `}
    </td>
  `;
}

function renderSchoolRow(props: LettersProps, row: RecommendationSchool, index: number) {
  const named = row.school.trim();
  return html`
    <tr class="logistics-schools__row">
      ${SCHOOL_FIELDS.map((field) => renderSchoolCell(props, row, index, field))}
      <td class="logistics-schools__cell logistics-schools__cell--remove">
        <button
          class="btn btn--icon btn--xs"
          type="button"
          aria-label=${named
            ? t("logistics.schools.remove", { school: named })
            : t("logistics.schools.removeRow", { row: String(index + 1) })}
          @click=${() =>
            props.onSchoolsChange(props.schools.filter((candidate) => candidate.id !== row.id))}
        >
          ${icons.x}
        </button>
      </td>
    </tr>
  `;
}

function renderSchoolsSection(props: LettersProps) {
  return html`
    <section class="logistics-request__section logistics-schools" data-testid="logistics-schools">
      <h3 class="card-title">${t("logistics.schools.title")}</h3>
      <p class="card-sub">${t("logistics.schools.sub")}</p>

      ${renderStatusOptions(APPLICATION_STATUS_LIST_ID, APPLICATION_STATUS_SUGGESTIONS)}
      ${renderStatusOptions(LETTER_STATUS_LIST_ID, LETTER_STATUS_SUGGESTIONS)}
      ${renderStatusOptions(TIMEZONE_LIST_ID, timezoneSuggestions())}

      <!-- Eight columns do not fit a laptop, and squeezing them would leave every field too narrow
           to read what was typed in it. The table keeps its width and this wrapper scrolls. -->
      <div class="logistics-schools__scroll">
        <table class="logistics-schools__table">
          <thead>
            <tr>
              ${SCHOOL_FIELDS.map((field) => renderSchoolHead(field))}
              <th scope="col" class="logistics-schools__head logistics-schools__head--remove">
                <span class="sr-only">${t("logistics.schools.removeColumn")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            ${props.schools.length
              ? repeat(
                  props.schools,
                  (row) => row.id,
                  (row, index) => renderSchoolRow(props, row, index),
                )
              : html`
                  <tr>
                    <td class="logistics-schools__empty" colspan=${SCHOOL_FIELDS.length + 1}>
                      ${t("logistics.schools.empty")}
                    </td>
                  </tr>
                `}
          </tbody>
        </table>
      </div>

      <div class="logistics-schools__actions">
        <button
          class="btn btn--sm"
          type="button"
          @click=${() => props.onSchoolsChange([...props.schools, createSchoolRow()])}
        >
          <span aria-hidden="true">${icons.plus}</span>
          ${t("logistics.schools.add")}
        </button>
      </div>
    </section>
  `;
}

/**
 * The list of facts a letter is written from.
 *
 * The letter stays a Drive template -- structure, salutation, the writer's own voice -- because
 * that is what a template is good at. What it cannot hold is the one thing only the member knows:
 * which project, and what they did on it. Without this the writer works from memory and from
 * whatever they can find in Slack, which is how a year of work becomes a sentence.
 *
 * The line under the heading routes to My Projects, which is where the member's projects and their
 * current step already live -- it is the fastest way to remember what they worked on. It is not a
 * source to copy from: there is no per-week contribution log anywhere yet (the brainstorming doc
 * still lists that as open), so what goes in this table is written here or not at all.
 */
function renderFactsSection(props: LettersProps) {
  const update = (row: LetterFact, key: "project" | "contribution") => (event: Event) => {
    const control = event.currentTarget;
    if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement)) {
      return;
    }
    props.onFactsChange(
      // Found by id, not by index: a removal above this row renumbers everything under it between
      // the handler being made and being called.
      props.facts.map((candidate) =>
        candidate.id === row.id ? { ...candidate, [key]: control.value } : candidate,
      ),
    );
  };
  return html`
    <section class="logistics-request__section logistics-schools" data-testid="logistics-facts">
      <h3 class="card-title">${t("logistics.facts.title")}</h3>
      <p class="card-sub">
        ${t("logistics.facts.sub")}
        <button
          class="logistics-facts__link"
          type="button"
          @click=${() => props.onOpenMyProjects()}
        >
          ${t("logistics.facts.openMyProjects")}
        </button>
      </p>

      <div class="logistics-schools__scroll">
        <table class="logistics-schools__table">
          <thead>
            <tr>
              <th scope="col" class="logistics-schools__head">
                <span class="logistics-schools__head-name">${t("logistics.facts.project")}</span>
              </th>
              <th scope="col" class="logistics-schools__head">
                <span class="logistics-schools__head-name"
                  >${t("logistics.facts.contribution")}</span
                >
                <small class="logistics-schools__head-hint"
                  >${t("logistics.facts.contributionHint")}</small
                >
              </th>
              <th scope="col" class="logistics-schools__head logistics-schools__head--remove">
                <span class="sr-only">${t("logistics.schools.removeColumn")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            ${props.facts.length
              ? repeat(
                  props.facts,
                  (row) => row.id,
                  (row, index) => html`
                    <tr class="logistics-schools__row">
                      <td class="logistics-schools__cell">
                        <input
                          class="logistics-schools__input"
                          type="text"
                          aria-label=${t("logistics.schools.cell", {
                            column: t("logistics.facts.project"),
                            row: String(index + 1),
                          })}
                          placeholder=${t("logistics.facts.projectPlaceholder")}
                          .value=${row.project}
                          @input=${update(row, "project")}
                        />
                      </td>
                      <td class="logistics-schools__cell">
                        <textarea
                          class="logistics-schools__input logistics-schools__notes"
                          rows="2"
                          aria-label=${t("logistics.schools.cell", {
                            column: t("logistics.facts.contribution"),
                            row: String(index + 1),
                          })}
                          placeholder=${t("logistics.facts.contributionPlaceholder")}
                          .value=${row.contribution}
                          @input=${update(row, "contribution")}
                        ></textarea>
                      </td>
                      <td class="logistics-schools__cell logistics-schools__cell--remove">
                        <button
                          class="btn btn--icon btn--xs"
                          type="button"
                          aria-label=${t("logistics.facts.removeRow", { row: String(index + 1) })}
                          @click=${() =>
                            props.onFactsChange(
                              props.facts.filter((candidate) => candidate.id !== row.id),
                            )}
                        >
                          ${icons.x}
                        </button>
                      </td>
                    </tr>
                  `,
                )
              : html`
                  <tr>
                    <td class="logistics-schools__empty" colspan="3">
                      ${t("logistics.facts.empty")}
                    </td>
                  </tr>
                `}
          </tbody>
        </table>
      </div>

      <div class="logistics-schools__actions">
        <button
          class="btn btn--sm"
          type="button"
          data-testid="logistics-facts-add"
          @click=${() => props.onFactsChange([...props.facts, createFactRow()])}
        >
          <span aria-hidden="true">${icons.plus}</span>
          ${t("logistics.facts.add")}
        </button>
      </div>
    </section>
  `;
}

// Local formatting: "when they submitted" is read against the reader's own clock, and it is the
// one column on this table that is not a claim the member is making.
function submittedLabel(submittedAt: number): string {
  if (!Number.isFinite(submittedAt) || submittedAt <= 0) {
    return t("logistics.meeting.notSubmitted");
  }
  return new Date(submittedAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Book Meeting, as a spreadsheet rather than a form.
 *
 * A meeting request is four short facts, and the people who schedule them read many at once: which
 * call, when it suits, on whose clock, and how long. A form per request meant opening each one to
 * find out whether it was a fifteen-minute check-in or an hour-long committee call, which is the
 * question that decides where it goes in a week. One row per request puts all four side by side.
 *
 * "Submitted" is stamped when the row is created and shown read-only. It is the column that decides
 * order of service, so it is the one field a requester must not be able to write.
 */
function renderMeetingSection(props: MeetingProps) {
  const update =
    (row: MeetingRequestRow, key: "purpose" | "preferredTime" | "timezone" | "lengthMinutes") =>
    (event: Event) => {
      const control = event.currentTarget;
      if (!(control instanceof HTMLInputElement)) {
        return;
      }
      props.onRowsChange(
        props.rows.map((candidate) =>
          candidate.id === row.id ? { ...candidate, [key]: control.value } : candidate,
        ),
      );
    };
  const cellLabel = (column: string, index: number) =>
    t("logistics.schools.cell", { column, row: String(index + 1) });
  return html`
    <section class="logistics-request__section logistics-schools" data-testid="logistics-meeting">
      <h3 class="card-title">${t("logistics.meeting.title")}</h3>
      <p class="card-sub">${t("logistics.meeting.sub")}</p>

      ${renderStatusOptions(TIMEZONE_LIST_ID, timezoneSuggestions())}

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
                  <th scope="col" class="logistics-schools__head">
                    <span class="logistics-schools__head-name">${heading}</span>
                  </th>
                `,
              )}
              <th scope="col" class="logistics-schools__head logistics-schools__head--remove">
                <span class="sr-only">${t("logistics.schools.removeColumn")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            ${props.rows.length
              ? repeat(
                  props.rows,
                  (row) => row.id,
                  (row, index) => html`
                    <tr class="logistics-schools__row">
                      <td class="logistics-schools__cell logistics-meeting__submitted">
                        ${submittedLabel(row.submittedAt)}
                      </td>
                      <td class="logistics-schools__cell">
                        <input
                          class="logistics-schools__input"
                          type="text"
                          aria-label=${cellLabel(t("logistics.meeting.purpose"), index)}
                          placeholder=${t("logistics.meeting.purposePlaceholder")}
                          .value=${row.purpose}
                          @input=${update(row, "purpose")}
                        />
                      </td>
                      <td class="logistics-schools__cell">
                        <input
                          class="logistics-schools__input"
                          type="datetime-local"
                          aria-label=${cellLabel(t("logistics.meeting.preferredTime"), index)}
                          .value=${row.preferredTime}
                          @input=${update(row, "preferredTime")}
                        />
                      </td>
                      <td class="logistics-schools__cell">
                        <input
                          class="logistics-schools__input"
                          type="text"
                          list=${TIMEZONE_LIST_ID}
                          aria-label=${cellLabel(t("logistics.meeting.timezone"), index)}
                          .value=${row.timezone}
                          @input=${update(row, "timezone")}
                        />
                      </td>
                      <td class="logistics-schools__cell">
                        <input
                          class="logistics-schools__input"
                          type="number"
                          min="5"
                          max="480"
                          step="5"
                          aria-label=${cellLabel(t("logistics.meeting.length"), index)}
                          placeholder=${t("logistics.meeting.lengthPlaceholder")}
                          .value=${row.lengthMinutes}
                          @input=${update(row, "lengthMinutes")}
                        />
                      </td>
                      <td class="logistics-schools__cell logistics-schools__cell--remove">
                        <button
                          class="btn btn--icon btn--xs"
                          type="button"
                          aria-label=${t("logistics.meeting.removeRow", { row: String(index + 1) })}
                          @click=${() =>
                            props.onRowsChange(
                              props.rows.filter((candidate) => candidate.id !== row.id),
                            )}
                        >
                          ${icons.x}
                        </button>
                      </td>
                    </tr>
                  `,
                )
              : html`
                  <tr>
                    <td class="logistics-schools__empty" colspan="6">
                      ${t("logistics.meeting.empty")}
                    </td>
                  </tr>
                `}
          </tbody>
        </table>
      </div>

      <div class="logistics-schools__actions">
        <button
          class="btn btn--sm"
          type="button"
          data-testid="logistics-meeting-add"
          @click=${() => props.onRowsChange([...props.rows, createMeetingRow()])}
        >
          <span aria-hidden="true">${icons.plus}</span>
          ${t("logistics.meeting.add")}
        </button>
      </div>
    </section>
  `;
}

// The two links a letter request carries. Both are one line of URL, so they share a shape: the
// heading is the field's name and labels the input through aria-labelledby, since a visible <label>
// beside it would only say the heading over again.
type LinkFieldProps = {
  testId: string;
  titleId: string;
  title: string;
  // The line under the heading, which for the Drive field carries the link to the templates.
  description: unknown;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
};

function renderLinkField(props: LinkFieldProps) {
  return html`
    <section class="logistics-request__section logistics-link" data-testid=${props.testId}>
      <h3 class="card-title" id=${props.titleId}>${props.title}</h3>
      <p class="card-sub">${props.description}</p>
      <input
        class="logistics-link__input"
        type="url"
        inputmode="url"
        aria-labelledby=${props.titleId}
        placeholder=${props.placeholder}
        .value=${props.value}
        @input=${(event: Event) => {
          const field = event.currentTarget;
          if (field instanceof HTMLInputElement) {
            props.onChange(field.value);
          }
        }}
      />
    </section>
  `;
}

function renderCvOverleafSection(props: LettersProps) {
  return renderLinkField({
    testId: "logistics-cv-overleaf",
    titleId: "logistics-cv-overleaf-title",
    title: t("logistics.cvOverleaf.title"),
    description: t("logistics.cvOverleaf.sub"),
    placeholder: t("logistics.cvOverleaf.placeholder"),
    value: props.cvOverleafUrl,
    onChange: props.onCvOverleafUrlChange,
  });
}

function renderDriveFolderSection(props: LettersProps) {
  return renderLinkField({
    testId: "logistics-drive-folder",
    titleId: "logistics-drive-folder-title",
    title: t("logistics.driveFolder.title"),
    // The templates are read from the lab's folder and filled in somewhere the member owns, so the
    // link out and the box to paste back into belong to the same instruction.
    description: html`
      ${t("logistics.driveFolder.sub")}
      <a
        class="logistics-link__folder"
        href=${TEMPLATE_FOLDER_URL}
        target="_blank"
        rel="noreferrer noopener"
        >${t("logistics.driveFolder.templates")}
        <span aria-hidden="true">${icons.externalLink}</span>
      </a>
    `,
    placeholder: t("logistics.driveFolder.placeholder"),
    value: props.driveFolderUrl,
    onChange: props.onDriveFolderUrlChange,
  });
}

// One container for the whole request: the documents, the optional context that travels with them,
// and the two actions that close it out.
function renderSignatureRequest(props: SignatureProps) {
  return html`
    <div
      class="card adminbot-card adminbot-card--wide logistics-upload logistics-request"
      data-testid="logistics-request"
    >
      ${renderSignatureSection(props)} ${renderSupportingSection(props)}
      ${renderRequestActions(props)}
    </div>
  `;
}

// The same container shape for letters: the schools the request covers, the two links that travel
// with it, then Save and Submit.
function renderLettersRequest(props: LettersProps) {
  return html`
    <div
      class="card adminbot-card adminbot-card--wide logistics-request"
      data-testid="logistics-letters"
    >
      ${renderSchoolsSection(props)} ${renderFactsSection(props)} ${renderCvOverleafSection(props)}
      ${renderDriveFolderSection(props)} ${renderRequestActions(props)}
    </div>
  `;
}

// The same container shape again for Book Meeting: one table, then Save and Submit.
function renderMeetingRequest(props: MeetingProps) {
  return html`
    <div
      class="card adminbot-card adminbot-card--wide logistics-request"
      data-testid="logistics-meeting-request"
    >
      ${renderMeetingSection(props)} ${renderRequestActions(props)}
    </div>
  `;
}

const TEMPLATE_BUTTONS: {
  template: LogisticsTemplate | null;
  labelKey: string;
  icon: (typeof icons)[keyof typeof icons];
}[] = [
  {
    template: "documentSignature",
    labelKey: "logistics.templates.documentSignature",
    icon: icons.penLine,
  },
  {
    template: "recommendationLetters",
    labelKey: "logistics.templates.recommendationLetters",
    icon: icons.fileText,
  },
  {
    template: "bookMeeting",
    labelKey: "logistics.templates.bookMeeting",
    icon: icons.clock,
  },
];

function renderTemplates(props: AdminBotLogisticsProps) {
  return html`
    <div class="card adminbot-card adminbot-card--wide" data-testid="logistics-templates">
      <div class="card-title">${t("logistics.templates.title")}</div>
      <div class="card-sub">${t("logistics.templates.sub")}</div>
      <div class="logistics__templates">
        ${TEMPLATE_BUTTONS.map((entry) => {
          const selected = entry.template !== null && entry.template === props.template;
          return html`
            <button
              class="btn logistics__template ${selected ? "active" : ""}"
              type="button"
              aria-pressed=${entry.template ? String(selected) : nothing}
              @click=${() => {
                if (entry.template) {
                  props.onTemplateChange(entry.template);
                }
              }}
            >
              <span class="logistics__template-icon" aria-hidden="true">${entry.icon}</span>
              ${t(entry.labelKey)}
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

/**
 * Above the templates, because it decides what the rest of the page is: making a request, or
 * reading the ones already made.
 *
 * Everyone gets both modes now that requests are stored by the service -- a member who cannot see
 * what they asked for has no way to check whether it arrived, and no way to take it back. What
 * differs is what the list holds: the service scopes it to the caller, so a member's "view" is
 * their own requests and an admin's is the lab's queue. The badge says which one you are reading.
 */
function renderAdminModes(props: AdminBotLogisticsProps, mode: LogisticsMode) {
  const button = (target: LogisticsMode, labelKey: string, icon: unknown) => html`
    <button
      class="btn logistics__template ${mode === target ? "active" : ""}"
      type="button"
      aria-pressed=${String(mode === target)}
      @click=${() => props.onModeChange(target)}
    >
      <span class="logistics__template-icon" aria-hidden="true">${icon}</span>
      ${t(labelKey)}
    </button>
  `;
  const isAdmin = props.role === "admin";
  return html`
    <div class="card adminbot-card adminbot-card--wide" data-testid="logistics-admin">
      <div class="logistics-admin__heading">
        <div class="card-title">${t("logistics.admin.title")}</div>
        ${isAdmin ? html`<span class="pill">${t("logistics.admin.badge")}</span>` : nothing}
      </div>
      <div class="card-sub">
        ${isAdmin ? t("logistics.admin.sub") : t("logistics.admin.memberSub")}
      </div>
      <div class="logistics__templates">
        ${button("make", "logistics.admin.make", icons.penLine)}
        ${button(
          "view",
          isAdmin ? "logistics.admin.view" : "logistics.admin.viewMine",
          icons.scrollText,
        )}
      </div>
    </div>
  `;
}

function renderMakeRequest(props: AdminBotLogisticsProps) {
  return html`
    ${renderTemplates(props)}
    ${props.template === "recommendationLetters"
      ? renderLettersRequest(props.letters)
      : props.template === "documentSignature"
        ? renderSignatureRequest(props.signature)
        : props.template === "bookMeeting"
          ? renderMeetingRequest(props.meeting)
          : nothing}
  `;
}

export function renderAdminBotLogistics(props: AdminBotLogisticsProps) {
  return html`
    <section class="adminbot-shell logistics" data-testid="adminbot-logistics">
      ${renderAdminModes(props, props.mode)}
      ${props.mode !== "view"
        ? renderMakeRequest(props)
        : // An open request is a card either way: the queue is for working across rows, and reading
          // one request in full is the same job for an admin as for anybody else.
          props.role === "admin" && !props.requests.open && !props.requests.openLoading
          ? renderAdminBotLogisticsQueue(props.queue)
          : renderAdminBotLogisticsRequests(props.requests)}
    </section>
  `;
}
