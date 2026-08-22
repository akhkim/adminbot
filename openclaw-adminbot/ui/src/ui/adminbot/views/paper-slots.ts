// The inside of a paper card, drawn to the shape of the PaperFlow chart.
//
// The chart is a trunk with four numbered branches hanging off "Compiled paper PDF ready", and
// this reads the same way: the writing steps as a spine, then Branch 1..4 in the chart's own
// order. The old card was five flat sections in a different order, which showed the same fields
// but hid the one fact the chart exists to convey -- that the four branches open together, and
// only once the paper compiles.
//
// Two halves, deliberately distinguishable at a glance: fields a person fills in, and the venue
// ladder that fills itself in from the bcc loop (contracts/paperflow-stages.ts). Mixing them was
// what made the card feel like a form with no end -- half of it was asking for facts the venue
// had not produced yet.
//
// It is the profile page's shape applied to a paper. A member's own record is a list of typed
// fields with a required mark, a hint about the shape each one accepts, and autosave -- and the
// evidence a paper collects is exactly the same kind of list, so it reads the same way rather
// than inventing a second vocabulary for the same idea.
//
// The registry is imported from the service's contracts module rather than restated here. What a
// slot is called, what kind of answer it takes, which hosts a link may be on and what it gates are
// one list that the server validates against and this form renders from -- so a field can never
// offer a shape the service will refuse.
import { html, nothing } from "lit";
import {
  adminBotPaperFlowBranchNumber,
  adminBotPaperSlotChartOrder,
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  adminBotPosterPhysicalStates,
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotBranch,
  type AdminBotPaperSlotDefinition,
} from "../../../../../extensions/adminbot/src/contracts/paper-slots.js";
import { icons } from "../../icons.ts";
import type { PaperflowStageRow, PaperSlotRow } from "../auth/session.ts";

export type PaperDetailsProps = {
  authors: string[];
  feedbackGivers: string[];
  venue: string;
  /** Absent for a reader who may not edit this paper; the block renders read-only instead. */
  onSaveDetails?: (details: { authors: string[]; feedbackGivers: string[]; venue: string }) => void;
};

export type PaperSlotsProps = {
  paperId: string;
  slots: PaperSlotRow[];
  /** The venue ladder. Empty for a card whose paper has not been fetched with stages. */
  stages?: PaperflowStageRow[];
  details?: PaperDetailsProps;
  loading: boolean;
  onSaveSlot: (
    slot: string,
    input: { url?: string; value_text?: string; value_note?: string; done?: boolean },
  ) => void;
};

/** Plain-English states for the one enum slot. */
const POSTER_PHYSICAL_LABELS: Record<string, string> = {
  not_needed: "Not needed",
  to_print: "Still to print",
  printed: "Printed",
  with_author: "With the author",
  shipped: "Shipped",
};

const BRANCH_LABELS: Record<AdminBotPaperSlotBranch, string> = {
  core: "Writing",
  venue: "Venue",
  archive: "Archival",
  social: "Social",
  talk: "Presentation",
};

/** What each branch is for, in the chart's own terms. One line, or the card becomes a manual. */
const BRANCH_BLURBS: Record<AdminBotPaperSlotBranch, string> = {
  core: "The trunk. Everything below opens once the paper compiles.",
  talk: "Slides, and the poster and video that come off them.",
  social: "The announcement, and the coauthors who sign it off.",
  archive: "The Drive copy, the arXiv package, and the gate before it goes public.",
  venue: "Submission, and the stages the venue answers on its own clock.",
};

const BRANCH_ICONS: Record<AdminBotPaperSlotBranch, keyof typeof icons> = {
  core: "fileText",
  venue: "send",
  archive: "archive",
  social: "globe",
  talk: "monitor",
};

const OWNER_LABELS: Record<string, string> = {
  first_author: "first author",
  coauthors: "coauthors",
  pi: "the PI",
  admin: "an admin",
};

function rowFor(slots: PaperSlotRow[], slot: AdminBotPaperSlot): PaperSlotRow | undefined {
  return slots.find((row) => row.slot === slot);
}

/**
 * Whether a field is worth filling in yet.
 *
 * A slot whose upstream evidence is still missing is shown, not hidden -- the checklist is the
 * point -- but it says what it is waiting for. Hiding it would make the card grow as work
 * progressed, which reads as the paper acquiring new requirements rather than revealing them.
 */
