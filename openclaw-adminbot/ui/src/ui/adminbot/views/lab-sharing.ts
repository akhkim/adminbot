// Lab Sharing tab: five panels --
//   1. Director status strip (availability, timezone, progress, a way to flag a blocker)
//   2. Seek help -- pick a project, describe what's needed, tag it, then post a general call or
//      search members to invite
//   3. Your invites -- collaboration invites sent to you, respond to the owner
//   4. Your requests -- help calls you sent out, deletable
//   5. Open projects -- a wrap-around deck of projects looking for hands
//   6. Announcements -- a lab-wide comms feed with an in-page compose dialog
//
// FRONTEND-ONLY for now: all data below is mock/static. Search `MOCK` for every spot that needs
// wiring to real state/controllers once the backend exists. State lives on AppViewState under the
// `labSharing*` fields (see the bottom of this file for the shape expected there) -- add those
// fields to AppViewState the same way onboarding/profile fields were added.
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
import { renderLabSharingResources } from "./lab-sharing-resources.ts";

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
  receivedAt: string;
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

type Announcement = {
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
    timezone: "",
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

const INVITE_STATUS: Record<string, string> = {
  pending: "Waiting for an admin to approve it",
  approved: "Approved; waiting to send",
  executed: "Sent",
  rejected: "Rejected",
  failed: "Could not be sent",
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
    receivedAt: INVITE_STATUS[invite.status] ?? invite.status,
  }));
}

// ---------------------------------------------------------------------------
// Announcements have no service behind them -- see renderAnnouncementsPanel.
// ---------------------------------------------------------------------------

const MOCK_ANNOUNCEMENTS: Announcement[] = [
  {
    id: "a1",
    authorName: "Zhijing Jin",
    body: "Reminder: Monday group meeting moves to 3pm this week only.",
    postedAt: "1 day ago",
  },
  {
    id: "a2",
    authorName: "Andrew Kim",
    body: "GPU cluster maintenance window Friday night -- expect downtime 11pm-2am ET.",
    postedAt: "3 days ago",
  },
];

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
// here rather than on AppViewState: typing state and an open flag are not things a re-render or a
// future backend sync should care about.
let memberSearchTimer: ReturnType<typeof setTimeout> | undefined;
let addingTag = false;
let tagDraft = "";
let announcements: Announcement[] = [...MOCK_ANNOUNCEMENTS];
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
    <section class="lab-sharing-director" data-testid="lab-sharing-director">
      <div class="lab-sharing-director__identity">
        <div class="lab-sharing-director__name-row">
          <span
            class="lab-sharing-director__dot"
            data-availability=${director.availability}
            aria-hidden="true"
          ></span>
          <div class="lab-sharing-director__name">${director.name}</div>
        </div>
        <div class="lab-sharing-director__meta">${availabilityLabel(director.availability)}</div>
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
            class="lab-sharing-tag ${active ? "lab-sharing-tag--active" : ""}"
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
              class="lab-sharing-tag lab-sharing-tag--add"
              aria-label=${t("labSharing.seekHelp.addTag")}
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
  const projectId = state.labSharingAskProjectId ?? ownedProjectsOf(state)[0]?.id ?? "";
  return html`
    <div class="lab-sharing-ask">
      <label class="lab-sharing-ask__field">
        <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.projectLabel")}</span>
        <select
          class="lab-sharing-ask__select"
          .value=${projectId}
          @change=${(event: Event) => {
            state.labSharingAskProjectId = (event.target as HTMLSelectElement).value;
          }}
        >
          ${ownedProjectsOf(state).map(
            (project) => html`<option value=${project.id}>${project.title}</option>`,
          )}
        </select>
      </label>

      <label class="lab-sharing-ask__field">
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
        <label class="lab-sharing-ask__field lab-sharing-ask__field--narrow">
          <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.membersLabel")}</span>
          <input
            class="lab-sharing-ask__input"
            type="number"
            min="1"
            .value=${String(state.labSharingAskMembers ?? 1)}
            @input=${(event: Event) => {
              state.labSharingAskMembers = Number((event.target as HTMLInputElement).value);
            }}
          />
        </label>
        <label class="lab-sharing-ask__field lab-sharing-ask__field--narrow">
          <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.hoursLabel")}</span>
          <input
            class="lab-sharing-ask__input"
            type="number"
            min="0"
            .value=${String(state.labSharingAskHours ?? 1)}
            @input=${(event: Event) => {
              state.labSharingAskHours = Number((event.target as HTMLInputElement).value);
            }}
          />
        </label>
      </div>

      <div class="lab-sharing-ask__field">
        <span class="lab-sharing-ask__label">${t("labSharing.seekHelp.tags")}</span>
        ${renderTagPicker(state)}
      </div>
    </div>
  `;
}

