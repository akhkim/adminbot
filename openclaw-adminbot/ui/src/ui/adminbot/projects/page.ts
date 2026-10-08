// One project's page at /my-work/<paper>/<tab>: a Project tab for the record itself, and a tab
// per lane holding that lane's checklist as a plain form.
//
// Reads the paper from the lab list the page already holds and its checklist from the per-paper
// cycle read; every write goes through the existing controllers, so the service's own checks
// (who may fill which slot, what shape a link must have) are the ones that apply.
import { html, nothing, type TemplateResult } from "lit";
import {
  adminBotPaperPresentationTypes,
  type AdminBotPaperStep,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import {
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  adminBotPosterPhysicalStates,
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlot,
} from "../../../../../extensions/adminbot/src/contracts/paper-slots.js";
import type { PaperSlotRow } from "../api/papers.ts";
import { fileBlockerInput, openEntries, resolveBlockerInput } from "../blockers.ts";
import {
  saveAdminBotPaper,
  type AdminBotPaperRecord,
  type AdminBotPaperSaveInput,
} from "../controllers/admin.ts";
import {
  circulateAdminBotSocialDraft,
  editAdminBotTrip,
  loadAdminBotPaperSlots,
  recordAdminBotSocialConsent,
  saveAdminBotPaperSlot,
  saveAdminBotPaperWeeklyUpdate,
  saveAdminBotSocialDraft,
  saveAdminBotTrip,
  setAdminBotPaperAttendee,
  setAdminBotPaperReimbursement,
  withdrawAdminBotTrip,
} from "../controllers/paper-slots.ts";
import { openPreRegistrationDialog } from "../pre-registration.ts";
import { paperTripDraftFrom, renderPaperCycle } from "../views/paper-cycle.ts";
import { renderPaperWeeklyUpdates } from "../views/paper-weekly-updates.ts";
import {
  navigateToProject,
  PROJECT_LANES,
  stepLabel,
  venuePosition,
  type ProjectLane,
  type ProjectSummary,
  type ProjectTab,
} from "./model.ts";
import type { ProjectsNavState } from "./nav.ts";
import { generateLinkedInDraft, generateXDraft } from "./social-drafts.ts";

type PageState = ProjectsNavState;

/** Papers whose checklist this page has asked for, so a failed read is not retried every render. */
const requested = new Set<string>();

export function renderProjectPage(state: PageState, paperId: string, tab: ProjectTab) {
  const paper = state.adminBotData?.papers?.find((candidate) => candidate.id === paperId);
  if (!paper) {
    return html`<p class="projects__empty">
      ${state.adminBotLoading ? "Loading…" : "This paper is not on your list."}
      <a href="#" @click=${(event: Event) => back(event, state)}>Back to your projects</a>
    </p>`;
  }
  if (!requested.has(paperId)) {
    requested.add(paperId);
    void loadAdminBotPaperSlots(state, paperId).finally(() => state.requestUpdate?.());
  }
  const summary = state.myProjects?.find((project) => project.paper_id === paperId);
  const lane = PROJECT_LANES.find((candidate) => candidate.segment === tab);
  return html`<section class="project" data-testid=${`project-${paperId}`}>
    <a class="project__back" href="#" @click=${(event: Event) => back(event, state)}
      >‹ My projects</a
    >
    <header class="project__head">
      <h2>${paper.title}</h2>
      <p>
        ${paper.alias ? html`<span class="project__alias">#${paper.alias}</span>` : nothing}
        ${summary ? venuePosition(summary) : paper.venue || "No venue picked yet"} ·
        ${stepLabel(paper.current_step)}
      </p>
    </header>
    <nav class="project__tabs" role="tablist">
      ${renderTabLink(state, paperId, "project", "Project", tab, undefined)}
      ${PROJECT_LANES.map((candidate) =>
        renderTabLink(state, paperId, candidate.segment, candidate.label, tab, summary, candidate),
      )}
    </nav>
    ${state.adminBotPaperSlotsError
      ? html`<p class="project__error" role="alert">${state.adminBotPaperSlotsError}</p>`
      : nothing}
    <div class="project__body">
      ${lane ? renderLaneTab(state, paper, lane) : renderProjectTab(state, paper, summary)}
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

/** Every write here is the whole required record plus the changed fields, as the service wants. */
function savePaper(
  state: PageState,
  paper: AdminBotPaperRecord,
  fields: Partial<AdminBotPaperSaveInput>,
) {
  void saveAdminBotPaper(state, {
    id: paper.id,
    title: paper.title,
    authors: paper.authors ?? [],
    currentStep: paper.current_step as AdminBotPaperStep,
    ...fields,
  }).then(() => {
    state.myProjects = null;
    state.requestUpdate?.();
  });
}

// ---------------------------------------------------------------- Project tab

function renderProjectTab(
  state: PageState,
  paper: AdminBotPaperRecord,
  summary: ProjectSummary | undefined,
) {
  const cycle = state.adminBotPaperSlots[paper.id];
  const blockers = openEntries(paper);
  const viewer = state.memberId ?? "";
  return html`
    <div class="project__grid">
      <section class="project__panel">
        <h3>What is open</h3>
        ${summary?.todos.length
          ? html`<ul class="project__todos">
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
                  <small
                    >${todo.ready ? "can be done now" : `waiting · ${lane?.label ?? ""}`}</small
                  >
                </li>`;
              })}
            </ul>`
          : html`<p>Nothing open.</p>`}
      </section>
      <section class="project__panel">
        <h3>Where it is going</h3>
        <p>${summary ? venuePosition(summary) : paper.venue || "No venue picked yet"}</p>
        <button
          type="button"
          class="btn"
          data-testid="project-prereg"
          @click=${() =>
            openPreRegistrationDialog({
              papers: [paper],
              onSavePaper: (input) => savePaper(state, paper, input),
              onDone: () => state.requestUpdate?.(),
            })}
        >
          Pre-register venues
        </button>
        ${paper.venue_decision === "accept"
          ? html`<button
              type="button"
              class="btn"
              @click=${() =>
                savePaper(state, paper, {
                  completedAt: paper.artifacts?.completed_at ? "" : new Date().toISOString(),
                })}
            >
              ${paper.artifacts?.completed_at ? "Reopen project" : "Mark project complete"}
            </button>`
          : nothing}
      </section>
      <section class="project__panel">
        <h3>Blockers</h3>
        ${blockers.map(
          (entry) => html`<div class="project__blocker">
            <strong>${entry.title}</strong> <small>${entry.note}</small>
            <button
              type="button"
              class="btn"
              @click=${() =>
                void saveAdminBotPaper(state, resolveBlockerInput(paper, entry.at, viewer))}
            >
              Resolved
            </button>
          </div>`,
        )}
        <form
          class="project__form"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const form = event.currentTarget as HTMLFormElement;
            const data = new FormData(form);
            const title = String(data.get("title") ?? "").trim();
            if (!title) {
              return;
            }
            void saveAdminBotPaper(
              state,
              fileBlockerInput(paper, {
                stage: paper.current_step,
                title,
                note: String(data.get("note") ?? "").trim(),
                by: viewer,
              }),
            );
            form.reset();
          }}
        >
          <input name="title" placeholder="What is stuck?" maxlength="70" />
          <input name="note" placeholder="Details (optional)" />
          <button type="submit" class="btn">Report a blocker</button>
        </form>
      </section>
    </div>
    ${cycle
      ? html`<section class="project__panel">
          <h3>Weekly updates</h3>
          ${renderPaperWeeklyUpdates({
            paperId: paper.id,
            updates: cycle.weeklyUpdates,
            ...(state.memberId ? { memberId: state.memberId } : {}),
            onSave: (body) =>
              void saveAdminBotPaperWeeklyUpdate(state, paper.id, body).finally(() =>
                state.requestUpdate?.(),
              ),
            busy: state.adminBotPaperSlotsBusyId === paper.id,
          })}
        </section>`
      : nothing}
  `;
}

// ---------------------------------------------------------------- lane tabs

function renderLaneTab(state: PageState, paper: AdminBotPaperRecord, lane: ProjectLane) {
  const cycle = state.adminBotPaperSlots[paper.id];
  if (!cycle) {
    return html`<p class="projects__empty">Loading this paper's checklist…</p>`;
  }
  const rows = new Map(cycle.slots.map((row) => [row.slot, row]));
  const slots = adminBotPaperSlots.filter(
    (slot) => adminBotPaperSlotRegistry[slot].branch === lane.branch,
  );
  const extra: TemplateResult | typeof nothing =
    lane.branch === "venue"
      ? renderVenueDecision(state, paper, cycle.stages)
      : lane.branch === "social"
        ? renderCycle(state, paper)
        : nothing;
  return html`<p class="project__legend">${lane.legend}.</p>
    <div class="project__slots">
      ${slots.map((slot) => renderSlot(state, paper.id, slot, rows))}
    </div>
    ${extra}`;
}