function waitingOn(definition: AdminBotPaperSlotDefinition, slots: PaperSlotRow[]): string | null {
  const blocked = definition.upstream.filter(
    (slot) => !isAdminBotPaperSlotSettled(rowFor(slots, slot)?.status ?? "missing"),
  );
  if (blocked.length === 0) {
    return null;
  }
  return blocked.map((slot) => adminBotPaperSlotRegistry[slot].label).join(" and ");
}

function statusPill(row: PaperSlotRow | undefined) {
  const status = row?.status ?? "missing";
  switch (status) {
    case "provided":
      return html`<span class="paper-slot__pill paper-slot__pill--done">Provided</span>`;
    case "invalid":
      return html`<span class="paper-slot__pill paper-slot__pill--invalid">Needs fixing</span>`;
    case "waived":
      return html`<span class="paper-slot__pill paper-slot__pill--waived">Waived</span>`;
    default:
      return html`<span class="paper-slot__pill">Missing</span>`;
  }
}

/** The accepted shape, from the same host and path list the service validates against. */
function shapeHint(definition: AdminBotPaperSlotDefinition): string | null {
  if (definition.kind !== "link") {
    return null;
  }
  const hosts = definition.urlHosts?.length ? definition.urlHosts.join(" or ") : "any https link";
  const path = definition.urlPath?.length ? `, a ${definition.urlPath.join(" or ")} URL` : "";
  return `${hosts}${path}`;
}

function renderInput(
  props: PaperSlotsProps,
  slot: AdminBotPaperSlot,
  definition: AdminBotPaperSlotDefinition,
  row: PaperSlotRow | undefined,
) {
  const disabled = row?.status === "waived";
  // Commit on change rather than on every keystroke: a URL is meaningless half-typed, and the
  // service answers a partial one with an `invalid` it would then have to take back.
  const commit = (value: string) => {
    if (definition.kind === "text") {
      props.onSaveSlot(slot, { value_text: value });
      return;
    }
    props.onSaveSlot(slot, { url: value });
  };

  if (definition.kind === "bool") {
    // A derived gate is a readout, not a control: it follows the social drafts below, and the
    // service refuses a direct write to it. Offering a checkbox that always errors would be worse
    // than offering none.
    const readOnly = disabled || Boolean(definition.derived);
    return html`
      <label class="paper-slot__check">
        <input
          type="checkbox"
          ?checked=${row?.status === "provided" || row?.status === "waived"}
          ?disabled=${readOnly}
          data-testid=${`paper-slot-${props.paperId}-${slot}`}
          @change=${(event: Event) =>
            props.onSaveSlot(slot, {
              done: (event.target as HTMLInputElement).checked,
            })}
        />
        <span>
          ${definition.derived
            ? row?.status === "provided"
              ? "Approved draft on file"
              : "Waiting on an approved draft"
            : row?.status === "provided"
              ? "Done"
              : "Mark done"}
        </span>
      </label>
    `;
  }

  if (definition.kind === "enum") {
    // Two halves of one answer: the closed state, and where the thing physically is.
    return html`
      <span class="paper-slot__enum">
        <select
          class="input"
          ?disabled=${disabled}
          data-testid=${`paper-slot-${props.paperId}-${slot}`}
          @change=${(event: Event) =>
            props.onSaveSlot(slot, {
              value_text: (event.target as HTMLSelectElement).value,
              value_note: row?.value_note ?? "",
            })}
        >
          <option value="" ?selected=${!row?.value_text}></option>
          ${adminBotPosterPhysicalStates.map(
            (state) => html`
              <option value=${state} ?selected=${state === row?.value_text}>
                ${POSTER_PHYSICAL_LABELS[state] ?? state}
              </option>
            `,
          )}
        </select>
        <input
          class="input"
          type="text"
          placeholder="Where is it?"
          .value=${row?.value_note ?? ""}
          ?disabled=${disabled || !row?.value_text}
          data-testid=${`paper-slot-note-${props.paperId}-${slot}`}
          @change=${(event: Event) =>
            props.onSaveSlot(slot, {
              value_text: row?.value_text ?? "",
              value_note: (event.target as HTMLInputElement).value,
            })}
        />
      </span>
    `;
  }

  if (definition.kind === "secret6") {
    // A credential, so it is typed into a password field and never rendered back once stored: the
    // service only returns it to an author or an admin, and even they do not need it on screen to
    // know it is on file.
    return html`
      <input
        class="input paper-slot__input"
        type="password"
        maxlength="6"
        autocomplete="off"
        placeholder=${row?.status === "provided" ? "On file — type to replace" : "6 characters"}
        ?disabled=${disabled}
        data-testid=${`paper-slot-${props.paperId}-${slot}`}
        @change=${(event: Event) => {
          const field = event.target as HTMLInputElement;
          props.onSaveSlot(slot, { value_text: field.value });
          field.value = "";
        }}
      />
    `;
  }

  return html`
    <input
      class="input paper-slot__input"
      type=${definition.kind === "link" ? "url" : "text"}
      .value=${(definition.kind === "link" ? row?.url : row?.value_text) ?? ""}
      ?disabled=${disabled}
      placeholder=${definition.kind === "link" ? "https://…" : "e.g. 4821"}
      autocomplete="off"
      data-testid=${`paper-slot-${props.paperId}-${slot}`}
      @change=${(event: Event) => commit((event.target as HTMLInputElement).value)}
    />
  `;
}

