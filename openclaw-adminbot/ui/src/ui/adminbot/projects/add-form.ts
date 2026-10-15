// Adding a project from My Projects & Papers: the button, the form, and the Slack-alias checks.
//
// Adding writes a new paper row at the first step, with the member as its author -- the same record
// Active Papers lists, so it appears there too. The alias becomes the project's Slack channel, so
// the form says why it refuses one rather than filing nothing and saying nothing.
import { html, nothing } from "lit";
import {
  adminBotNormalizePaperAlias,
  adminBotPaperAliasMaxLength,
  adminBotProjectChannelName,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import { paperSteps } from "../data/paper-steps.ts";
import { formatVenue, venueYears } from "../data/venue-catalog.ts";
import { renderDateControl } from "../date-control.ts";
import { serializeVenueTargets } from "../venue-targets.ts";
import { findOwnMember } from "../views/profile-fields.ts";
import { CONFIDENCE_OPTIONS, defaultTarget, venueOptions } from "./venues.ts";
import type { PaperWorkspaceProps, ProjectVenueDraft } from "./workspace.ts";

/** The service upserts by id and a new paper has none yet, so it is slugged from the title. */
/** A text field's value from a submitted form; anything else (a File) reads as empty. */
function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

export function paperIdFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/(^-|-$)/gu, "")
    .slice(0, 60);
}

/**
 * Why this short name cannot be one, or null when it can.
 *
 * Shared by the create form and the project page's own editor so the two cannot answer
 * differently: the alias becomes a Slack channel either way.
 */
export function aliasRefusal(typed: string): string | null {
  const trimmed = typed.trim();
  if (!trimmed) {
    return "Give the project a short name — it becomes its Slack channel.";
  }
  if (!adminBotNormalizePaperAlias(trimmed)) {
    return (
      `"${trimmed}" cannot be a Slack channel name. Use letters, digits and hyphens, ` +
      `${adminBotPaperAliasMaxLength} characters or fewer — a title with an apostrophe, ` +
      "a colon or spaces around punctuation will not do as it stands."
    );
  }
  return null;
}

