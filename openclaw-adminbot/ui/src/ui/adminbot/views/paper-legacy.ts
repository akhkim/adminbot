// My Projects & Papers as a profile page: every field of every paper, flat.
//
// The third drawing of the same papers, beside the cards and the sheet, and it exists because the
// other two answer different questions. The card is a workflow -- what is this paper waiting on,
// what moves it next -- so it groups by stage, hides what is not yet relevant and puts a control
// behind a disclosure. The sheet is a bulk editor: one row per paper, built for pasting a column
// out of Google Sheets. Neither answers "show me everything recorded about this paper, in one
// list, the way my own profile shows everything recorded about me".
//
// So this borrows the profile's markup rather than inventing a third look: the same
// `profile__field-group` sections, the same label-plus-control rows, the same debounced autosave
// with an explicit Save beside it. Someone who has filled in their profile already knows how to
// use this, which is the entire point of copying it.
//
// Two stores behind one form. The paper *record* (title, alias, authors, venue, the acceptance
// details) is written with onSavePaper; the 24 PaperFlow evidence slots are written one at a time
// with onSaveSlot. The form does not care -- it diffs what changed and sends each half to the
// endpoint that owns it, so a member types in one place and never learns there were two.
//
// Links appear once, as slots. The record also carries `artifacts.overleaf_edit_url` and friends,
// and the sheet offers both -- but the same URL in two rows of one form is an invitation to type
// two different answers, and the evidence slot is the copy the card, the nudge and the completion
// count all read.

