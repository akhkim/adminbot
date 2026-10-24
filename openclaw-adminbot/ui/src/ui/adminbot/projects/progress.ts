// Where a project stands and how it moves: the pipeline step, what can be done next, the venue's
// decision and what it owes once it said yes, and "this one is finished".
//
// Every write here is the whole required record plus the changed fields, through the same paper
// save the rest of the page uses, so Active Papers and the project page can never disagree about
// where something is.
import { html, nothing } from "lit";
import {
  adminBotPaperAcceptanceNeedsOverleafReason,
  isAdminBotPaperAcceptanceUnblocked,
} from "../../../../../extensions/adminbot/src/contracts/paper-slots.js";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { PaperSlotOverviewRow } from "../api/paper-admin.ts";
import type {
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  AdminBotPaperStep,
} from "../controllers/admin.ts";
import { paperSteps } from "../data/paper-steps.ts";
import { isDormant, nextStepFor, nextTasksFor } from "../next-step.ts";
import {
  PRESENTATION_FORMATS,
  PUBLICATION_TRACKS,
  presentationFormat,
  publicationTrack,
} from "../paper-classification.ts";
import { completedOnLabel, completionReadiness, isPaperCompleted } from "../paper-completion.ts";
import { openPaperFlowMap } from "../paperflow-map.ts";
import { paperProgress, stepLabel } from "./model.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

function savePaperFields(
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
  fields: Partial<AdminBotPaperSaveInput>,
) {
  props.onSavePaper({
    id: paper.id,
    title: paper.title,
    authors: paper.authors ?? [],
    currentStep: paper.current_step,
    ...fields,
  });
}

/**
 * Two ways to move a paper, because they answer different questions: "it moved on" (Next) and
 * "it is actually at X" (the picker). Both write `current_step`, which still buckets blockers and
 * drives Active Papers, so it has to be movable in both directions -- a mis-click, or a rejection
 * that sends a paper back to writing. Jumping *forward* past unfinished steps asks first, because
 * that is the move that asserts work happened.
 *
 * `picker: false` leaves the dropdown off where the page already has a Current step control (the
 * flat view), so one field is not two dropdowns that can disagree mid-edit.
 */
export function renderStepControls(
  paper: AdminBotPaperRecord,
  props: PaperWorkspaceProps,
  options: { picker?: boolean } = {},
) {
  const { index } = paperProgress(paper);
  const next = index >= 0 && index < paperSteps.length - 1 ? paperSteps[index + 1] : null;
  return html`
    <div class="my-work-item__controls">
      <button
        type="button"
        class="btn btn--sm"
        data-testid=${`my-work-map-${paper.id}`}
        @click=${() => openPaperFlowMap(paper)}
      >
        View PaperFlow
      </button>
      ${next
        ? html`
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`my-work-advance-${paper.id}`}
              @click=${() => savePaperFields(props, paper, { currentStep: next })}
            >
              ${t("myWork.items.advance", { step: stepLabel(next) })}
            </button>
          `
        : nothing}
      ${options.picker === false
        ? nothing
        : html`<label class="my-work-item__step">
            <span class="sr-only">Pipeline step</span>
            <select
              class="target__select"
              data-testid=${`my-work-step-${paper.id}`}
              @change=${(event: Event) => {
                const target = (event.target as HTMLSelectElement).value as AdminBotPaperStep;
                const targetIndex = paperSteps.indexOf(target);
                if (targetIndex - index > 1) {
                  const names = paperSteps
                    .slice(index, targetIndex)
                    .map((value) => stepLabel(value))
                    .join(", ");
                  if (
                    !globalThis.confirm(
                      `Jumping to ${stepLabel(target)} marks these as done: ${names}.\n\nContinue?`,
                    )
                  ) {
                    (event.target as HTMLSelectElement).value = paper.current_step;
                    return;
                  }
                }
                savePaperFields(props, paper, { currentStep: target });
              }}
            >
              ${paperSteps.map(
                (step) => html`
                  <option value=${step} ?selected=${step === paper.current_step}>
                    ${stepLabel(step)}
                  </option>
                `,
              )}
            </select>
          </label>`}
    </div>
  `;
}

/**
 * What can be done now, derived from the PaperFlow dependency graph rather than typed by hand.
 * Read-only. The graph fans out, so the frontier is usually several tasks at once, and listing
 * them as cards says "these can happen in parallel".
 */
