// Blockers on a project: the report form, the ones already filed on a paper, and the roll-up of
// every open blocker across the viewer's own papers.
//
// Blockers are real records, written onto the paper the same way the step is (see ../blockers.ts),
// so an admin sees a report the moment it is filed and a member and an admin are always looking at
// the same rows. Moved here from the old My Projects card when the card became a project page.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import {
  BLOCKER_TITLE_MAX,
  editBlockerInput,
  fileBlockerInput,
  openEntries,
  resolveBlockerInput,
} from "../blockers.ts";
import type { AdminBotPaperRecord, AdminBotPaperStep } from "../controllers/admin.ts";
import { paperSteps } from "../views/admin.ts";
import { findOwnMember } from "../views/profile.ts";
import { stepLabel } from "./model.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

// Who reviews a blocker. The lab's head professor is a setting, so read it rather than naming a
// person in the source; fall back only when the setting has not loaded.
const FALLBACK_REVIEWER = "Zhijing";

/** A text field's value from a submitted form; anything else (a File) reads as empty. */
function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

export function reviewerName(state: AppViewState): string {
  const headId = state.adminBotData?.settings?.head_professor_member_id;
  if (!headId) {
    return FALLBACK_REVIEWER;
  }
  const head = (state.adminBotData?.members ?? []).find((member) => member.id === headId);
  return head?.name?.trim() || FALLBACK_REVIEWER;
}

/** Opens the report form for one paper. Outside the form so pressing it changes nothing else. */
export function renderReportBlockerButton(
  state: AppViewState,
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
  testId = `my-work-report-${paper.id}`,
) {
  return html`<button
    type="button"
    class="btn btn--sm"
    data-testid=${testId}
    @click=${() => {
      state.myWorkBlockerDraft = { paperId: paper.id, text: "" };
      props.onRerender?.();
    }}
  >
    ${t("myWork.blockers.report")}
  </button>`;
}

/**
 * Report a blocker, as structured data rather than a chat message.
 *
 * The stage is a fixed list rather than free text because the whole point is that an admin can
 * sort by it. It reuses `paperSteps`, so the options a member picks from and the buckets an admin
 * sorts into cannot drift apart.
 */
export function renderBlockerForm(
  state: AppViewState,
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
) {
  const draft = state.myWorkBlockerDraft;
  if (draft?.paperId !== paper.id) {
    return nothing;
  }
  const editing = draft.at ? openEntries(paper).find((entry) => entry.at === draft.at) : undefined;

  return html`
    <form
      class="blocker-form"
      @submit=${async (event: SubmitEvent) => {
        event.preventDefault();
        if (draft.saving) {
          return;
        }
        const data = new FormData(event.currentTarget as HTMLFormElement);
        const title = formText(data, "title").trim();
        const titleInput = (event.currentTarget as HTMLFormElement).elements.namedItem(
          "title",
        ) as HTMLInputElement;
        titleInput.setCustomValidity(title ? "" : "Enter a short description of what is blocked.");
        if (!titleInput.reportValidity()) {
          return;
        }
        const fields = {
          stage: formText(data, "stage"),
          title,
          note: formText(data, "note").trim(),
        };
        Object.assign(draft, fields, { saving: true, error: undefined });
        props.onRerender?.();
        try {
          const saved = await props.onSaveBlocker?.(
            editing
              ? editBlockerInput(paper, editing.at, fields)
              : // Named at filing time so the admin list can say who to go ask.
                fileBlockerInput(paper, { ...fields, by: findOwnMember(state)?.name ?? "" }),
          );
          if (state.myWorkBlockerDraft !== draft) {
            return;
          }
          if (saved) {
            state.myWorkBlockerDraft = null;
          } else {
            draft.error = "Could not save the blocker report. Your draft is kept. Try again.";
          }
        } catch {
          if (state.myWorkBlockerDraft === draft) {
            draft.error = "Could not save the blocker report. Your draft is kept. Try again.";
          }
        } finally {
          draft.saving = false;
          props.onRerender?.();
        }
      }}
    >
      <p class="blocker-form__notice">
        <span class="blocker-form__notice-icon" aria-hidden="true">${icons.alertTriangle}</span>
        <span>
          This is a quick blocker report for PaperFlow — not a messaging system. Anything
          confidential, or anything that needs a back-and-forth, belongs in Slack.
        </span>
      </p>

      <div class="blocker-form__fields">
        <label class="register__field">
          <span class="register__label">Which stage is blocked?</span>
          <select
            class="input"
            name="stage"
            ?disabled=${draft.saving}
            data-testid=${`blocker-stage-${paper.id}`}
          >
            ${paperSteps.map(
              (step) => html`
                <option
                  value=${step}
                  ?selected=${step === (draft.stage || editing?.stage || paper.current_step)}
                >
                  ${stepLabel(step)}
                </option>
              `,
            )}
          </select>
        </label>

        <label class="register__field">
          <span class="register__label">What is blocked? (short, required)</span>
          <input
            class="input"
            name="title"
            ?disabled=${draft.saving}
            required
            @input=${(event: Event) => (event.target as HTMLInputElement).setCustomValidity("")}
            maxlength=${BLOCKER_TITLE_MAX}
            placeholder="e.g. OpenReview rejects the PDF"
            .value=${draft.title ?? editing?.title ?? ""}
            data-testid=${`blocker-title-${paper.id}`}
          />
          <span class="register__hint">Up to ${BLOCKER_TITLE_MAX} characters.</span>
        </label>
      </div>

      <label class="register__field">
        <span class="register__label">Details</span>
        <textarea
          class="input"
          name="note"
          ?disabled=${draft.saving}
          rows="4"
          placeholder=${t("myWork.blockers.placeholder")}
        >
${draft.note ?? editing?.note ?? ""}</textarea
        >
      </label>

      ${draft.error ? html`<p role="alert">${draft.error}</p>` : nothing}
      <div class="blocker-form__footer">
        <p class="blocker-form__reviewer">
          ${t("myWork.blockers.reviewer", { name: reviewerName(state) })}
        </p>
        <div class="register__actions">
          <button
            type="submit"
            class="btn primary"
            ?disabled=${draft.saving}
            aria-busy=${Boolean(draft.saving)}
          >
            ${draft.saving
              ? "Saving report…"
              : editing
                ? "Save changes"
                : t("myWork.blockers.submit")}
          </button>
          <button
            type="button"
            class="btn"
            @click=${() => {
              state.myWorkBlockerDraft = null;
              props.onRerender?.();
            }}
          >
            ${t("myWork.blockers.cancel")}
          </button>
        </div>
      </div>
    </form>
  `;
}

