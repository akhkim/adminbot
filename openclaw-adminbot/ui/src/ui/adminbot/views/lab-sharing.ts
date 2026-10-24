// Lab Sharing tab (Collaborate): six panels --
//   1. Director status strip (availability, timezone, progress, a way to flag a blocker)
//   2. Seek help -- pick a project, describe what's needed, tag it, then post a general call or
//      search members to invite
//   3. Your invites -- collaboration invites sent to you, respond to the owner
//   4. Your requests -- help calls you sent out, deletable
//   5. Open projects -- a wrap-around deck of projects looking for hands
//   6. Announcements -- a lab-wide comms feed with an in-page compose dialog
//
// Five of the six read and write the service. Panels 1-5 go through controllers/lab-sharing.ts
// onto `state.labSharing*`; the adapters just below turn the service's shapes into the shapes the
// panels were drawn against, and each says so where it cannot be an honest translation.
//
// Announcements (6) is the exception and the only thing left that stores nothing: it holds what
// the viewer composes for as long as the page lives and no longer. It seeds no posts -- a seeded
// post has to be signed by somebody, and every name would be a person who never said it -- and it
// wears a "Sample data" pill on its face.
//
// This header used to say the whole file was frontend-only and to search MOCK for the spots that
// needed wiring. That stopped being true when the five panels landed, and a reader who believed it
// had no way to tell which half of the page to trust.
import { html, nothing } from "lit";
import "./lab-sharing-how-to.ts";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  askAdminBotLabSharingMember,
  closeAdminBotLabSharingRequest,
  loadAdminBotLabSharing,
  offerAdminBotLabSharingHelp,
  postAdminBotLabSharingRequest,
  searchAdminBotLabSharingMembers,
} from "../controllers/lab-sharing.ts";
import { onViewSessionReset } from "../view-session-reset.ts";
import { renderLabSharingResources } from "./lab-sharing-resources.ts";
import { renderMemberMap } from "./member-map.ts";

// ---------------------------------------------------------------------------
// Types (shape guesses -- adjust once a real API contract exists)
// ---------------------------------------------------------------------------

type DirectorStatus = {
  name: string;
  availability: "available" | "busy" | "away";
  timezone: string;
  localTime: string;
  progressLabel: string;
  progressPercent: number;
};

type LabMemberSummary = {
  id: string;
  name: string;
  role: string;
  projects: string[];
  interests: string[];
};

type OwnedProject = {
  id: string;
  title: string;
  tags: string[];
};

type OpenProject = {
  id: string;
  title: string;
  owner: string;
  summary: string;
  tags: string[];
  membersNeeded: number;
  hoursPerWeek: number;
};

type CollabInvite = {
  id: string;
  fromName: string;
  projectId: string;
  note: string;
  /** Where the invitation has got to, in words. Not a time: invitations carry no clock. */
  receivedAt: string;
  tone: "" | "ok" | "warn" | "danger";
};

type HelpRequest = {
  id: string;
  projectId: string;
  comment: string;
  members: number;
  hours: number;
  tags: string[];
  sentAt: string;
};

export type Announcement = {
  id: string;
  authorName: string;
  body: string;
  postedAt: string;
};

// The fixed tag vocabulary for the frontend prototype -- swap for a real managed tag list later.
const AVAILABLE_TAGS = [
  "causality",
  "multi-agent",
  "writing",
  "QA",
  "UI/UX feedback",
  "data collection",
  "visualization",
  "reasoning",
  "alignment",
  "annotation",
];

// ---------------------------------------------------------------------------
// The service, in this page's own words
//
// The panels below are unchanged from the design they shipped as; what changed is where their rows
// come from. Each adapter takes one service shape (data/lab-sharing.ts, snake_case, keyed by
// `paper_id`) and returns the shape the panel was written against, so the markup never learns the
// wire format and there is one place to look when a field moves.
//
// Two of them cannot be honest translations, and say so at their own definition: the broadcast
// carries no progress figure, and invitations run outwards rather than in.
// ---------------------------------------------------------------------------

/**
 * The lab-wide broadcast, in the shape this strip was drawn for.
 *
 * Two of that shape's fields have no source and are not invented: the service stores no progress
 * figure and no per-person local clock. `progressPercent` of -1 is the panel's signal to leave the
 * bar out entirely rather than draw an honest-looking 0%.
 */
function directorOf(state: AppViewState): DirectorStatus | null {
  const status = state.labSharing?.status;
  if (!status || status.retracted_at) {
    return null;
  }
  const availability =
    status.availability === "busy" || status.availability === "away"
      ? status.availability
      : "available";
  return {
    name: status.message,
    availability,
    timezone: status.timezone ?? "",
    localTime: "",
    progressLabel: "",
    progressPercent: -1,
  };
}

function ownedProjectsOf(state: AppViewState): OwnedProject[] {
  // Tags live on the request, not the paper, so a project the member has not posted about yet has
  // none to show. An empty list rather than an invented one.
  return (state.labSharing?.projects ?? []).map((project) => ({
    id: project.id,
    title: project.title,
    tags: [],
  }));
}

function openProjectsOf(state: AppViewState): OpenProject[] {
  return (state.labSharing?.open ?? []).map((request) => ({
    id: request.paper_id,
    title: request.title,
    owner: request.owner_name,
    summary: request.description,
    tags: request.tags ?? [],
    membersNeeded: request.members_needed,
    hoursPerWeek: request.hours_per_week,
  }));
}

function sentRequestsOf(state: AppViewState): HelpRequest[] {
  return (state.labSharing?.mine ?? []).map((request) => ({
    // A member posts at most one request per paper, so the paper is the row's identity.
    id: request.paper_id,
    projectId: request.paper_id,
    comment: request.description,
    members: request.members_needed,
    hours: request.hours_per_week,
    tags: request.tags ?? [],
    // The service keeps a timeline in the poster's own words ("before the ARR deadline"), which is
    // what this line has to show; there is no "sent at" clock behind it.
    sentAt: request.timeline,
  }));
}

