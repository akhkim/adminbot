// The inside of a paper card: every artifact the paper owes, as an editable field.
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
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  adminBotPosterPhysicalStates,
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotBranch,
  type AdminBotPaperSlotDefinition,
} from "../../../../../extensions/adminbot/src/contracts/paper-slots.js";
import { icons } from "../../icons.ts";
import type { PaperSlotRow } from "../auth/session.ts";

export type PaperSlotsProps = {
  paperId: string;
  slots: PaperSlotRow[];
  loading: boolean;
  onSaveSlot: (
    slot: string,
    input: { url?: string; value_text?: string; value_note?: string; done?: boolean },
  ) => void;
  /** Show every field rather than just the ones that are ready. Per card, per session. */
  showAllSlots?: boolean;
  onToggleShowAll?: () => void;
  /** Opens the drafting tool for a social gate. Absent leaves the gate as a read-only checkbox. */
  onOpenDraft?: (platform: "linkedin" | "x") => void;
};

/** Plain-English states for the one enum slot. */
const POSTER_PHYSICAL_LABELS: Record<string, string> = {
  not_needed: "Not needed",
  to_print: "Still to print",
  printed: "Printed",
  with_author: "With the author",
  shipped: "Shipped",
};

/** Reading order of the card: the writing, then the venue, then everything a finished paper trails. */
const BRANCH_ORDER: AdminBotPaperSlotBranch[] = ["core", "venue", "archive", "social", "talk"];

