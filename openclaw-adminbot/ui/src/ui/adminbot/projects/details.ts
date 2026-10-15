// A project's own answers -- title, short name, start date -- editable after the fact, and saved
// the way the profile page saves: a beat after typing stops, or as soon as focus leaves the form.
//
// A title changes over a project's life; that is the normal case. The service always allowed these
// through OWN_PAPER_EDITABLE_FIELDS, and this is where they are typed.
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import {
  adminBotNormalizePaperAlias,
  adminBotPaperAliasMaxLength,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { cancelAutosave, focusLeftForm, scheduleAutosave } from "../autosave.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { renderDateControl } from "../date-control.ts";
import { aliasRefusal } from "./add-form.ts";
import type { PaperWorkspaceProps, ProjectDetailsDraft } from "./workspace.ts";

/**
 * One autosave timer per project, keyed by paper id: the flat view draws several projects at once,
 * and a shared timer would let a pause in one commit another's half-typed draft.
 */
const detailsSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * What was last written for each project, so the debounce and the blur commit -- which can both
 * come due for one edit while the record is still in flight -- do not write it twice.
 */
const detailsLastSaved = new Map<string, string>();

function detailsSignature(draft: ProjectDetailsDraft): string {
  return JSON.stringify([draft.title.trim(), draft.alias.trim(), draft.startedOn.trim()]);
}

/**
 * Why this draft cannot be written yet, or null.
 *
 * A title cannot be empty and the short name has to be a legal Slack channel, so an unguarded
 * autosave would fire a doomed request every time the member paused mid-word.
 */
function detailsRefusal(draft: ProjectDetailsDraft): string | null {
  if (!draft.title.trim()) {
    return "Give the project a title.";
  }
  // Blank clears the alias, which the record allows; anything else has to be a name Slack takes.
  const aliasTyped = draft.alias.trim();
  const aliasProblem = aliasTyped ? aliasRefusal(aliasTyped) : null;
  if (aliasProblem) {
    return aliasProblem;
  }
  const startedOn = draft.startedOn.trim();
  if (startedOn && !/^\d{4}-\d{2}-\d{2}$/u.test(startedOn)) {
    return "The start date must look like 2026-09-01.";
  }
  return null;
}

/** Drops pending edits so a different member on this browser never inherits them. */
export function resetProjectDetailsState(): void {
  for (const timer of detailsSaveTimers.values()) {
    clearTimeout(timer);
  }
  detailsSaveTimers.clear();
  detailsLastSaved.clear();
}

/**
 * The editor itself.
 *
 * A draft that cannot be written is held, not sent: its timer is cancelled outright, so a
 * half-typed short name never becomes a request. And the draft outlives its own commit -- these
 * inputs are bound to state, so dropping it the moment a save fires would snap the box back to the
 * stored value while the member was still typing in it.
 */
export function renderProjectDetails(
  state: AppViewState,
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
): unknown {
  const stored: ProjectDetailsDraft = {
    title: paper.title ?? "",
    alias: paper.alias ?? "",
    startedOn: paper.started_on ?? "",
    error: null,
  };
  const draft = (state.myWorkProjectEdits ?? {})[paper.id] ?? stored;
  const setTimer = (next: ReturnType<typeof setTimeout> | undefined): void => {
    if (next) {
      detailsSaveTimers.set(paper.id, next);
    } else {
      detailsSaveTimers.delete(paper.id);
    }
  };
  const patch = (fields: Partial<ProjectDetailsDraft>): void => {
    const current = (state.myWorkProjectEdits ?? {})[paper.id] ?? stored;
    state.myWorkProjectEdits = {
      ...state.myWorkProjectEdits,
      [paper.id]: { ...current, ...fields },
    };
    props.onRerender?.();
  };
  // Reads the draft at fire time: the timer outlives the render that set it.
  const commit = (options: { force?: boolean } = {}): void => {
    const typed = (state.myWorkProjectEdits ?? {})[paper.id];
    if (!typed) {
      return;
    }
    const refusal = detailsRefusal(typed);
    if (refusal) {
      patch({ error: refusal });
      return;
    }
    // Only the automatic paths are deduplicated. A press of the button always writes: a save that
    // failed leaves the signature recorded, and suppressing the retry would make it a silent no-op.
    const signature = detailsSignature(typed);
    if (!options.force && signature === detailsLastSaved.get(paper.id)) {
      return;
    }
    detailsLastSaved.set(paper.id, signature);
    const aliasTyped = typed.alias.trim();
    props.onSavePaper({
      id: paper.id,
      title: typed.title.trim(),
      authors: paper.authors ?? [],
      currentStep: paper.current_step,
      alias: aliasTyped ? (adminBotNormalizePaperAlias(aliasTyped) ?? "") : "",
      startedOn: typed.startedOn.trim(),
    });
    patch({ error: null });
  };
  const edited = (fields: Partial<ProjectDetailsDraft>): void => {
    patch({ ...fields, error: null });
    const typed = (state.myWorkProjectEdits ?? {})[paper.id] ?? stored;
    if (detailsRefusal(typed)) {
      // Held rather than queued: the message waits for the member to stop or leave.
      cancelAutosave(detailsSaveTimers.get(paper.id), setTimer);
      return;
    }
    scheduleAutosave(detailsSaveTimers.get(paper.id), setTimer, commit);
  };
  const dirty =
    draft.title !== stored.title ||
    draft.alias !== stored.alias ||
    draft.startedOn !== stored.startedOn;
  return html`
    <details class="my-work-details" data-testid=${`my-work-details-${paper.id}`}>
      <summary>Project details</summary>
      <form
        class="my-work-details__form"
        @submit=${(event: SubmitEvent) => event.preventDefault()}
        @focusout=${(event: FocusEvent) => {
          const form = event.currentTarget as HTMLFormElement;
          if (!focusLeftForm(form, event)) {
            return;
          }
          // Not flushAutosave, which only runs when a timer is pending: a draft that cannot be
          // written has had its timer cancelled, and that case must not pass silently. `commit`
          // decides -- it writes, or it explains.
          const typed = (state.myWorkProjectEdits ?? {})[paper.id];
          const changed =
            typed !== undefined &&
            (typed.title !== stored.title ||
              typed.alias !== stored.alias ||
              typed.startedOn !== stored.startedOn);
          if (!changed) {
            return;
          }
          cancelAutosave(detailsSaveTimers.get(paper.id), setTimer);
          commit();
        }}
      >
        <div class="my-work-details__grid">
          <label class="my-work-details__field">
            <span>Title</span>
            <input
              class="input"
              data-testid=${`my-work-details-title-${paper.id}`}
              .value=${draft.title}
              @input=${(event: Event) =>
                edited({ title: (event.target as HTMLInputElement).value })}
            />
          </label>
          <label class="my-work-details__field">
            <span>Short name</span>
            <input
              class="input"
              maxlength=${adminBotPaperAliasMaxLength}
              data-testid=${`my-work-details-alias-${paper.id}`}
              .value=${draft.alias}
              @input=${(event: Event) =>
                edited({ alias: (event.target as HTMLInputElement).value })}
            />
            <span class="register__hint">
              Names the Slack channel for a project that does not have one yet. Renaming it here
              does not rename a channel that already exists.
            </span>
          </label>
          <label class="my-work-details__field">
            <span>Started on</span>
            ${renderDateControl(
              html`<input
                class="input"
                type="date"
                data-testid=${`my-work-details-started-${paper.id}`}
                .value=${live(draft.startedOn)}
                @input=${(event: Event) =>
                  edited({ startedOn: (event.target as HTMLInputElement).value })}
              />`,
              draft.startedOn,
            )}
          </label>
        </div>
        ${draft.error
          ? html`<p
              class="my-work-add-form__error"
              role="alert"
              data-testid=${`my-work-details-error-${paper.id}`}
            >
              ${draft.error}
            </p>`
          : nothing}
        <div class="my-work-details__actions">
          <span class="my-work-details__autosave-hint">${t("myWork.details.autosaveHint")}</span>
          <!-- The explicit save. Autosave still does the work; this lets somebody who has just
               corrected a title *finish*, rather than wait out a debounce they cannot see. -->
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${!dirty}
            data-testid=${`my-work-details-save-${paper.id}`}
            @click=${() => {
              cancelAutosave(detailsSaveTimers.get(paper.id), setTimer);
              commit({ force: true });
            }}
          >
            Save details
          </button>
        </div>
      </form>
    </details>
  `;
}