function membersOf(state: AppViewState): LabMemberSummary[] {
  return (state.labSharingMembers ?? []).map((member) => ({
    id: member.id,
    name: member.name,
    role: member.research_branch,
    projects: member.projects.map((project) => project.title),
    interests: member.research_topics ?? [],
  }));
}

// Where an invitation has got to, as a label and a pill tone. An unknown status shows as itself
// rather than being guessed into one of these.
const INVITE_STATUS: Record<string, { key: string; tone: "" | "ok" | "warn" | "danger" }> = {
  pending: { key: "labSharing.invites.status.pending", tone: "warn" },
  approved: { key: "labSharing.invites.status.approved", tone: "" },
  executed: { key: "labSharing.invites.status.executed", tone: "ok" },
  rejected: { key: "labSharing.invites.status.rejected", tone: "danger" },
  failed: { key: "labSharing.invites.status.failed", tone: "danger" },
};

/**
 * Invitations, which run the other way.
 *
 * This panel was drawn for invitations arriving -- somebody asks you, and you accept or decline.
 * The service has no such record: an invitation is something the viewer *sends*, and it reaches
 * its recipient only once an admin approves it. So the card keeps its shape and changes what it
 * names -- who it went to, which paper, and where it has got to -- and the Respond button went
 * with the flow it belonged to.
 */