/** Slack channel names are lowercase, so the comparison is too. */
function channelExists(channels: readonly string[], alias: string): boolean {
  const wanted = adminBotProjectChannelName(alias).toLowerCase();
  return channels.some((channel) => channel.replace(/^#/u, "").toLowerCase() === wanted);
}

/**
 * Whether the alias contradicts a channel the member says already exists.
 *
 * Only a *known* mismatch blocks: with the box unticked, or the channel list unavailable, the claim
 * is simply unverified. Refusing a correct alias over a lookup that could not run is worse than
 * filing one nobody verified.
 */
function channelMismatch(props: PaperWorkspaceProps, alias: string): boolean {
  const check = props.channelCheck;
  if (!check?.enabled || !check.channels) {
    return false;
  }
  return !channelExists(check.channels, alias);
}

/** Near-misses for what was typed, so a mismatch is actionable rather than a guess. */
function nearbyChannels(channels: readonly string[], alias: string): string[] {
  const wanted = alias.toLowerCase();
  if (wanted.length < 2) {
    return [];
  }
  return channels
    .map((channel) => channel.replace(/^#/u, ""))
    .filter((channel) => channel.startsWith("proj-"))
    .filter((channel) => {
      const suffix = channel.slice("proj-".length).toLowerCase();
      return suffix.startsWith(wanted.slice(0, 3)) || wanted.startsWith(suffix.slice(0, 3));
    })
    .slice(0, 5);
}

/** The "this channel already exists" box, and the verdict once it is ticked. */
function renderChannelExistsCheck(props: PaperWorkspaceProps, state: AppViewState) {
  const check = props.channelCheck;
  if (!check || !props.onChannelCheckToggle) {
    return nothing;
  }
  const alias = adminBotNormalizePaperAlias(state.myWorkProjectAlias) ?? "";
  const verdict = (() => {
    if (!check.enabled) {
      return nothing;
    }
    if (check.loading) {
      return html`<span class="register__hint">Reading the lab's Slack channels…</span>`;
    }
    if (check.error) {
      // Not styled as an error on the field: the member has done nothing wrong, and the project can
      // still be filed.
      return html`<span class="register__hint" data-testid="my-work-channel-check-unavailable"
        >${check.error} You can still file the project — check the channel name by hand.</span
      >`;
    }
    if (!check.channels || !alias) {
      return nothing;
    }
    if (channelExists(check.channels, alias)) {
      return html`<span class="register__hint" data-testid="my-work-channel-check-ok"
        >Matches <code>#${adminBotProjectChannelName(alias)}</code> in Slack.</span
      >`;
    }
    const nearby = nearbyChannels(check.channels, alias);
    return html`<span class="register__error" data-testid="my-work-channel-check-mismatch">
      No <code>#${adminBotProjectChannelName(alias)}</code> in Slack.
      ${nearby.length
        ? html`Did you mean ${nearby.map((channel) => html`<code>#${channel}</code> `)}?`
        : html`Check the channel's exact name and use it as the alias.`}
    </span>`;
  })();
  return html`
    <div class="register__field">
      <label class="my-work-add-form__checkbox">
        <input
          type="checkbox"
          data-testid="my-work-channel-exists"
          .checked=${check.enabled}
          @change=${(event: Event) =>
            props.onChannelCheckToggle?.((event.target as HTMLInputElement).checked)}
        />
        <span>This project already has a Slack channel</span>
      </label>
      ${verdict}
    </div>
  `;
}

export function renderAddButton(state: AppViewState, props: PaperWorkspaceProps) {
  return html`
    <button
      type="button"
      class="btn my-work__add"
      data-testid="my-work-add-project"
      @click=${() => {
        state.myWorkProjectDraft = "";
        props.onRerender?.();
        // Lit commits the re-render in a microtask, so the form exists by the next frame: bring it
        // up and put the cursor in the title box instead of leaving the member to hunt for it.
        window.requestAnimationFrame(() => {
          const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
          document.querySelector<HTMLElement>("#my-work-add-form")?.scrollIntoView({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start",
          });
          document
            .querySelector<HTMLInputElement>("#my-work-add-form input[name='title']")
            ?.focus();
        });
      }}
    >
      ${t("myWork.items.add")}
    </button>
  `;
}

export function renderAddForm(state: AppViewState, props: PaperWorkspaceProps) {
  const draft = state.myWorkProjectDraft ?? "";
  const member = findOwnMember(state);
  const fallback = defaultTarget();
  // Read through a function rather than captured once: every handler below runs after the render
  // that created it, and one that closed over the array would file whatever was on screen when it
  // was drawn rather than what was picked since.
  const currentTargets = (): ProjectVenueDraft[] =>
    state.myWorkProjectVenues?.length
      ? state.myWorkProjectVenues
      : [{ venueId: fallback.id, year: fallback.year, confidence: 50 }];
  const targets = currentTargets();
  const updateTarget = (index: number, patch: Partial<ProjectVenueDraft>) => {
    const next = [...currentTargets()];
    const current = next[index];
    if (current) {
      next[index] = { ...current, ...patch };
    }
    state.myWorkProjectVenues = next;
    props.onRerender?.();
  };
  return html`
    <form
      id="my-work-add-form"
      class="my-work-add-form register"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const data = new FormData(form);
        const title = draft.trim();
        const aliasTyped = formText(data, "alias").trim();
        const alias = adminBotNormalizePaperAlias(aliasTyped) ?? "";
        const startedOn = formText(data, "started_on").trim();
        // Every refusal says why. A bare `return` files nothing and reports nothing, which leaves
        // the member looking at a filled-in form and an unchanged page.
        const refuse = (reason: string): void => {
          state.myWorkProjectError = reason;
          props.onRerender?.();
        };
        if (!title) {
          refuse("Give the project a title.");
          return;
        }
        const aliasProblem = aliasRefusal(aliasTyped);
        if (aliasProblem) {
          refuse(aliasProblem);
          return;
        }
        if (!startedOn) {
          refuse("Say when work on the project started.");
          return;
        }
        if (channelMismatch(props, alias)) {
          refuse(
            `No #${adminBotProjectChannelName(alias)} in Slack, but the box says the channel ` +
              "already exists. Use the channel's exact name, or untick the box.",
          );
          return;
        }
        state.myWorkProjectError = null;
        const rows = currentTargets();
        const primary = rows[0] ?? { venueId: fallback.id, year: fallback.year, confidence: 50 };
        props.onSavePaper({
          id: paperIdFromTitle(title),
          title,
          alias,
          startedOn,
          authors: member?.name?.trim() ? [member.name.trim()] : [],
          currentStep: paperSteps[0],
          // Every target, each with its own odds -- the shape venue-targets.ts already stores.
          venueTargets: serializeVenueTargets(
            rows.map((target) => ({
              venue_id: target.venueId,
              label: formatVenue(target.venueId, target.year),
              confidence: target.confidence,
            })),
          ),
          // The first target also lands in the legacy pair: the deadline board, the venue-stage
          // nudges and the page's own target line all read `artifacts.conference`.
          conference: formatVenue(primary.venueId, primary.year),
          confidence: String(primary.confidence),
        });
        state.myWorkProjectDraft = null;
        state.myWorkProjectAlias = "";
        state.myWorkProjectError = null;
        state.myWorkProjectVenues = [];
        props.onChannelCheckToggle?.(false);
        props.onRerender?.();
      }}
    >
      <div class="my-work-add-form__head">
        <h3>${t("myWork.items.add")}</h3>
        <p>Starts at the first step and shows up on Active Papers too.</p>
      </div>

      ${state.myWorkProjectError
        ? html`<p class="my-work-add-form__error" role="alert" data-testid="my-work-add-error">
            ${state.myWorkProjectError}
          </p>`
        : nothing}

      <label class="register__field">
        <span class="register__label">Title</span>
        <input
          class="input"
          name="title"
          placeholder=${t("myWork.items.namePlaceholder")}
          .value=${draft}
          @input=${(event: Event) => {
            state.myWorkProjectDraft = (event.target as HTMLInputElement).value;
          }}
        />
      </label>

      <label class="register__field">
        <span class="register__label">Alias</span>
        <input
          class="input"
          name="alias"
          required
          maxlength=${adminBotPaperAliasMaxLength}
          placeholder="ex. CAIS"
          data-testid="my-work-add-alias"
          .value=${state.myWorkProjectAlias}
          @input=${(event: Event) => {
            state.myWorkProjectAlias = (event.target as HTMLInputElement).value;
          }}
        />
        <!-- Said next to the box rather than only in a validation message: the name becomes a
             channel other people have to recognise. -->
        <span class="register__hint">
          What the lab calls this project out loud — CAIS for Causal AI Scientist. Its Slack channel
          will be #proj-cais. Letters, digits and hyphens.
          <strong
            >If the project already has a Slack channel, the alias must be that channel's name
            without the <code>proj-</code> prefix</strong
          >
          — #proj-cais means the alias is <code>cais</code>.
        </span>
      </label>

      ${renderChannelExistsCheck(props, state)}

      <label class="register__field">
        <span class="register__label">Started on</span>
        ${renderDateControl(html`<input
          class="input"
          name="started_on"
          type="date"
          required
          data-testid="my-work-add-started-on"
        />`)}
        <span class="register__hint">
          When work actually began, which is often well before the paper is filed here.
        </span>
      </label>

      <!-- One row per venue the paper is aimed at, each with its own odds: independent bets on the
           same work, not a distribution that has to sum to anything. Conference before year,
           because the conference is the decision and the year follows from it. -->
      <div class="register__field">
        <span class="register__label">Target venues</span>
        ${targets.map(
          (target, index) => html`
            <div
              class="register__row register__row--venue"
              data-testid=${`register-venue-row-${index}`}
            >
              <label class="sr-only" for=${`register-venue-${index}`}>Target venue</label>
              <select
                class="input"
                id=${`register-venue-${index}`}
                data-testid=${`register-venue-${index}`}
                @change=${(event: Event) =>
                  updateTarget(index, { venueId: (event.target as HTMLSelectElement).value })}
              >
                ${venueOptions(target.venueId)}
                <option value="" ?selected=${!target.venueId}>Other / not decided yet</option>
              </select>
              <label class="sr-only" for=${`register-venue-year-${index}`}>Target year</label>
              <select
                class="input"
                id=${`register-venue-year-${index}`}
                data-testid=${`register-venue-year-${index}`}
                @change=${(event: Event) =>
                  updateTarget(index, {
                    year: Number((event.target as HTMLSelectElement).value),
                  })}
              >
                ${venueYears().map(
                  (year) => html`
                    <option value=${String(year)} ?selected=${year === target.year}>${year}</option>
                  `,
                )}
              </select>
              <label class="sr-only" for=${`register-venue-odds-${index}`}>How likely</label>
              <select
                class="input"
                id=${`register-venue-odds-${index}`}
                data-testid=${`register-venue-odds-${index}`}
                @change=${(event: Event) =>
                  updateTarget(index, {
                    confidence: Number((event.target as HTMLSelectElement).value),
                  })}
              >
                ${CONFIDENCE_OPTIONS.map(
                  (value) => html`
                    <option value=${value} ?selected=${Number(value) === target.confidence}>
                      ${value}% likely
                    </option>
                  `,
                )}
              </select>
              ${targets.length > 1
                ? html`<button
                    type="button"
                    class="btn btn--sm"
                    title="Remove this venue"
                    data-testid=${`register-venue-remove-${index}`}
                    @click=${() => {
                      state.myWorkProjectVenues = currentTargets().filter((_, at) => at !== index);
                      props.onRerender?.();
                    }}
                  >
                    ${icons.x}
                  </button>`
                : nothing}
            </div>
          `,
        )}
        <button
          type="button"
          class="btn btn--sm"
          data-testid="register-venue-add"
          @click=${() => {
            state.myWorkProjectVenues = [
              ...currentTargets(),
              { venueId: "", year: fallback.year, confidence: 50 },
            ];
            props.onRerender?.();
          }}
        >
          Add another conference
        </button>
        <span class="register__hint">
          Defaults to the next deadline. Add as many as the paper is genuinely aimed at, each with
          its own odds.
        </span>
      </div>

      <div class="register__actions">
        <button type="submit" class="btn">${t("myWork.items.addSubmit")}</button>
        <button
          type="button"
          class="btn"
          data-testid="my-work-add-cancel"
          @click=${() => {
            state.myWorkProjectDraft = null;
            state.myWorkProjectError = null;
            props.onRerender?.();
          }}
        >
          ${t("myWork.blockers.cancel")}
        </button>
      </div>
    </form>
  `;
}