/**
 * The blockers already filed on one paper, each with its own controls.
 *
 * Per-row rather than one form for the paper, because a paper can be stuck on several things and
 * "edit the blocker" is meaningless once there are three of them.
 */
export function renderPaperBlockers(
  state: AppViewState,
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
) {
  const open = openEntries(paper);
  if (open.length === 0) {
    return nothing;
  }
  return html`
    <ul class="my-work-item__blockers">
      ${open.map(
        (entry) => html`
          <li class="my-work-item__blocker">
            <span class="my-work-item__blocker-icon" aria-hidden="true"
              >${icons.alertTriangle}</span
            >
            <span class="my-work-item__blocker-copy">
              <span class="my-work-item__blocker-title">${entry.title}</span>
              <span class="my-work-item__blocker-meta">${stepLabel(entry.stage)}</span>
            </span>
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`blocker-edit-${paper.id}-${entry.at}`}
              @click=${() => {
                state.myWorkBlockerDraft = { paperId: paper.id, at: entry.at, text: "" };
                props.onRerender?.();
              }}
            >
              Edit
            </button>
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`blocker-resolve-${paper.id}-${entry.at}`}
              @click=${() => {
                props.onSavePaper(
                  resolveBlockerInput(paper, entry.at, findOwnMember(state)?.name ?? ""),
                );
              }}
            >
              Resolved
            </button>
          </li>
        `,
      )}
    </ul>
  `;
}

/**
 * Every open blocker across the viewer's own papers.
 *
 * Derived from the papers themselves rather than from a separate list, so a blocker filed here is
 * the one that shows up in the head professor's sorted view, and clearing it there clears it here.
 */
export function renderBlockerBoard(state: AppViewState, items: AdminBotPaperRecord[]) {
  const blockers = items.flatMap((paper) =>
    openEntries(paper).map((blocker) => ({ paper, blocker })),
  );
  if (!blockers.length) {
    return nothing;
  }
  return html`
    <section class="my-work__section" data-testid="my-work-blockers">
      <h2 class="my-work__section-title">${t("myWork.blockers.title")}</h2>
      <div class="my-work__blockers">
        ${blockers.map(
          ({ paper, blocker }) => html`
            <article class="my-work-blocker">
              <span class="my-work-blocker__icon" aria-hidden="true">${icons.alertTriangle}</span>
              <div class="my-work-blocker__copy">
                <p class="my-work-blocker__text">${blocker.title}</p>
                <p class="my-work-blocker__meta">
                  ${paper.title} · ${stepLabel(blocker.stage as AdminBotPaperStep)} ·
                  ${t("myWork.blockers.reviewer", { name: reviewerName(state) })}
                </p>
              </div>
              <span class="pill my-work-blocker__status">${t("myWork.blockers.pending")}</span>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}
