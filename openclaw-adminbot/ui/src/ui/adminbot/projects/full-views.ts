// The two whole-page drawings of the viewer's papers, offered beside the project cards:
//
//   - the flat view: every field of every paper on one page, laid out like the profile
//     (views/paper-legacy.ts), with each paper's blockers, targets, timeline, completion, cycle,
//     history and delete drawn alongside its fields;
//   - the sheet: one row per paper, built for pasting a column out of a spreadsheet (paper-grid.ts).
//
// Both write through the same two endpoints as the project pages -- the paper save and the slot
// save -- so they are other drawings of the same records, not other stores. Which one is showing is
// per-session view state: it changes nothing about the papers and nobody needs it after a reload.
import { html, nothing } from "lit";
import { isPaperFeedbackSlot } from "../../../../../extensions/adminbot/src/contracts/paper-feedback.js";
import type { AppViewState } from "../../app-view-state.ts";
import { mapImportColumns } from "../api/paper-admin.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import {
  clearHistory,
  clearSavedEdits,
  diffForHistory,
  emptyPaperGridState,
  recordHistory,
  renderPaperGrid,
  unsentSlotEdits,
  type PaperGridState,
} from "../paper-grid.ts";
import { paperSteps } from "../views/admin.ts";
import { renderPaperFeedback } from "../views/paper-feedback.ts";
import {
  cancelPaperLegacyAutosave,
  emptyPaperLegacyState,
  renderPaperLegacy,
  type PaperLegacyState,
} from "../views/paper-legacy.ts";
import { renderPaperTimeline } from "../views/paper-timeline.ts";
import { findOwnMember } from "../views/profile.ts";
import { paperIdFromTitle } from "./add-form.ts";
import {
  renderBlockerForm,
  renderPaperBlockers,
  renderReportBlockerButton,
} from "./blocker-report.ts";
import { renderCycle, renderWeeklyUpdates } from "./cycle.ts";
import { renderDeletePaper, renderHideButton, renderPaperRecentEdits } from "./paper-actions.ts";
import { renderCompletion, renderNextStep, renderStepControls } from "./progress.ts";
import { renderTarget, renderVenueTargets } from "./venues.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

export type ProjectsListMode = "cards" | "flat" | "sheet";

let mode: ProjectsListMode = "cards";
// Kept across renders so a half-typed field or cell survives a repaint.
let legacyState: PaperLegacyState | null = null;
let gridState: PaperGridState | null = null;

export function projectsListMode(): ProjectsListMode {
  return mode;
}

/** Switches the overview's drawing. The two whole-page views are exclusive: opening one closes the other. */
export function setProjectsListMode(next: ProjectsListMode): void {
  mode = next;
  legacyState = next === "flat" ? (legacyState ?? emptyPaperLegacyState()) : null;
  gridState = next === "sheet" ? (gridState ?? emptyPaperGridState()) : null;
}

/** Discards half-typed flat-form and sheet edits before a different member uses this browser. */
export function resetProjectsListViews(): void {
  cancelPaperLegacyAutosave();
  clearHistory();
  mode = "cards";
  legacyState = null;
  gridState = null;
}

/**
 * The feedback-request form, drawn in the flat view: its field list skips the feedback slots,
 * because a generic text box cannot build the request the service validates. Gated on the slots
 * having loaded so an unfetched paper does not offer a form for rows it has not seen.
 */
function renderFlatFeedback(paper: AdminBotPaperRecord, props: PaperWorkspaceProps) {
  const slots = props.slots[paper.id]?.slots ?? [];
  if (!slots.some((row) => isPaperFeedbackSlot(row.slot))) {
    return nothing;
  }
  return renderPaperFeedback({
    slots,
    loading: props.slotsBusyId === paper.id,
    onSaveSlot: (slot, input) => props.onSaveSlot(paper.id, slot, input),
  });
}

/**
 * What a project page has that the flat view's fields do not: everything that is not one answer
 * on the record or one evidence slot, drawn with the same renderers and handlers. The project
 * details and acceptance fields are left out because the flat form carries each of them as a row,
 * and two controls for one field are two answers waiting to disagree.
 */