function renderMemberCard(state: AppViewState, member: LabMemberSummary) {
  const invited = (state.labSharingInvitedMemberIds ?? []).includes(member.id);
  return html`
    <article class="lab-sharing-member" data-testid=${`lab-sharing-member-${member.id}`}>
      <div class="lab-sharing-member__header">
        <span class="lab-sharing-member__name">${member.name}</span>
        <span class="lab-sharing-member__role">${member.role}</span>
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
        class="btn ${invited ? "" : "primary"} lab-sharing-member__invite"
        ?disabled=${invited}
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

  return html`
    <section class="lab-sharing-seek" data-testid="lab-sharing-seek-help">
      <div class="lab-sharing-seek__header">
        <h2 class="lab-sharing-seek__title">${t("labSharing.seekHelp.title")}</h2>
        <p class="lab-sharing-seek__sub">${t("labSharing.seekHelp.subtitle")}</p>
      </div>

      ${renderAskForm(state)}

      <div class="lab-sharing-seek__divider">
        <span>${t("labSharing.seekHelp.searchHeading")}</span>
      </div>

      <div class="lab-sharing-seek__search-row">
        <input
          type="text"
          class="lab-sharing-seek__search"
          placeholder=${t("labSharing.seekHelp.searchPlaceholder")}
          .value=${query}
          @input=${(event: Event) => {
            const value = (event.target as HTMLInputElement).value;
            state.labSharingSearchQuery = value;
            requestUpdate(state);
            // Debounced, because this is a request per keystroke otherwise. The generation guard is
            // the query itself: a reply for something the member has since typed past is dropped.
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

      <div class="lab-sharing-seek__results">
        ${trimmed
          ? results.length
            ? results.map((member) => renderMemberCard(state, member))
            : html`<p class="lab-sharing-seek__empty">${t("labSharing.seekHelp.empty")}</p>`
          : html`<p class="lab-sharing-seek__hint">${t("labSharing.seekHelp.searchPrompt")}</p>`}
      </div>

      ${askingMemberId
        ? renderMemberAskDialog(
            state,
            membersOf(state).find((member) => member.id === askingMemberId) ?? null,
          )
        : nothing}

      <div class="lab-sharing-seek__or">
        <span class="lab-sharing-seek__or-line"></span>
        <span class="lab-sharing-seek__or-label">${t("labSharing.seekHelp.or")}</span>
        <span class="lab-sharing-seek__or-line"></span>
      </div>

      <button
        type="button"
        class="btn primary lab-sharing-seek__call"
        data-testid="lab-sharing-general-call"
        @click=${() => {
          confirmingGeneralCall = true;
          requestUpdate(state);
        }}
      >
        ${t("labSharing.seekHelp.generalCall")}
      </button>

      ${confirmingGeneralCall ? renderGeneralCallDialog(state) : nothing}
    </section>
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

        ${state.labSharingAskComment
          ? html`<p class="lab-sharing-invite-dialog__summary">${state.labSharingAskComment}</p>`
          : nothing}

        <div class="lab-sharing-invite-dialog__detail">
          <span class="lab-sharing-invite-dialog__label"
            >${t("labSharing.seekHelp.membersLabel")}</span
          >
          <span class="lab-sharing-invite-dialog__value">${state.labSharingAskMembers ?? 1}</span>
        </div>
        <div class="lab-sharing-invite-dialog__detail">
          <span class="lab-sharing-invite-dialog__label"
            >${t("labSharing.seekHelp.hoursLabel")}</span
          >
          <span class="lab-sharing-invite-dialog__value">${state.labSharingAskHours ?? 1}</span>
        </div>

        ${(state.labSharingAskTags ?? []).length
          ? html`
              <div class="lab-sharing-invite-dialog__needs">
                ${(state.labSharingAskTags ?? []).map(
                  (tag) => html`<span class="lab-sharing-invite-dialog__need">${tag}</span>`,
                )}
              </div>
            `
          : nothing}

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
    }).finally(() => requestUpdate(state));
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

        ${state.labSharingAskComment
          ? html`<p class="lab-sharing-invite-dialog__summary">${state.labSharingAskComment}</p>`
          : nothing}

        <div class="lab-sharing-invite-dialog__detail">
          <span class="lab-sharing-invite-dialog__label"
            >${t("labSharing.seekHelp.membersLabel")}</span
          >
          <span class="lab-sharing-invite-dialog__value">${state.labSharingAskMembers ?? 1}</span>
        </div>
        <div class="lab-sharing-invite-dialog__detail">
          <span class="lab-sharing-invite-dialog__label"
            >${t("labSharing.seekHelp.hoursLabel")}</span
          >
          <span class="lab-sharing-invite-dialog__value">${state.labSharingAskHours ?? 1}</span>
        </div>

        ${(state.labSharingAskTags ?? []).length
          ? html`
              <div class="lab-sharing-invite-dialog__needs">
                ${(state.labSharingAskTags ?? []).map(
                  (tag) => html`<span class="lab-sharing-invite-dialog__need">${tag}</span>`,
                )}
              </div>
            `
          : nothing}

        <div class="lab-sharing-invite-dialog__field">
          <label class="lab-sharing-invite-dialog__label" for="lab-sharing-ask-special-message"
            >${t("labSharing.seekHelp.specialMessageLabel", { name: member.name })}</label
          >
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
        </div>

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
// 3. Your invites -- respond to the owner
// ---------------------------------------------------------------------------

function renderInvitesPanel(state: AppViewState) {
  const responded = new Set(state.labSharingRespondedInviteIds ?? []);
  const invites = invitesOf(state).filter((invite) => !responded.has(invite.id));
  const viewingInvite = invitesOf(state).find((invite) => invite.id === viewingInviteId) ?? null;

  return html`
    <section class="lab-sharing-invites" data-testid="lab-sharing-invites">
      <h2 class="lab-sharing-invites__title">${t("labSharing.invites.title")}</h2>
      <div class="lab-sharing-invites__list">
        ${invites.map(
          (invite) => html`
            <article class="lab-sharing-invite" data-testid=${`lab-sharing-invite-${invite.id}`}>
              <div class="lab-sharing-invite__header">
                <span class="lab-sharing-invite__from"
                  >${t("labSharing.invites.to", { name: invite.fromName })}</span
                >
                <span class="lab-sharing-invite__time">${invite.receivedAt}</span>
              </div>
              <p class="lab-sharing-invite__project">${invite.projectId}</p>
              <p class="lab-sharing-invite__note">${invite.note}</p>
              <div class="lab-sharing-invite__actions">
                <button
                  type="button"
                  class="btn primary lab-sharing-invite__view"
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
      </div>

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
      <h3 class="lab-sharing-invite-dialog__title">${invite.projectId}</h3>
      <span class="lab-sharing-invite-dialog__from"
        >${t("labSharing.invites.to", { name: invite.fromName })}</span
      >
    </div>
    <p class="lab-sharing-invite-dialog__note">${invite.note}</p>
  `;
}

// ---------------------------------------------------------------------------
// 4. Your requests -- help calls you sent out, deletable
// ---------------------------------------------------------------------------

function renderYourRequestsPanel(state: AppViewState) {
  const sentRequests = sentRequestsOf(state);
  return html`
    <section class="lab-sharing-requests" data-testid="lab-sharing-requests">
      <h2 class="lab-sharing-requests__title">${t("labSharing.requests.title")}</h2>
      ${sentRequests.length === 0
        ? html`<p class="lab-sharing-requests__empty">${t("labSharing.requests.empty")}</p>`
        : html`
            <div class="lab-sharing-requests__list">
              ${sentRequests.map(
                (request) => html`
                  <article
                    class="lab-sharing-request"
                    data-testid=${`lab-sharing-request-${request.id}`}
                  >
                    <div class="lab-sharing-request__header">
                      <span class="lab-sharing-request__project">
                        ${ownedProjectsOf(state).find((p) => p.id === request.projectId)?.title ??
                        request.projectId}
                      </span>
                      <span class="lab-sharing-request__time">${request.sentAt}</span>
                    </div>
                    <p class="lab-sharing-request__note">${request.comment}</p>
                    <div class="lab-sharing-request__meta">
                      <span class="lab-sharing-request__stats">
                        ${t("labSharing.requests.stats", {
                          members: String(request.members),
                          hours: String(request.hours),
                        })}
                      </span>
                      <div class="lab-sharing-request__needs">
                        ${request.tags.map(
                          (tag) => html`<span class="lab-sharing-request__need">${tag}</span>`,
                        )}
                      </div>
                    </div>
                    <div class="lab-sharing-request__actions">
                      ${confirmingDeleteRequestId === request.id
                        ? html`
                            <button
                              type="button"
                              class="btn lab-sharing-request__cancel"
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
                              class="btn lab-sharing-request__delete lab-sharing-request__delete--confirm"
                              data-testid=${`lab-sharing-request-delete-${request.id}`}
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
                              class="btn lab-sharing-request__delete"
                              data-testid=${`lab-sharing-request-delete-${request.id}`}
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
function renderProjectCard(state: AppViewState, project: OpenProject) {
  return html`
    <article class="lab-sharing-project" data-testid=${`lab-sharing-project-${project.id}`}>
      <div class="lab-sharing-project__header">
        <h3 class="lab-sharing-project__title">${project.title}</h3>
        <span class="lab-sharing-project__owner">${project.owner}</span>
      </div>
      <p class="lab-sharing-project__summary">${project.summary}</p>
      <div class="lab-sharing-project__needs">
        ${project.tags.map((tag) => html`<span class="lab-sharing-project__need">${tag}</span>`)}
      </div>
      <div class="lab-sharing-project__footer">
        <span class="lab-sharing-project__stats">
          ${t("labSharing.openProjects.stats", {
            members: String(project.membersNeeded),
            hours: String(project.hoursPerWeek),
          })}
        </span>
        <button
          type="button"
          class="btn primary lab-sharing-project__offer"
          data-testid=${`lab-sharing-offer-${project.id}`}
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
      <section class="lab-sharing-projects" data-testid="lab-sharing-open-projects">
        <h2 class="lab-sharing-projects__title">${t("labSharing.openProjects.title")}</h2>
        <p class="lab-sharing-projects__empty">${t("labSharing.openProjects.empty")}</p>
      </section>
    `;
  }
  // Wrap-around deck: `% total` (with a positive-modulo guard) so prev/next cycle forever
  // instead of hitting hard stops at either end.
  const index = (((state.labSharingOpenProjectIndex ?? 0) % total) + total) % total;
  const project = projects[index];

  return html`
    <section class="lab-sharing-projects" data-testid="lab-sharing-open-projects">
      <div class="lab-sharing-projects__header">
        <h2 class="lab-sharing-projects__title">${t("labSharing.openProjects.title")}</h2>
        <span class="lab-sharing-projects__count">${index + 1} / ${total}</span>
      </div>

      <div class="lab-sharing-projects__deck">
        <button
          type="button"
          class="lab-sharing-projects__nav lab-sharing-projects__nav--prev"
          aria-label=${t("labSharing.openProjects.previous")}
          @click=${() => {
            state.labSharingOpenProjectIndex = (index - 1 + total) % total;
            requestUpdate(state);
          }}
        >
          <svg
            class="lab-sharing-projects__chevron"
            viewBox="0 0 10 10"
            width="10"
            height="10"
            aria-hidden="true"
          >
            <path
              d="M6.5 2.5L3.5 5L6.5 7.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        ${renderProjectCard(state, project)}

        <button
          type="button"
          class="lab-sharing-projects__nav lab-sharing-projects__nav--next"
          aria-label=${t("labSharing.openProjects.next")}
          @click=${() => {
            state.labSharingOpenProjectIndex = (index + 1) % total;
            requestUpdate(state);
          }}
        >
          <svg
            class="lab-sharing-projects__chevron"
            viewBox="0 0 10 10"
            width="10"
            height="10"
            aria-hidden="true"
          >
            <path
              d="M3.5 2.5L6.5 5L3.5 7.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 6. Announcements -- feed plus an in-page compose dialog
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
    <section class="lab-sharing-announcements" data-testid="lab-sharing-announcements">
      <div class="lab-sharing-announcements__header">
        <h2 class="lab-sharing-announcements__title">
          ${t("labSharing.announcements.title")}
          <span class="pill warn" data-testid="lab-sharing-announcements-sample"
            >${t("labSharing.announcements.sample")}</span
          >
        </h2>
        <button
          type="button"
          class="btn lab-sharing-announcements__add"
          data-testid="lab-sharing-announcement-add"
          @click=${() => {
            composingAnnouncement = true;
            announcementDraft = "";
            requestUpdate(state);
            // The compose panel is at the bottom of the page; bring it into view so the member
            // lands on the thing they just asked to write.
            requestAnimationFrame(() => {
              document
                .querySelector<HTMLElement>('[data-testid="lab-sharing-announcement-compose"]')
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          }}
        >
          + ${t("labSharing.announcements.add")}
        </button>
      </div>

      <div class="lab-sharing-announcements__list">
        ${announcements.map(
          (announcement) => html`
            <article
              class="lab-sharing-announcement"
              data-testid=${`lab-sharing-announcement-${announcement.id}`}
            >
              <div class="lab-sharing-announcement__header">
                <span class="lab-sharing-announcement__author">${announcement.authorName}</span>
                <span class="lab-sharing-announcement__time">${announcement.postedAt}</span>
              </div>
              <p class="lab-sharing-announcement__body">${announcement.body}</p>
            </article>
          `,
        )}
      </div>

      ${composingAnnouncement
        ? html`
            <div
              class="lab-sharing-compose"
              role="dialog"
              aria-modal="true"
              aria-label=${t("labSharing.announcements.composeTitle")}
              data-testid="lab-sharing-announcement-compose"
            >
              <h3 class="lab-sharing-compose__title">
                ${t("labSharing.announcements.composeTitle")}
              </h3>
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
              <div class="lab-sharing-compose__actions">
                <button
                  type="button"
                  class="btn lab-sharing-compose__cancel"
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
                  class="btn primary lab-sharing-compose__send"
                  data-testid="lab-sharing-announcement-send"
                  ?disabled=${!announcementDraft.trim()}
                  @click=${() => {
                    // MOCK: send through the real announcement channel once the backend exists.
                    const body = announcementDraft.trim();
                    if (!body) {
                      return;
                    }
                    announcements = [
                      { id: `local-${Date.now()}`, authorName: "You", body, postedAt: "just now" },
                      ...announcements,
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
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * What the tab could not load, and the one panel that has nothing behind it.
 *
 * The banner this replaces said the whole tab was a preview; five of its six panels now read and
 * write the service, so a blanket warning would be false in the other direction. What survives is
 * narrower and truer: the reads that failed, named one per line, and -- on the announcements panel
 * itself -- a badge saying that one is still sample data.
 */
function renderLoadNotices(state: AppViewState) {
  const errors = state.labSharingErrors ?? [];
  if (!errors.length && !state.labSharingNotice) {
    return nothing;
  }
  return html`
    <div class="lab-sharing__coming-soon" role="status" data-testid="lab-sharing-notice">
      <span class="lab-sharing__coming-soon-copy">
        ${state.labSharingNotice ? html`<strong>${state.labSharingNotice}</strong>` : nothing}
        ${errors.map((message) => html`<span>${message}</span>`)}
      </span>
    </div>
  `;
}

/**
 * The Collaborate tab.
 *
 * The six panels are the design from #23, in the order it put them; what sits under them now is
 * the service. The two strips that design never had -- the guidebook question box and the resource
 * shortcuts -- follow it, wearing the same section shell as the rest so the page reads as one
 * thing rather than as two eras stacked.
 *
 * Loading is kicked off from the render rather than from a lifecycle hook because this view is a
 * function, not a component: the guard is the snapshot's own absence, so it runs once per session
 * and not once per keystroke.
 */
export function renderLabSharing(state: AppViewState) {
  const session = loadStoredMemberSession();
  if (session && !state.labSharing && !state.labSharingLoading) {
    void loadAdminBotLabSharing(state).finally(() => requestUpdate(state));
  }
  return html`
    <div class="lab-sharing" data-testid="lab-sharing">
      ${renderLoadNotices(state)} ${renderDirectorPanel(state)} ${renderInvitesPanel(state)}
      ${renderYourRequestsPanel(state)} ${renderSeekHelpPanel(state)}
      ${renderOpenProjectsPanel(state)} ${renderAnnouncementsPanel(state)}
      <lab-sharing-how-to
        .baseUrl=${resolveAdminBotBaseUrl(state.settings)}
        .sessionToken=${session?.sessionToken ?? ""}
      ></lab-sharing-how-to>
      ${renderLabSharingResources(state.basePath, Boolean(session?.sessionToken))}
    </div>
  `;
}
