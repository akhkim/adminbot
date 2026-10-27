// One project's page at /my-work/<paper>/<tab>: a Project tab for the record itself, and a tab per
// lane holding that lane's checklist.
//
// Reads the paper from the lab list the page already holds and its checklist from the per-paper
// cycle read. Every write goes through the workspace props (surfaces/projects.ts), so the service's
// own checks -- who may fill which slot, what shape a link must have -- are the ones that apply.
//
// The Project tab carries what the old card did around the checklist: the decision banner, the
// blockers, where the paper is aimed and whether it is finished, its details and people, the
// timeline and next steps, the weekly log, its history, and delete. The lane tabs carry the
// checklist itself, drawn by the same renderer the flat view uses, one branch per tab, with the
// venue decision on Venue and the drafts and conference rows on Social.
import { html, nothing, type TemplateResult } from "lit";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { isPaperCompleted } from "../paper-completion.ts";
import { openPreRegistrationDialog } from "../pre-registration.ts";
import { renderPaperDetails, renderPaperSlots } from "../views/paper-slots.ts";
import { renderPaperTimeline } from "../views/paper-timeline.ts";
import {
  renderBlockerForm,
  renderPaperBlockers,
  renderReportBlockerButton,
} from "./blocker-report.ts";
import { renderCycle, renderWeeklyUpdates } from "./cycle.ts";
import { renderDecisionBanners } from "./decisions.ts";
import { renderProjectDetails } from "./details.ts";
import {
  navigateToProject,
  ownPapers,
  PROJECT_LANES,
  stepLabel,
  venuePosition,
  type ProjectLane,
  type ProjectSummary,
  type ProjectTab,
} from "./model.ts";
import type { ProjectsNavState } from "./nav.ts";
import { renderDeletePaper, renderHideButton, renderPaperRecentEdits } from "./paper-actions.ts";
import {
  renderAcceptance,
  renderCompletion,
  renderNextStep,
  renderOutstanding,
  renderStepControls,
} from "./progress.ts";
import { renderTarget, renderVenueTargets } from "./venues.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

type PageState = ProjectsNavState;

/** Papers whose checklist this page has asked for, so a failed read is not retried every render. */
const requested = new Set<string>();

/** Forgets which checklists were asked for, so the next member's pages read their own. */
export function resetProjectPageState(): void {
  requested.clear();
}

function requestCycle(props: PaperWorkspaceProps, paperId: string): void {
  if (props.slots[paperId] || requested.has(paperId) || !props.onLoadSlots) {
    return;
  }
  requested.add(paperId);
  // Out of the render pass: a read that settles synchronously in a test would re-enter Lit.
  queueMicrotask(() => props.onLoadSlots?.(paperId));
}