const STATUS_TEXT: Record<PaperSlotRow["status"], string> = {
  missing: "Open",
  provided: "Done",
  invalid: "Needs fixing",
  waived: "Waived",
};

function renderSlot(
  state: PageState,
  paperId: string,
  slot: AdminBotPaperSlot,
  rows: Map<string, PaperSlotRow>,
) {
  const definition = adminBotPaperSlotRegistry[slot];
  const row = rows.get(slot) ?? { paper_id: paperId, slot, status: "missing" as const };
  const settled = (name: string) => isAdminBotPaperSlotSettled(rows.get(name)?.status ?? "missing");
  const waitingOn = definition.upstream.filter((name) => !settled(name));
  const blocked = waitingOn.length > 0;
  const busy = state.adminBotPaperSlotsBusyId === paperId;
  const save = (input: {
    url?: string;
    value_text?: string;
    value_note?: string;
    done?: boolean;
  }) =>
    void saveAdminBotPaperSlot(state, paperId, slot, input).finally(() => {
      state.myProjects = null;
      state.requestUpdate?.();
    });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const value = String(data.get("value") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();
    if (definition.kind === "link" || definition.kind === "feedback") {
      save({ url: value });
    } else if (definition.kind === "enum") {
      save({ value_text: value, value_note: note });
    } else {
      save({ value_text: value });
    }
  };
  let control: TemplateResult;
  if (definition.derived) {
    control = html`<small>Ticks itself once a draft below is approved.</small>`;
  } else if (definition.kind === "bool") {
    control = html`<label class="project__check">
      <input
        type="checkbox"
        .checked=${settled(slot)}
        ?disabled=${blocked || busy}
        @change=${(event: Event) => save({ done: (event.target as HTMLInputElement).checked })}
      />
      Done
    </label>`;
  } else {
    const input =
      definition.kind === "enum"
        ? html`<select name="value" ?disabled=${blocked}>
              ${adminBotPosterPhysicalStates.map(
                (option) =>
                  html`<option value=${option} ?selected=${row.value_text === option}>
                    ${option.replaceAll("_", " ")}
                  </option>`,
              )}
            </select>
            <input
              name="note"
              placeholder="Where it is"
              .value=${row.value_note ?? ""}
              ?disabled=${blocked}
            />`
        : html`<input
            name="value"
            type=${definition.kind === "secret6"
              ? "password"
              : definition.kind === "text"
                ? "text"
                : "url"}
            .value=${definition.kind === "secret6" ? "" : (row.url ?? row.value_text ?? "")}
            placeholder=${definition.example ?? ""}
            ?disabled=${blocked}
          />`;
    control = html`<form class="project__slot-form" @submit=${submit}>
      ${input}<button type="submit" class="btn" ?disabled=${blocked || busy}>Save</button>
    </form>`;
  }
  return html`<div
    class="project__slot is-${row.status} ${definition.subOf ? "is-child" : ""}"
    data-testid=${`project-slot-${slot}`}
  >
    <div class="project__slot-head">
      <span class="project__slot-label">${definition.label}</span>
      <span class="project__status">${STATUS_TEXT[row.status]}</span>
    </div>
    ${row.status === "invalid" && row.invalid_reason
      ? html`<small class="project__error">${row.invalid_reason}</small>`
      : nothing}
    ${blocked
      ? html`<small
          >Waits on
          ${waitingOn.map((name) => adminBotPaperSlotRegistry[name].label).join(", ")}</small
        >`
      : nothing}
    ${control}
  </div>`;
}