const BRANCH_LABELS: Record<AdminBotPaperSlotBranch, string> = {
  core: "Writing",
  venue: "Venue",
  archive: "Archival",
  social: "Social",
  talk: "Presentation",
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
    // The social draft gates are read-only by design: their truth lives in `paper_social_drafts`,
    // so a checkbox here could only ever disagree with it. What the author actually wants when
    // they click one is the drafting tool, so that is what it opens.
    if (definition.derived && props.onOpenDraft) {
      const platform = slot === "linkedin_draft" ? "linkedin" : "x";
      const done = row?.status === "provided";
      return html`
        <button
          type="button"
          class="paper-slot__draft-open"
          data-testid=${`paper-slot-${props.paperId}-${slot}`}
          @click=${() => props.onOpenDraft?.(platform)}
        >
          ${done ? "Approved draft on file — open" : "Write the draft"}
        </button>
      `;
    }

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
        placeholder=${row?.status === "provided"
          ? "On file — type to replace"
          : (definition.example ?? "6 characters")}
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
      placeholder=${definition.example ?? (definition.kind === "link" ? "https://…" : "e.g. 4821")}
      autocomplete="off"
      data-testid=${`paper-slot-${props.paperId}-${slot}`}
      @change=${(event: Event) => commit((event.target as HTMLInputElement).value)}
    />
  `;
}

function renderSlot(props: PaperSlotsProps, slot: AdminBotPaperSlot) {
  const definition = adminBotPaperSlotRegistry[slot];
  const row = rowFor(props.slots, slot);
  const blocked = waitingOn(definition, props.slots);
  const shape = shapeHint(definition);
  return html`
    <div
      class=${`paper-slot ${blocked ? "paper-slot--blocked" : ""} ${
        row?.status === "invalid" ? "paper-slot--invalid" : ""
      }`}
      data-testid=${`paper-slot-row-${props.paperId}-${slot}`}
    >
      <div class="paper-slot__head">
        <span class="paper-slot__label">
          ${definition.label}
          ${definition.required
            ? nothing
            : html`<span class="paper-slot__optional">optional</span>`}
          <!-- A <details> rather than a tooltip: it works on touch, it is reachable by keyboard,
               and the answer stays open while the reader types the value it describes. -->
          ${definition.hint
            ? html`<details class="paper-slot__help">
                <summary
                  aria-label=${`What goes in ${definition.label}?`}
                  data-testid=${`paper-slot-help-${props.paperId}-${slot}`}
                >
                  ?
                </summary>
                <p>${definition.hint}</p>
                ${definition.example
                  ? html`<p class="paper-slot__help-example">
                      For example <code>${definition.example}</code>
                    </p>`
                  : nothing}
              </details>`
            : nothing}
        </span>
        ${statusPill(row)}
      </div>
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
    </div>
  `;
}

/** Roughly three rows of the square grid: enough to see the shape of the work, few enough to read. */
const VISIBLE_SLOT_LIMIT = 9;

/**
 * Which slots are worth showing right now.
 *
 * Twenty-five fields at once is a wall, and "Missing" ends up meaning two different things --
 * overdue, and not-your-turn-yet. But filtering to only what is unblocked is too sharp the
 * other way: a fresh paper has exactly two reachable fields, which leaves the grid looking
 * broken and says nothing about what comes next.
 *
 * So the working set is three tiers, in priority order, capped at VISIBLE_SLOT_LIMIT:
 *
 *   1. anything already filled in wrongly -- it has to stay reachable to be corrected
 *   2. everything actionable now -- the parallel frontier
 *   3. near-future work: blocked by exactly one thing, so it is what opens next
 *
 * Tier 3 is what keeps the grid full and the sequence legible. The rest is behind the toggle.
 */
function slotDistance(
  definition: AdminBotPaperSlotDefinition,
  slots: PaperSlotRow[],
): number {
  return definition.upstream.filter(
    (slot) => !isAdminBotPaperSlotSettled(rowFor(slots, slot)?.status ?? "missing"),
  ).length;
}

export function visibleSlots(
  slots: PaperSlotRow[],
  limit = VISIBLE_SLOT_LIMIT,
): AdminBotPaperSlot[] {
  const open = adminBotPaperSlots.filter(
    (slot) => !isAdminBotPaperSlotSettled(rowFor(slots, slot)?.status ?? "missing"),
  );
  const rank = (slot: AdminBotPaperSlot): number => {
    if ((rowFor(slots, slot)?.status ?? "missing") === "invalid") {
      return 0;
    }
    const distance = slotDistance(adminBotPaperSlotRegistry[slot], slots);
    return distance === 0 ? 1 : distance === 1 ? 2 : 3;
  };
  return open
    .filter((slot) => rank(slot) <= 2)
    .sort((left, right) => rank(left) - rank(right))
    .slice(0, limit);
}

export function renderPaperSlots(props: PaperSlotsProps) {
  if (props.loading && props.slots.length === 0) {
    return html`<p class="paper-slots__loading">Loading this paper's checklist…</p>`;
  }

  const visible = new Set(visibleSlots(props.slots));
  const isOpen = (slot: AdminBotPaperSlot) => visible.has(slot);
  const ready = [...visible].filter(
    (slot) => slotDistance(adminBotPaperSlotRegistry[slot], props.slots) === 0,
  ).length;
  const hidden = adminBotPaperSlots.length - visible.size;
  const showAll = props.showAllSlots ?? false;

  return html`
    <div class="paper-slots" data-testid=${`paper-slots-${props.paperId}`}>
      <div class="paper-slots__filter">
        <span class="paper-slots__filter-text">
          ${showAll
            ? `Showing all ${adminBotPaperSlots.length} fields`
            : `${ready} you can do now · ${visible.size - ready} coming up · ${hidden} further off`}
        </span>
        ${props.onToggleShowAll
          ? html`<button
              type="button"
              class="btn btn--sm"
              data-testid=${`paper-slots-toggle-${props.paperId}`}
              @click=${() => props.onToggleShowAll?.()}
            >
              ${showAll ? "Show only what's ready" : "Show all fields"}
            </button>`
          : nothing}
      </div>
      ${BRANCH_ORDER.map((branch) => {
        const slots = adminBotPaperSlots.filter(
          (slot) =>
            adminBotPaperSlotRegistry[slot].branch === branch && (showAll || isOpen(slot)),
        );
        if (slots.length === 0) {
          return nothing;
        }
        return html`
          <section class="paper-slots__group">
            <h4 class="paper-slots__group-title">
              <span class="paper-slots__group-icon" aria-hidden="true"
                >${icons[BRANCH_ICONS[branch]]}</span
              >
              ${BRANCH_LABELS[branch]}
            </h4>
            <div class="paper-slots__grid">${slots.map((slot) => renderSlot(props, slot))}</div>
          </section>
        `;
      })}
    </div>
  `;
}
