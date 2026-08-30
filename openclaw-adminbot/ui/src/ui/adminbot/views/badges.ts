import { html, nothing } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { t } from "../../../i18n/index.ts";
import "../../components/modal-dialog.ts";
import { icons } from "../../icons.ts";
import type {
  BadgeDefinition,
  BadgeDefinitionInput,
  BadgeNominationView,
  LabMember,
} from "../auth/session.ts";
import type { BadgeLoadError } from "../data/badges.ts";
import { renderBadgeSelect } from "./badge-select.ts";
import { renderBadgeTierRows } from "./badge-tier-rows.ts";

/**
 * The three fields this view reads off a member.
 *
 * Narrower than `LabMember` on purpose: the Admin tab holds its roster as the controller's
 * `AdminBotLabMember`, which spells `onboarding` differently, and this list has no interest in
 * either shape beyond a name, an id and the badges already on the row.
 */
export type BadgeRosterMember = Pick<LabMember, "id" | "name" | "assigned_badges">;

export type AdminBotBadgesProps = {
  definitions: BadgeDefinition[];
  definitionsLoading: boolean;
  definitionsError: BadgeLoadError | null;
  nominations: BadgeNominationView[];
  nominationsLoading: boolean;
  nominationsError: BadgeLoadError | null;
  busyKey: string | null;
  notice: { kind: "success" | "error"; text: string } | null;
  members: readonly BadgeRosterMember[];
  assignRowId: string;
  onToggleAssignRow: (memberId: string) => void;
  memberQuery: string;
  onMemberQueryChange: (query: string) => void;
  editBadgeId: string;
  onToggleEditBadge: (badgeId: string) => void;
  onRefresh: () => void;
  onSaveDefinition: (input: BadgeDefinitionInput) => Promise<void>;
  onAssign: (memberId: string, badgeId: string, evidence?: string) => void;
  onRemove: (memberId: string, badgeId: string) => void;
  onDecide: (nominationId: string, decision: "approve" | "reject") => void;
};

function badgeLabel(badge: Pick<BadgeDefinition, "name" | "tier">): string {
  return badge.tier ? `${badge.name} · ${badge.tier}` : badge.name;
}