function renderVenueDecision(
  state: PageState,
  paper: AdminBotPaperRecord,
  stages: Array<{ stage: string; label: string; state: string }>,
) {
  const decision = paper.venue_decision ?? "pending";
  const field = (key: keyof AdminBotPaperSaveInput) => (event: Event) =>
    savePaper(state, paper, { [key]: (event.target as HTMLInputElement).value });
  return html`<section class="project__panel">
    <h3>Venue decision</h3>
    <div class="project__decision">
      <label
        >Decision
        <select @change=${field("venueDecision")} data-testid="project-decision">
          ${["pending", "accept", "reject"].map(
            (value) =>
              html`<option value=${value} ?selected=${decision === value}>${value}</option>`,
          )}
        </select></label
      >
      ${decision === "accept"
        ? html`<label
              >Venue <input .value=${paper.accepted_venue ?? ""} @change=${field("acceptedVenue")}
            /></label>
            <label
              >Year
              <input
                type="number"
                .value=${String(paper.accepted_year ?? "")}
                @change=${field("acceptedYear")}
            /></label>
            <label
              >Archival
              <select @change=${field("isArchival")}>
                <option value="" ?selected=${paper.is_archival === undefined}>Not said</option>
                <option value="true" ?selected=${paper.is_archival === true}>Archival</option>
                <option value="false" ?selected=${paper.is_archival === false}>Non-archival</option>
              </select></label
            >
            <label
              >Presentation
              <select @change=${field("presentationType")}>
                <option value="">Not said</option>
                ${adminBotPaperPresentationTypes.map(
                  (type) =>
                    html`<option value=${type} ?selected=${paper.presentation_type === type}>
                      ${type}
                    </option>`,
                )}
              </select></label
            >`
        : nothing}
    </div>
    ${stages.length
      ? html`<ol class="project__stages">
          ${stages.map((stage) => html`<li class="is-${stage.state}">${stage.label}</li>`)}
        </ol>`
      : nothing}
  </section>`;
}