export function renderNextStep(paper: AdminBotPaperRecord) {
  // A dormant paper says why it is quiet; silence would read as a broken page.
  if (isDormant(paper)) {
    return html`<p class="my-work-item__next my-work-item__next--dormant">
      <span>Dormant — no reminders while this sits idle. Move a step to wake it up.</span>
    </p>`;
  }
  const next = nextStepFor(paper);
  if (!next) {
    return nothing;
  }
  if (next.done) {
    return html`<p class="my-work-item__next my-work-item__next--done">
      ${icons.check} <span>Everything on this paper is finished.</span>
    </p>`;
  }
  const tasks = nextTasksFor(paper);
  if (tasks.length === 0) {
    return nothing;
  }
  return html`
    <div class="tasks">
      <p class="tasks__title">
        What can be done now
        ${tasks.length > 1
          ? html`<span class="tasks__count">${tasks.length} in parallel</span>`
          : nothing}
      </p>
      <ul class="tasks__grid">
        ${tasks.map(
          (task) => html`
            <li
              class=${`task ${task.isApproval ? "task--approval" : ""} ${
                task.optional ? "task--optional" : ""
              }`}
            >
              <span class="task__branch">${task.branch || "Task"}</span>
              <strong class="task__label">${task.label}</strong>
              ${task.hint ? html`<span class="task__hint">${task.hint}</span>` : nothing}
              <span class="task__footer">
                <span class="task__who">
                  ${task.isApproval
                    ? `Approval from ${task.waitingOn}`
                    : `Owner: ${task.waitingOn}`}
                </span>
                <span class="task__unblocks">
                  ${task.optional
                    ? "Blocks nothing"
                    : task.unblocks.length
                      ? `Unblocks ${task.unblocks.slice(0, 2).join(", ")}`
                      : "Last step on this branch"}
                </span>
              </span>
            </li>
          `,
        )}
      </ul>
    </div>
  `;
}

/**
 * What the venue said, and what it owes once it said yes.
 *
 * Asked rather than inferred: `is_archival` decides whether this counts as a publication at all,
 * and the same workshop can be archival one year and not the next. Until these are in, the
 * conference half of the Social tab stays shut.
 */
export function renderAcceptance(paper: AdminBotPaperRecord, props: PaperWorkspaceProps) {
  const decision = paper.venue_decision ?? "pending";
  const save = (fields: Partial<AdminBotPaperSaveInput>) => savePaperFields(props, paper, fields);
  // Mirrors the service's refusal so the option is shut before it is chosen rather than bounced
  // after. Only once the slots are loaded: an unread cycle is not evidence of a missing link, and
  // the service is the check that holds either way.
  const slotRows = props.slots[paper.id]?.slots;
  const acceptBlocked =
    decision !== "accept" &&
    slotRows !== undefined &&
    !isAdminBotPaperAcceptanceUnblocked(slotRows);
  return html`
    <div
      class="paper-acceptance"
      data-decision=${decision}
      data-testid=${`paper-acceptance-${paper.id}`}
    >
      <label class="paper-acceptance__field">
        <span class="register__label">Venue decision</span>
        <select
          class="input"
          data-testid=${`paper-decision-${paper.id}`}
          @change=${(event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            (event.target as HTMLSelectElement)
              .closest(".paper-acceptance")
              ?.setAttribute("data-decision", value);
            save({ venueDecision: value });
          }}
        >
          ${["pending", "accept", "reject"].map(
            (value) => html`
              <option
                value=${value}
                ?selected=${value === decision}
                ?disabled=${value === "accept" && acceptBlocked}
              >
                ${value === "pending"
                  ? "Not heard yet"
                  : value === "accept"
                    ? "Accepted"
                    : "Rejected"}
              </option>
            `,
          )}
        </select>
      </label>
      ${acceptBlocked
        ? html`<p
            class="paper-acceptance__note"
            data-testid=${`paper-decision-needs-overleaf-${paper.id}`}
          >
            ${adminBotPaperAcceptanceNeedsOverleafReason}
          </p>`
        : nothing}
      ${decision === "accept"
        ? html`
            <label class="paper-acceptance__field">
              <span class="register__label">Accepted venue</span>
              <input
                class="input"
                .value=${paper.accepted_venue ?? ""}
                placeholder="e.g. ACL 2027"
                data-testid=${`paper-accepted-venue-${paper.id}`}
                @change=${(event: Event) =>
                  save({ acceptedVenue: (event.target as HTMLInputElement).value })}
              />
            </label>
            <label class="paper-acceptance__field">
              <span class="register__label">Year</span>
              <input
                class="input"
                type="number"
                min="2000"
                max="2100"
                .value=${paper.accepted_year ? String(paper.accepted_year) : ""}
                data-testid=${`paper-accepted-year-${paper.id}`}
                @change=${(event: Event) =>
                  save({ acceptedYear: (event.target as HTMLInputElement).value })}
              />
            </label>
            <label class="paper-acceptance__field">
              <span class="register__label">Archival?</span>
              <select
                class="input"
                data-testid=${`paper-archival-${paper.id}`}
                @change=${(event: Event) =>
                  save({ isArchival: (event.target as HTMLSelectElement).value })}
              >
                <option value="" ?selected=${paper.is_archival === undefined}>Not said</option>
                <option value="true" ?selected=${paper.is_archival === true}>
                  Archival — counts as a publication
                </option>
                <option value="false" ?selected=${paper.is_archival === false}>Non-archival</option>
              </select>
            </label>
            <label class="paper-acceptance__field">
              <span class="register__label">Publication track</span>
              <select
                class="input"
                data-testid=${`paper-track-${paper.id}`}
                @change=${(event: Event) =>
                  save({ publicationTrack: (event.target as HTMLSelectElement).value })}
              >
                <option value="" ?selected=${!publicationTrack(paper)}>Not said</option>
                ${PUBLICATION_TRACKS.map(
                  (track) =>
                    html`<option value=${track} ?selected=${publicationTrack(paper) === track}>
                      ${track[0]?.toUpperCase()}${track.slice(1)}
                    </option>`,
                )}
              </select>
            </label>
            <label class="paper-acceptance__field">
              <span class="register__label">Presentation format</span>
              <select
                class="input"
                data-testid=${`paper-presentation-${paper.id}`}
                @change=${(event: Event) =>
                  save({ presentationType: (event.target as HTMLSelectElement).value })}
              >
                <option value="" ?selected=${!presentationFormat(paper)}>Not said</option>
                ${PRESENTATION_FORMATS.map(
                  (type) => html`
                    <option value=${type} ?selected=${type === presentationFormat(paper)}>
                      ${type[0]?.toUpperCase()}${type.slice(1)}
                    </option>
                  `,
                )}
              </select>
            </label>
          `
        : nothing}
    </div>
  `;
}