/** The slots drawn inside this one's row. Two halves of one PaperFlow node, not two steps. */
function childrenOf(slot: AdminBotPaperSlot): AdminBotPaperSlot[] {
  return adminBotPaperSlots.filter(
    (candidate) => adminBotPaperSlotRegistry[candidate].subOf === slot,
  );
}

/**
 * A nested half-slot: its own label, control and status, indented under its parent.
 *
 * It keeps a status pill of its own because the two halves really can disagree -- a submission
 * page can be on file while the id is not -- and collapsing them to one pill would let the card
 * report a node as done when half of it is missing.
 */
function renderChildSlot(props: PaperSlotsProps, slot: AdminBotPaperSlot) {
  const definition = adminBotPaperSlotRegistry[slot];
  const row = rowFor(props.slots, slot);
  return html`
    <div
      class=${`paper-slot__child ${row?.status === "invalid" ? "paper-slot__child--invalid" : ""}`}
      data-testid=${`paper-slot-child-${props.paperId}-${slot}`}
    >
      <div class="paper-slot__child-head">
        <span class="paper-slot__child-label">
          ${definition.label}
          ${definition.required
            ? nothing
            : html`<span class="paper-slot__optional">optional</span>`}
        </span>
        ${statusPill(row)}
      </div>
      ${renderInput(props, slot, definition, row)}
      ${definition.hint ? html`<p class="paper-slot__note">${definition.hint}</p>` : nothing}
      ${row?.status === "invalid" && row.invalid_reason
        ? html`<p class="paper-slot__error" role="alert">${row.invalid_reason}</p>`
        : nothing}
    </div>
  `;
}

function renderSlot(props: PaperSlotsProps, slot: AdminBotPaperSlot) {
  const definition = adminBotPaperSlotRegistry[slot];
  const row = rowFor(props.slots, slot);
  const blocked = waitingOn(definition, props.slots);
  const shape = shapeHint(definition);
  const children = childrenOf(slot);
  return html`
    <div
      class=${`paper-slot ${blocked ? "paper-slot--blocked" : ""} ${
        row?.status === "invalid" ? "paper-slot--invalid" : ""
      } ${children.length > 0 ? "paper-slot--grouped" : ""}`}
      data-testid=${`paper-slot-row-${props.paperId}-${slot}`}
    >
      <div class="paper-slot__head">
        <span class="paper-slot__label">
          ${definition.groupLabel ?? definition.label}
          ${definition.required
            ? nothing
            : html`<span class="paper-slot__optional">optional</span>`}
        </span>
        ${statusPill(row)}
      </div>
      ${definition.groupLabel && definition.groupLabel !== definition.label
        ? html`<span class="paper-slot__sublabel">${definition.label}</span>`
        : nothing}
      ${renderInput(props, slot, definition, row)}
      <p class="paper-slot__meta">
        ${definition.owner === "first_author"
          ? nothing
          : html`<span class="paper-slot__owner">${OWNER_LABELS[definition.owner]}</span>`}
        ${definition.gates
          ? html`<span class="paper-slot__gates"
              >unblocks ${definition.gates.replace(/_/gu, " ")}</span
            >`
          : nothing}
        ${shape ? html`<span class="paper-slot__shape">${shape}</span>` : nothing}
      </p>
      ${row?.status === "invalid" && row.invalid_reason
        ? html`<p class="paper-slot__error" role="alert">${row.invalid_reason}</p>`
        : nothing}
      ${row?.status === "waived" && row.waived_reason
        ? html`<p class="paper-slot__note">Waived by an admin: ${row.waived_reason}</p>`
        : nothing}
      ${blocked ? html`<p class="paper-slot__note">Waiting on ${blocked}.</p>` : nothing}
      ${children.length > 0
        ? html`<div class="paper-slot__children">
            ${children.map((child) => renderChildSlot(props, child))}
          </div>`
        : nothing}
    </div>
  `;
}