/** Social drafts, coauthor sign-off, and the conference roll call: the existing cycle panel. */
function renderCycle(state: PageState, paper: AdminBotPaperRecord) {
  const cycle = state.adminBotPaperSlots[paper.id];
  if (!cycle) {
    return nothing;
  }
  const done = () => state.requestUpdate?.();
  const names = new Map(
    (state.adminBotData?.members ?? []).map((member) => [member.id, member.name]),
  );
  const saveDraft: Parameters<typeof generateXDraft>[2] = (paperId, platform, body, xThread) =>
    void saveAdminBotSocialDraft(state, paperId, platform, body, xThread).finally(done);
  return renderPaperCycle({
    paperId: paper.id,
    drafts: cycle.drafts,
    consents: cycle.consents,
    attendees: cycle.attendees,
    reimbursements: cycle.reimbursements,
    conferenceOpen:
      paper.venue_decision === "accept" && cycle.missingAcceptanceDetails.length === 0,
    missingAcceptanceDetails: cycle.missingAcceptanceDetails,
    cycleClosed: cycle.cycleClosed,
    // The reader's own trip, once the service has named the conference this paper goes to.
    ...(cycle.conferenceKey ? tripProps(state, cycle.conferenceKey, cycle.myTrip ?? null) : {}),
    memberId: state.memberId ?? null,
    memberName: (memberId) => names.get(memberId) ?? memberId,
    paperAuthors: paper.authors ?? [],
    creditMembers: state.adminBotData?.members ?? [],
    onSaveDraft: (platform, body, xThread) => saveDraft(paper.id, platform, body, xThread),
    onGenerateLinkedInDraft: (venue, note, pdfBase64) =>
      void generateLinkedInDraft(state, paper, saveDraft, venue, note, pdfBase64),
    onGenerateXDraft: (_venue, _note, pdfBase64, announcement, credits) =>
      void generateXDraft(state, paper, saveDraft, pdfBase64, announcement, credits),
    onCirculateDraft: (draftId) =>
      void circulateAdminBotSocialDraft(state, paper.id, draftId).finally(done),
    onConsent: (draftId, decision, comment) =>
      void recordAdminBotSocialConsent(state, paper.id, draftId, decision, comment).finally(done),
    onSetAttendee: (name, memberId, attending) =>
      void setAdminBotPaperAttendee(state, paper.id, name, memberId, attending).finally(done),
    onSetReimbursement: (memberId, status) =>
      void setAdminBotPaperReimbursement(state, paper.id, memberId, status).finally(done),
  });
}

function tripProps(state: PageState, key: string, trip: Parameters<typeof paperTripDraftFrom>[0]) {
  const base = paperTripDraftFrom(trip);
  const done = () => state.requestUpdate?.();
  return {
    myTrip: trip,
    tripDraft: state.adminBotTripDrafts[key] ?? base,
    tripSaving: state.adminBotTripSavingKey === key,
    onEditTrip: (patch: Parameters<typeof editAdminBotTrip>[2]) => {
      editAdminBotTrip(state, key, patch, base);
      done();
    },
    onSaveTrip: () =>
      void saveAdminBotTrip(state, key, state.adminBotTripDrafts[key] ?? base).finally(done),
    onWithdrawTrip: () => void withdrawAdminBotTrip(state, key).finally(done),
  };
}