function submittedAt(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function errorSummaryKey(error: BadgeLoadError): string {
  switch (error) {
    case "unreachable":
      return "adminbotBadges.empty.unreachable";
    case "expired":
      return "adminbotBadges.empty.expired";
    case "forbidden":
      return "adminbotBadges.empty.forbidden";
    case "failed":
      return "adminbotBadges.empty.failed";
    default:
      return "adminbotBadges.empty.noSession";
  }
}

function renderErrorState(props: AdminBotBadgesProps, error: BadgeLoadError) {
  const retryable = error === "unreachable" || error === "failed";
  return html`
    <div class="card adminbot-card adminbot-card--wide">
      <div class="card-title">${t("adminbotBadges.empty.title")}</div>
      <div class="card-sub">${t(errorSummaryKey(error))}</div>
      ${retryable
        ? html`<div class="adminbot-form__actions">
            <button class="btn btn--sm" type="button" @click=${props.onRefresh}>
              ${t("adminbotBadges.refresh")}
            </button>
          </div>`
        : nothing}
    </div>
  `;
}

function inputValue(form: HTMLFormElement, name: string): string {
  return String(new FormData(form).get(name) ?? "").trim();
}

function mandatoryMark() {
  return html`<span class="profile__mandatory" aria-hidden="true"></span
    ><span class="sr-only">${t("profile.basics.mandatory")}</span>`;
}

function optionalMark() {
  return html`<span class="profile__optional">${t("profile.basics.optional")}</span>`;
}

// The create form spawns one badge by default (a single description, no tier) or several at once
// (one per tier row, each with its own description) once the admin adds a tier -- all sharing
// category/name so they land in the same auto-derived family. `tier` and `description` are
// index-aligned: row N's tier pairs with row N's description.
function definitionInputs(form: HTMLFormElement): BadgeDefinitionInput[] {
  const formData = new FormData(form);
  const category = String(formData.get("category") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const tiers = formData.getAll("tier").map((value) => String(value).trim());
  const descriptions = formData.getAll("description").map((value) => String(value).trim());
  if (tiers.length === 0) {
    return [{ category, name, description: descriptions[0] ?? "" }];
  }
  return tiers.map((tier, index) => ({
    category,
    name,
    description: descriptions[index] ?? "",
    tier: tier || undefined,
  }));
}

function renderCreateForm(props: AdminBotBadgesProps) {
  const busyKey = "definition:new";
  return html`
    <form
      class="card adminbot-card adminbot-card--wide adminbot-badge-card"
      @submit=${(event: Event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const inputs = definitionInputs(form);
        // Sequential, not Promise.all: each tier's create must land before the next one is sent,
        // or the backend can't find the prior tier yet and gives every tier its own family_key
        // instead of grouping them.
        void (async () => {
          for (const input of inputs) {
            await props.onSaveDefinition(input);
          }
        })();
      }}
    >
      <div class="adminbot-badge-card__head">
        <div class="card-title">${t("adminbotBadges.newBadge")}</div>
        <button
          class="btn primary"
          type="submit"
          ?disabled=${props.busyKey !== null}
          aria-busy=${props.busyKey === busyKey}
        >
          ${t("adminbotBadges.save")}
        </button>
      </div>
      <div class="adminbot-badge-form">
        <label>
          <span>${t("adminbotBadges.field.name")} ${mandatoryMark()}</span>
          <input class="input" name="name" required />
        </label>
        <label>
          <span>${t("adminbotBadges.field.category")} ${optionalMark()}</span>
          <input class="input" name="category" />
        </label>
        <div class="adminbot-badge-form__wide">
          ${renderBadgeTierRows({ disabled: props.busyKey !== null })}
        </div>
      </div>
    </form>
  `;
}

function definitionUpdateInput(form: HTMLFormElement): BadgeDefinitionInput {
  return {
    category: inputValue(form, "category"),
    name: inputValue(form, "name"),
    tier: inputValue(form, "tier") || undefined,
    description: inputValue(form, "description"),
  };
}

function renderCatalogCard(props: AdminBotBadgesProps, badge: BadgeDefinition) {
  return html`
    <div class="card adminbot-card adminbot-badge-catalog__card">
      <div class="adminbot-badge-catalog__summary">
        <div class="adminbot-badge-catalog__head">
          <span class="card-title">${badgeLabel(badge)}</span>
          <button
            class="adminbot-badge-catalog__edit"
            type="button"
            aria-label=${`${t("adminbotBadges.edit")} ${badgeLabel(badge)}`}
            @click=${() => props.onToggleEditBadge(badge.id)}
          >
            ${icons.edit}
          </button>
        </div>
        ${badge.category ? html`<span class="ab-chip">${badge.category}</span>` : nothing}
        <p class="adminbot-badge-catalog__description">${badge.description}</p>
      </div>
    </div>
  `;
}

function renderEditBadgeModal(props: AdminBotBadgesProps) {
  const badge = props.definitions.find((entry) => entry.id === props.editBadgeId);
  if (!badge) {
    return nothing;
  }
  const busyKey = `definition:${badge.id}`;
  return html`
    <openclaw-modal-dialog
      label=${`${t("adminbotBadges.edit")} ${badgeLabel(badge)}`}
      @modal-cancel=${() => props.onToggleEditBadge(badge.id)}
    >
      <form
        class="card adminbot-card adminbot-badge-card adminbot-badge-modal-form"
        @submit=${(event: Event) => {
          event.preventDefault();
          void props.onSaveDefinition({
            id: badge.id,
            ...definitionUpdateInput(event.currentTarget as HTMLFormElement),
          });
          props.onToggleEditBadge(badge.id);
        }}
      >
        <div class="card-title">${t("adminbotBadges.edit")}</div>
        <div class="adminbot-badge-form">
          <label>
            <span>${t("adminbotBadges.field.name")}</span>
            <input class="input" name="name" .value=${badge.name} required />
          </label>
          <label>
            <span>${t("adminbotBadges.field.category")}</span>
            <input class="input" name="category" .value=${badge.category ?? ""} />
          </label>
          <label>
            <span>${t("adminbotBadges.field.tier")}</span>
            <input class="input" name="tier" .value=${badge.tier ?? ""} />
          </label>
          <label class="adminbot-badge-form__wide">
            <span>${t("adminbotBadges.field.description")}</span>
            <textarea
              class="input adminbot-badge-textarea--compact"
              name="description"
              rows="1"
              required
              .value=${badge.description}
            ></textarea>
          </label>
        </div>
        <div class="adminbot-form__actions">
          <button
            class="btn primary"
            type="submit"
            ?disabled=${props.busyKey !== null}
            aria-busy=${props.busyKey === busyKey}
          >
            ${t("adminbotBadges.save")}
          </button>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.busyKey !== null}
            @click=${() => props.onToggleEditBadge(badge.id)}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>
  `;
}

function badgeOptions(definitions: BadgeDefinition[]) {
  return definitions.map((badge) => ({
    id: badge.id,
    name: badgeLabel(badge),
    hint: badge.category,
  }));
}

// Module-level, not per-call: the ref must stay bound to the same hidden input across
// re-renders (e.g. while the notice banner updates) so the currently picked badge in the open
// assign modal survives renders that happen before the admin submits it.
const assignBadgeIdRef = createRef<HTMLInputElement>();

function memberMatchesQuery(member: BadgeRosterMember, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return (
    (member.name ?? "").toLowerCase().includes(needle) ||
    (member.id ?? "").toLowerCase().includes(needle)
  );
}

function renderAssignModal(props: AdminBotBadgesProps) {
  const member = props.members.find((entry) => String(entry.id ?? "") === props.assignRowId);
  if (!member) {
    return nothing;
  }
  const memberId = String(member.id ?? "");
  const badgeIdRef = assignBadgeIdRef;
  return html`
    <openclaw-modal-dialog
      label=${`${t("adminbotBadges.assign")} — ${member.name ?? memberId}`}
      @modal-cancel=${() => props.onToggleAssignRow(memberId)}
    >
      <form
        class="card adminbot-card adminbot-badge-card adminbot-badge-modal-form"
        @submit=${(event: Event) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          const badgeId = badgeIdRef.value?.value ?? "";
          if (!badgeId) {
            return;
          }
          props.onAssign(memberId, badgeId, inputValue(form, "evidence") || undefined);
          props.onToggleAssignRow(memberId);
        }}
      >
        <div class="card-title">${t("adminbotBadges.assign")} — ${member.name ?? memberId}</div>
        <input type="hidden" ${ref(badgeIdRef)} />
        ${renderBadgeSelect({
          options: badgeOptions(props.definitions),
          value: badgeIdRef.value?.value ?? "",
          placeholder: t("adminbotBadges.pickBadge"),
          label: t("adminbotBadges.pickBadge"),
          disabled: props.busyKey !== null,
          onPick: (badgeId) => {
            if (badgeIdRef.value) {
              badgeIdRef.value.value = badgeId;
            }
          },
        })}
        <textarea
          class="input adminbot-badge-textarea--compact"
          name="evidence"
          rows="1"
          placeholder=${t("adminbotBadges.field.assignEvidence")}
          ?disabled=${props.busyKey !== null}
        ></textarea>
        <div class="adminbot-form__actions">
          <button
            class="btn primary"
            type="submit"
            ?disabled=${props.busyKey !== null || props.definitions.length === 0}
          >
            ${t("adminbotBadges.assign")}
          </button>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.busyKey !== null}
            @click=${() => props.onToggleAssignRow(memberId)}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>
  `;
}

function renderMemberBadgeRow(props: AdminBotBadgesProps, member: BadgeRosterMember) {
  const memberId = String(member.id ?? "");
  const assigned = (member.assigned_badges ?? []) as NonNullable<LabMember["assigned_badges"]>;
  return html`
    <tr>
      <td>
        <strong>${member.name ?? memberId}</strong>
        <small>${memberId}</small>
      </td>
      <td>
        ${assigned.length === 0
          ? html`<span class="adminbot-form__meta">${t("adminbotBadges.emptyAssignments")}</span>`
          : html`<ul class="adminbot-badge-chip-list">
              ${assigned.map(
                (badge) => html`<li
                  class="adminbot-badge-chip ${badge.evidence ? "adminbot-badge-chip--has-evidence" : ""}"
                  tabindex=${badge.evidence ? "0" : "-1"}
                >
                  <span>${badgeLabel(badge)}</span>
                  <button
                    class="adminbot-badge-chip__remove"
                    type="button"
                    aria-label=${`${t("adminbotBadges.remove")} ${badgeLabel(badge)}`}
                    ?disabled=${props.busyKey !== null}
                    @click=${() => props.onRemove(memberId, badge.badge_id)}
                  >
                    &times;
                  </button>
                  ${badge.evidence
                    ? html`<div class="adminbot-badge-chip__popover">
                        <strong>${t("adminbotBadges.field.evidence")}:</strong> ${badge.evidence}
                      </div>`
                    : nothing}
                </li>`,
              )}
            </ul>`}
      </td>
      <td>
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${props.busyKey !== null || props.definitions.length === 0}
          @click=${() => props.onToggleAssignRow(memberId)}
        >
          ${t("adminbotBadges.assign")}
        </button>
      </td>
    </tr>
  `;
}

function renderMembersBadgeTable(props: AdminBotBadgesProps) {
  const members = [...props.members]
    .filter((member) => memberMatchesQuery(member, props.memberQuery))
    .sort((left, right) => (left.name ?? left.id ?? "").localeCompare(right.name ?? right.id ?? ""));
  return html`
    <div class="card adminbot-card adminbot-card--wide">
      <div class="card-title">${t("adminbotBadges.assignments")}</div>
      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              placeholder=${t("adminbotBadges.pickMemberToView")}
              .value=${props.memberQuery}
              @input=${(event: Event) =>
                props.onMemberQueryChange((event.target as HTMLInputElement).value)}
            />
          </div>
        </div>
        <div class="data-table-container">
          <table class="data-table adminbot-badge-table">
            <thead>
              <tr>
                <th>${t("adminbotBadges.pickMember")}</th>
                <th>${t("adminbotBadges.field.currentBadges")}</th>
                <th>${t("adminbotBadges.assign")}</th>
              </tr>
            </thead>
            <tbody>
              ${members.length === 0
                ? html`<tr>
                    <td colspan="3" class="data-table-empty-cell">
                      ${t("adminbotBadges.emptyAssignments")}
                    </td>
                  </tr>`
                : members.map((member) => renderMemberBadgeRow(props, member))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderNominations(props: AdminBotBadgesProps) {
  return html`
    <div class="card adminbot-card adminbot-card--wide">
      <div class="card-title">${t("adminbotBadges.nominations")}</div>
      ${props.nominationsLoading && props.nominations.length === 0
        ? html`<div class="adminbot-form__meta">${t("adminbotBadges.loading")}</div>`
        : props.nominations.length === 0
          ? html`<div class="adminbot-form__meta">${t("adminbotBadges.emptyNominations")}</div>`
          : html`<ul class="adminbot-badge-nominations">
              ${props.nominations.map(
                (nomination) => html`<li class="card adminbot-card adminbot-card--wide">
                  <div class="adminbot-badge-card__head">
                    <div>
                      <div class="card-title">
                        ${nomination.member_name ?? nomination.member_id}
                        — ${badgeLabel({
                          name: nomination.badge_name,
                          tier: nomination.badge_tier,
                        })}
                      </div>
                      <div class="adminbot-form__meta">
                        ${t("adminbotBadges.field.submittedAt")}: ${submittedAt(nomination.created_at)}
                      </div>
                    </div>
                    <div class="adminbot-form__actions">
                      <button
                        class="btn primary"
                        type="button"
                        ?disabled=${props.busyKey !== null}
                        @click=${() => props.onDecide(nomination.id, "approve")}
                      >
                        ${t("adminbotBadges.approve")}
                      </button>
                      <button
                        class="btn danger"
                        type="button"
                        ?disabled=${props.busyKey !== null}
                        @click=${() => props.onDecide(nomination.id, "reject")}
                      >
                        ${t("adminbotBadges.reject")}
                      </button>
                    </div>
                  </div>
                  <div>${nomination.badge_description}</div>
                  ${nomination.evidence
                    ? html`<div class="adminbot-badge-evidence">
                        <strong>${t("adminbotBadges.field.evidence")}:</strong>
                        ${nomination.evidence}
                      </div>`
                    : nothing}
                </li>`,
              )}
            </ul>`}
    </div>
  `;
}

export function renderAdminBotBadges(props: AdminBotBadgesProps) {
  if (props.definitionsLoading && props.definitions.length === 0) {
    return html`<section class="adminbot-shell">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="adminbot-form__meta">${t("adminbotBadges.loading")}</div>
      </div>
    </section>`;
  }
  if (props.definitionsError) {
    return html`<section class="adminbot-shell">
      ${renderErrorState(props, props.definitionsError)}
    </section>`;
  }
  return html`
    <section class="adminbot-shell">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="card-title">${t("adminbotBadges.title")}</div>
        <div class="card-sub">${t("adminbotBadges.sub")}</div>
        ${props.notice
          ? html`<div class="callout ${props.notice.kind === "error" ? "danger" : "success"}">
              ${props.notice.text}
            </div>`
          : nothing}
        <div class="adminbot-form__actions">
          <button class="btn btn--sm" type="button" ?disabled=${props.definitionsLoading} @click=${props.onRefresh}>
            ${t("adminbotBadges.refresh")}
          </button>
        </div>
      </div>
      ${renderCreateForm(props)}
      <div class="card adminbot-card adminbot-card--wide">
        <div class="card-title">${t("adminbotBadges.catalog")}</div>
        ${props.definitions.length === 0
          ? html`<div class="adminbot-form__meta">${t("adminbotBadges.emptyCatalog")}</div>`
          : html`<div class="adminbot-badge-catalog">
              ${props.definitions.map((badge) => renderCatalogCard(props, badge))}
            </div>`}
      </div>
      ${renderMembersBadgeTable(props)}
      ${props.nominationsError
        ? renderErrorState(props, props.nominationsError)
        : renderNominations(props)}
      ${renderEditBadgeModal(props)}
      ${renderAssignModal(props)}
    </section>
  `;
}
