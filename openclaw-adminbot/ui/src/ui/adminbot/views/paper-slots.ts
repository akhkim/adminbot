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
  onSaveSlot: (slot: string, input: { url?: string; value_text?: string; done?: boolean }) => void;
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
    return html`
      <label class="paper-slot__check">
        <input
          type="checkbox"
          ?checked=${row?.status === "provided" || row?.status === "waived"}
          ?disabled=${disabled}
          data-testid=${`paper-slot-${props.paperId}-${slot}`}
          @change=${(event: Event) =>
            props.onSaveSlot(slot, {
              done: (event.target as HTMLInputElement).checked,
            })}
        />
        <span>${row?.status === "provided" ? "Done" : "Mark done"}</span>
      </label>
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

export function renderPaperSlots(props: PaperSlotsProps) {
  if (props.loading && props.slots.length === 0) {
    return html`<p class="paper-slots__loading">Loading this paper's checklist…</p>`;
  }
  return html`
    <div class="paper-slots" data-testid=${`paper-slots-${props.paperId}`}>
      ${BRANCH_ORDER.map((branch) => {
        const slots = adminBotPaperSlots.filter(
          (slot) => adminBotPaperSlotRegistry[slot].branch === branch,
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