export function renderProjectPage(
  state: PageState,
  props: PaperWorkspaceProps,
  paperId: string,
  tab: ProjectTab,
) {
  const paper = state.adminBotData?.papers?.find((candidate) => candidate.id === paperId);
  if (!paper) {
    return html`<p class="projects__empty">
      ${state.adminBotLoading ? "Loading…" : "This paper is not on your list."}
      <a href="#" @click=${(event: Event) => back(event, state)}>Back to your projects</a>
    </p>`;
  }
  requestCycle(props, paperId);
  const summary = state.myProjects?.find((project) => project.paper_id === paperId);
  const lane = PROJECT_LANES.find((candidate) => candidate.segment === tab);
  const own = ownPapers(state).some((candidate) => candidate.id === paper.id);
  const cycle = props.slots[paper.id];
  // The deadline is what decides how urgent the paper is, so it sits beside where it is aimed.
  const deadline = paper.deadline;
  return html`<section class="project" data-testid=${`project-${paperId}`}>
    <a class="project__back" href="#" @click=${(event: Event) => back(event, state)}
      >‹ My projects</a
    >
    <header class="project__head">
      <h2>
        ${paper.title}
        ${isPaperCompleted(paper)
          ? html`<span class="my-work-item__badge" data-testid=${`my-work-done-badge-${paper.id}`}
              >Completed</span
            >`
          : nothing}
      </h2>
      <p>
        ${paper.alias ? html`<span class="project__alias">#${paper.alias}</span>` : nothing}
        ${summary ? venuePosition(summary) : paper.venue || "No venue picked yet"} ·
        ${stepLabel(paper.current_step)}
        ${deadline
          ? html`· due
              <span class="ab-num" data-testid="project-deadline">${deadline.slice(0, 10)}</span>`
          : nothing}
      </p>
      <p class="project__meta">${(paper.authors ?? []).join(", ")}</p>
      <div class="project__actions">
        ${renderReportBlockerButton(state, props, paper)}
        ${own ? renderHideButton(props, paper) : nothing}
      </div>
    </header>
    ${renderPaperBlockers(state, props, paper)} ${renderBlockerForm(state, props, paper)}
    <nav class="project__tabs" role="tablist">
      ${renderTabLink(state, paperId, "project", "Project", tab, undefined)}
      ${PROJECT_LANES.map((candidate) =>
        renderTabLink(state, paperId, candidate.segment, candidate.label, tab, summary, candidate),
      )}
    </nav>
    ${props.slotsError
      ? html`<p class="project__error my-work__error-line" role="alert">
          ${props.slotsError}
          ${!cycle && props.onLoadSlots
            ? html`<button
                type="button"
                class="btn btn--sm"
                data-testid="project-retry"
                @click=${() => props.onLoadSlots?.(paper.id)}
              >
                Retry
              </button>`
            : nothing}
        </p>`
      : nothing}
    <div class="project__body">
      ${lane
        ? renderLaneTab(state, props, paper, lane)
        : renderProjectTab(state, props, paper, summary, own)}
    </div>
  </section>`;
}

function back(event: Event, state: PageState) {
  event.preventDefault();
  navigateToProject(state, null);
}

function renderTabLink(
  state: PageState,
  paperId: string,
  segment: ProjectTab,
  label: string,
  current: ProjectTab,
  summary: ProjectSummary | undefined,
  lane?: ProjectLane,
) {
  const open = lane && summary ? summary.lanes[lane.branch].open : 0;
  return html`<a
    role="tab"
    aria-selected=${segment === current ? "true" : "false"}
    class="project__tab ${segment === current ? "is-active" : ""}"
    href=${`${state.basePath}/my-work/${encodeURIComponent(paperId)}${segment === "project" ? "" : `/${segment}`}`}
    data-testid=${`project-tab-${segment}`}
    @click=${(event: MouseEvent) => {
      event.preventDefault();
      navigateToProject(state, paperId, segment);
    }}
    >${lane
      ? html`<span class="lane-dot lane-dot--${lane.branch}" aria-hidden="true"></span>`
      : nothing}${label}${open ? html`<small>${open}</small>` : nothing}</a
  >`;
}

// ---------------------------------------------------------------- Project tab

function renderOpenWork(
  state: PageState,
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
  summary: ProjectSummary | undefined,
) {
  if (summary?.todos.length) {
    return html`<ul class="project__todos">
      ${summary.todos.map((todo) => {
        const lane = PROJECT_LANES.find((candidate) => candidate.branch === todo.lane);
        return html`<li class=${todo.ready ? "is-ready" : "is-waiting"}>
          <span class="lane-dot lane-dot--${todo.lane}" aria-hidden="true"></span>
          <a
            href="#"
            @click=${(event: Event) => {
              event.preventDefault();
              navigateToProject(state, paper.id, lane?.segment ?? "project");
            }}
            >${todo.label}</a
          >
          <small>${todo.ready ? "can be done now" : `waiting · ${lane?.label ?? ""}`}</small>
        </li>`;
      })}
    </ul>`;
  }
  // Not one of the viewer's active projects -- finished, rejected, dormant, or somebody else's
  // paper opened from Active Papers -- so the sidebar summary does not carry it. The service's
  // overview row still says how it stands.
  const row = props.overview.find((candidate) => candidate.paper_id === paper.id);
  return row ? html`<p>${renderOutstanding(row)}</p>` : html`<p>Nothing open.</p>`;
}

function renderProjectTab(
  state: PageState,
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
  summary: ProjectSummary | undefined,
  own: boolean,
) {
  const cycle = props.slots[paper.id];
  return html`
    ${own ? renderDecisionBanners([paper], props, state.adminBotData?.members ?? []) : nothing}
    <div class="project__grid">
      <section class="project__panel">
        <h3>What is open</h3>
        ${renderOpenWork(state, props, paper, summary)}
      </section>
      <section class="project__panel" data-testid="project-target">
        <h3>Where it is going</h3>
        <p>${summary ? venuePosition(summary) : paper.venue || "No venue picked yet"}</p>
        ${renderVenueTargets(paper)} ${renderTarget(paper, props)}
        <div>
          <button
            type="button"
            class="btn btn--sm"
            data-testid="project-prereg"
            @click=${() =>
              openPreRegistrationDialog({
                papers: [paper],
                onSavePaper: props.onSavePaper,
                onDone: () => props.onRerender?.(),
              })}
          >
            Pre-register venues
          </button>
        </div>
        ${renderCompletion(paper, props)}
      </section>
      <section class="project__panel">
        <h3>Progress</h3>
        ${renderNextStep(paper)} ${renderStepControls(paper, props)}
      </section>
    </div>
    ${renderPaperTimeline({ paperId: paper.id, slots: cycle?.slots ?? [], paper })}
    ${renderProjectDetails(state, props, paper)}
    <section class="project__panel" data-testid="project-people">
      ${renderPaperDetails({
        paperId: paper.id,
        details: {
          authors: paper.authors ?? [],
          // The picker renders when the roster is on hand; without it the block falls back to the
          // old text box rather than an author list nobody can add to.
          authorLinks: paper.author_links ?? [],
          members: (state.adminBotData?.members ?? []).map((member) =>
            member.email
              ? { id: member.id, name: member.name, hint: member.email }
              : { id: member.id, name: member.name },
          ),
          coauthorDraft: state.myWorkCoauthorDraft?.[paper.id] ?? {
            email: "",
            name: "",
            twitter: "",
          },
          onCoauthorDraftChange: (draft) => {
            const current = state.myWorkCoauthorDraft?.[paper.id] ?? {
              email: "",
              name: "",
              twitter: "",
            };
            state.myWorkCoauthorDraft = {
              ...state.myWorkCoauthorDraft,
              [paper.id]: { ...current, ...draft },
            };
            props.onRerender?.();
          },
          feedbackGivers: paper.feedback_givers ?? [],
          venue: paper.venue ?? paper.artifacts?.conference ?? "",
          authorRoles: paper.author_roles ?? "",
          // The same paper save every other control here uses, so the people and the step pointer
          // cannot end up on different records.
          onSaveDetails: (details) =>
            props.onSavePaper({
              id: paper.id,
              title: paper.title,
              authors: details.authors,
              // The links are the author list now; `authors` rides along for an older service.
              ...(details.authorLinks ? { authorLinks: details.authorLinks } : {}),
              feedbackGivers: details.feedbackGivers,
              venue: details.venue,
              authorRoles: details.authorRoles,
              currentStep: paper.current_step,
            }),
        },
      })}
    </section>
    ${cycle
      ? html`<section class="project__panel">
          <h3>Weekly updates</h3>
          ${renderWeeklyUpdates(paper, props)}
        </section>`
      : nothing}
    <!-- Who moved this paper, and when, then the one destructive control: last, so it is not
         something to hit while scrolling. -->
    ${renderPaperRecentEdits(state, props, paper)} ${renderDeletePaper(paper, props)}
  `;
}

// ---------------------------------------------------------------- lane tabs

function renderLaneTab(
  state: PageState,
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
  lane: ProjectLane,
) {
  const cycle = props.slots[paper.id];
  const extra: TemplateResult | typeof nothing =
    lane.branch === "venue"
      ? html`<section class="project__panel">
          <h3>Venue decision</h3>
          ${renderAcceptance(paper, props)}
        </section>`
      : lane.branch === "social"
        ? renderCycle(state, paper, props)
        : nothing;
  return html`<p class="project__legend">${lane.legend}.</p>
    ${cycle
      ? renderPaperSlots({
          paperId: paper.id,
          paperTitle: paper.title,
          paper,
          slots: cycle.slots,
          stages: cycle.stages,
          loading: props.slotsBusyId === paper.id,
          onSaveSlot: (slot, input) => props.onSaveSlot(paper.id, slot, input),
          branch: lane.branch,
          // "Write the draft" on a social gate opens the drafts below it on the same tab.
          ...(lane.branch === "social"
            ? {
                onOpenDraft: () => {
                  const el = document.getElementById(`paper-social-drafts-${paper.id}`);
                  if (el instanceof HTMLDetailsElement) {
                    el.open = true;
                    el.scrollIntoView({ behavior: "smooth", block: "start" });
                  }
                },
              }
            : {}),
        })
      : html`<p class="projects__empty">Loading this paper's checklist…</p>`}
    ${extra}`;
}