/**
 * A comma-separated name list, edited as one line.
 *
 * One text field rather than a row of add/remove chips, because these lists are copied wholesale
 * out of the paper's own byline -- the thing people actually do is paste, and a chip editor makes
 * pasting the slowest way to enter a list. Order is preserved exactly as typed, which matters:
 * author order decides who the PaperFlow stage nudges reach.
 */
function renderNameList(params: {
  id: string;
  label: string;
  hint: string;
  values: string[];
  placeholder: string;
  onChange?: (values: string[]) => void;
}) {
  const text = params.values.join(", ");
  if (!params.onChange) {
    return html`
      <div class="paper-detail">
        <span class="paper-detail__label">${params.label}</span>
        <p class="paper-detail__readonly">${text || "—"}</p>
      </div>
    `;
  }
  return html`
    <label class="paper-detail">
      <span class="paper-detail__label">${params.label}</span>
      <input
        class="input"
        type="text"
        .value=${text}
        placeholder=${params.placeholder}
        autocomplete="off"
        data-testid=${params.id}
        @change=${(event: Event) => {
          const raw = (event.target as HTMLInputElement).value;
          params.onChange?.(
            raw
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean),
          );
        }}
      />
      <span class="paper-detail__hint">${params.hint}</span>
    </label>
  `;
}

/**
 * Who is on the paper, who read it, and where it is aimed.
 *
 * Above the checklist rather than inside it, because none of the three is evidence of a step --
 * they are what the paper *is*, and the steps below are what has been done to it. The author list
 * in particular has to be editable here: it decides who every PaperFlow nudge on this paper
 * reaches, and until now it could only be changed from the admin form.
 */
function renderDetails(props: PaperSlotsProps) {
  const details = props.details;
  if (!details) {
    return nothing;
  }
  const save = details.onSaveDetails;
  const commit = (patch: Partial<{ authors: string[]; feedbackGivers: string[]; venue: string }>) =>
    save?.({
      authors: details.authors,
      feedbackGivers: details.feedbackGivers,
      venue: details.venue,
      ...patch,
    });
  return html`
    <section class="paper-slots__details" data-testid=${`paper-details-${props.paperId}`}>
      ${renderNameList({
        id: `paper-authors-${props.paperId}`,
        label: "Author list",
        hint: "In the order the paper prints them. The first lab member on this list gets the venue-stage emails.",
        values: details.authors,
        placeholder: "Ada Lovelace, Rahul Babu Shrestha, Zhijing Jin",
        ...(save ? { onChange: (authors: string[]) => commit({ authors }) } : {}),
      })}
      ${renderNameList({
        id: `paper-feedback-givers-${props.paperId}`,
        label: "Feedback givers",
        hint: "People asked to read the draft. Not authors — this is who you showed it to.",
        values: details.feedbackGivers,
        placeholder: "Bernhard Schölkopf, Terry Zhang",
        ...(save ? { onChange: (feedbackGivers: string[]) => commit({ feedbackGivers }) } : {}),
      })}
      ${save
        ? html`
            <label class="paper-detail">
              <span class="paper-detail__label">Aimed conference</span>
              <input
                class="input"
                type="text"
                .value=${details.venue}
                placeholder="ICLR 2027"
                autocomplete="off"
                data-testid=${`paper-venue-${props.paperId}`}
                @change=${(event: Event) =>
                  commit({ venue: (event.target as HTMLInputElement).value.trim() })}
              />
              <span class="paper-detail__hint">
                Where this is going next. Quoted in the venue-stage emails and matched against the
                deadline board.
              </span>
            </label>
          `
        : html`
            <div class="paper-detail">
              <span class="paper-detail__label">Aimed conference</span>
              <p class="paper-detail__readonly">${details.venue || "—"}</p>
            </div>
          `}
    </section>
  `;
}