function renderFlatExtras(
  state: AppViewState,
  paper: AdminBotPaperRecord,
  props: PaperWorkspaceProps,
) {
  return {
    top: html`
      <div class="paper-legacy__actions">
        ${renderReportBlockerButton(state, props, paper, `paper-legacy-report-${paper.id}`)}
        ${renderHideButton(props, paper, `paper-legacy-hide-${paper.id}`)}
      </div>
      ${renderPaperBlockers(state, props, paper)} ${renderBlockerForm(state, props, paper)}
      ${renderVenueTargets(paper)} ${renderTarget(paper, props)}
      ${renderPaperTimeline({
        paperId: paper.id,
        slots: props.slots[paper.id]?.slots ?? [],
        paper,
      })}
      ${renderNextStep(paper)} ${renderFlatFeedback(paper, props)}
    `,
    bottom: html`
      ${renderCompletion(paper, props)} ${renderWeeklyUpdates(paper, props)}
      ${renderCycle(state, paper, props)} ${renderStepControls(paper, props, { picker: false })}
      ${renderPaperRecentEdits(state, props, paper)} ${renderDeletePaper(paper, props)}
    `,
  };
}

export function renderFlatView(
  state: AppViewState,
  props: PaperWorkspaceProps,
  papers: AdminBotPaperRecord[],
) {
  legacyState ??= emptyPaperLegacyState();
  const rerender = () => props.onRerender?.();
  return renderPaperLegacy({
    state: legacyState,
    papers,
    slots: props.slots,
    onLoadSlots: props.onLoadSlots,
    onSavePaper: props.onSavePaper,
    onSaveSlot: props.onSaveSlot,
    onChange: rerender,
    onExit: () => {
      setProjectsListMode("cards");
      rerender();
    },
    renderPaperExtras: (paper) => renderFlatExtras(state, paper, props),
  });
}

export function renderSheetView(
  state: AppViewState,
  props: PaperWorkspaceProps,
  papers: AdminBotPaperRecord[],
) {
  gridState ??= emptyPaperGridState();
  const grid = gridState;
  const rerender = () => props.onRerender?.();
  return renderPaperGrid({
    state: grid,
    papers,
    onChange: rerender,
    slots: props.slots,
    onLoadSlots: props.onLoadSlots,
    onSaveSlots: (writes) => {
      for (const write of writes) {
        props.onSaveSlot(write.paperId, write.slot, write.input);
      }
    },
    viewerName: findOwnMember(state)?.name ?? "",
    onSaveAll: (inputs) => {
      grid.saving = true;
      grid.notice = `Saving ${inputs.length} paper(s)…`;
      // Diffed before the write: afterwards the record holds the new value and "changed X from A
      // to B" would no longer be answerable.
      const entries = diffForHistory(grid, papers);
      const stranded = unsentSlotEdits(grid, papers);
      grid.history = recordHistory(entries);
      rerender();
      // One request per changed paper, because that is the endpoint that exists today.
      for (const input of inputs) {
        props.onSavePaper(input);
      }
      grid.saving = false;
      clearSavedEdits(grid, papers);
      grid.notice = `Sent ${inputs.length} paper(s) · ${entries.length} change(s) logged.${
        // Evidence cells typed against a paper whose slots had not loaded need a second press.
        stranded ? ` ${stranded} evidence cell(s) still loading — press Update again.` : ""
      }`;
      rerender();
    },
    onExit: () => {
      setProjectsListMode("cards");
      rerender();
    },
    onMapColumnsWithModel: async (unmapped, available) => {
      const stored = loadStoredMemberSession();
      return stored
        ? mapImportColumns(
            unmapped,
            available,
            stored.sessionToken,
            resolveAdminBotBaseUrl(state.settings),
          )
        : {};
    },
    // Rows that matched no paper become new records -- a deliberate second step, same endpoint.
    onCreatePapers: (candidates) => {
      for (const candidate of candidates) {
        const title = candidate.values.title ?? "";
        props.onSavePaper({
          id: paperIdFromTitle(title),
          title,
          authors: [],
          currentStep: paperSteps[0],
          alias: candidate.values.alias ?? "",
          startedOn: candidate.values.started_on ?? "",
        });
      }
    },
  });
}

export function renderListMode(
  state: AppViewState,
  props: PaperWorkspaceProps,
  papers: AdminBotPaperRecord[],
) {
  if (mode === "flat") {
    return html`<div class="my-work my-work--legacy">${renderFlatView(state, props, papers)}</div>`;
  }
  if (mode === "sheet") {
    return html`<div class="my-work my-work--sheet">${renderSheetView(state, props, papers)}</div>`;
  }
  return nothing;
}