import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import {
  adminBotPaperPresentationTypes,
  adminBotPaperVenueDecisions,
  type AdminBotPaperStep,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import {
  adminBotPaperSlotChartOrder,
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  adminBotPosterPhysicalStates,
  validateAdminBotPaperSlotUrl,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotBranch,
} from "../../../../../extensions/adminbot/src/contracts/paper-slots.js";
import { icons } from "../../icons.ts";
import type { PaperCycle, PaperSlotRow } from "../auth/session.ts";
import { flushAutosave, focusLeftForm, scheduleAutosave } from "../autosave.ts";
import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "../controllers/admin.ts";
import { paperSteps, stepLabels } from "./admin.ts";

/** What one control writes back, and to which of the two stores. */
type LegacyField =
  | {
      kind: "record";
      key: string;
      label: string;
      control: "text" | "date" | "number" | "paragraph" | "select";
      options?: readonly string[];
      optionLabel?: (value: string) => string;
      hint?: string;
      example?: string;
      value: (paper: AdminBotPaperRecord) => string;
    }
  | {
      kind: "slot";
      key: string;
      label: string;
      slot: AdminBotPaperSlot;
      /** The enum slot's free-text half rides in its own row-sibling, keyed `<slot>__note`. */
      note?: boolean;
    };

type LegacyGroup = {
  id: string;
  label: string;
  icon: keyof typeof icons;
  fields: LegacyField[];
};

const VENUE_DECISION_LABELS: Record<string, string> = {
  pending: "Still waiting",
  accept: "Accepted",
  reject: "Rejected",
};

const YES_NO = ["yes", "no"] as const;

const POSTER_STATE_LABELS: Record<string, string> = {
  not_needed: "Not needed",
  to_print: "To print",
  printed: "Printed",
  with_author: "With the author",
  shipped: "Shipped",
};

/** Branch headings, in the chart's own reading order. Matches the card, so the two agree. */
const BRANCH_LABELS: Record<AdminBotPaperSlotBranch, string> = {
  core: "Writing and submission",
  talk: "Talk",
  social: "Social",
  archive: "Archive",
  venue: "Conference",
};

const BRANCH_ICONS: Record<AdminBotPaperSlotBranch, keyof typeof icons> = {
  core: "penLine",
  talk: "mic",
  social: "send",
  archive: "archive",
  venue: "clock",
};

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The record half, grouped the way the profile groups a person: who it is, where it is going.
 *
 * `current_step` is here rather than left to the card's stepper because this view's promise is
 * that everything on the record is on this page -- a field the reader can see on the card but not
 * here would send them back to the card to find it, which is the trip this view exists to save.
 */
const RECORD_GROUPS: LegacyGroup[] = [
  {
    id: "project",
    label: "Project",
    icon: "fileText",
    fields: [
      {
        kind: "record",
        key: "title",
        label: "Title",
        control: "text",
        example: "A causal framework for robustness",
        value: (paper) => paper.title ?? "",
      },
      {
        kind: "record",
        key: "alias",
        label: "Short name",
        control: "text",
        hint: "What the lab calls it out loud. Becomes the Slack channel proj-<name>.",
        example: "cais",
        value: (paper) => paper.alias ?? "",
      },
      {
        kind: "record",
        key: "authors",
        label: "Authors",
        control: "text",
        hint: "In the order the paper prints them, separated by commas.",
        example: "Ada Lovelace, Bob Coauthor",
        value: (paper) => (paper.authors ?? []).join(", "),
      },
      {
        kind: "record",
        key: "authorRoles",
        label: "Who did what",
        control: "paragraph",
        hint: "A paragraph you can paste into the contributions statement.",
        value: (paper) => paper.author_roles ?? "",
      },
      {
        kind: "record",
        key: "startedOn",
        label: "Started on",
        control: "date",
        value: (paper) => paper.started_on ?? "",
      },
      {
        kind: "record",
        key: "currentStep",
        label: "Current step",
        control: "select",
        options: paperSteps,
        optionLabel: (value) => stepLabels[value as AdminBotPaperStep] ?? value,
        value: (paper) => paper.current_step ?? "",
      },
    ],
  },
  {
    id: "venue",
    label: "Venue",
    icon: "clock",
    fields: [
      {
        kind: "record",
        key: "venue",
        label: "Target venue",
        control: "text",
        example: "EMNLP 2026",
        value: (paper) => paper.venue ?? "",
      },
      {
        kind: "record",
        key: "confidence",
        label: "Confidence",
        control: "text",
        hint: "How likely the authors think this venue is, as a percentage.",
        example: "60",
        value: (paper) => paper.artifacts?.confidence ?? "",
      },
      {
        kind: "record",
        key: "venueDecision",
        label: "Decision",
        control: "select",
        options: adminBotPaperVenueDecisions,
        optionLabel: (value) => VENUE_DECISION_LABELS[value] ?? value,
        value: (paper) => paper.venue_decision ?? "",
      },
      // The four acceptance details. Nothing infers these; the conference branch -- who is going,
      // posters, reimbursements -- stays shut until all four are in, which is why they sit
      // together rather than beside the decision that opened them.
      {
        kind: "record",
        key: "acceptedVenue",
        label: "Accepted venue",
        control: "text",
        example: "EMNLP",
        value: (paper) => paper.accepted_venue ?? "",
      },
      {
        kind: "record",
        key: "acceptedYear",
        label: "Year",
        control: "number",
        example: "2026",
        value: (paper) =>
          typeof paper.accepted_year === "number" ? String(paper.accepted_year) : "",
      },
      {
        kind: "record",
        key: "isArchival",
        label: "Archival",
        control: "select",
        options: YES_NO,
        optionLabel: title,
        hint: "Whether this counts as a publication. The same workshop can be either.",
        value: (paper) =>
          typeof paper.is_archival === "boolean" ? (paper.is_archival ? "yes" : "no") : "",
      },
      {
        kind: "record",
        key: "presentationType",
        label: "Presentation",
        control: "select",
        options: adminBotPaperPresentationTypes,
        optionLabel: title,
        value: (paper) => paper.presentation_type ?? "",
      },
    ],
  },
];

/** The 24 evidence slots, grouped by the branch they hang off on the PaperFlow chart. */
function slotGroups(): LegacyGroup[] {
  return adminBotPaperSlotChartOrder
    .map((branch) => ({
      id: `slots-${branch}`,
      label: BRANCH_LABELS[branch],
      icon: BRANCH_ICONS[branch],
      fields: adminBotPaperSlots
        .filter((slot) => adminBotPaperSlotRegistry[slot].branch === branch)
        .map((slot) => {
          const definition = adminBotPaperSlotRegistry[slot];
          return {
            kind: "slot" as const,
            key: slot,
            label: definition.label,
            slot,
            ...(definition.kind === "enum" ? { note: true } : {}),
          };
        }),
    }))
    .filter((group) => group.fields.length > 0);
}

export function legacyGroups(): LegacyGroup[] {
  return [...RECORD_GROUPS, ...slotGroups()];
}

// --- state -------------------------------------------------------------------------------

/**
 * What has been typed and not yet sent, per paper.
 *
 * Module state for the same reason the sheet's is: it changes nothing about the papers, nobody
 * needs it after a reload, and keeping it here means a re-render mid-edit does not throw away a
 * half-typed URL.
 */
export type PaperLegacyState = {
  edits: Map<string, Map<string, string>>;
  /** Papers whose evidence has been asked for, so the fetch happens once each. */
  slotsRequested: Set<string>;
  notice: string | null;
};

export function emptyPaperLegacyState(): PaperLegacyState {
  return { edits: new Map(), slotsRequested: new Set(), notice: null };
}

function editsFor(state: PaperLegacyState, paperId: string): Map<string, string> {
  const existing = state.edits.get(paperId);
  if (existing) {
    return existing;
  }
  const fresh = new Map<string, string>();
  state.edits.set(paperId, fresh);
  return fresh;
}

/** The value on file for one field, before anything was typed over it. */
function storedValue(
  field: LegacyField,
  paper: AdminBotPaperRecord,
  cycle: PaperCycle | undefined,
  note: boolean,
): string {
  if (field.kind === "record") {
    return field.value(paper);
  }
  const row = cycle?.slots?.find((entry: PaperSlotRow) => entry.slot === field.slot);
  if (!row) {
    return "";
  }
  const definition = adminBotPaperSlotRegistry[field.slot];
  if (note) {
    return row.value_note ?? "";
  }
  switch (definition.kind) {
    case "link":
      return row.url ?? "";
    case "bool":
      return row.status === "provided" ? "yes" : "";
    default:
      return row.value_text ?? "";
  }
}

/** What the control shows: the typed value where there is one, the stored value otherwise. */
function liveValue(
  state: PaperLegacyState,
  field: LegacyField,
  paper: AdminBotPaperRecord,
  cycle: PaperCycle | undefined,
  note = false,
): string {
  const key = note ? `${field.key}__note` : field.key;
  const typed = state.edits.get(paper.id)?.get(key);
  return typed ?? storedValue(field, paper, cycle, note);
}

/**
 * The refusal for one typed value, or null.
 *
 * Advisory and per field, like the sheet's: a bad arXiv URL marks its own row and still lets the
 * title beside it save. The service re-validates everything regardless.
 */
export function legacyFieldError(field: LegacyField, value: string): string | null {
  if (!value.trim()) {
    return null;
  }
  if (field.kind === "slot") {
    const definition = adminBotPaperSlotRegistry[field.slot];
    if (definition.kind === "link") {
      const check = validateAdminBotPaperSlotUrl(field.slot, value);
      return check.ok ? null : check.reason;
    }
    if (definition.kind === "secret6" && !/^[a-z0-9]{6}$/iu.test(value.trim())) {
      return "Six letters and digits, as arXiv issues it.";
    }
    return null;
  }
  if (field.key === "acceptedYear" && !/^\d{4}$/u.test(value.trim())) {
    return "A four-digit year.";
  }
  return null;
}

// --- saving ------------------------------------------------------------------------------

export type PaperLegacyWrites = {
  record: AdminBotPaperSaveInput | null;
  slots: Array<{
    slot: string;
    input: { url?: string; value_text?: string; value_note?: string; done?: boolean };
  }>;
};

/**
 * Turn one paper's typed edits into the two shapes the two endpoints take.
 *
 * Only what changed. The record write is all-or-nothing by nature -- upsertPaper takes the whole
 * record -- so it carries the stored value for every field the reader did not touch; the slot
 * writes are one per slot and are skipped entirely for slots nobody edited, which is what keeps a
 * Save from firing 24 requests every time somebody fixes a typo in the title.
 */
export function collectLegacyWrites(
  state: PaperLegacyState,
  paper: AdminBotPaperRecord,
  cycle: PaperCycle | undefined,
): PaperLegacyWrites {
  const typed = state.edits.get(paper.id);
  const writes: PaperLegacyWrites = { record: null, slots: [] };
  if (!typed || typed.size === 0) {
    return writes;
  }
  const groups = legacyGroups();
  const all = groups.flatMap((group) => group.fields);
  const recordTouched = all.some(
    (field) =>
      field.kind === "record" &&
      typed.has(field.key) &&
      !legacyFieldError(field, typed.get(field.key) ?? ""),
  );

  if (recordTouched) {
    const read = (key: string): string => {
      const field = all.find((entry) => entry.kind === "record" && entry.key === key);
      return field ? liveValue(state, field, paper, cycle) : "";
    };
    const year = read("acceptedYear").trim();
    writes.record = {
      id: paper.id,
      title: read("title").trim(),
      authors: read("authors")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
      currentStep: (read("currentStep") || paper.current_step) as AdminBotPaperStep,
      alias: read("alias").trim(),
      startedOn: read("startedOn").trim(),
      authorRoles: read("authorRoles"),
      venue: read("venue").trim(),
      confidence: read("confidence").trim(),
      venueDecision: read("venueDecision"),
      acceptedVenue: read("acceptedVenue").trim(),
      // Sent only when it is a real year: the service parses this, and "20" on the way to typing
      // "2026" would otherwise land as a decision about the paper.
      ...(/^\d{4}$/u.test(year) ? { acceptedYear: year } : {}),
      isArchival: read("isArchival"),
      presentationType: read("presentationType"),
    };
  }

  for (const field of all) {
    if (field.kind !== "slot") {
      continue;
    }
    const definition = adminBotPaperSlotRegistry[field.slot];
    if (definition.derived) {
      continue;
    }
    const valueKey = field.key;
    const noteKey = `${field.key}__note`;
    if (!typed.has(valueKey) && !typed.has(noteKey)) {
      continue;
    }
    const value = liveValue(state, field, paper, cycle);
    if (legacyFieldError(field, value)) {
      continue;
    }
    switch (definition.kind) {
      case "link":
        writes.slots.push({ slot: field.slot, input: { url: value.trim() } });
        break;
      case "bool":
        writes.slots.push({ slot: field.slot, input: { done: value === "yes" } });
        break;
      case "enum":
        writes.slots.push({
          slot: field.slot,
          input: {
            value_text: value,
            value_note: liveValue(state, field, paper, cycle, true),
          },
        });
        break;
      default:
        writes.slots.push({ slot: field.slot, input: { value_text: value.trim() } });
    }
  }
  return writes;
}

// --- rendering ---------------------------------------------------------------------------

export type PaperLegacyProps = {
  state: PaperLegacyState;
  papers: AdminBotPaperRecord[];
  slots?: Record<string, PaperCycle>;
  onLoadSlots?: (paperId: string) => void;
  onSavePaper: (input: AdminBotPaperSaveInput) => void;
  onSaveSlot: (
    paperId: string,
    slot: string,
    input: { url?: string; value_text?: string; value_note?: string; done?: boolean },
  ) => void;
  onChange: () => void;
  onExit: () => void;
};

/**
 * Asks the host for every paper's evidence, once each.
 *
 * Deferred out of the render pass for the reason the sheet defers it: a fetch that resolves
 * synchronously in a test would otherwise re-enter Lit mid-template.
 */
function requestEvidence(props: PaperLegacyProps): void {
  if (!props.onLoadSlots) {
    return;
  }
  const wanted = props.papers
    .filter((paper) => !props.slots?.[paper.id] && !props.state.slotsRequested.has(paper.id))
    .map((paper) => paper.id);
  if (wanted.length === 0) {
    return;
  }
  for (const id of wanted) {
    props.state.slotsRequested.add(id);
  }
  queueMicrotask(() => {
    for (const id of wanted) {
      props.onLoadSlots?.(id);
    }
  });
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function commitPaper(props: PaperLegacyProps, paper: AdminBotPaperRecord): () => void {
  return () => {
    const cycle = props.slots?.[paper.id];
    const writes = collectLegacyWrites(props.state, paper, cycle);
    if (!writes.record && writes.slots.length === 0) {
      return;
    }
    if (writes.record) {
      props.onSavePaper(writes.record);
    }
    for (const write of writes.slots) {
      props.onSaveSlot(paper.id, write.slot, write.input);
    }
    // Cleared only for what was actually sent: a field still carrying a refusal keeps its typed
    // value, so the reader can see and fix what was rejected instead of watching it revert.
    const typed = props.state.edits.get(paper.id);
    if (typed) {
      for (const field of legacyGroups().flatMap((group) => group.fields)) {
        const value = liveValue(props.state, field, paper, cycle);
        if (!legacyFieldError(field, value)) {
          typed.delete(field.key);
          typed.delete(`${field.key}__note`);
        }
      }
    }
    props.state.notice = `Saved ${paper.title}.`;
    props.onChange();
  };
}

function renderControl(
  props: PaperLegacyProps,
  paper: AdminBotPaperRecord,
  field: LegacyField,
  note: boolean,
): TemplateResult {
  const cycle = props.slots?.[paper.id];
  const value = liveValue(props.state, field, paper, cycle, note);
  const key = note ? `${field.key}__note` : field.key;
  const testId = `paper-legacy-${paper.id}-${key}`;
  const onEdit = (next: string) => {
    editsFor(props.state, paper.id).set(key, next);
    props.onChange();
  };

  if (field.kind === "slot") {
    const definition = adminBotPaperSlotRegistry[field.slot];
    if (definition.derived) {
      // Status comes from the social drafts and this slot rejects direct writes, so a control here
      // would be a lie. The card says the same thing.
      const row = cycle?.slots?.find((entry: PaperSlotRow) => entry.slot === field.slot);
      return html`<span class="paper-legacy__derived" data-testid=${testId}
        >${row?.status === "provided" ? "Done" : "Set by the drafts above"}</span
      >`;
    }
    if (definition.kind === "bool" && !note) {
      return html`<input
        class="paper-legacy__check"
        type="checkbox"
        data-testid=${testId}
        .checked=${value === "yes"}
        @change=${(event: Event) => onEdit((event.target as HTMLInputElement).checked ? "yes" : "")}
      />`;
    }
    if (definition.kind === "enum" && !note) {
      return html`<select
        class="input"
        aria-label=${field.label}
        data-testid=${testId}
        @change=${(event: Event) => onEdit((event.target as HTMLSelectElement).value)}
      >
        <option value="" ?selected=${!value}></option>
        ${adminBotPosterPhysicalStates.map(
          (option) => html`<option value=${option} ?selected=${option === value}>
            ${POSTER_STATE_LABELS[option] ?? option}
          </option>`,
        )}
      </select>`;
    }
    return html`<input
      class="input"
      type=${definition.kind === "link" ? "url" : "text"}
      maxlength=${ifDefined(definition.kind === "secret6" ? 6 : undefined)}
      placeholder=${ifDefined(note ? "Where it physically is" : definition.example)}
      aria-label=${note ? `${field.label} — where it physically is` : field.label}
      data-testid=${testId}
      .value=${value}
      @input=${(event: Event) => onEdit((event.target as HTMLInputElement).value)}
    />`;
  }

  if (field.control === "select") {
    return html`<select
      class="input"
      data-testid=${testId}
      @change=${(event: Event) => onEdit((event.target as HTMLSelectElement).value)}
    >
      <option value="" ?selected=${!value}></option>
      ${(field.options ?? []).map(
        (option) => html`<option value=${option} ?selected=${option === value}>
          ${field.optionLabel ? field.optionLabel(option) : option}
        </option>`,
      )}
    </select>`;
  }
  if (field.control === "paragraph") {
    return html`<textarea
      class="input"
      rows="3"
      placeholder=${ifDefined(field.example)}
      data-testid=${testId}
      .value=${value}
      @input=${(event: Event) => onEdit((event.target as HTMLTextAreaElement).value)}
    ></textarea>`;
  }
  return html`<input
    class="input"
    type=${field.control === "date" ? "date" : field.control === "number" ? "number" : "text"}
    placeholder=${ifDefined(field.example)}
    data-testid=${testId}
    .value=${value}
    @input=${(event: Event) => onEdit((event.target as HTMLInputElement).value)}
  />`;
}

function renderRow(
  props: PaperLegacyProps,
  paper: AdminBotPaperRecord,
  field: LegacyField,
): TemplateResult {
  const cycle = props.slots?.[paper.id];
  const error = legacyFieldError(field, liveValue(props.state, field, paper, cycle));
  const hint = field.kind === "record" ? field.hint : adminBotPaperSlotRegistry[field.slot].hint;
  const paired = field.kind === "slot" && Boolean(field.note);
  const body = html`
    <span class="profile__form-label">${field.label}</span>
    ${renderControl(props, paper, field, false)}
    ${paired
      ? html`<span class="paper-legacy__note">${renderControl(props, paper, field, true)}</span>`
      : nothing}
    ${hint ? html`<span class="paper-legacy__hint">${hint}</span>` : nothing}
    ${error
      ? html`<span
          class="paper-legacy__error"
          role="alert"
          data-testid=${`paper-legacy-error-${paper.id}-${field.key}`}
          >${error}</span
        >`
      : nothing}
  `;
  // A `<label>` forwards a click anywhere inside it to the first labelable control it contains, so
  // the one row holding two -- the poster's state and the note saying where it physically is --
  // would put the cursor in the dropdown when somebody clicked the note. That row gets a plain
  // container and its controls carry their own accessible names, which is the same exception the
  // profile makes for its checkbox groups.
  return paired
    ? html`<div class="profile__form-row">${body}</div>`
    : html`<label class="profile__form-row">${body}</label>`;
}

function renderPaper(props: PaperLegacyProps, paper: AdminBotPaperRecord): TemplateResult {
  const loading = Boolean(props.onLoadSlots) && !props.slots?.[paper.id];
  const commit = commitPaper(props, paper);
  const timerKey = paper.id;
  return html`
    <section
      class="profile__section paper-legacy__paper"
      data-testid=${`paper-legacy-paper-${paper.id}`}
    >
      <div class="profile__section-head">
        <h2 class="profile__section-title">${paper.title}</h2>
      </div>
      <form
        class="profile__form"
        @submit=${(event: SubmitEvent) => event.preventDefault()}
        @input=${() =>
          scheduleAutosave(
            saveTimers.get(timerKey),
            (next) => {
              if (next) {
                saveTimers.set(timerKey, next);
              } else {
                saveTimers.delete(timerKey);
              }
            },
            commit,
          )}
        @focusout=${(event: FocusEvent) => {
          const form = event.currentTarget as HTMLFormElement;
          if (!focusLeftForm(form, event)) {
            return;
          }
          // Leaving commits immediately rather than waiting out the debounce: the reader may be on
          // their way to another paper, and a pending timer would not survive it.
          flushAutosave(
            saveTimers.get(timerKey),
            (next) => {
              if (next) {
                saveTimers.set(timerKey, next);
              } else {
                saveTimers.delete(timerKey);
              }
            },
            commit,
          );
        }}
      >
        ${legacyGroups().map((group) => {
          // The evidence bands stay on the page while they load rather than appearing late: a
          // section that pops in after the record fields have settled reads as the form growing
          // under the reader's hands.
          const evidence = group.id.startsWith("slots-");
          return html`
            <div class="profile__field-group">
              <h3 class="profile__group-title">
                <span class="profile__group-icon" aria-hidden="true">${icons[group.icon]}</span>
                ${group.label}
                ${evidence && loading
                  ? html`<span class="paper-legacy__loading">loading…</span>`
                  : nothing}
              </h3>
              <div class="profile__field-grid">
                ${group.fields.map((field) => renderRow(props, paper, field))}
              </div>
            </div>
          `;
        })}
        <div class="profile__form-actions">
          <span class="profile__autosave-hint">Saves as you type.</span>
          <button
            type="button"
            class="btn primary"
            data-testid=${`paper-legacy-save-${paper.id}`}
            @click=${commit}
          >
            Save
          </button>
        </div>
      </form>
    </section>
  `;
}

export function renderPaperLegacy(props: PaperLegacyProps): TemplateResult {
  requestEvidence(props);
  return html`
    <div class="paper-legacy" data-testid="paper-legacy">
      <div class="paper-legacy__head">
        <p class="paper-legacy__lead">
          Every field on every paper, laid out like your profile. The card view groups the same
          answers by what each one unblocks.
        </p>
        <button
          type="button"
          class="btn btn--sm"
          data-testid="paper-legacy-exit"
          @click=${props.onExit}
        >
          Back to cards
        </button>
      </div>
      ${props.state.notice
        ? html`<p class="paper-legacy__notice" role="status">${props.state.notice}</p>`
        : nothing}
      ${props.papers.length === 0
        ? html`<p class="my-work__empty">Nothing here yet.</p>`
        : props.papers.map((paper) => renderPaper(props, paper))}
    </div>
  `;
}