function invitesOf(state: AppViewState): CollabInvite[] {
  return (state.labSharing?.invites ?? []).map((invite) => ({
    id: invite.id,
    fromName: invite.recipient_name,
    projectId: invite.project_title,
    note: invite.kind,
    receivedAt: INVITE_STATUS[invite.status] ? t(INVITE_STATUS[invite.status].key) : invite.status,
    tone: INVITE_STATUS[invite.status]?.tone ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Announcements have no service behind them -- see renderAnnouncementsPanel.
// ---------------------------------------------------------------------------

/**
 * Who a locally composed announcement is from.
 *
 * The viewer, resolved from the session the rest of the tab already runs on. This panel used to
 * open on two fabricated posts signed "Zhijing Jin" and "Andrew Kim", and a post the viewer wrote
 * was signed "You" -- so the only names on the lab's announcement feed were two people who had not
 * said either thing, and never the person actually typing. While the tab carried a preview banner
 * and kept this panel folded inside a "sample data" disclosure that read as a mockup; #238 put the
 * panel inline with the five real ones, which left the fabrications looking like the lab's record.
 *
 * `memberName` is what the topbar already greets the viewer with, so an impersonated session
 * ("view as") signs as the member being viewed, which is the same person every other panel here is
 * scoped to. Empty only before the profile read lands, which is why there is a fallback at all.
 */
function announcementAuthor(state: AppViewState): string {
  return state.memberName?.trim() || t("labSharing.announcements.authorFallback");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function availabilityLabel(status: DirectorStatus["availability"]): string {
  if (status === "available") {
    return t("labSharing.director.availabilityAvailable");
  }
  if (status === "busy") {
    return t("labSharing.director.availabilityBusy");
  }
  return t("labSharing.director.availabilityAway");
}

function requestUpdate(state: AppViewState): void {
  (state as AppViewState & { requestUpdate?: () => void }).requestUpdate?.();
}

// The inline "add a tag" chip and the announcement compose dialog keep their transient UI state
// here rather than on AppViewState: typing state and open flags survive a re-render, but are cleared
// when the signed-in member changes.
let memberSearchTimer: ReturnType<typeof setTimeout> | undefined;
let addingTag = false;
let tagDraft = "";
/**
 * The composed feed lives on view state, not at module scope.
 *
 * Everything else parked in this block is transient chrome -- an open flag, a half-typed tag --
 * which a re-render may keep. They still belong to the current member and must be cleared on
 * sign-out, especially announcement text and a help-request message that would otherwise appear
 * under the next member's name.
 */
function announcementsOf(state: AppViewState): Announcement[] {
  return state.labSharingAnnouncements ?? [];
}
let composingAnnouncement = false;
let announcementDraft = "";
let viewingInviteId: string | null = null;
// Member-specific ask: which member the dialog is open for (null = closed), plus the draft of the
// optional "special message" just for them. Draft lives here so a re-render does not wipe typing.
let askingMemberId: string | null = null;
let askSpecialMessage = "";
// Whether the general-call confirmation dialog is open.
let confirmingGeneralCall = false;
// Which "Your requests" row is asking for a second, confirming click before it is deleted.
let confirmingDeleteRequestId: string | null = null;

export function resetLabSharingSessionState(): void {
  if (memberSearchTimer) {
    clearTimeout(memberSearchTimer);
    memberSearchTimer = undefined;
  }
  addingTag = false;
  tagDraft = "";
  composingAnnouncement = false;
  announcementDraft = "";
  viewingInviteId = null;
  askingMemberId = null;
  askSpecialMessage = "";
  confirmingGeneralCall = false;
  confirmingDeleteRequestId = null;
}
onViewSessionReset(resetLabSharingSessionState);


// ---------------------------------------------------------------------------
// Shared section shell
//
// Every panel is the same card the rest of AdminBot uses (`card adminbot-card adminbot-card--wide`
// with a `card-title` and an optional `card-sub`), so this tab reads as one of the app's pages
// rather than as its own site. The heading stays an <h2> for the document outline; the class gives
// it the app's look.
// ---------------------------------------------------------------------------

function sectionHead(title: string, sub?: string, aside?: unknown) {
  return html`
    <div class="lab-sharing-section__head">
      <div class="lab-sharing-section__heading">
        <h2 class="card-title">${title}</h2>
        ${sub ? html`<p class="card-sub">${sub}</p>` : nothing}
      </div>
      ${aside ?? nothing}
    </div>
  `;
}

function isBusy(state: AppViewState): boolean {
  return Boolean(state.labSharingBusy);
}

// ---------------------------------------------------------------------------
// 1. Director status strip
// ---------------------------------------------------------------------------

function renderDirectorPanel(state: AppViewState) {
  const director = directorOf(state);
  if (!director) {
    // No broadcast standing. The strip goes rather than drawing an empty status card, which reads
    // as "the lab has said something and we cannot show it".
    return nothing;
  }
  return html`
    <section
      class="card adminbot-card adminbot-card--wide lab-sharing-director"
      data-testid="lab-sharing-director"
      aria-label=${t("labSharing.director.title")}
    >
      <span
        class="lab-sharing-director__dot"
        data-availability=${director.availability}
        aria-hidden="true"
      ></span>
      <div class="lab-sharing-director__identity">
        <div class="lab-sharing-director__eyebrow">${t("labSharing.director.title")}</div>
        <div class="lab-sharing-director__name">${director.name}</div>
        <div class="lab-sharing-director__meta">
          ${availabilityLabel(director.availability)}${director.timezone
            ? html` · ${t("professor.broadcast.timezoneLabel", { timezone: director.timezone })}`
            : nothing}
        </div>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 2. Seek help -- project picker + ask details + tags, then search/invite or general call
// ---------------------------------------------------------------------------

function renderTagPicker(state: AppViewState) {
  const selected = new Set(state.labSharingAskTags ?? []);
  const known = new Set(AVAILABLE_TAGS);
  const allTags = [...AVAILABLE_TAGS, ...[...selected].filter((tag) => !known.has(tag))];
  const commitDraft = () => {
    const value = tagDraft.trim();
    tagDraft = "";
    addingTag = false;
    if (value && !selected.has(value)) {
      state.labSharingAskTags = [...selected, value];
      requestUpdate(state);
    }
  };
  return html`
    <div class="lab-sharing-tags" role="group" aria-label=${t("labSharing.seekHelp.tags")}>
      ${allTags.map((tag) => {
        const active = selected.has(tag);
        return html`
          <button
            type="button"
            class="chip lab-sharing-tag ${active ? "lab-sharing-tag--active" : ""}"
            aria-pressed=${active}
            @click=${() => {
              const next = new Set(selected);
              if (active) {
                next.delete(tag);
              } else {
                next.add(tag);
              }
              state.labSharingAskTags = [...next];
              requestUpdate(state);
            }}
          >
            ${tag}
          </button>
        `;
      })}
      ${addingTag
        ? html`
            <input
              type="text"
              class="lab-sharing-tag lab-sharing-tag--input"
              aria-label=${t("labSharing.seekHelp.addTag")}
              placeholder=${t("labSharing.seekHelp.addTagPlaceholder")}
              .value=${tagDraft}
              @input=${(event: Event) => {
                tagDraft = (event.target as HTMLInputElement).value;
              }}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitDraft();
                } else if (event.key === "Escape") {
                  tagDraft = "";
                  addingTag = false;
                  requestUpdate(state);
                }
              }}
              @blur=${() => {
                commitDraft();
              }}
            />
          `
        : html`
            <button
              type="button"
              class="chip lab-sharing-tag lab-sharing-tag--add"
              @click=${() => {
                addingTag = true;
                requestUpdate(state);
              }}
            >
              + ${t("labSharing.seekHelp.addTag")}
            </button>
          `}
    </div>
  `;
}

function renderAskForm(state: AppViewState) {
  const projects = ownedProjectsOf(state);
  const projectId = state.labSharingAskProjectId ?? projects[0]?.id ?? "";
  return html`
    <div class="adminbot-form lab-sharing-ask">
      <label class="adminbot-form__field lab-sharing-ask__field">
        <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.projectLabel")}</span>
        ${projects.length
          ? html`<select
              class="lab-sharing-ask__select"
              .value=${projectId}
              @change=${(event: Event) => {
                state.labSharingAskProjectId = (event.target as HTMLSelectElement).value;
              }}
            >
              ${projects.map(
                (project) => html`<option value=${project.id}>${project.title}</option>`,
              )}
            </select>`
          : html`<p class="muted lab-sharing-ask__none">${t("labSharing.seekHelp.noProjects")}</p>`}
      </label>

      <label class="adminbot-form__field lab-sharing-ask__field">
        <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.commentLabel")}</span>
        <textarea
          class="lab-sharing-ask__textarea"
          rows="3"
          placeholder=${t("labSharing.seekHelp.commentPlaceholder")}
          .value=${state.labSharingAskComment ?? ""}
          @input=${(event: Event) => {
            state.labSharingAskComment = (event.target as HTMLTextAreaElement).value;
            requestUpdate(state);
          }}
        ></textarea>
      </label>

      <div class="lab-sharing-ask__row">
        <label class="adminbot-form__field lab-sharing-ask__field">
          <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.membersLabel")}</span>
          <input
            class="lab-sharing-ask__input"
            type="number"
            min="1"
            inputmode="numeric"
            .value=${String(state.labSharingAskMembers ?? 1)}
            @input=${(event: Event) => {
              state.labSharingAskMembers = Number((event.target as HTMLInputElement).value);
            }}
          />
        </label>
        <label class="adminbot-form__field lab-sharing-ask__field">
          <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.hoursLabel")}</span>
          <input
            class="lab-sharing-ask__input"
            type="number"
            min="0"
            inputmode="numeric"
            .value=${String(state.labSharingAskHours ?? 1)}
            @input=${(event: Event) => {
              state.labSharingAskHours = Number((event.target as HTMLInputElement).value);
            }}
          />
        </label>
      </div>

      <div class="adminbot-form__field lab-sharing-ask__field">
        <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.tags")}</span>
        ${renderTagPicker(state)}
      </div>
    </div>
  `;
}

function renderMemberCard(state: AppViewState, member: LabMemberSummary, canAsk: boolean) {
  const invited = (state.labSharingInvitedMemberIds ?? []).includes(member.id);
  return html`
    <article class="lab-sharing-member" data-testid=${`lab-sharing-member-${member.id}`}>
      <div class="lab-sharing-member__header">
        <span class="lab-sharing-member__name">${member.name}</span>
        ${member.role ? html`<span class="lab-sharing-member__role">${member.role}</span>` : nothing}
      </div>
      ${member.projects.length
        ? html`<p class="lab-sharing-member__line">
            <span class="lab-sharing-member__line-label">${t("labSharing.seekHelp.projects")}</span>
            ${member.projects.join(", ")}
          </p>`
        : nothing}
      ${member.interests.length
        ? html`<p class="lab-sharing-member__line">
            <span class="lab-sharing-member__line-label"
              >${t("labSharing.seekHelp.interests")}</span
            >
            ${member.interests.join(", ")}
          </p>`
        : nothing}
      <button
        type="button"
        class="btn btn--sm lab-sharing-member__invite"
        ?disabled=${invited || !canAsk || isBusy(state)}
        @click=${() => {
          askingMemberId = member.id;
          askSpecialMessage = "";
          requestUpdate(state);
        }}
      >
        ${invited ? t("labSharing.seekHelp.invited") : t("labSharing.seekHelp.invite")}
      </button>
    </article>
  `;
}

function renderSeekHelpPanel(state: AppViewState) {
  const query = state.labSharingSearchQuery ?? "";
  const trimmed = query.trim();
  // Members stay hidden until the member actually searches -- no directory dump, just results.
  const results = trimmed ? membersOf(state) : [];
  // Both routes below file against a paper. With none to pick, they would send an empty id and
  // fail at the service, so they wait until there is one.
  const canAsk = ownedProjectsOf(state).length > 0;

  return html`
    <section
      class="card adminbot-card adminbot-card--wide lab-sharing-seek"
      data-testid="lab-sharing-seek-help"
    >
      ${sectionHead(t("labSharing.seekHelp.title"), t("labSharing.seekHelp.subtitle"))}
      ${renderAskForm(state)}

      <div class="lab-sharing-seek__route">
        <h3 class="lab-sharing-seek__route-title">${t("labSharing.seekHelp.searchHeading")}</h3>
        <div class="adminbot-form">
          <input
            type="search"
            class="lab-sharing-seek__search"
            aria-label=${t("labSharing.seekHelp.searchHeading")}
            placeholder=${t("labSharing.seekHelp.searchPlaceholder")}
            .value=${query}
            @input=${(event: Event) => {
              const value = (event.target as HTMLInputElement).value;
              state.labSharingSearchQuery = value;
              requestUpdate(state);
              // Debounced, because this is a request per keystroke otherwise. The generation guard
              // is the query itself: a reply for something the member has since typed past is
              // dropped.
              clearTimeout(memberSearchTimer);
              if (!value.trim()) {
                state.labSharingMembers = [];
                return;
              }
              memberSearchTimer = setTimeout(() => {
                void searchAdminBotLabSharingMembers(state, value).then(() => {
                  if ((state.labSharingSearchQuery ?? "") === value) {
                    requestUpdate(state);
                  }
                });
              }, 250);
            }}
          />
        </div>
        <div class="lab-sharing-seek__results" aria-live="polite">
          ${trimmed
            ? results.length
              ? results.map((member) => renderMemberCard(state, member, canAsk))
              : html`<p class="muted lab-sharing-seek__empty">${t("labSharing.seekHelp.empty")}</p>`
            : html`<p class="muted lab-sharing-seek__hint">
                ${t("labSharing.seekHelp.searchPrompt")}
              </p>`}
        </div>
      </div>

      ${askingMemberId
        ? renderMemberAskDialog(
            state,
            membersOf(state).find((member) => member.id === askingMemberId) ?? null,
          )
        : nothing}

      <div class="lab-sharing-seek__route lab-sharing-seek__route--call">
        <div class="lab-sharing-seek__call-copy">
          <h3 class="lab-sharing-seek__route-title">${t("labSharing.seekHelp.callHeading")}</h3>
          <p class="muted">${t("labSharing.seekHelp.callHint")}</p>
        </div>
        <button
          type="button"
          class="btn primary lab-sharing-seek__call"
          data-testid="lab-sharing-general-call"
          ?disabled=${!canAsk || isBusy(state)}
          @click=${() => {
            confirmingGeneralCall = true;
            requestUpdate(state);
          }}
        >
          ${t("labSharing.seekHelp.generalCall")}
        </button>
      </div>

      ${confirmingGeneralCall ? renderGeneralCallDialog(state) : nothing}
    </section>
  `;
}

/** The request as it will be filed: members, hours and tags, shown in both confirm dialogs. */
function renderAskSummary(state: AppViewState) {
  const tags = state.labSharingAskTags ?? [];
  return html`
    ${state.labSharingAskComment
      ? html`<p class="lab-sharing-invite-dialog__summary">${state.labSharingAskComment}</p>`
      : nothing}
    <dl class="lab-sharing-invite-dialog__details">
      <div class="lab-sharing-invite-dialog__detail">
        <dt class="lab-sharing-invite-dialog__label">${t("labSharing.seekHelp.membersLabel")}</dt>
        <dd class="lab-sharing-invite-dialog__value">${state.labSharingAskMembers ?? 1}</dd>
      </div>
      <div class="lab-sharing-invite-dialog__detail">
        <dt class="lab-sharing-invite-dialog__label">${t("labSharing.seekHelp.hoursLabel")}</dt>
        <dd class="lab-sharing-invite-dialog__value">${state.labSharingAskHours ?? 1}</dd>
      </div>
    </dl>
    ${tags.length
      ? html`<div class="chip-row">${tags.map((tag) => html`<span class="chip">${tag}</span>`)}</div>`
      : nothing}
  `;
}

function renderGeneralCallDialog(state: AppViewState) {
  const projectId = state.labSharingAskProjectId ?? ownedProjectsOf(state)[0]?.id ?? "";
  const project = ownedProjectsOf(state).find((p) => p.id === projectId);
  const publish = () => {
    confirmingGeneralCall = false;
    requestUpdate(state);
    void postAdminBotLabSharingRequest(state, projectId, {
      description: state.labSharingAskComment ?? "",
      tags: state.labSharingAskTags ?? [],
      members_needed: state.labSharingAskMembers ?? 1,
      hours_per_week: state.labSharingAskHours ?? 1,
      // The form has no timeline field, and the service takes one. Left empty rather than guessed:
      // an invented deadline is worse than none on a board people plan against.
      timeline: "",
    }).finally(() => requestUpdate(state));
  };
  return html`
    <div
      class="lab-sharing-invite-dialog"
      role="dialog"
      aria-modal="true"
      aria-label=${t("labSharing.seekHelp.confirmCallTitle")}
      data-testid="lab-sharing-general-call-dialog"
    >
      <div class="lab-sharing-invite-dialog__panel">
        <div class="lab-sharing-invite-dialog__head">
          <span class="lab-sharing-invite-dialog__from"
            >${t("labSharing.seekHelp.confirmCallTitle")}</span
          >
          <h3 class="lab-sharing-invite-dialog__title">${project?.title ?? projectId}</h3>
        </div>
        ${renderAskSummary(state)}
        <div class="lab-sharing-invite-dialog__actions">
          <button
            type="button"
            class="btn lab-sharing-invite-dialog__close"
            @click=${() => {
              confirmingGeneralCall = false;
              requestUpdate(state);
            }}
          >
            ${t("labSharing.seekHelp.cancel")}
          </button>
          <button
            type="button"
            class="btn primary lab-sharing-invite-dialog__respond"
            data-testid="lab-sharing-general-call-send"
            ?disabled=${isBusy(state)}
            @click=${() => publish()}
          >
            ${t("labSharing.seekHelp.postCall")}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderMemberAskDialog(state: AppViewState, member: LabMemberSummary | null) {
  if (!member) {
    return nothing;
  }
  const projectId = state.labSharingAskProjectId ?? ownedProjectsOf(state)[0]?.id ?? "";
  const project = ownedProjectsOf(state).find((p) => p.id === projectId);
  const send = () => {
    const note = [state.labSharingAskComment, askSpecialMessage]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join("\n\n");
    state.labSharingInvitedMemberIds = [...(state.labSharingInvitedMemberIds ?? []), member.id];
    askingMemberId = null;
    requestUpdate(state);
    void askAdminBotLabSharingMember(state, {
      recipient_id: member.id,
      paper_id: projectId,
      kind: "collaboration",
      note,
    })
      .then((ok) => {
        // Marked "Invited" straight away so the button cannot be pressed twice; a request the
        // service refused un-marks it, or the member is left believing an ask went out that did not.
        if (!ok) {
          state.labSharingInvitedMemberIds = (state.labSharingInvitedMemberIds ?? []).filter(
            (id) => id !== member.id,
          );
        }
      })
      .finally(() => requestUpdate(state));
  };
  return html`
    <div
      class="lab-sharing-invite-dialog"
      role="dialog"
      aria-modal="true"
      aria-label=${t("labSharing.seekHelp.askMemberTitle", { name: member.name })}
      data-testid="lab-sharing-ask-dialog"
    >
      <div class="lab-sharing-invite-dialog__panel">
        <div class="lab-sharing-invite-dialog__head">
          <span class="lab-sharing-invite-dialog__from"
            >${t("labSharing.seekHelp.askMemberTitle", { name: member.name })}</span
          >
          <h3 class="lab-sharing-invite-dialog__title">${project?.title ?? projectId}</h3>
        </div>
        ${renderAskSummary(state)}
        <label class="adminbot-form adminbot-form__field lab-sharing-invite-dialog__field">
          <span>${t("labSharing.seekHelp.specialMessageLabel", { name: member.name })}</span>
          <textarea
            id="lab-sharing-ask-special-message"
            class="lab-sharing-invite-dialog__input"
            placeholder=${t("labSharing.seekHelp.specialMessagePlaceholder")}
            .value=${askSpecialMessage}
            @input=${(event: Event) => {
              askSpecialMessage = (event.target as HTMLTextAreaElement).value;
              requestUpdate(state);
            }}
          ></textarea>
        </label>
        <div class="lab-sharing-invite-dialog__actions">
          <button
            type="button"
            class="btn lab-sharing-invite-dialog__close"
            @click=${() => {
              askingMemberId = null;
              requestUpdate(state);
            }}
          >
            ${t("labSharing.seekHelp.cancel")}
          </button>
          <button
            type="button"
            class="btn primary lab-sharing-invite-dialog__respond"
            data-testid="lab-sharing-ask-send"
            ?disabled=${isBusy(state)}
            @click=${() => send()}
          >
            ${t("labSharing.seekHelp.sendInvite")}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// 3. Invitations the viewer has asked for, and where each has got to
// ---------------------------------------------------------------------------

function renderInvitesPanel(state: AppViewState) {
  const responded = new Set(state.labSharingRespondedInviteIds ?? []);
  const invites = invitesOf(state).filter((invite) => !responded.has(invite.id));
  const viewingInvite = invitesOf(state).find((invite) => invite.id === viewingInviteId) ?? null;

  return html`
    <section
      class="card adminbot-card adminbot-card--wide lab-sharing-invites"
      data-testid="lab-sharing-invites"
    >
      ${sectionHead(t("labSharing.invites.title"), t("labSharing.invites.subtitle"))}
      ${invites.length === 0
        ? html`<p class="muted lab-sharing-invites__empty">${t("labSharing.invites.empty")}</p>`
        : html`<div class="lab-sharing-list lab-sharing-invites__list">
            ${invites.map(
              (invite) => html`
                <article
                  class="lab-sharing-row lab-sharing-invite"
                  data-testid=${`lab-sharing-invite-${invite.id}`}
                >
                  <div class="lab-sharing-row__main">
                    <p class="lab-sharing-row__title lab-sharing-invite__project">
                      ${invite.projectId}
                    </p>
                    <p class="lab-sharing-row__meta">
                      <span class="lab-sharing-invite__from"
                        >${t("labSharing.invites.to", { name: invite.fromName })}</span
                      >
                      <span aria-hidden="true">·</span>
                      <span class="lab-sharing-invite__note">${invite.note}</span>
                    </p>
                  </div>
                  <div class="lab-sharing-row__aside">
                    <span class="pill ${invite.tone} lab-sharing-invite__time"
                      >${invite.receivedAt}</span
                    >
                    <button
                      type="button"
                      class="btn btn--sm lab-sharing-invite__view"
                      @click=${() => {
                        viewingInviteId = invite.id;
                        requestUpdate(state);
                      }}
                    >
                      ${t("labSharing.invites.view")}
                    </button>
                  </div>
                </article>
              `,
            )}
          </div>`}
      ${viewingInvite
        ? html`
            <div
              class="lab-sharing-invite-dialog"
              role="dialog"
              aria-modal="true"
              aria-label=${t("labSharing.invites.viewTitle")}
              data-testid="lab-sharing-invite-dialog"
            >
              <div class="lab-sharing-invite-dialog__panel">
                ${renderInviteDetails(viewingInvite)}
                <div class="lab-sharing-invite-dialog__actions">
                  <button
                    type="button"
                    class="btn lab-sharing-invite-dialog__close"
                    @click=${() => {
                      viewingInviteId = null;
                      requestUpdate(state);
                    }}
                  >
                    ${t("labSharing.invites.close")}
                  </button>
                </div>
              </div>
            </div>
          `
        : nothing}
    </section>
  `;
}

function renderInviteDetails(invite: CollabInvite) {
  return html`
    <div class="lab-sharing-invite-dialog__head">
      <span class="lab-sharing-invite-dialog__from">${t("labSharing.invites.viewTitle")}</span>
      <h3 class="lab-sharing-invite-dialog__title">${invite.projectId}</h3>
    </div>
    <dl class="lab-sharing-invite-dialog__details">
      <div class="lab-sharing-invite-dialog__detail">
        <dt class="lab-sharing-invite-dialog__label">${t("labSharing.invites.recipient")}</dt>
        <dd class="lab-sharing-invite-dialog__value">${invite.fromName}</dd>
      </div>
      <div class="lab-sharing-invite-dialog__detail">
        <dt class="lab-sharing-invite-dialog__label">${t("labSharing.invites.kind")}</dt>
        <dd class="lab-sharing-invite-dialog__value">${invite.note}</dd>
      </div>
      <div class="lab-sharing-invite-dialog__detail">
        <dt class="lab-sharing-invite-dialog__label">${t("labSharing.invites.statusLabel")}</dt>
        <dd class="lab-sharing-invite-dialog__value">
          <span class="pill ${invite.tone}">${invite.receivedAt}</span>
        </dd>
      </div>
    </dl>
  `;
}

// ---------------------------------------------------------------------------
// 4. Your requests -- help calls you sent out, deletable
// ---------------------------------------------------------------------------

function renderYourRequestsPanel(state: AppViewState) {
  const sentRequests = sentRequestsOf(state);
  return html`
    <section
      class="card adminbot-card adminbot-card--wide lab-sharing-requests"
      data-testid="lab-sharing-requests"
    >
      ${sectionHead(t("labSharing.requests.title"))}
      ${sentRequests.length === 0
        ? html`<p class="muted lab-sharing-requests__empty">${t("labSharing.requests.empty")}</p>`
        : html`
            <div class="lab-sharing-list lab-sharing-requests__list">
              ${sentRequests.map(
                (request) => html`
                  <article
                    class="lab-sharing-row lab-sharing-request"
                    data-testid=${`lab-sharing-request-${request.id}`}
                  >
                    <div class="lab-sharing-row__main">
                      <p class="lab-sharing-row__title lab-sharing-request__project">
                        ${ownedProjectsOf(state).find((p) => p.id === request.projectId)?.title ??
                        request.projectId}
                      </p>
                      ${request.comment
                        ? html`<p class="lab-sharing-request__note">${request.comment}</p>`
                        : nothing}
                      <p class="lab-sharing-row__meta lab-sharing-request__stats">
                        ${t("labSharing.requests.stats", {
                          members: String(request.members),
                          hours: String(request.hours),
                        })}${request.sentAt
                          ? html` · <span class="lab-sharing-request__time">${request.sentAt}</span>`
                          : nothing}
                      </p>
                      ${request.tags.length
                        ? html`<div class="chip-row lab-sharing-request__needs">
                            ${request.tags.map(
                              (tag) => html`<span class="chip lab-sharing-request__need">${tag}</span>`,
                            )}
                          </div>`
                        : nothing}
                    </div>
                    <div class="lab-sharing-row__aside lab-sharing-request__actions">
                      ${confirmingDeleteRequestId === request.id
                        ? html`
                            <button
                              type="button"
                              class="btn btn--sm lab-sharing-request__cancel"
                              data-testid=${`lab-sharing-request-cancel-${request.id}`}
                              @click=${() => {
                                confirmingDeleteRequestId = null;
                                requestUpdate(state);
                              }}
                            >
                              ${t("labSharing.requests.cancelDelete")}
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm danger lab-sharing-request__delete lab-sharing-request__delete--confirm"
                              data-testid=${`lab-sharing-request-delete-${request.id}`}
                              ?disabled=${isBusy(state)}
                              @click=${() => {
                                confirmingDeleteRequestId = null;
                                requestUpdate(state);
                                // Closed, not deleted: the service keeps the row and stops showing
                                // it to the lab, so an offer already made against it still has
                                // something to point at.
                                void closeAdminBotLabSharingRequest(
                                  state,
                                  request.projectId,
                                ).finally(() => requestUpdate(state));
                              }}
                            >
                              ${t("labSharing.requests.confirmDelete")}
                            </button>
                          `
                        : html`
                            <button
                              type="button"
                              class="btn btn--sm lab-sharing-request__delete"
                              data-testid=${`lab-sharing-request-delete-${request.id}`}
                              ?disabled=${isBusy(state)}
                              @click=${() => {
                                confirmingDeleteRequestId = request.id;
                                requestUpdate(state);
                              }}
                            >
                              ${t("labSharing.requests.delete")}
                            </button>
                          `}
                    </div>
                  </article>
                `,
              )}
            </div>
          `}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 5. Open projects deck
// ---------------------------------------------------------------------------

const CHEVRON_PREV = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="m15 18-6-6 6-6" />
</svg>`;
const CHEVRON_NEXT = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="m9 18 6-6-6-6" />
</svg>`;

function renderProjectCard(state: AppViewState, project: OpenProject) {
  return html`
    <article class="lab-sharing-project" data-testid=${`lab-sharing-project-${project.id}`}>
      <div class="lab-sharing-project__header">
        <h3 class="lab-sharing-project__title">${project.title}</h3>
        <span class="lab-sharing-project__owner">${project.owner}</span>
      </div>
      ${project.summary
        ? html`<p class="lab-sharing-project__summary">${project.summary}</p>`
        : nothing}
      ${project.tags.length
        ? html`<div class="chip-row lab-sharing-project__needs">
            ${project.tags.map((tag) => html`<span class="chip lab-sharing-project__need">${tag}</span>`)}
          </div>`
        : nothing}
      <div class="lab-sharing-project__footer">
        <span class="lab-sharing-project__stats">
          ${t("labSharing.openProjects.stats", {
            members: String(project.membersNeeded),
            hours: String(project.hoursPerWeek),
          })}
        </span>
        <button
          type="button"
          class="btn btn--sm primary lab-sharing-project__offer"
          data-testid=${`lab-sharing-offer-${project.id}`}
          ?disabled=${isBusy(state)}
          @click=${() => {
            // The hours the poster asked for, as the opening offer. The panel has no field of its
            // own for it, and asking for a number before the offer exists is a form where a click
            // belongs -- the poster and the offerer settle the real figure between them.
            void offerAdminBotLabSharingHelp(state, project.id, {
              hours_per_week: project.hoursPerWeek,
              note: "",
            }).finally(() => requestUpdate(state));
          }}
        >
          ${t("labSharing.openProjects.offerHelp")}
        </button>
      </div>
    </article>
  `;
}

function renderOpenProjectsPanel(state: AppViewState) {
  const projects = openProjectsOf(state);
  const total = projects.length;
  if (total === 0) {
    return html`
      <section
        class="card adminbot-card adminbot-card--wide lab-sharing-projects"
        data-testid="lab-sharing-open-projects"
      >
        ${sectionHead(t("labSharing.openProjects.title"), t("labSharing.openProjects.subtitle"))}
        <p class="muted lab-sharing-projects__empty">${t("labSharing.openProjects.empty")}</p>
      </section>
    `;
  }
  // Wrap-around deck: `% total` (with a positive-modulo guard) so prev/next cycle forever
  // instead of hitting hard stops at either end.
  const index = (((state.labSharingOpenProjectIndex ?? 0) % total) + total) % total;
  const project = projects[index];
  const step = (delta: number) => {
    state.labSharingOpenProjectIndex = (index + delta + total) % total;
    requestUpdate(state);
  };

  return html`
    <section
      class="card adminbot-card adminbot-card--wide lab-sharing-projects"
      data-testid="lab-sharing-open-projects"
    >
      ${sectionHead(
        t("labSharing.openProjects.title"),
        t("labSharing.openProjects.subtitle"),
        total > 1
          ? html`<div class="lab-sharing-projects__pager">
              <button
                type="button"
                class="btn btn--icon lab-sharing-projects__nav lab-sharing-projects__nav--prev"
                aria-label=${t("labSharing.openProjects.previous")}
                @click=${() => step(-1)}
              >
                ${CHEVRON_PREV}
              </button>
              <span class="lab-sharing-projects__count" aria-live="polite"
                >${index + 1} / ${total}</span
              >
              <button
                type="button"
                class="btn btn--icon lab-sharing-projects__nav lab-sharing-projects__nav--next"
                aria-label=${t("labSharing.openProjects.next")}
                @click=${() => step(1)}
              >
                ${CHEVRON_NEXT}
              </button>
            </div>`
          : nothing,
      )}
      ${renderProjectCard(state, project)}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 6. Announcements -- feed plus an in-page compose form
// ---------------------------------------------------------------------------

/**
 * The one panel with nothing behind it.
 *
 * Every other panel on this tab reads and writes the service now. This one has no route, no store
 * and no action type -- so it keeps its design and wears a badge saying what it is, rather than
 * being quietly deleted or quietly left to look like the others.
 */
function renderAnnouncementsPanel(state: AppViewState) {
  return html`
    <section
      class="card adminbot-card adminbot-card--wide lab-sharing-announcements"
      data-testid="lab-sharing-announcements"
    >
      <div class="lab-sharing-section__head">
        <div class="lab-sharing-section__heading">
          <h2 class="card-title lab-sharing-announcements__title">
            ${t("labSharing.announcements.title")}
          </h2>
          <span class="pill warn" data-testid="lab-sharing-announcements-sample"
            >${t("labSharing.announcements.sample")}</span
          >
        </div>
        ${composingAnnouncement
          ? nothing
          : html`<button
              type="button"
              class="btn btn--sm lab-sharing-announcements__add"
              data-testid="lab-sharing-announcement-add"
              @click=${() => {
                composingAnnouncement = true;
                announcementDraft = "";
                requestUpdate(state);
                // Bring the compose form into view so the member lands on the thing they just
                // asked to write.
                requestAnimationFrame(() => {
                  document
                    .querySelector<HTMLElement>('[data-testid="lab-sharing-announcement-compose"]')
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                });
              }}
            >
              ${t("labSharing.announcements.add")}
            </button>`}
      </div>

      ${composingAnnouncement
        ? html`
            <div
              class="adminbot-form lab-sharing-compose"
              role="group"
              aria-label=${t("labSharing.announcements.composeTitle")}
              data-testid="lab-sharing-announcement-compose"
            >
              <label class="adminbot-form__field">
                <span>${t("labSharing.announcements.composeTitle")}</span>
                <textarea
                  class="lab-sharing-compose__input"
                  rows="3"
                  placeholder=${t("labSharing.announcements.bodyPlaceholder")}
                  .value=${announcementDraft}
                  @input=${(event: Event) => {
                    announcementDraft = (event.target as HTMLTextAreaElement).value;
                    requestUpdate(state);
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === "Escape") {
                      composingAnnouncement = false;
                      announcementDraft = "";
                      requestUpdate(state);
                    }
                  }}
                ></textarea>
              </label>
              <div class="lab-sharing-compose__actions">
                <button
                  type="button"
                  class="btn btn--sm lab-sharing-compose__cancel"
                  @click=${() => {
                    composingAnnouncement = false;
                    announcementDraft = "";
                    requestUpdate(state);
                  }}
                >
                  ${t("labSharing.announcements.cancel")}
                </button>
                <button
                  type="button"
                  class="btn btn--sm primary lab-sharing-compose__send"
                  data-testid="lab-sharing-announcement-send"
                  ?disabled=${!announcementDraft.trim()}
                  @click=${() => {
                    // MOCK: send through the real announcement channel once the backend exists.
                    const body = announcementDraft.trim();
                    if (!body) {
                      return;
                    }
                    state.labSharingAnnouncements = [
                      {
                        id: `local-${Date.now()}`,
                        authorName: announcementAuthor(state),
                        body,
                        postedAt: t("labSharing.announcements.justNow"),
                      },
                      ...announcementsOf(state),
                    ];
                    composingAnnouncement = false;
                    announcementDraft = "";
                    requestUpdate(state);
                  }}
                >
                  ${t("labSharing.announcements.send")}
                </button>
              </div>
            </div>
          `
        : nothing}

      <div class="lab-sharing-list lab-sharing-announcements__list">
        ${announcementsOf(state).length
          ? nothing
          : html`<p class="muted lab-sharing-announcements__empty">
              ${t("labSharing.announcements.empty")}
            </p>`}
        ${announcementsOf(state).map(
          (announcement) => html`
            <article
              class="lab-sharing-row lab-sharing-announcement"
              data-testid=${`lab-sharing-announcement-${announcement.id}`}
            >
              <div class="lab-sharing-row__main">
                <p class="lab-sharing-row__meta">
                  <span class="lab-sharing-announcement__author">${announcement.authorName}</span>
                  <span aria-hidden="true">·</span>
                  <span class="lab-sharing-announcement__time">${announcement.postedAt}</span>
                </p>
                <p class="lab-sharing-announcement__body">${announcement.body}</p>
              </div>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * What the tab could not load, and how the last write went.
 *
 * The banner this replaces said the whole tab was a preview; five of its six panels now read and
 * write the service, so a blanket warning would be false in the other direction. What survives is
 * narrower and truer: the reads that failed, named one per line with a way to try again, and the
 * outcome of the last action in the tone it actually had -- a success no longer wears the same
 * warning box as a failure.
 */
function renderLoadNotices(state: AppViewState) {
  const errors = state.labSharingErrors ?? [];
  const notice = state.labSharingNotice;
  if (!errors.length && !notice) {
    return nothing;
  }
  const failed = state.labSharingNoticeTone === "error";
  return html`
    <div class="lab-sharing__notices" data-testid="lab-sharing-notice">
      ${notice
        ? html`<div
            class="callout callout--dismissible ${failed ? "danger" : "success"}"
            role=${failed ? "alert" : "status"}
          >
            <div class="callout__content">${notice}</div>
            <button
              type="button"
              class="callout__dismiss"
              aria-label=${t("labSharing.dismiss")}
              @click=${() => {
                state.labSharingNotice = null;
                state.labSharingNoticeTone = null;
                requestUpdate(state);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>`
        : nothing}
      ${errors.length
        ? html`<div class="callout danger lab-sharing__load-error" role="alert">
            <div class="callout__content">
              ${errors.map((message) => html`<p>${message}</p>`)}
            </div>
            <button
              type="button"
              class="btn btn--sm"
              ?disabled=${Boolean(state.labSharingLoading)}
              @click=${() => {
                void loadAdminBotLabSharing(state).finally(() => requestUpdate(state));
                requestUpdate(state);
              }}
            >
              ${t("labSharing.retry")}
            </button>
          </div>`
        : nothing}
    </div>
  `;
}

/**
 * The Collaborate tab.
 *
 * The six panels are the design from #23, in the order it put them; what sits under them now is
 * the service. The two strips that design never had -- the guidebook question box and the resource
 * shortcuts -- follow it, wearing the same card as the rest so the page reads as one thing rather
 * than as two eras stacked.
 *
 * Loading is kicked off from the render rather than from a lifecycle hook because this view is a
 * function, not a component: the guard is the snapshot's own absence, so it runs once per session
 * and not once per keystroke. Until the first read lands the data panels are replaced by a loading
 * line; drawing them empty would show "nothing posted yet" for things that are merely not here yet.
 */
export function renderLabSharing(state: AppViewState) {
  const session = loadStoredMemberSession();
  if (session && !state.labSharing && !state.labSharingLoading) {
    void loadAdminBotLabSharing(state).finally(() => requestUpdate(state));
  }
  const loading = Boolean(state.labSharingLoading) && !state.labSharing;
  return html`
    <div class="lab-sharing" data-testid="lab-sharing" aria-busy=${loading ? "true" : "false"}>
      ${renderLoadNotices(state)}
      ${loading
        ? html`<div class="muted lab-sharing__loading" role="status">
            ${t("labSharing.loading")}
          </div>`
        : html`${renderDirectorPanel(state)} ${renderInvitesPanel(state)}
          ${renderYourRequestsPanel(state)} ${renderSeekHelpPanel(state)}
          ${renderOpenProjectsPanel(state)}`}
      ${renderAnnouncementsPanel(state)}
      ${
        // The Dashboard's map, not a copy: same data, same privacy shape (names for an admin,
        // headcounts otherwise), drawn as a Collaborate section. It sits here because "who could I
        // work with" is partly "who is awake when I am"; app-render loads it for this tab as well
        // as for the Dashboard, and refreshes it while either is open.
        renderMemberMap(state.adminBotMemberMap ?? null, {
          variant: "section",
          now: Date.now(),
          loading: state.adminBotMemberMapLoading,
        })
      }
      <lab-sharing-how-to
        .baseUrl=${resolveAdminBotBaseUrl(state.settings)}
        .sessionToken=${session?.sessionToken ?? ""}
      ></lab-sharing-how-to>
      ${renderLabSharingResources(state.basePath, Boolean(session?.sessionToken))}
    </div>
  `;
}