/**
 * The venue ladder: what the venue has answered, and what it has not.
 *
 * Read-only, and it says so. There is no control here because there is nothing a person can do to
 * make reviews arrive -- the one action available is bcc'ing the mail when it lands, which is
 * what the waiting rung asks for. Showing it as a strip of states rather than a list of fields is
 * the whole point: it is a thing being watched, not a thing being filled in.
 */
function renderStages(props: PaperSlotsProps) {
  const stages = props.stages ?? [];
  if (stages.length === 0) {
    return nothing;
  }
  return html`
    <div class="paper-stages" data-testid=${`paper-stages-${props.paperId}`}>
      <p class="paper-stages__lede">
        <span class="paper-stages__lede-icon" aria-hidden="true">${icons.radio}</span>
        Tracked automatically — bcc AdminBot on the venue's mail and these close themselves.
      </p>
      <ol class="paper-stages__list">
        ${stages.map(
          (stage) => html`
            <li
              class=${`paper-stage paper-stage--${stage.state}`}
              data-testid=${`paper-stage-${props.paperId}-${stage.stage}`}
            >
              <span class="paper-stage__label">${stage.label}</span>
              ${stage.state === "closed"
                ? html`<span class="paper-stage__detail"
                    >${stage.closed_by === "admin"
                      ? "Recorded by an admin"
                      : "Received"}${stage.closed_at
                      ? ` · ${new Date(stage.closed_at).toLocaleDateString()}`
                      : ""}${stage.closed_by_subject ? ` · "${stage.closed_by_subject}"` : ""}</span
                  >`
                : stage.state === "waiting"
                  ? html`<span class="paper-stage__detail paper-stage__detail--waiting"
                      >Waiting — bcc us when it lands</span
                    >`
                  : html`<span class="paper-stage__detail">Not yet</span>`}
            </li>
          `,
        )}
      </ol>
    </div>
  `;
}

/** The slots on one branch that get a row of their own — children are drawn inside their parent. */
function topLevelSlots(branch: AdminBotPaperSlotBranch): AdminBotPaperSlot[] {
  return adminBotPaperSlots.filter((slot) => {
    const definition = adminBotPaperSlotRegistry[slot];
    return definition.branch === branch && !definition.subOf;
  });
}

export function renderPaperSlots(props: PaperSlotsProps) {
  if (props.loading && props.slots.length === 0) {
    return html`<p class="paper-slots__loading">Loading this paper's checklist…</p>`;
  }
  return html`
    <div class="paper-slots" data-testid=${`paper-slots-${props.paperId}`}>
      ${renderDetails(props)}
      ${adminBotPaperSlotChartOrder.map((branch) => {
        const slots = topLevelSlots(branch);
        const branchNumber = adminBotPaperFlowBranchNumber[branch];
        if (slots.length === 0 && !(branch === "venue" && (props.stages?.length ?? 0) > 0)) {
          return nothing;
        }
        return html`
          <section
            class=${`paper-slots__group ${branchNumber === null ? "paper-slots__group--trunk" : "paper-slots__group--branch"}`}
            data-testid=${`paper-slots-branch-${props.paperId}-${branch}`}
          >
            <h4 class="paper-slots__group-title">
              <span class="paper-slots__group-icon" aria-hidden="true"
                >${icons[BRANCH_ICONS[branch]]}</span
              >
              ${branchNumber === null
                ? nothing
                : html`<span class="paper-slots__branch-number">Branch ${branchNumber}</span>`}
              ${BRANCH_LABELS[branch]}
            </h4>
            <p class="paper-slots__group-blurb">${BRANCH_BLURBS[branch]}</p>
            <div class="paper-slots__grid">${slots.map((slot) => renderSlot(props, slot))}</div>
            ${branch === "venue" ? renderStages(props) : nothing}
          </section>
        `;
      })}
    </div>
  `;
}