/**
 * "This one is finished" -- the last thing anybody does to a paper. Greyed out with its reason
 * until a venue has accepted; see paper-completion.ts for why presenting is a claim a person makes.
 * Reopening clears the stamp with "" rather than omitting it, which the merge would leave alone.
 */
export function renderCompletion(paper: AdminBotPaperRecord, props: PaperWorkspaceProps) {
  const done = isPaperCompleted(paper);
  const { ready, reason } = completionReadiness(paper);
  const write = (completedAt: string) => savePaperFields(props, paper, { completedAt });
  return html`
    <div class="paper-completion" data-testid=${`paper-completion-${paper.id}`}>
      ${done
        ? html`
            <p class="paper-completion__done">
              Completed <span class="ab-num">${completedOnLabel(paper)}</span>
            </p>
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`paper-reopen-${paper.id}`}
              @click=${() => write("")}
            >
              Reopen
            </button>
          `
        : html`
            <button
              type="button"
              class="btn btn--sm"
              ?disabled=${!ready}
              data-testid=${`paper-complete-${paper.id}`}
              @click=${() => write(new Date().toISOString())}
            >
              Mark as presented and completed
            </button>
            ${reason ? html`<span class="paper-completion__why">${reason}</span>` : nothing}
          `}
    </div>
  `;
}

/**
 * The one phrase that says how a paper the card list leaves out stands.
 *
 * "Everything is in" is a claim about the artifacts, so it is made from the count and never from
 * an empty `missing_slots`: the service chases nothing on a rejected paper, which is how a paper
 * with nothing on file once announced that everything was in.
 */
export function renderOutstanding(row: PaperSlotOverviewRow) {
  const outstanding = row.missing_slots.length;
  if (row.dormant) {
    return html`<span class="pill">Dormant</span>`;
  }
  if (row.closed) {
    return html`<span class="my-work-item__outstanding is-closed"
      >Rejected — pick a new venue to reopen it</span
    >`;
  }
  if (row.provided_count >= row.required_count) {
    return html`<span class="my-work-item__outstanding is-complete">Everything is in</span>`;
  }
  if (outstanding === 0) {
    return html`<span class="my-work-item__outstanding">Waiting on earlier steps</span>`;
  }
  return html`<span class="my-work-item__outstanding"
    >${row.provided_count}/${row.required_count} · ${outstanding}
    outstanding${row.escalating ? " · escalating" : ""}</span
  >`;
}
